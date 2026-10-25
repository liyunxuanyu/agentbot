import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import {
  applyMentions,
  decideSpeakers,
  MAX_SPEAKERS,
  parseHostReply,
  type ChannelRef,
} from "../../src/server/core/group/host.js";
import { dispatchSpeakers } from "../../src/server/core/group/dispatcher.js";
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * 群聊主持与派发（M10 / P0-06）。
 *
 * 用**假驱动 + 真编排器**，而不是直接 stub 编排器：
 * 「未被点名的 Bot 产生 0 次运行时调用」这条要求只有数到 `prompt()` 的调用次数
 * 才算证明 —— 数 Turn 数会把「起了 Turn 但没发 prompt」也算进去。
 */

const NOW = Date.now();

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake-group",
  displayName: "Fake Group",
  protocol: "cli-stdio",
  launch: { command: "fake", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: false,
    resume: false,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "done", "error"],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "none",
  executionLocations: ["local"],
};

interface FakeBotDriver extends ChannelDriver {
  /** 运行时调用次数（prompt 的次数）——「0 次调用」的度量。 */
  calls: number;
  /** 每次 prompt 开始/结束的时间戳（串行 vs 并行的判据）。 */
  spans: { start: number; end: number }[];
}

interface FakeBotOptions {
  /** 产出正文；默认「<botId> 已回复」。 */
  reply?: (text: string) => string;
  /** prompt 持续时长（毫秒），用来观察串行/并行。 */
  latencyMs?: number;
  /** true = prompt 永不结束（用于取消/超时场景）。 */
  hang?: boolean;
}

function createBotDriver(botId: string, opts: FakeBotOptions = {}): FakeBotDriver {
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  const handle: SessionHandle = { sessionId: `s_${botId}`, pid: null, runtimeSessionId: `rt_${botId}` };
  let release: (() => void) | null = null;

  const driver: FakeBotDriver = {
    protocol: "cli-stdio",
    calls: 0,
    spans: [],
    async start() {
      return handle;
    },
    async initialize() {
      return {
        capabilities: DECL.capabilities,
        source: "probed" as const,
        version: "1.0.0",
        healthStatus: "healthy" as const,
      };
    },
    async newSession() {
      return { runtimeSessionId: `rt_${botId}` };
    },
    async resumeSession() {
      return { ok: false, reason: "测试不支持" };
    },
    async prompt(h, input) {
      driver.calls += 1;
      const start = Date.now();
      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? "turn_unknown";
      const messageId = ctx?.messageId ?? "msg_unknown";

      const emit = (e: CanonicalEvent): void => eventCb?.(e);
      const text = opts.reply ? opts.reply(input.text) : `${botId} 已回复`;

      if (opts.hang) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        driver.spans.push({ start, end: Date.now() });
        return;
      }

      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));

      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "start", text: "" },
      });
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "delta", text },
      });
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "end", text: "" },
      });
      emit({ type: "done", turnId, ts: Date.now(), payload: { stopReason: "end", durationMs: 1 } });
      driver.spans.push({ start, end: Date.now() });
    },
    async cancel() {
      release?.();
    },
    async respondPermission() {
      /* 不涉及 */
    },
    onEvent(_h, cb) {
      eventCb = cb;
    },
    onPermission() {
      /* 不涉及 */
    },
    onExit() {
      /* 不涉及 */
    },
    async dispose() {
      release?.();
    },
  };
  return driver;
}

interface Fixture {
  db: DB;
  drivers: Map<string, FakeBotDriver>;
  orchestrator: ReturnType<typeof createTurnOrchestrator>;
  channel: ChannelRef;
  close: () => void;
}

interface SetupOptions {
  /** 每个 Bot 的驱动行为；缺省用默认回复。 */
  behavior?: Record<string, FakeBotOptions>;
  /** 参与者 id（第一个是主持人，除非显式指定 hostId）。 */
  participants: string[];
  hostId?: string | null;
  /** 哪些 Bot 的运行时「不可用」（resolveRuntime 返回 null）。 */
  unavailable?: string[];
}

