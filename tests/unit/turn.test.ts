import { describe, expect, it } from "vitest";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import { createEventBus, type EventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import type { AdapterDeclaration, ChannelDriver, SessionHandle } from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import { createBotIdEnricher } from "../../src/server/http/dto.js";
import type { EventRow } from "../../src/server/core/events/model.js";

/**
 * 最小 Turn 编排测试（P0-04 / P0-05 / P0-15）。
 *
 * 用**假驱动**而不是真运行时：这些断言要挡住的是编排逻辑的问题
 * （收口、掩码、botId、排队、取消），与具体协议无关。
 * 真运行时由契约测试与真实探测覆盖。
 */

const NOW = Date.now();

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake",
  displayName: "Fake",
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
  // 故意只声明 3 类：用于验证「未声明类型被 ingest 丢弃」
  eventCapabilities: ["message_delta", "done", "error"],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "none",
  executionLocations: ["local"],
};

interface FakeDriverOptions {
  /** 每个 prompt 依次产出的事件（由测试指定）。 */
  script: (turn: { turnId: string; messageId: string }) => CanonicalEvent[];
  /** true 表示 prompt 永不 resolve（模拟长任务，用于取消测试）。 */
  hang?: boolean;
}

interface FakeDriver extends ChannelDriver {
  /** 让测试手动触发退出。 */
  fireExit(info: { code: number | null; stderrTail: string }): void;
  cancelCount(): number;
}

function createFakeDriver(opts: FakeDriverOptions): FakeDriver {
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  let exitCb: ((i: { code: number | null; signal?: string; stderrTail: string }) => void) | null = null;
  let cancels = 0;
  let currentTurn: { turnId: string; messageId: string } | null = null;
  /** prompt 的 resolve 句柄（hang 模式下由 cancel/退出放行）。 */
  let releasePrompt: (() => void) | null = null;

  const handle: SessionHandle = {
    sessionId: "s",
    pid: 1234,
    runtimeSessionId: "rt_1",
  };

  const driver: FakeDriver = {
    protocol: "cli-stdio",
    async start() {
      return handle;
    },
    async initialize() {
      return {
        capabilities: DECL.capabilities,
        source: "probed",
        version: "1.0.0",
        healthStatus: "healthy",
      };
    },
    async newSession() {
      return { runtimeSessionId: "rt_1" };
    },
    async resumeSession() {
      return { ok: false, reason: "不支持" };
    },
    async prompt(h, input) {
      // 编排层在 prompt 前通过 setTurnContext 注入 turnId / messageId
      const ctx = getTurnContext(h);
      currentTurn = {
        turnId: ctx?.turnId ?? "turn_unknown",
        messageId: ctx?.messageId ?? "msg_unknown",
      };
      void input;
      const events = opts.script(currentTurn);
      for (const e of events) eventCb?.(e);
      if (opts.hang) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
    },
    async cancel() {
      cancels += 1;
      releasePrompt?.();
    },
    async respondPermission() {
      // 假驱动不涉及权限
    },
    onEvent(_h, cb) {
      eventCb = cb;
    },
    onPermission() {
      // 不需要
    },
    onExit(_h, cb) {
      exitCb = cb;
    },
    async dispose() {
      // 无进程
    },
    fireExit(info) {
      exitCb?.({ code: info.code, stderrTail: info.stderrTail });
    },
    cancelCount() {
      return cancels;
    },
  };

  return driver;
}

interface Fixture {
  db: DB;
  bus: EventBus;
  lock: ReturnType<typeof createSessionLock>;
  channelId: string;
  botId: string;
  driver: FakeDriver;
  orchestrator: ReturnType<typeof createTurnOrchestrator>;
  close: () => void;
}

