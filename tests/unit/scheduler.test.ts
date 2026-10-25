import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import { createAssignmentRunner } from "../../src/server/core/assignment/runner.js";
import { buildServer } from "../../src/server/http/server.js";
import {
  createSchedule,
  createScheduler,
  getScheduleRow,
  toScheduleDto,
  type Scheduler,
} from "../../src/server/core/scheduling/scheduler.js";
import {
  computeNextRun,
  nextDailyAt,
  parseAtTime,
  validateTrigger,
} from "../../src/server/core/scheduling/triggers.js";
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import { listenEphemeral } from "./http-listen.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * 定时任务（M12 / P0-11）。
 *
 * 断言的是 PRD 的六句边界处理：
 *   ① 三种触发方式的下次时间；
 *   ② 周期最小间隔 5 分钟（更小拒绝保存）；
 *   ③ 服务未运行错过触发 → 启动补跑 **1 次**并标「补跑」，不重复补跑；
 *   ④ 周期连续失败 3 次 → 自动暂停并显示原因；
 *   ⑤ 一次性任务执行后置「已完成」并保留记录；
 *   ⑥ 结果落进原会话（system 消息），权限走 hold（source='schedule'）。
 *
 * 时间不 mock：补跑用「把 next_run_at 写到过去」制造，比假时钟更贴近真实恢复路径。
 */

const NOW = Date.now();
let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-sch-"));
});
afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄占用
  }
});

// ---------------------------------------------------------------------------
// ① 触发时间计算（纯函数）
// ---------------------------------------------------------------------------