function setup(opts: SetupOptions): Fixture {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const channelId = "ch_group";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'group', '研究小组', ?, ?, ?)`,
  ).run(channelId, JSON.stringify(opts.participants), opts.hostId === undefined ? (opts.participants[0] ?? null) : opts.hostId, NOW);

  const drivers = new Map<string, FakeBotDriver>();
  for (const id of opts.participants) {
    db.prepare(
      `INSERT INTO bots (id, name, persona, execution_location, status, created_at, updated_at)
       VALUES (?, ?, ?, 'local', 'active', ?, ?)`,
    ).run(id, `Bot-${id}`, `${id} 的人格`, NOW, NOW);
    drivers.set(id, createBotDriver(id, opts.behavior?.[id] ?? {}));
  }

  const unavailable = new Set(opts.unavailable ?? []);
  const resolveRuntime = (botId: string): { runtimeId: string; declaration: AdapterDeclaration; driver: ChannelDriver } | null => {
    const driver = drivers.get(botId);
    if (!driver || unavailable.has(botId)) return null;
    return { runtimeId: `rt_${botId}`, declaration: DECL, driver };
  };

  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime,
    idleReapMs: 0,
    killImpl: async () => ({ gone: true }),
    log: () => undefined,
  });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock: createSessionLock(),
    resolveRuntime,
    supervisor,
  });

  return {
    db,
    drivers,
    orchestrator,
    channel: {
      id: channelId,
      participantBotIds: opts.participants,
      hostBotId: opts.hostId === undefined ? (opts.participants[0] ?? null) : opts.hostId,
    },
    close: () => {
      void orchestrator.dispose();
      void supervisor.dispose();
      db.close();
    },
  };
}

function hostReply(speakers: { botId: string; reason?: string }[], skipReason?: string): string {
  return JSON.stringify({
    speakers: speakers.map((s) => ({ botId: s.botId, reason: s.reason ?? "更合适" })),
    ...(skipReason === undefined ? {} : { skipReason }),
  });
}

const PARTICIPANTS = [
  { id: "bot_a", name: "研究助手", persona: "查资料" },
  { id: "bot_b", name: "实现助手", persona: "写代码" },
  { id: "bot_c", name: "审查助手", persona: "挑毛病" },
  { id: "bot_d", name: "文档助手", persona: "写文档" },
  { id: "bot_e", name: "运维助手", persona: "跑脚本" },
  { id: "bot_f", name: "数据助手", persona: "做统计" },
];

// ---------------------------------------------------------------------------
// 纯函数：解析与 @ 合并
// ---------------------------------------------------------------------------

describe("主持人回复解析（parseHostReply）", () => {
  it("0 个发言人：返回空名单 + skipReason", () => {
    const r = parseHostReply(hostReply([], "大家都在忙，本轮不必回答"), PARTICIPANTS, "bot_a");
    expect(r.speakers).toEqual([]);
    expect(r.skipReason).toBe("大家都在忙，本轮不必回答");
    expect(r.nonJson).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("1 个发言人：原样保留理由", () => {
    const r = parseHostReply(hostReply([{ botId: "bot_b", reason: "会写代码" }]), PARTICIPANTS, "bot_a");
    expect(r.speakers).toEqual([{ botId: "bot_b", reason: "会写代码" }]);
  });

  it("3 个发言人：全部保留（正好在上限）", () => {
    const r = parseHostReply(
      hostReply([{ botId: "bot_b" }, { botId: "bot_c" }, { botId: "bot_d" }]),
      PARTICIPANTS,
      "bot_a",
    );
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_b", "bot_c", "bot_d"]);
    expect(r.warnings).toEqual([]);
  });

  it("5 个发言人：截断到 3 个并记 warning（P0-06 单轮 ≤3）", () => {
    const r = parseHostReply(
      hostReply([
        { botId: "bot_b" },
        { botId: "bot_c" },
        { botId: "bot_d" },
        { botId: "bot_e" },
        { botId: "bot_f" },
      ]),
      PARTICIPANTS,
      "bot_a",
    );
    expect(r.speakers).toHaveLength(MAX_SPEAKERS);
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_b", "bot_c", "bot_d"]);
    expect(r.warnings.join(" ")).toContain("截断");
  });

  it("不存在的 BotId 被丢弃，剩余合法名单保留并记 warning", () => {
    const r = parseHostReply(
      hostReply([{ botId: "bot_ghost" }, { botId: "bot_b", reason: "合适" }]),
      PARTICIPANTS,
      "bot_a",
    );
    expect(r.speakers).toEqual([{ botId: "bot_b", reason: "合适" }]);
    expect(r.warnings.join(" ")).toContain("bot_ghost");
  });

  it("全部是不存在的 BotId：名单为空，不能凭空造人", () => {
    const r = parseHostReply(hostReply([{ botId: "bot_x" }, { botId: "bot_y" }]), PARTICIPANTS, "bot_a");
    expect(r.speakers).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });

  it("带 Markdown 围栏与前后寒暄也能解析", () => {
    const text = `好的，我来决定：\n\`\`\`json\n${hostReply([{ botId: "bot_c", reason: "审查" }])}\n\`\`\`\n以上。`;
    const r = parseHostReply(text, PARTICIPANTS, "bot_a");
    expect(r.speakers).toEqual([{ botId: "bot_c", reason: "审查" }]);
    expect(r.nonJson).toBe(false);
  });

  it("非 JSON 降级：按名字匹配（不报错、不空跑）", () => {
    const r = parseHostReply("我觉得研究助手和实现助手都应该回答这个问题。", PARTICIPANTS, "bot_a");
    expect(r.nonJson).toBe(true);
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_a", "bot_b"]);
    expect(r.warnings.join(" ")).toContain("不是结构化 JSON");
  });

  it("非 JSON 且一个名字都没提到：取第一个非主持人参与者", () => {
    const r = parseHostReply("嗯……让我想想。", PARTICIPANTS, "bot_a");
    expect(r.nonJson).toBe(true);
    expect(r.speakers).toHaveLength(1);
    expect(r.speakers[0]?.botId).toBe("bot_b");
  });

  it("空回复：降级为默认第一人（不是崩溃）", () => {
    const r = parseHostReply("", PARTICIPANTS, "bot_a");
    expect(r.nonJson).toBe(true);
    expect(r.speakers).toHaveLength(1);
  });

  it("speakers 写成字符串数组也能解析（LLM 常见偷懒）", () => {
    const r = parseHostReply('{"speakers":["bot_b","bot_c"]}', PARTICIPANTS, "bot_a");
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_b", "bot_c"]);
  });

  it("重复的 BotId 只保留一次", () => {
    const r = parseHostReply(hostReply([{ botId: "bot_b" }, { botId: "bot_b" }]), PARTICIPANTS, "bot_a");
    expect(r.speakers).toHaveLength(1);
  });
});

