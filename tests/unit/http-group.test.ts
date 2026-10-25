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
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * 群聊 HTTP 端到端（M10 / P0-06）。
 *
 * 验的是「前端拿到什么」：`POST /api/messages` 在群聊里必须回名单，
 * 且只有名单里的 Bot 产生 assistant 消息 —— 这正是 PRD 的验收口径
 * （「查 messages 表里 assistant 消息数」）。
 */

const NOW = Date.now();
let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-group-http-"));
});
afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄占用
  }
});

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake-group-http",
  displayName: "Fake Group HTTP",
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

interface BotDriver extends ChannelDriver {
  calls: number;
}

function createBotDriver(botId: string, reply: string): BotDriver {
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  const handle: SessionHandle = { sessionId: `s_${botId}`, pid: null, runtimeSessionId: `rt_${botId}` };
  return {
    protocol: "cli-stdio",
    calls: 0,
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
    async prompt(h) {
      // this 在对象字面量方法里不可靠，用闭包计数（见下方 wrapper）
      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? "turn_x";
      const messageId = ctx?.messageId ?? "msg_x";
      const emit = (e: CanonicalEvent): void => eventCb?.(e);
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "delta", text: reply },
      });
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "end", text: "" },
      });
      emit({ type: "done", turnId, ts: Date.now(), payload: { stopReason: "end", durationMs: 3 } });
    },
    async cancel() {
      /* 无进程 */
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
      /* 无进程 */
    },
  };
}

interface Ctx {
  app: FastifyInstance;
  base: string;
  db: DB;
  channelId: string;
  calls: Map<string, number>;
  close: () => Promise<void>;
}