describe("触发时间计算", () => {
  it("一次性延迟：now + N 分钟", () => {
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime();
    expect(computeNextRun({ triggerType: "once", delayMinutes: 30 }, from)).toBe(
      from + 30 * 60_000,
    );
  });

  it("周期：now + N 分钟", () => {
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime();
    expect(computeNextRun({ triggerType: "interval", intervalMinutes: 15 }, from)).toBe(
      from + 15 * 60_000,
    );
  });

  it("每日 HH:MM：今天没过就今天，过了就明天（本地时区）", () => {
    const morning = new Date(2026, 0, 15, 8, 0, 0).getTime();
    const at9 = computeNextRun({ triggerType: "daily", atTime: "09:00" }, morning);
    expect(at9).not.toBeNull();
    expect(new Date(at9 as number).getDate()).toBe(15);
    expect(new Date(at9 as number).getHours()).toBe(9);

    const evening = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const next9 = computeNextRun({ triggerType: "daily", atTime: "09:00" }, evening);
    expect(next9).not.toBeNull();
    expect(new Date(next9 as number).getDate()).toBe(16);
    expect(new Date(next9 as number).getHours()).toBe(9);
  });

  it("每日 HH:MM：正好是当前分钟 → 推到明天（严格晚于 from）", () => {
    const exactly = new Date(2026, 0, 15, 9, 0, 0).getTime();
    const next = nextDailyAt("09:00", exactly);
    expect(next).toBeGreaterThan(exactly);
    expect(new Date(next).getDate()).toBe(16);
  });

  it("HH:MM 解析：合法与非法", () => {
    expect(parseAtTime("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseAtTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseAtTime("24:00")).toBeNull();
    expect(parseAtTime("9:00")).toBeNull(); // 必须两位
    expect(parseAtTime("09:60")).toBeNull();
    expect(parseAtTime("abc")).toBeNull();
  });
});

describe("触发参数校验（保存时）", () => {
  it("周期 5 分钟 → 通过（正好等于下限）", () => {
    expect(validateTrigger({ triggerType: "interval", intervalMinutes: 5 }).ok).toBe(true);
  });

  it("周期 4 分钟 → 拒绝，并说明最小间隔", () => {
    const r = validateTrigger({ triggerType: "interval", intervalMinutes: 4 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("interval_too_small");
    expect(r.message).toContain("5 分钟");
  });

  it("一次性延迟必须 ≥1 整数分钟；超过一年拒绝", () => {
    expect(validateTrigger({ triggerType: "once", delayMinutes: 1 }).ok).toBe(true);
    expect(validateTrigger({ triggerType: "once", delayMinutes: 0 }).ok).toBe(false);
    expect(validateTrigger({ triggerType: "once", delayMinutes: 1.5 }).ok).toBe(false);
    expect(validateTrigger({ triggerType: "once", delayMinutes: 999_999 }).code).toBe(
      "delay_too_large",
    );
  });

  it("每日时间格式非法 → 拒绝", () => {
    expect(validateTrigger({ triggerType: "daily", atTime: "25:00" }).ok).toBe(false);
    expect(validateTrigger({ triggerType: "daily", atTime: "09:00" }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake-sch",
  displayName: "Fake Sch",
  protocol: "cli-stdio",
  launch: { command: "fake", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: true,
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

interface Fixture {
  db: DB;
  scheduler: Scheduler;
  orchestrator: ReturnType<typeof createTurnOrchestrator>;
  channelId: string;
  botId: string;
  /** 每次 prompt 的文本（断言任务内容被真正发给运行时）。 */
  prompts: string[];
  /** 控制下一次 prompt 的结果。 */
  setMode(mode: "done" | "fail"): void;
  close: () => Promise<void>;
}

function createDriver(state: { mode: "done" | "fail"; prompts: string[] }): ChannelDriver {
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  const handle: SessionHandle = { sessionId: "s", pid: null, runtimeSessionId: "rt" };
  return {
    protocol: "cli-stdio",
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
      return { runtimeSessionId: "rt" };
    },
    async resumeSession() {
      return { ok: false, reason: "测试不支持" };
    },
    async prompt(h, input) {
      state.prompts.push(input.text);
      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? "turn_x";
      const messageId = ctx?.messageId ?? "msg_x";
      if (state.mode === "fail") {
        eventCb?.({
          type: "error",
          turnId,
          ts: Date.now(),
          payload: { code: "boom", message: "运行时失败", fatal: true },
        } as CanonicalEvent);
        return;
      }
      eventCb?.({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "delta", text: "本周竞品动态：A 发布了新版。" },
      } as CanonicalEvent);
      eventCb?.({
        type: "done",
        turnId,
        ts: Date.now(),
        payload: { stopReason: "end", durationMs: 5 },
      } as CanonicalEvent);
    },
    async cancel() {
      /* 不涉及 */
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
      /* 不涉及 */
    },
  };
}

async function setup(): Promise<Fixture> {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const channelId = "ch_sch";
  const botId = "bot_sch";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '研究助手', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), NOW);
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, status, created_at, updated_at)
     VALUES (?, '研究助手', '做竞品研究', 'local', 'active', ?, ?)`,
  ).run(botId, NOW, NOW);

  const state = { mode: "done" as "done" | "fail", prompts: [] as string[] };
  const driver = createDriver(state);
  const resolveRuntime = () => ({ runtimeId: "rt_sch", declaration: DECL, driver });

  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime,
    idleReapMs: 0,
    killImpl: async () => ({ gone: true }),
    log: () => undefined,
  });
  const permissions = createPermissionResolver({
    db,
    bus,
    isSessionAlive: (sid) => supervisor.isAlive(sid),
    sessionCwdOf: () => workDir,
    respond: () => Promise.resolve(true),
    setHeld: () => undefined,
    setSessionStatus: () => undefined,
    log: () => undefined,
  });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock: createSessionLock(),
    resolveRuntime,
    supervisor,
  });
  const scheduler = createScheduler({
    db,
    orchestrator,
    isRuntimeAvailable: () => true,
    log: () => undefined,
  });

  return {
    db,
    scheduler,
    orchestrator,
    channelId,
    botId,
    prompts: state.prompts,
    setMode(mode) {
      state.mode = mode;
    },
    close: async () => {
      scheduler.stop();
      await orchestrator.dispose();
      await supervisor.dispose();
      permissions.dispose();
      db.close();
    },
  };
}

function addSchedule(
  f: Fixture,
  overrides: Partial<{
    name: string;
    triggerType: "once" | "interval" | "daily";
    delayMinutes: number;
    intervalMinutes: number;
    atTime: string;
    nextRunAt: number | null;
    failCount: number;
    enabled: number;
  }> = {},
): string {
  const id = `sch_test_${Math.random().toString(36).slice(2, 8)}`;
  f.db
    .prepare(
      `INSERT INTO schedules
         (id, name, bot_id, channel_id, prompt, trigger_type, interval_minutes, delay_minutes,
          at_time, next_run_at, last_result, last_run_at, fail_count, enabled, created_at)
       VALUES (?, ?, ?, ?, '整理本周竞品动态', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.name ?? "竞品周报",
      f.botId,
      f.channelId,
      overrides.triggerType ?? "once",
      overrides.intervalMinutes ?? null,
      overrides.delayMinutes ?? 1,
      overrides.atTime ?? null,
      overrides.nextRunAt === undefined ? NOW + 60_000 : overrides.nextRunAt,
      overrides.failCount ?? 0,
      overrides.enabled ?? 1,
      NOW,
    );
  return id;
}

function systemNotices(db: DB, channelId: string): string[] {
  const rows = db
    .prepare(
      `SELECT content FROM messages
        WHERE channel_id = ? AND role = 'system' ORDER BY created_at ASC`,
    )
    .all(channelId) as { content: string }[];
  return rows.map((r) => r.content);
}

// ---------------------------------------------------------------------------
// ② 创建校验
// ---------------------------------------------------------------------------

describe("创建定时任务", () => {
  it("周期 3 分钟 → 拒绝（interval_too_small），不落库", async () => {
    const f = await setup();
    const result = createSchedule(
      f.db,
      {
        name: "太密",
        botId: f.botId,
        channelId: f.channelId,
        prompt: "看竞品",
        triggerType: "interval",
        intervalMinutes: 3,
      },
      { minIntervalMinutes: 5 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("interval_too_small");
      expect(result.message).toContain("5 分钟");
    }
    const count = f.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
    expect(count.n).toBe(0);
    await f.close();
  });

  it("合法周期 5 分钟 → 落库并算好下次触发", async () => {
    const f = await setup();
    const at = NOW;
    const result = createSchedule(
      f.db,
      {
        name: "竞品扫描",
        botId: f.botId,
        channelId: f.channelId,
        prompt: "看竞品",
        triggerType: "interval",
        intervalMinutes: 5,
      },
      { minIntervalMinutes: 5, now: at },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.next_run_at).toBe(at + 5 * 60_000);
      expect(result.schedule.enabled).toBe(1);
    }
    await f.close();
  });

  it("目标 Bot 不在会话里 → 拒绝（结果无处回贴）", async () => {
    const f = await setup();
    f.db.prepare("UPDATE channels SET participant_bot_ids = '[]' WHERE id = ?").run(f.channelId);
    const result = createSchedule(
      f.db,
      {
        name: "x",
        botId: f.botId,
        channelId: f.channelId,
        prompt: "y",
        triggerType: "once",
        delayMinutes: 1,
      },
      { minIntervalMinutes: 5 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bot_not_in_channel");
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// ③ 执行与回贴
// ---------------------------------------------------------------------------

describe("到点执行", () => {
  it("触发 → 系统块 + Bot 的真实 Turn；结果落进原会话（不造假 Turn）", async () => {
    const f = await setup();
    const id = addSchedule(f, { triggerType: "once", delayMinutes: 1, nextRunAt: NOW - 1 });

    const started = await f.scheduler.runDue();
    expect(started).toBe(1);
    await f.scheduler.drain();

    // 任务内容真的发给了运行时
    expect(f.prompts).toContain("整理本周竞品动态");

    const notices = systemNotices(f.db, f.channelId);
    expect(notices.some((n) => n.includes("定时任务「竞品周报」触发") && n.includes("研究助手"))).toBe(true);
    expect(notices.some((n) => n.includes("完成"))).toBe(true);

    // assistant 消息（真实 Turn）落在同一渠道
    const assistant = f.db
      .prepare("SELECT content, status FROM messages WHERE channel_id = ? AND role = 'assistant'")
      .all(f.channelId) as { content: string; status: string }[];
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toContain("竞品动态");
    expect(assistant[0]?.status).toBe("done");

    const row = getScheduleRow(f.db, id);
    expect(row?.last_result).toContain("成功");
    expect(row?.fail_count).toBe(0);
    await f.close();
  });

  it("一次性任务执行后置「已完成」并保留记录（不删行）", async () => {
    const f = await setup();
    const id = addSchedule(f, { triggerType: "once", delayMinutes: 1, nextRunAt: NOW - 1 });
    await f.scheduler.runDue();
    await f.scheduler.drain();

    const row = getScheduleRow(f.db, id);
    expect(row).not.toBeNull();
    expect(row?.next_run_at).toBeNull();
    expect(row?.enabled).toBe(0);

    const dto = toScheduleDto(f.db, row!);
    expect(dto.status).toBe("completed");
    await f.close();
  });

  it("一次性任务「已认领但还在跑」→ 状态是 active，不是 paused", async () => {
    const f = await setup();
    // 模拟 claim 之后的中间态：next_run_at 已置空、还没有结果
    const id = addSchedule(f, { triggerType: "once", delayMinutes: 1, nextRunAt: null, enabled: 0 });
    const row = getScheduleRow(f.db, id)!;
    expect(row.last_result).toBeNull();
    expect(toScheduleDto(f.db, row).status).toBe("active");
    await f.close();
  });

  it("权限来源是 schedule（走 hold 档，不是 interactive）", async () => {
    const f = await setup();
    // 拦截 orchestrator.start 的入参：source 必须显式传 schedule
    let seenSource: string | null = null;
    const orig = f.orchestrator.start.bind(f.orchestrator);
    (f.orchestrator as unknown as { start: typeof orig }).start = async (input) => {
      seenSource = input.source ?? null;
      return orig(input);
    };
    addSchedule(f, { triggerType: "once", delayMinutes: 1, nextRunAt: NOW - 1 });
    await f.scheduler.runDue();
    await f.scheduler.drain();
    expect(seenSource).toBe("schedule");
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// ④ 补跑：只 1 次
// ---------------------------------------------------------------------------

describe("服务未运行错过触发 → 补跑 1 次", () => {
  it("启动补跑一次并标「补跑」；再启动不重复补跑", async () => {
    const f = await setup();
    // 服务「当时没跑」：next_run_at 已经是过去
    const id = addSchedule(f, { triggerType: "interval", intervalMinutes: 5, nextRunAt: NOW - 10 * 60_000 });

    f.scheduler.start();
    await f.scheduler.drain();

    const notices = systemNotices(f.db, f.channelId);
    expect(notices.filter((n) => n.includes("补跑")).length).toBeGreaterThanOrEqual(1);
    expect(notices.some((n) => n.includes("定时任务「竞品周报」补跑"))).toBe(true);

    const afterFirst = getScheduleRow(f.db, id);
    expect(afterFirst?.last_result).toContain("补跑");
    // 下次触发已推进到未来（不是还停在过去）
    expect(afterFirst?.next_run_at ?? 0).toBeGreaterThan(NOW);

    const runsAfterFirst = systemNotices(f.db, f.channelId).filter((n) => n.includes("补跑")).length;

    // 再次启动（模拟第二次重启）：不应再补跑
    f.scheduler.stop();
    f.scheduler.start();
    await f.scheduler.drain();
    const runsAfterSecond = systemNotices(f.db, f.channelId).filter((n) => n.includes("补跑")).length;
    expect(runsAfterSecond).toBe(runsAfterFirst);

    // 再显式跑一次到期检查也不动它
    await f.scheduler.runDue({ catchup: true });
    await f.scheduler.drain();
    expect(systemNotices(f.db, f.channelId).filter((n) => n.includes("补跑")).length).toBe(
      runsAfterFirst,
    );
    await f.close();
  });

  it("没有过期任务时启动不执行任何东西", async () => {
    const f = await setup();
    addSchedule(f, { triggerType: "interval", intervalMinutes: 5, nextRunAt: NOW + 5 * 60_000 });
    f.scheduler.start();
    await f.scheduler.drain();
    expect(systemNotices(f.db, f.channelId)).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// ⑤ 连续失败 3 次 → 自动暂停
// ---------------------------------------------------------------------------

describe("周期任务连续失败 3 次 → 自动暂停", () => {
  it("前两次继续，第三次把 enabled 置 0 并写明原因", async () => {
    const f = await setup();
    const id = addSchedule(f, {
      triggerType: "interval",
      intervalMinutes: 5,
      nextRunAt: NOW - 1,
    });
    f.setMode("fail");

    // 第 1 次
    f.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(NOW - 1, id);
    await f.scheduler.runDue();
    await f.scheduler.drain();
    let row = getScheduleRow(f.db, id);
    expect(row?.fail_count).toBe(1);
    expect(row?.enabled).toBe(1);

    // 第 2 次
    f.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(NOW - 1, id);
    await f.scheduler.runDue();
    await f.scheduler.drain();
    row = getScheduleRow(f.db, id);
    expect(row?.fail_count).toBe(2);
    expect(row?.enabled).toBe(1);

    // 第 3 次 → 自动暂停
    f.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(NOW - 1, id);
    await f.scheduler.runDue();
    await f.scheduler.drain();
    row = getScheduleRow(f.db, id);
    expect(row?.fail_count).toBe(3);
    expect(row?.enabled).toBe(0);
    expect(row?.last_result).toContain("自动暂停");

    const dto = toScheduleDto(f.db, row!);
    expect(dto.status).toBe("paused");
    expect(dto.autoPaused).toBe(true);
    await f.close();
  });

  it("成功一次会把 fail_count 清零（不累计历史失败）", async () => {
    const f = await setup();
    const id = addSchedule(f, { triggerType: "interval", intervalMinutes: 5, nextRunAt: NOW - 1, failCount: 2 });

    f.setMode("done");
    await f.scheduler.runDue();
    await f.scheduler.drain();
    const row = getScheduleRow(f.db, id);
    expect(row?.fail_count).toBe(0);
    expect(row?.enabled).toBe(1);
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// ⑥ REST
// ---------------------------------------------------------------------------

describe("REST /api/schedules", () => {
  interface HttpCtx {
    app: FastifyInstance;
    base: string;
    db: DB;
    scheduler: Scheduler;
    channelId: string;
    botId: string;
    close: () => Promise<void>;
  }

  async function bootHttp(): Promise<HttpCtx> {
    const f = await setup();
    const app = buildServer(
      {
        db: f.db,
        runtimes: [],
        schemaVersion: 1,
        startedAt: NOW,
        resolveRuntime: () => null,
        orchestrator: f.orchestrator,
        permissions: createPermissionResolver({
          db: f.db,
          isSessionAlive: () => false,
          sessionCwdOf: () => workDir,
          respond: () => Promise.resolve(true),
          setHeld: () => undefined,
          setSessionStatus: () => undefined,
          log: () => undefined,
        }),
        assignments: createAssignmentRunner({
          db: f.db,
          orchestrator: f.orchestrator,
          isRuntimeAvailable: () => true,
          log: () => undefined,
        }),
        scheduler: f.scheduler,
      },
      { authEnabled: false, webRoot: join(workDir, "no-web") },
    );
    const base = await listenEphemeral(app);
    return {
      app,
      base,
      db: f.db,
      scheduler: f.scheduler,
      channelId: f.channelId,
      botId: f.botId,
      close: async () => {
        await app.close();
        await f.close();
      },
    };
  }

  it("POST 周期 2 分钟 → 400 interval_too_small", async () => {
    const c = await bootHttp();
    const res = await fetch(`${c.base}/api/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "太密",
        botId: c.botId,
        channelId: c.channelId,
        prompt: "看竞品",
        triggerType: "interval",
        intervalMinutes: 2,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("interval_too_small");
    expect(body.message).toContain("5 分钟");
    await c.close();
  });

  it("POST → 201；GET 列表含下次触发与上次结果；PATCH 暂停/恢复；DELETE", async () => {
    const c = await bootHttp();
    const created = await fetch(`${c.base}/api/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "竞品周报",
        botId: c.botId,
        channelId: c.channelId,
        prompt: "整理本周竞品动态",
        triggerType: "daily",
        atTime: "09:00",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      schedule: { id: string; nextRunAt: number; status: string; trigger: string };
    };
    const id = createdBody.schedule.id;
    expect(createdBody.schedule.nextRunAt).toBeGreaterThan(Date.now());
    expect(createdBody.schedule.status).toBe("active");
    expect(createdBody.schedule.trigger).toContain("每日 09:00");

    const list = (await (await fetch(`${c.base}/api/schedules`)).json()) as {
      schedules: { id: string; nextRunAt: number | null; lastResult: string | null }[];
      schedulerRunning: boolean;
      minIntervalMinutes: number;
    };
    expect(list.schedules).toHaveLength(1);
    expect(list.minIntervalMinutes).toBe(5);
    expect(list.schedulerRunning).toBe(false); // 本测试没 start 调度器

    // 暂停 → nextRunAt 清空
    const paused = await fetch(`${c.base}/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as {
      schedule: { enabled: boolean; nextRunAt: number | null; status: string };
    };
    expect(pausedBody.schedule.enabled).toBe(false);
    expect(pausedBody.schedule.nextRunAt).toBeNull();
    expect(pausedBody.schedule.status).toBe("paused");

    // 恢复 → 重算下次触发 + 清失败计数
    const resumed = await fetch(`${c.base}/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, name: "竞品周报（改）" }),
    });
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as {
      schedule: { name: string; enabled: boolean; nextRunAt: number | null; failCount: number };
    };
    expect(resumedBody.schedule.name).toBe("竞品周报（改）");
    expect(resumedBody.schedule.enabled).toBe(true);
    expect(resumedBody.schedule.nextRunAt).toBeGreaterThan(Date.now());
    expect(resumedBody.schedule.failCount).toBe(0);

    // 删除
    const del = await fetch(`${c.base}/api/schedules/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const after = (await (await fetch(`${c.base}/api/schedules`)).json()) as { schedules: unknown[] };
    expect(after.schedules).toHaveLength(0);

    // 已删除再删 → 404
    const again = await fetch(`${c.base}/api/schedules/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    await c.close();
  });
});