describe("@ 优先规则（applyMentions）", () => {
  it("@ 的 Bot 必被包含且排在最前，即使主持人没提名", () => {
    const r = applyMentions([{ botId: "bot_b", reason: "主持人提名" }], ["bot_d"], PARTICIPANTS);
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_d", "bot_b"]);
    expect(r.speakers[0]?.reason).toBe("用户点名");
  });

  it("@ 的 Bot 已在主持人名单里：提到最前，不重复", () => {
    const r = applyMentions(
      [{ botId: "bot_b", reason: "x" }, { botId: "bot_c", reason: "y" }],
      ["bot_c"],
      PARTICIPANTS,
    );
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_c", "bot_b"]);
  });

  it("@ 了不在群里的 Bot：忽略并记 warning", () => {
    const r = applyMentions([], ["bot_zzz"], PARTICIPANTS);
    expect(r.speakers).toEqual([]);
    expect(r.warnings.join(" ")).toContain("不在群里");
  });

  it("@ 多个（3 个）：全部优先且不超过上限", () => {
    const r = applyMentions([{ botId: "bot_a", reason: "x" }], ["bot_b", "bot_c", "bot_d"], PARTICIPANTS);
    expect(r.speakers.map((s) => s.botId)).toEqual(["bot_b", "bot_c", "bot_d"]);
  });

  it("@ 超过 3 个：截断到 3 并记 warning", () => {
    const r = applyMentions([], ["bot_b", "bot_c", "bot_d", "bot_e"], PARTICIPANTS);
    expect(r.speakers).toHaveLength(3);
    expect(r.warnings.join(" ")).toContain("超出单轮上限");
  });
});

// ---------------------------------------------------------------------------
// 主持人决策（真编排器 + 假驱动）
// ---------------------------------------------------------------------------