async function boot(opts: {
  hostReply: string;
  participants: string[];
  hostId?: string;
  /** 这些 Bot 的运行时不可用（resolveRuntime 返回 null）。 */
  unavailable?: string[];
}): Promise<Ctx> {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const channelId = "ch_group_http";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'group', '研究小组', ?, ?, ?)`,
  ).run(
    channelId,
    JSON.stringify(opts.participants),
    opts.hostId === undefined ? (opts.participants[0] ?? null) : opts.hostId,
    NOW,
  );

  const calls = new Map<string, number>();
  const drivers = new Map<string, BotDriver>();
  for (const id of opts.participants) {
    db.prepare(
      `INSERT INTO bots (id, name, persona, default_runtime_id, execution_location, repo_path, status,
                         allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
       VALUES (?, ?, 'p', NULL, 'local', ?, 'active', '[]', 0, 0, 0, ?, ?)`,
    ).run(id, `Bot-${id}`, workDir, NOW, NOW);
    const driver = createBotDriver(id, id === (opts.hostId ?? opts.participants[0]) ? opts.hostReply : `${id} 的回复`);
    calls.set(id, 0);
    // 计数包装：prompt 次数就是「运行时调用次数」
    const originalPrompt = driver.prompt.bind(driver);
    driver.prompt = async (h, input) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      await originalPrompt(h, input);
    };
    drivers.set(id, driver);
  }

  const resolveRuntime = (botId: string) => {
    if (opts.unavailable?.includes(botId)) return null;
    const driver = drivers.get(botId);
    return driver ? { runtimeId: `rt_${botId}`, declaration: DECL, driver } : null;
  };

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
    isSessionAlive: () => true,
    sessionCwdOf: () => workDir,
    respond: async () => true,
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
  const assignments = createAssignmentRunner({
    db,
    orchestrator,
    isRuntimeAvailable: (id) => resolveRuntime(id) !== null,
    log: () => undefined,
  });

  const app = buildServer(
    {
      db,
      runtimes: [],
      schemaVersion: 1,
      startedAt: NOW,
      resolveRuntime,
      orchestrator,
      permissions,
      assignments,
      groupDecisionTimeoutMs: 5000,
    },
    { authEnabled: false, webRoot: join(workDir, "no-web") },
  );
  const base = await listenEphemeral(app);

  return {
    app,
    base,
    db,
    channelId,
    calls,
    close: async () => {
      assignments.stop();
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      db.close();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 按 Bot 统计 assistant 消息数（主持人那一轮也有一条，所以要看归属）。 */
function assistantByBot(db: DB, channelId: string): { bot_id: string; n: number }[] {
  return db
    .prepare(
      `SELECT s.bot_id, COUNT(*) AS n FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE m.channel_id = ? AND m.role = 'assistant'
        GROUP BY s.bot_id ORDER BY s.bot_id`,
    )
    .all(channelId) as { bot_id: string; n: number }[];
}

describe("HTTP · 群聊派发", () => {
  it("主持人点 2 个：响应带名单，只有这 2 个产生 assistant 消息（未被点名的 0 调用）", async () => {
    const ctx = await boot({
      participants: ["bot_a", "bot_b", "bot_c"],
      hostReply: JSON.stringify({
        speakers: [
          { botId: "bot_b", reason: "会写代码" },
          { botId: "bot_c", reason: "能审查" },
        ],
      }),
    });

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, text: "帮我修个 bug 并审一下" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      speakers: { botId: string; reason: string }[];
      calls: number;
      skipReason: string | null;
      degraded: string;
      sessionId: string;
    };
    expect(body.speakers.map((s) => s.botId)).toEqual(["bot_b", "bot_c"]);
    expect(body.calls).toBe(2);
    expect(body.degraded).toBe("none");

    // 派发是后台跑的：等两个发言人真正跑完（主持人那一轮也会产出一条 assistant 消息，
    // 所以不能只数总数 —— 要等发言人的调用计数落地）
    await waitFor(() => (ctx.calls.get("bot_b") ?? 0) === 1 && (ctx.calls.get("bot_c") ?? 0) === 1);
    await waitFor(() => assistantByBot(ctx.db, ctx.channelId).length >= 3);

    // 运行时调用计数：主持人 1 次 + 两个发言人各 1 次；bot_a 只作为主持人被调过
    expect(ctx.calls.get("bot_a")).toBe(1);
    expect(ctx.calls.get("bot_b")).toBe(1);
    expect(ctx.calls.get("bot_c")).toBe(1);

    // assistant 消息按 Bot 归属：主持人 1 条（决策输出），b/c 各 1 条
    expect(assistantByBot(ctx.db, ctx.channelId)).toEqual([
      { bot_id: "bot_a", n: 1 },
      { bot_id: "bot_b", n: 1 },
      { bot_id: "bot_c", n: 1 },
    ]);

    // 用户消息只落一条（3 个 Turn 共用同一条用户输入，不能出现 3 个一样的用户气泡）
    const userCount = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND role = 'user'")
      .get(ctx.channelId) as { n: number };
    expect(userCount.n).toBe(1);

    await ctx.close();
  }, 20000);

  it("用户 @ bot_c：必被包含且排在名单第一位", async () => {
    const ctx = await boot({
      participants: ["bot_a", "bot_b", "bot_c"],
      // 主持人只点了 b，但用户 @ 了 c
      hostReply: JSON.stringify({ speakers: [{ botId: "bot_b", reason: "合适" }] }),
    });

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: ctx.channelId,
        text: "让 C 看看",
        mentionBotIds: ["bot_c"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { speakers: { botId: string; reason: string }[] };
    expect(body.speakers[0]?.botId).toBe("bot_c");
    expect(body.speakers[0]?.reason).toBe("用户点名");
    expect(body.speakers.map((s) => s.botId)).toEqual(["bot_c", "bot_b"]);

    await waitFor(() => (ctx.calls.get("bot_c") ?? 0) === 1 && (ctx.calls.get("bot_b") ?? 0) === 1);
    expect(ctx.calls.get("bot_c")).toBe(1);
    expect(ctx.calls.get("bot_b")).toBe(1);
    await ctx.close();
  }, 20000);

  it("主持人返回空名单：speakers 为空 + skipReason，一个 Bot 都不调用", async () => {
    const ctx = await boot({
      participants: ["bot_a", "bot_b"],
      hostReply: JSON.stringify({ speakers: [], skipReason: "问题不明确" }),
    });

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, text: "嗯" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { speakers: unknown[]; skipReason: string; calls: number };
    expect(body.speakers).toEqual([]);
    expect(body.skipReason).toBe("问题不明确");
    expect(body.calls).toBe(0);

    // 等一小会儿，确认没有任何发言人产生 assistant 消息（主持人那一轮自己有 1 条）
    await new Promise((r) => setTimeout(r, 300));
    const byBot = assistantByBot(ctx.db, ctx.channelId);
    expect(byBot).toEqual([{ bot_id: "bot_a", n: 1 }]);
    expect(ctx.calls.get("bot_a")).toBe(1); // 只有主持人那一轮
    expect(ctx.calls.get("bot_b")).toBe(0);
    await ctx.close();
  }, 20000);

  it("主持人返回 5 个：截到 3，调用数 ≤3", async () => {
    const ctx = await boot({
      participants: ["bot_a", "bot_b", "bot_c", "bot_d", "bot_e", "bot_f"],
      hostReply: JSON.stringify({
        speakers: [
          { botId: "bot_b" },
          { botId: "bot_c" },
          { botId: "bot_d" },
          { botId: "bot_e" },
          { botId: "bot_f" },
        ],
      }),
    });

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, text: "全员上" }),
    });
    const body = (await res.json()) as { speakers: { botId: string }[]; calls: number };
    expect(body.speakers).toHaveLength(3);
    expect(body.calls).toBe(3);

    await waitFor(() => assistantByBot(ctx.db, ctx.channelId).length >= 4);
    expect(ctx.calls.get("bot_e")).toBe(0);
    expect(ctx.calls.get("bot_f")).toBe(0);
    await ctx.close();
  }, 20000);

  it("主持人返回不存在的 Bot：丢弃该项，群内出现系统提示", async () => {
    const ctx = await boot({
      participants: ["bot_a", "bot_b"],
      hostReply: JSON.stringify({
        speakers: [{ botId: "bot_ghost", reason: "不存在" }, { botId: "bot_b", reason: "存在" }],
      }),
    });

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, text: "找个不存在的" }),
    });
    const body = (await res.json()) as {
      speakers: { botId: string }[];
      notice: string | null;
      warnings: string[];
    };
    expect(body.speakers.map((s) => s.botId)).toEqual(["bot_b"]);
    expect(body.notice).toContain("bot_ghost");

    // 系统提示落在会话流里（role=system）
    await waitFor(() => {
      const row = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND role = 'system'")
        .get(ctx.channelId) as { n: number };
      return row.n > 0;
    });
    await ctx.close();
  }, 20000);

  it("主持人不可用：降级为 @ 谁谁回，群内提示可见", async () => {
    const ctx = await boot({
      participants: ["bot_a", "bot_b", "bot_c"],
      hostReply: "{}",
      unavailable: ["bot_a"],
    });

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, text: "主持人在吗", mentionBotIds: ["bot_b"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      speakers: { botId: string }[];
      degraded: string;
      notice: string | null;
    };
    expect(body.degraded).toBe("host_unavailable");
    expect(body.notice).toContain("@ 谁谁回");
    expect(body.speakers.map((s) => s.botId)).toEqual(["bot_b"]);
    // 主持人一次都没被调用（不可用就直接降级，不发起 Turn）
    expect(ctx.calls.get("bot_a")).toBe(0);

    await waitFor(() => (ctx.calls.get("bot_b") ?? 0) === 1);
    expect(ctx.calls.get("bot_b")).toBe(1);
    expect(ctx.calls.get("bot_c")).toBe(0);

    // 系统提示落在会话流里
    const notice = ctx.db
      .prepare("SELECT content FROM messages WHERE channel_id = ? AND role = 'system'")
      .all(ctx.channelId) as { content: string }[];
    expect(notice.some((n) => n.content.includes("@ 谁谁回"))).toBe(true);
    await ctx.close();
  }, 20000);
});