function setup(script: FakeDriverOptions["script"], hang = false): Fixture {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 100 });
  const lock = createSessionLock();

  const channelId = "ch_test";
  const botId = "bot_test";
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), NOW);
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, status, created_at, updated_at)
     VALUES (?, '小助', '测试人格', 'local', 'active', ?, ?)`,
  ).run(botId, NOW, NOW);

  const driver = createFakeDriver({ script, hang });
  // 假驱动的 pid 为 null：supervisor 不登记、不杀任何真实进程
  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime: () => ({ runtimeId: "fake", declaration: DECL, driver }),
    idleReapMs: 0,
    killImpl: async () => ({ gone: true }),
    log: () => undefined,
  });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock,
    resolveRuntime: () => ({ runtimeId: "fake", declaration: DECL, driver }),
    supervisor,
  });

  return {
    db,
    bus,
    lock,
    channelId,
    botId,
    driver,
    orchestrator,
    close: () => {
      void orchestrator.dispose();
      void supervisor.dispose();
      db.close();
    },
  };
}

/** 从驱动上下文里读出编排层注入的 turnId / messageId（假驱动用）。 */
function scriptUsingContext(extra: "fatal_error" | "done" | "undeclared" | "none" = "done") {
  return (turn: { turnId: string; messageId: string }): CanonicalEvent[] => {
    const base: CanonicalEvent[] = [
      {
        type: "message_delta",
        turnId: turn.turnId,
        ts: Date.now(),
        payload: { messageId: turn.messageId, phase: "start", text: "" },
      },
      {
        type: "message_delta",
        turnId: turn.turnId,
        ts: Date.now(),
        payload: { messageId: turn.messageId, phase: "delta", text: "你好，我在。" },
      },
    ];
    if (extra === "undeclared") {
      // thought 未在 DECL.eventCapabilities 中声明 → ingest 必须丢弃
      base.push({
        type: "thought",
        turnId: turn.turnId,
        ts: Date.now(),
        payload: { phase: "delta", text: "这段思考不该出现" },
      });
    }
    if (extra === "fatal_error") {
      base.push({
        type: "error",
        turnId: turn.turnId,
        ts: Date.now(),
        payload: { code: "runtime_crashed", message: "运行时挂了", fatal: true },
      });
      return base;
    }
    if (extra === "none") {
      // 不产出任何终态事件（配合 hang：模拟长任务，用于取消测试）
      return base;
    }
    base.push({
      type: "message_delta",
      turnId: turn.turnId,
      ts: Date.now(),
      payload: { messageId: turn.messageId, phase: "end", text: "" },
    });
    base.push({
      type: "done",
      turnId: turn.turnId,
      ts: Date.now(),
      payload: { stopReason: "end", durationMs: 12 },
    });
    return base;
  };
}

describe("最小 Turn · 正常收口", () => {
  it("正文写入 messages.content，消息 done，Session 回 idle", async () => {
    const f = setup(scriptUsingContext("done"));
    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "你好",
    });
    expect(info.queued).toBe(false);

    await waitFor(() => messageStatus(f.db, info.messageId) === "done");

    const msg = getMessage(f.db, info.messageId);
    expect(msg.content).toBe("你好，我在。");
    expect(msg.status).toBe("done");
    expect(sessionStatus(f.db, info.sessionId)).toBe("idle");

    // 用户消息也落库了
    const user = f.db
      .prepare("SELECT content, role FROM messages WHERE turn_id = ? AND role = 'user'")
      .get(info.turnId) as { content: string; role: string };
    expect(user).toEqual({ content: "你好", role: "user" });

    f.close();
  });

  it("SSE 帧的 payload 带 botId（群聊里主持人 ≠ 发言人）", async () => {
    // 注意：ingest 会把 payload 规整成已知字段（botId 不落库），
    // 所以归属在出帧时补（http/dto.ts 的 createBotIdEnricher）。
    // 这里断言的是前端真正拿到的东西。
    const f = setup(scriptUsingContext("done"));
    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "你好",
    });
    await waitFor(() => messageStatus(f.db, info.messageId) === "done");

    const rows = eventsOf(f.db, info.sessionId);
    expect(rows.length).toBeGreaterThan(0);
    const enrich = createBotIdEnricher(f.db);
    for (const row of rows) {
      const payload = enrich(row) as { botId?: string };
      expect(payload.botId).toBe(f.botId);
    }

    // 同一 Session 的归属缓存命中：再问一次不查库也不变
    expect((enrich(rows[0]!) as { botId?: string }).botId).toBe(f.botId);

    f.close();
  });

  it("未声明的事件类型被 ingest 丢弃，不落库（掩码落地，UI 无空块）", async () => {
    const f = setup(scriptUsingContext("undeclared"));
    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "你好",
    });
    await waitFor(() => messageStatus(f.db, info.messageId) === "done");

    const types = (
      f.db
        .prepare("SELECT DISTINCT type FROM events WHERE session_id = ?")
        .all(info.sessionId) as { type: string }[]
    ).map((r) => r.type);
    expect(types).not.toContain("thought");
    expect(types).toContain("message_delta");
    expect(types).toContain("done");

    f.close();
  });

  it("事件先落库再广播：订阅者收到的每一帧都能在库里查到", async () => {
    const f = setup(scriptUsingContext("done"));

    // 先跑一轮把 Session 建出来，再订阅第二轮（订阅要先知道 sessionId）
    const first = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "第一轮",
    });
    await waitFor(() => messageStatus(f.db, first.messageId) === "done");

    const seen: { id: number; type: string }[] = [];
    const off = f.bus.subscribe(first.sessionId, (row) => seen.push({ id: row.id, type: row.type }));

    const second = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "第二轮",
    });
    expect(second.sessionId).toBe(first.sessionId);
    await waitFor(() => messageStatus(f.db, second.messageId) === "done");
    off();

    // 广播顺序与落库顺序一致，且每帧都能在库里查到（先写库再推流）
    expect(seen.map((s) => s.type)).toEqual(["message_delta", "message_delta", "message_delta", "done"]);
    for (const frame of seen) {
      const exists = f.db.prepare("SELECT 1 AS ok FROM events WHERE id = ?").get(frame.id);
      expect(exists).toBeTruthy();
    }
    // id 单调
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.id).toBeGreaterThan(seen[i - 1]!.id);
    }

    f.close();
  });
});

describe("最小 Turn · 崩溃与取消", () => {
  it("fatal error → 消息 failed、Session crashed、错误事件落库", async () => {
    const f = setup(scriptUsingContext("fatal_error"));
    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "你好",
    });
    await waitFor(() => messageStatus(f.db, info.messageId) === "failed");

    expect(sessionStatus(f.db, info.sessionId)).toBe("crashed");
    const errorRows = f.db
      .prepare("SELECT payload FROM events WHERE type = 'error' AND session_id = ?")
      .all(info.sessionId) as { payload: string }[];
    expect(errorRows.length).toBeGreaterThan(0);
    expect(JSON.parse(errorRows[0]!.payload)).toMatchObject({ code: "runtime_crashed", fatal: true });

    f.close();
  });

  it("取消：已生成内容保留，消息标 interrupted，done 的 stopReason 是 cancelled", async () => {
    const f = setup(scriptUsingContext("none"), true);
    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "长任务",
    });
    // 等驱动真正开始 prompt（有正文进来）
    await waitFor(() => getMessage(f.db, info.messageId).content.length > 0);

    const ok = await f.orchestrator.cancel(info.sessionId, info.turnId);
    expect(ok).toBe(true);
    expect(f.driver.cancelCount()).toBe(1);

    await waitFor(() => messageStatus(f.db, info.messageId) === "interrupted");
    expect(getMessage(f.db, info.messageId).content).toBe("你好，我在。");

    f.close();
  });

  it("取消已结束的轮次返回 false（路由层据此回 409，不谎称已中断）", async () => {
    const f = setup(scriptUsingContext("done"));
    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "你好",
    });
    await waitFor(() => messageStatus(f.db, info.messageId) === "done");
    expect(await f.orchestrator.cancel(info.sessionId, info.turnId)).toBe(false);
    f.close();
  });
});

describe("最小 Turn · 会话锁（P0-15 双标签页）", () => {
  it("同一 Session 第二个请求返回 queued + position，不并发执行", async () => {
    const f = setup(scriptUsingContext("none"), true);

    const first = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "第一条",
    });
    expect(first.queued).toBe(false);

    // 同一 Bot 同一渠道 → 复用同一 Session，锁被占
    const second = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "第二条",
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.queued).toBe(true);
    expect(second.position).toBe(1);

    // 取消排队中的那条：不应去 cancel 正在跑的进程
    const before = f.driver.cancelCount();
    expect(await f.orchestrator.cancel(second.sessionId, second.turnId)).toBe(true);
    expect(f.driver.cancelCount()).toBe(before);
    expect(messageStatus(f.db, second.messageId)).toBe("interrupted");

    await f.orchestrator.cancel(first.sessionId, first.turnId);
    f.close();
  });

  it("前一轮结束后排队的 Turn 自动放行", async () => {
    const f = setup(scriptUsingContext("done"));

    const first = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "第一条",
    });
    const second = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "第二条",
    });
    expect(second.queued).toBe(true);

    await waitFor(() => messageStatus(f.db, second.messageId) === "done");
    expect(getMessage(f.db, second.messageId).content).toBe("你好，我在。");

    f.close();
  });
});

describe("最小 Turn · 未绑定运行时", () => {
  it("Bot 未绑运行时 → 抛 runtime_not_bound（HTTP 层转 409）", async () => {
    const f = setup(scriptUsingContext("done"));
    const orchestrator = createTurnOrchestrator({
      db: f.db,
      bus: f.bus,
      lock: f.lock,
      resolveRuntime: () => null,
      supervisor: createSupervisor({
        db: f.db,
        resolveRuntime: () => null,
        idleReapMs: 0,
        killImpl: async () => ({ gone: true }),
        log: () => undefined,
      }),
    });
    await expect(
      orchestrator.start({ channelId: f.channelId, botId: f.botId, text: "你好" }),
    ).rejects.toThrow(/未绑定/);
    f.close();
  });
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function getMessage(db: DB, id: string): { content: string; status: string } {
  const row = db.prepare("SELECT content, status FROM messages WHERE id = ?").get(id) as
    | { content: string; status: string }
    | undefined;
  return row ?? { content: "", status: "missing" };
}

function messageStatus(db: DB, id: string): string {
  return getMessage(db, id).status;
}

function eventsOf(db: DB, sessionId: string): EventRow[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as {
    id: number;
    session_id: string;
    message_id: string | null;
    turn_id: string;
    type: string;
    seq: number;
    payload: string;
    raw: string | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    messageId: r.message_id,
    turnId: r.turn_id,
    type: r.type as EventRow["type"],
    seq: r.seq,
    payload: JSON.parse(r.payload) as EventRow["payload"],
    raw: r.raw === null ? null : (JSON.parse(r.raw) as unknown),
    createdAt: r.created_at,
  }));
}

function sessionStatus(db: DB, id: string): string {
  const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? "missing";
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}