describe("主持人决策（decideSpeakers）", () => {
  it("主持人正常返回：名单落地，且只有主持人被调用过", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c"],
      behavior: {
        bot_a: { reply: () => hostReply([{ botId: "bot_b", reason: "会写代码" }]) },
      },
    });

    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "帮我改个 bug",
      [],
    );

    expect(decision.degraded).toBe("none");
    expect(decision.speakers).toEqual([{ botId: "bot_b", reason: "会写代码" }]);
    expect(decision.hostTurn).not.toBeNull();
    // 决策阶段只跑了主持人这一轮
    expect(f.drivers.get("bot_a")?.calls).toBe(1);
    expect(f.drivers.get("bot_b")?.calls).toBe(0);
    expect(f.drivers.get("bot_c")?.calls).toBe(0);

    // 会话流里记录的是**用户原文**，不是主持人内部 prompt
    const userMsg = f.db
      .prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'user'")
      .get(decision.hostTurn!.turnId) as { content: string } | undefined;
    expect(userMsg?.content).toBe("帮我改个 bug");

    f.close();
  });

  it("主持人不可用：不发起任何调用，降级为「@ 谁谁回」", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c"],
      unavailable: ["bot_a"],
    });

    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: (id) => id !== "bot_a" },
      f.channel,
      "帮我看下",
      ["bot_c"],
    );

    expect(decision.degraded).toBe("host_unavailable");
    expect(decision.notice).toContain("@ 谁谁回");
    expect(decision.speakers.map((s) => s.botId)).toEqual(["bot_c"]);
    expect(f.drivers.get("bot_a")?.calls).toBe(0);
    expect(f.drivers.get("bot_c")?.calls).toBe(0);
    f.close();
  });

  it("没有主持人：同样降级，且不崩", async () => {
    const f = setup({ participants: ["bot_a", "bot_b"], hostId: null });
    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "随便聊聊",
      [],
    );
    expect(decision.degraded).toBe("no_host");
    expect(decision.speakers).toEqual([]);
    expect(decision.skipReason).toBe("本群没有设置主持人");
    expect(f.drivers.get("bot_a")?.calls).toBe(0);
    f.close();
  });

  it("主持人返回非 JSON：降级但仍给出可执行名单", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c"],
      behavior: { bot_a: { reply: () => "我建议让 Bot-bot_b 来回答。" } },
    });
    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "谁来答",
      [],
    );
    expect(decision.degraded).toBe("non_json");
    expect(decision.speakers.map((s) => s.botId)).toEqual(["bot_b"]);
    f.close();
  });

  it("主持人返回空名单：speakers 为空 + skipReason（前端显示「本轮无 Bot 发言」）", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b"],
      behavior: { bot_a: { reply: () => hostReply([], "问题不明确，等用户补充") } },
    });
    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "嗯",
      [],
    );
    expect(decision.speakers).toEqual([]);
    expect(decision.skipReason).toBe("问题不明确，等用户补充");
    expect(decision.degraded).toBe("empty_list");
    f.close();
  });

  it("主持人返回 5 个：截到 3，warning 同时进决策结果", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e", "bot_f"],
      behavior: {
        bot_a: {
          reply: () =>
            hostReply([{ botId: "bot_b" }, { botId: "bot_c" }, { botId: "bot_d" }, { botId: "bot_e" }, { botId: "bot_f" }]),
        },
      },
    });
    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "全员上",
      [],
    );
    expect(decision.speakers).toHaveLength(3);
    expect(decision.warnings.join(" ")).toContain("截断");
    f.close();
  });

  it("主持人返回不存在的 Bot：丢弃 + notice（群内系统提示）", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b"],
      behavior: { bot_a: { reply: () => hostReply([{ botId: "bot_ghost" }, { botId: "bot_b" }]) } },
    });
    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "找个不存在的",
      [],
    );
    expect(decision.speakers.map((s) => s.botId)).toEqual(["bot_b"]);
    expect(decision.notice).toContain("bot_ghost");
    f.close();
  });

  it("主持人超时：降级为 @ 谁谁回并给群内提示", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b"],
      behavior: { bot_a: { hang: true } },
    });
    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true, decisionTimeoutMs: 80 },
      f.channel,
      "想很久",
      ["bot_b"],
    );
    expect(decision.degraded).toBe("timeout");
    expect(decision.notice).toContain("@ 谁谁回");
    expect(decision.speakers.map((s) => s.botId)).toEqual(["bot_b"]);
    // 主持人确实被调用了一次（超时是「调了没回」，不是「没调」）
    expect(f.drivers.get("bot_a")?.calls).toBe(1);
    f.close();
  }, 10000);
});

// ---------------------------------------------------------------------------
// 派发（0 次调用 / 顺序 / 并行）
// ---------------------------------------------------------------------------

describe("群聊派发（dispatchSpeakers）", () => {
  it("未被点名的 Bot 产生 0 次运行时调用（硬要求）", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c", "bot_d"],
      behavior: {
        bot_a: { reply: () => hostReply([{ botId: "bot_b" }, { botId: "bot_c" }]) },
      },
    });

    const decision = await decideSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      f.channel,
      "两个人回答",
      [],
    );
    const dispatched = await dispatchSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      { channelId: f.channel.id, speakers: decision.speakers, text: "两个人回答", parallel: false },
    );

    expect(dispatched.results.map((r) => r.botId)).toEqual(["bot_b", "bot_c"]);
    expect(dispatched.calls).toBe(2);

    // 逐个数 prompt 次数：没被点名的 bot_a（主持人）与 bot_d 都是 0
    expect(f.drivers.get("bot_a")?.calls).toBe(1); // 只作为主持人被调过一次
    expect(f.drivers.get("bot_b")?.calls).toBe(1);
    expect(f.drivers.get("bot_c")?.calls).toBe(1);
    expect(f.drivers.get("bot_d")?.calls).toBe(0);
    f.close();
  }, 15000);

  it("默认依次执行：后一个在前一个结束之后才开始", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c"],
      behavior: { bot_b: { latencyMs: 60 }, bot_c: { latencyMs: 60 } },
    });

    await dispatchSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      {
        channelId: f.channel.id,
        speakers: [
          { botId: "bot_b", reason: "先" },
          { botId: "bot_c", reason: "后" },
        ],
        text: "依次来",
        parallel: false,
      },
    );

    const b = f.drivers.get("bot_b")!;
    const c = f.drivers.get("bot_c")!;
    expect(b.calls).toBe(1);
    expect(c.calls).toBe(1);
    // 串行：c 的开始不早于 b 的结束（留 5ms 抖动余量）
    expect(c.spans[0]!.start).toBeGreaterThanOrEqual(b.spans[0]!.end - 5);
    f.close();
  }, 15000);

  it("显式 @ 多个 → 并行（两个 prompt 时间重叠）", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c"],
      behavior: { bot_b: { latencyMs: 120 }, bot_c: { latencyMs: 120 } },
    });

    await dispatchSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      {
        channelId: f.channel.id,
        speakers: [
          { botId: "bot_b", reason: "点名1" },
          { botId: "bot_c", reason: "点名2" },
        ],
        text: "一起上",
        parallel: true,
      },
    );

    const b = f.drivers.get("bot_b")!;
    const c = f.drivers.get("bot_c")!;
    const overlap = Math.min(b.spans[0]!.end, c.spans[0]!.end) - Math.max(b.spans[0]!.start, c.spans[0]!.start);
    expect(overlap).toBeGreaterThan(0);
    f.close();
  }, 15000);

  it("某一轮失败不阻塞后续发言人", async () => {
    const f = setup({
      participants: ["bot_a", "bot_b", "bot_c"],
      // bot_b 的运行时不可用 → 直接失败；bot_c 必须照常跑
      unavailable: ["bot_b"],
    });

    const results = await dispatchSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: (id) => id !== "bot_b" },
      {
        channelId: f.channel.id,
        speakers: [
          { botId: "bot_b", reason: "第一个" },
          { botId: "bot_c", reason: "第二个" },
        ],
        text: "有人挂了也要继续",
        parallel: false,
      },
    );

    expect(results.results[0]?.status).toBe("start_failed");
    expect(results.results[0]?.error).toContain("运行时不可用");
    expect(results.results[1]?.status).toBe("done");
    expect(f.drivers.get("bot_b")?.calls).toBe(0);
    expect(f.drivers.get("bot_c")?.calls).toBe(1);
    f.close();
  }, 15000);

  it("空名单：一次调用都不发", async () => {
    const f = setup({ participants: ["bot_a", "bot_b"] });
    const results = await dispatchSpeakers(
      { db: f.db, orchestrator: f.orchestrator, isRuntimeAvailable: () => true },
      { channelId: f.channel.id, speakers: [], text: "没人回答", parallel: false },
    );
    expect(results.calls).toBe(0);
    expect(results.results).toEqual([]);
    expect(f.drivers.get("bot_a")?.calls).toBe(0);
    expect(f.drivers.get("bot_b")?.calls).toBe(0);
    f.close();
  });
});
