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
import * as eventsRepo from "../../src/server/core/repo/events.js";
import { buildServer } from "../../src/server/http/server.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * critic 阻断项补齐后的端点契约（P0-01 / P0-03 / P0-04 / P0-05）。
 *
 * 走真 HTTP（真 socket）而不是直接调 handler：这五个端点的失败模式几乎都在
 * 序列化与状态码上（`already_exists` 的 `existingId`、`name_mismatch`、
 * 事件的 `meta` 有没有被过滤掉），单测 handler 看不出来。
 *
 * 探测用 `node --version` 真起子进程：只有真跑一次才能区分
 * 「ready」「missing」以及「重复添加同一可执行文件」的判定是否成立。
 */

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-crud-http-"));
});
afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄占用
  }
});

const NOW = Date.now();

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "crud-rt",
  displayName: "CRUD 运行时",
  protocol: "cli-stdio",
  launch: { command: "node", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(?<version>\\d+\\.\\d+\\.\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: false,
    resume: false,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "done", "error"],
  permission: { channel: "none", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "none",
  executionLocations: ["local"],
};

function createDriver(): ChannelDriver {
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
    async prompt() {
      /* 本文件不发消息 */
    },
    async cancel() {
      /* 无活跃 Turn */
    },
    async respondPermission() {
      /* 无权限请求 */
    },
    onEvent(_h, cb: (e: CanonicalEvent) => void) {
      void cb;
    },
    onPermission() {
      /* 无 */
    },
    onExit() {
      /* 无 */
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
  close: () => Promise<void>;
}

async function boot(): Promise<Ctx> {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const driver = createDriver();
  const resolveRuntime = () => ({ runtimeId: "crud-rt", declaration: DECL, driver });

  // 运行时行：`runtime_bindings.runtime_id` 有外键，删除测试要用到。
  // 命令取一个不在 PATH 上的名字：否则「同一可执行文件」判定会把测试里
  // 用 node 本体添加的自定义运行时判成重复。
  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, command, protocol, capabilities,
        event_capabilities, health_status, created_at)
     VALUES ('crud-rt', 'crud-rt', 'CRUD 运行时', 'builtin', 'crud-runtime-binary', 'cli-stdio', ?, ?, 'ready', ?)`,
  ).run(JSON.stringify(DECL.capabilities), JSON.stringify(DECL.eventCapabilities), NOW);

  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime,
    idleReapMs: 0,
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
    isRuntimeAvailable: () => true,
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
      // 内置声明表：单运行时重探靠它找声明（main.ts 里是同一份东西）
      declarations: new Map([[DECL.id, DECL]]),
    },
    { authEnabled: false, webRoot: join(workDir, "no-web") },
  );
  const base = await listenEphemeral(app);

  return {
    app,
    base,
    db,
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

function seedBot(
  db: DB,
  input: { id: string; name: string; runtimeId?: string | null },
): { channelId: string; sessionId: string } {
  const now = Date.now();
  const channelId = `ch_${input.id}`;
  const sessionId = `sess_${input.id}`;
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', ?, ?, NULL, ?)`,
  ).run(channelId, input.name, JSON.stringify([input.id]), now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, default_runtime_id, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, ?, '初始人格', ?, 'local', ?, 'active', '[]', 0, 0, 0, ?, ?)`,
  ).run(input.id, input.name, input.runtimeId ?? null, workDir, now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
     VALUES (?, ?, ?, NULL, 'fresh', 'created', ?)`,
  ).run(sessionId, input.id, channelId, now);
  return { channelId, sessionId };
}

function insertEvent(
  db: DB,
  sessionId: string,
  turnId: string,
  type: Parameters<typeof eventsRepo.insert>[1]["type"],
  payload: unknown,
): void {
  eventsRepo.insert(db, {
    sessionId,
    messageId: null,
    turnId,
    type,
    payload: payload as never,
  });
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// P0-01 · 手动添加自定义运行时 + 单运行时重探
// ---------------------------------------------------------------------------

describe("HTTP · 运行时（P0-01）", () => {
  it("POST /api/runtimes 添加自定义命令 → 201，立即探测并返回完整 DTO", async () => {
    const ctx = await boot();
    // 用 node 本体当「自定义运行时」：真实可执行文件，探测会拿到版本
    const { status, body } = await postJson(ctx.base, "/api/runtimes", {
      id: "my-node",
      displayName: "我的 Node",
      protocol: "cli-stdio",
      command: process.execPath,
      args: [],
    });

    expect(status).toBe(201);
    const runtime = body["runtime"] as Record<string, unknown>;
    expect(runtime["id"]).toBe("my-node");
    expect(runtime["displayName"]).toBe("我的 Node");
    expect(runtime["protocol"]).toBe("cli-stdio");
    expect(runtime["availability"]).toBe("ready");
    expect(runtime["version"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(runtime["executable"]).toBeTruthy();
    // cli-stdio 的掩码来自 custom.ts 的通道能力表
    expect(runtime["eventCapabilities"]).toEqual(["message_delta", "usage", "done", "error"]);
    // cli-stdio 不提供权限通道 → 必须强制 worktree（安全底线）
    expect(runtime["requiresWorktree"]).toBe(true);

    // 列表里能查到，且 source 是 custom
    const list = (await (await fetch(`${ctx.base}/api/runtimes`)).json()) as {
      runtimes: { id: string }[];
    };
    expect(list.runtimes.map((r) => r.id)).toContain("my-node");
    const row = ctx.db
      .prepare("SELECT source FROM runtime_definitions WHERE id = 'my-node'")
      .get() as { source: string };
    expect(row.source).toBe("custom");

    // 声明本身已缓存（重启后靠它恢复）
    const caps = ctx.db
      .prepare("SELECT capabilities FROM runtime_definitions WHERE id = 'my-node'")
      .get() as { capabilities: string };
    const parsed = JSON.parse(caps.capabilities) as { _declaration?: { id: string } };
    expect(parsed._declaration?.id).toBe("my-node");

    await ctx.close();
  }, 30_000);

  it("重复添加同一可执行文件 → 409 already_exists + existingId", async () => {
    const ctx = await boot();
    const first = await postJson(ctx.base, "/api/runtimes", {
      id: "node-a",
      displayName: "Node A",
      protocol: "cli-stdio",
      command: process.execPath,
    });
    expect(first.status).toBe(201);

    const second = await postJson(ctx.base, "/api/runtimes", {
      id: "node-b",
      displayName: "Node B",
      protocol: "cli-stdio",
      command: process.execPath,
    });
    expect(second.status).toBe(409);
    expect(second.body["error"]).toBe("already_exists");
    expect(second.body["existingId"]).toBe("node-a");
    expect(second.body["reason"]).toBe("executable");

    // 同 id 也拦
    const sameId = await postJson(ctx.base, "/api/runtimes", {
      id: "node-a",
      displayName: "另一个名字",
      protocol: "acp",
      command: "definitely-not-exists-xyz",
    });
    expect(sameId.status).toBe(409);
    expect(sameId.body["existingId"]).toBe("node-a");

    // 库里只有一条 node-* 运行时（种子行不算）
    const count = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM runtime_definitions WHERE id LIKE 'node-%'")
      .get() as { n: number };
    expect(count.n).toBe(1);

    await ctx.close();
  }, 30_000);

  it("命令不存在 → 仍然 201，但 availability=missing（探测失败是有效结果）", async () => {
    const ctx = await boot();
    const { status, body } = await postJson(ctx.base, "/api/runtimes", {
      id: "ghost",
      displayName: "不存在的运行时",
      protocol: "cli-stdio",
      command: "definitely-not-installed-xyz",
    });
    expect(status).toBe(201);
    const runtime = body["runtime"] as Record<string, unknown>;
    expect(runtime["availability"]).toBe("missing");
    expect(runtime["executable"]).toBeNull();
    await ctx.close();
  }, 30_000);

  it("校验：缺 id / displayName / command、protocol 不在 5 种里 → 400 + 字段级错误", async () => {
    const ctx = await boot();
    const { status, body } = await postJson(ctx.base, "/api/runtimes", {
      protocol: "websocket",
    });
    expect(status).toBe(400);
    expect(body["error"]).toBe("invalid_runtime");
    const fields = body["fields"] as { field: string }[];
    const names = fields.map((f) => f.field);
    expect(names).toContain("id");
    expect(names).toContain("displayName");
    expect(names).toContain("command");
    expect(names).toContain("protocol");
    await ctx.close();
  }, 30_000);

  it("POST /api/runtimes/:id/probe 只重探该行，DTO 更新", async () => {
    const ctx = await boot();
    // 内置行（来自 declarations 注入）+ 一条已存在的 custom
    await postJson(ctx.base, "/api/runtimes", {
      id: "probe-me",
      displayName: "待重探",
      protocol: "cli-stdio",
      command: process.execPath,
    });
    const before = ctx.db
      .prepare("SELECT last_probe_at FROM runtime_definitions WHERE id = 'probe-me'")
      .get() as { last_probe_at: number };

    // 人为把状态改坏，验证 probe 真的会写回
    ctx.db
      .prepare(
        "UPDATE runtime_definitions SET health_status = 'timeout', last_probe_at = 1 WHERE id = 'probe-me'",
      )
      .run();

    await new Promise((r) => setTimeout(r, 5));
    const res = await fetch(`${ctx.base}/api/runtimes/probe-me/probe`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runtime: Record<string, unknown> };
    expect(body.runtime["availability"]).toBe("ready");
    expect(body.runtime["lastProbeAt"]).toBeGreaterThan(before.last_probe_at);
    expect(body.runtime["lastProbeAt"]).toBeGreaterThan(1);
    await ctx.close();
  }, 30_000);

  it("POST /api/runtimes/:id/probe 未知 id → 404 runtime_not_found", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/runtimes/nope/probe`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("runtime_not_found");
    await ctx.close();
  }, 30_000);

  it("自定义运行时的声明能读回（重启后 Bot 仍可解析运行时）", async () => {
    const ctx = await boot();
    await postJson(ctx.base, "/api/runtimes", {
      id: "restart-me",
      displayName: "重启后仍在",
      protocol: "acp",
      command: process.execPath,
      args: ["--acp"],
      env: { DEMO_FLAG: "1" },
      cwd: workDir,
      detect: { versionArgs: ["--version"], versionPattern: "(?<version>\\d+\\.\\d+\\.\\d+)" },
    });

    // 模拟重启：不经过 HTTP，直接从库里读声明（main.ts 启动序走的就是这条路）
    const { readCustomDeclarations, readCustomDeclaration } = await import(
      "../../src/server/adapters/probe.js"
    );
    const all = readCustomDeclarations(ctx.db);
    const decl = all.find((d) => d.id === "restart-me");
    expect(decl).toBeDefined();
    expect(decl?.displayName).toBe("重启后仍在");
    expect(decl?.protocol).toBe("acp");
    expect(decl?.launch.command).toBe(process.execPath);
    expect(decl?.launch.args).toEqual(["--acp"]);
    expect(decl?.launch.env).toEqual({ DEMO_FLAG: "1" });
    expect(decl?.launch.cwd).toBe(workDir);
    // acp 通道的默认值来自 custom.ts 的通道能力表
    expect(decl?.permission.channel).toBe("acp-reverse");
    expect(decl?.resumeStrategy).toBe("acp");

    // 按 id 单读也一致
    expect(readCustomDeclaration(ctx.db, "restart-me")?.id).toBe("restart-me");
    // 内置行不该被当成自定义
    expect(readCustomDeclaration(ctx.db, "crud-rt")).toBeNull();

    await ctx.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// P0-03 · PATCH persona + DELETE bot
// ---------------------------------------------------------------------------

describe("HTTP · Bot 编辑人格（P0-03）", () => {
  it("PATCH {persona} → 落库，GET 读到新值", async () => {
    const ctx = await boot();
    const { channelId } = seedBot(ctx.db, { id: "bot_p", name: "小写手" });
    expect(channelId).toBeTruthy();

    const patch = await postJson(
      ctx.base,
      "/api/bots/bot_p",
      { persona: "你是一位严谨的技术写作者，回答简短。" },
      "PATCH",
    );
    expect(patch.status).toBe(200);

    const detail = (await (await fetch(`${ctx.base}/api/bots/bot_p`)).json()) as {
      bot: { persona: string };
    };
    expect(detail.bot.persona).toBe("你是一位严谨的技术写作者，回答简短。");

    // 列表里也是新值（不是只有详情页对）
    const list = (await (await fetch(`${ctx.base}/api/bots`)).json()) as {
      bots: { id: string; persona: string }[];
    };
    expect(list.bots.find((b) => b.id === "bot_p")?.persona).toContain("技术写作者");

    await ctx.close();
  }, 30_000);

  it("PATCH persona 超过 4000 字符 → 400 invalid_boundary + field=persona", async () => {
    const ctx = await boot();
    seedBot(ctx.db, { id: "bot_long", name: "长人格" });
    const res = await postJson(
      ctx.base,
      "/api/bots/bot_long",
      { persona: "x".repeat(4001) },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("invalid_boundary");
    const fields = res.body["fields"] as { field: string; code: string }[];
    expect(fields).toContainEqual(
      expect.objectContaining({ field: "persona", code: "too_long" }),
    );

    // 未落库
    const row = ctx.db.prepare("SELECT persona FROM bots WHERE id = 'bot_long'").get() as {
      persona: string;
    };
    expect(row.persona).toBe("初始人格");
    await ctx.close();
  }, 30_000);

  it("PATCH persona 恰好 4000 字符 → 200（边界值不误伤）", async () => {
    const ctx = await boot();
    seedBot(ctx.db, { id: "bot_exact", name: "边界人格" });
    const res = await postJson(
      ctx.base,
      "/api/bots/bot_exact",
      { persona: "y".repeat(4000) },
      "PATCH",
    );
    expect(res.status).toBe(200);
    await ctx.close();
  }, 30_000);
});

describe("HTTP · Bot 默认权限模式（R5 / G2）", () => {
  it("PATCH {permissionMode} → 落库；已有会话的档位不被改写", async () => {
    const ctx = await boot();
    const { sessionId } = seedBot(ctx.db, { id: "bot_pm", name: "默认档位" });
    // 会话已经在会话内切到 auto：Bot 默认值只影响之后新建的会话
    ctx.db.prepare("UPDATE sessions SET permission_mode = 'auto' WHERE id = ?").run(sessionId);

    const res = await postJson(
      ctx.base,
      "/api/bots/bot_pm",
      { permissionMode: "plan" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect(res.body["permissionMode"]).toBe("plan");

    const bot = ctx.db
      .prepare("SELECT permission_mode FROM bots WHERE id = 'bot_pm'")
      .get() as { permission_mode: string };
    expect(bot.permission_mode).toBe("plan");

    const session = ctx.db
      .prepare("SELECT permission_mode FROM sessions WHERE id = ?")
      .get(sessionId) as { permission_mode: string };
    expect(session.permission_mode).toBe("auto");

    await ctx.close();
  }, 30_000);

  it("PATCH 非法档位 → 400 invalid_boundary + field=permissionMode，不落库", async () => {
    const ctx = await boot();
    seedBot(ctx.db, { id: "bot_pm2", name: "非法档位" });

    const res = await postJson(
      ctx.base,
      "/api/bots/bot_pm2",
      { permissionMode: "yolo" },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("invalid_boundary");
    const fields = res.body["fields"] as { field: string; code: string }[];
    expect(fields).toContainEqual(
      expect.objectContaining({ field: "permissionMode", code: "invalid_value" }),
    );

    const row = ctx.db
      .prepare("SELECT permission_mode FROM bots WHERE id = 'bot_pm2'")
      .get() as { permission_mode: string };
    expect(row.permission_mode).toBe("confirm");
    await ctx.close();
  }, 30_000);
});

describe("HTTP · 新建 Bot 不要求项目地址（R1）", () => {
  it("内置引擎：不填 repoPath → 201，默认工作区为空、执行位置 local", async () => {
    const ctx = await boot();
    // 内置引擎没有权限通道，但也不需要 worktree —— 工作区下沉到会话/群聊
    ctx.db
      .prepare(
        `INSERT INTO runtime_definitions
           (id, adapter_name, display_name, source, command, protocol, capabilities,
            event_capabilities, health_status, created_at)
         VALUES ('rt_builtin_http', 'rt_builtin_http', '内置引擎', 'builtin', 'builtin', 'builtin',
                 '{}', '[]', 'ready', ?)`,
      )
      .run(NOW);

    const res = await postJson(ctx.base, "/api/bots", {
      name: "无路径 Bot",
      runtimeId: "rt_builtin_http",
    });
    expect(res.status).toBe(201);
    const bot = res.body["bot"] as {
      defaultWorkspace: string | null;
      effectivePath: string | null;
      executionLocation: string;
      permissionMode: string;
      role: string;
    };
    expect(bot.executionLocation).toBe("local");
    expect(bot.defaultWorkspace).toBeNull();
    expect(bot.effectivePath).toBeNull();
    // G2：新 Bot 默认 confirm；本接口不能顺手把角色提升成管理员
    expect(bot.permissionMode).toBe("confirm");
    expect(bot.role).toBe("member");

    await ctx.close();
  }, 30_000);
});

describe("HTTP · 删除 Bot（P0-03）", () => {
  it("名称不符 → 400 name_mismatch，什么都不删", async () => {
    const ctx = await boot();
    const { channelId } = seedBot(ctx.db, { id: "bot_d1", name: "要被删的" });
    const res = await postJson(
      ctx.base,
      "/api/bots/bot_d1",
      { confirmName: "要被删", mode: "cascade" },
      "DELETE",
    );
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("name_mismatch");
    expect(
      ctx.db.prepare("SELECT id FROM bots WHERE id = 'bot_d1'").get(),
    ).toBeTruthy();
    expect(
      ctx.db.prepare("SELECT id FROM channels WHERE id = ?").get(channelId),
    ).toBeTruthy();
    await ctx.close();
  }, 30_000);

  it("缺 mode → 400 mode_required（不猜用户想删还是归档）", async () => {
    const ctx = await boot();
    seedBot(ctx.db, { id: "bot_d2", name: "没选模式" });
    const res = await postJson(
      ctx.base,
      "/api/bots/bot_d2",
      { confirmName: "没选模式" },
      "DELETE",
    );
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("mode_required");
    await ctx.close();
  }, 30_000);

  it("cascade：会话/消息/事件/记忆/定时任务/绑定全删，usage_records 保留", async () => {
    const ctx = await boot();
    const { channelId, sessionId } = seedBot(ctx.db, { id: "bot_d3", name: "级联删除" });

    // 造齐各类数据
    ctx.db
      .prepare(
        `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
         VALUES ('msg_1', ?, ?, 'turn_1', 'user', '你好', 'done', ?)`,
      )
      .run(sessionId, channelId, Date.now());
    insertEvent(ctx.db, sessionId, "turn_1", "thought", { phase: "end", text: "想一想" });
    insertEvent(ctx.db, sessionId, "turn_1", "usage", {
      inputTokens: 10,
      outputTokens: 20,
      reported: true,
    });
    ctx.db
      .prepare(
        `INSERT INTO memory_entries (id, bot_id, content, kind, injected, version, updated_at, created_at)
         VALUES ('mem_1', 'bot_d3', '喜欢短句', 'manual', 1, 1, ?, ?)`,
      )
      .run(Date.now(), Date.now());
    ctx.db
      .prepare(
        `INSERT INTO schedules (id, name, bot_id, channel_id, prompt, trigger_type, interval_minutes,
                                next_run_at, enabled, created_at)
         VALUES ('sch_1', '每日摘要', 'bot_d3', ?, '总结今天', 'interval', 60, ?, 1, ?)`,
      )
      .run(channelId, Date.now() + 3600_000, Date.now());
    ctx.db
      .prepare(
        `INSERT INTO assignments (id, title, deliverable, bot_id, status, queue_pos, created_at)
         VALUES ('asg_1', '写报告', 'Markdown', 'bot_d3', 'completed', 0, ?)`,
      )
      .run(Date.now());
    ctx.db
      .prepare(
        `INSERT INTO runtime_bindings (id, bot_id, runtime_id, location, bound_at)
         VALUES ('rb_1', 'bot_d3', 'crud-rt', 'local', ?)`,
      )
      .run(Date.now());
    // 历史用量：删除后必须还在（P0-12）
    ctx.db
      .prepare(
        `INSERT INTO usage_records (id, bot_id, runtime_id, session_id, mode, input_tokens,
                                    output_tokens, reported, created_at)
         VALUES ('use_1', 'bot_d3', 'crud-rt', ?, 'interactive', 100, 200, 1, ?)`,
      )
      .run(sessionId, Date.now());

    const res = await postJson(
      ctx.base,
      "/api/bots/bot_d3",
      { confirmName: "级联删除", mode: "cascade" },
      "DELETE",
    );
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["mode"]).toBe("cascade");
    expect(res.body["usageRecordsKept"]).toBe(1);

    const count = (sql: string, ...params: unknown[]): number =>
      (ctx.db.prepare(sql).get(...params) as { n: number }).n;

    expect(count("SELECT COUNT(*) AS n FROM bots WHERE id = 'bot_d3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE bot_id = 'bot_d3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", sessionId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE session_id = ?", sessionId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memory_entries WHERE bot_id = 'bot_d3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM schedules WHERE bot_id = 'bot_d3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM assignments WHERE bot_id = 'bot_d3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM runtime_bindings WHERE bot_id = 'bot_d3'")).toBe(0);
    // 独占渠道（私聊只有这个 Bot）一起删
    expect(count("SELECT COUNT(*) AS n FROM channels WHERE id = ?", channelId)).toBe(0);
    // 用量保留
    expect(count("SELECT COUNT(*) AS n FROM usage_records WHERE bot_id = 'bot_d3'")).toBe(1);

    // Bot 列表里消失
    const list = (await (await fetch(`${ctx.base}/api/bots`)).json()) as { bots: unknown[] };
    expect(list.bots).toHaveLength(0);

    await ctx.close();
  }, 30_000);

  it("cascade：群聊保留，只把该 Bot 从参与者里摘掉并顺延主持人", async () => {
    const ctx = await boot();
    const now = Date.now();
    for (const [id, name] of [
      ["bot_g1", "主持人"],
      ["bot_g2", "成员"],
    ] as const) {
      ctx.db
        .prepare(
          `INSERT INTO bots (id, name, persona, status, created_at, updated_at)
           VALUES (?, ?, '', 'active', ?, ?)`,
        )
        .run(id, name, now, now);
    }
    ctx.db
      .prepare(
        `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
         VALUES ('ch_group', 'group', '研究小组', ?, 'bot_g1', ?)`,
      )
      .run(JSON.stringify(["bot_g1", "bot_g2"]), now);

    const res = await postJson(
      ctx.base,
      "/api/bots/bot_g1",
      { confirmName: "主持人", mode: "cascade" },
      "DELETE",
    );
    expect(res.status).toBe(200);

    const ch = ctx.db
      .prepare("SELECT participant_bot_ids, host_bot_id FROM channels WHERE id = 'ch_group'")
      .get() as { participant_bot_ids: string; host_bot_id: string };
    expect(JSON.parse(ch.participant_bot_ids)).toEqual(["bot_g2"]);
    expect(ch.host_bot_id).toBe("bot_g2");
    await ctx.close();
  }, 30_000);

  it("archive：status=archived，一行数据都不删", async () => {
    const ctx = await boot();
    const { channelId, sessionId } = seedBot(ctx.db, { id: "bot_arch", name: "归档我" });
    insertEvent(ctx.db, sessionId, "turn_1", "thought", { phase: "end", text: "留着" });
    ctx.db
      .prepare(
        `INSERT INTO memory_entries (id, bot_id, content, kind, injected, version, updated_at, created_at)
         VALUES ('mem_a', 'bot_arch', '记忆', 'manual', 1, 1, ?, ?)`,
      )
      .run(Date.now(), Date.now());

    const res = await postJson(
      ctx.base,
      "/api/bots/bot_arch",
      { confirmName: "归档我", mode: "archive" },
      "DELETE",
    );
    expect(res.status).toBe(200);
    expect(res.body["mode"]).toBe("archive");

    const bot = ctx.db.prepare("SELECT status FROM bots WHERE id = 'bot_arch'").get() as {
      status: string;
    };
    expect(bot.status).toBe("archived");
    // 数据全在
    const count = (sql: string, ...p: unknown[]): number =>
      (ctx.db.prepare(sql).get(...p) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM channels WHERE id = ?", channelId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", sessionId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE session_id = ?", sessionId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM memory_entries WHERE bot_id = 'bot_arch'")).toBe(1);

    // 归档后从 Bot 列表消失（listBots 只查 active），但详情仍可读
    const list = (await (await fetch(`${ctx.base}/api/bots`)).json()) as { bots: unknown[] };
    expect(list.bots).toHaveLength(0);
    const detail = await fetch(`${ctx.base}/api/bots/bot_arch`);
    expect(detail.status).toBe(200);

    await ctx.close();
  }, 30_000);

  it("删除不存在的 Bot → 404 bot_not_found", async () => {
    const ctx = await boot();
    const res = await postJson(
      ctx.base,
      "/api/bots/nope",
      { confirmName: "nope", mode: "cascade" },
      "DELETE",
    );
    expect(res.status).toBe(404);
    expect(res.body["error"]).toBe("bot_not_found");
    await ctx.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// P0-04 / P0-05 · 事件回放
// ---------------------------------------------------------------------------

describe("HTTP · 事件回放（P0-04 / P0-05）", () => {
  it("返回全部历史事件，含 meta 与 usage；形状与 SSE 帧一致", async () => {
    const ctx = await boot();
    const { sessionId } = seedBot(ctx.db, { id: "bot_e1", name: "事件回放" });

    insertEvent(ctx.db, sessionId, "turn_1", "thought", { phase: "end", text: "先想一下" });
    insertEvent(ctx.db, sessionId, "turn_1", "plan", { entries: [] });
    insertEvent(ctx.db, sessionId, "turn_1", "tool_call", {
      callId: "c1",
      name: "read_file",
      status: "running",
    });
    insertEvent(ctx.db, sessionId, "turn_1", "tool_result", {
      callId: "c1",
      status: "ok",
      output: "内容",
    });
    insertEvent(ctx.db, sessionId, "turn_1", "usage", {
      inputTokens: 12,
      outputTokens: 34,
      reported: true,
    });
    // meta：前端靠它生成 Session 分隔条，必须返回
    insertEvent(ctx.db, sessionId, "meta_x", "meta", {
      kind: "session_resumed",
      data: { runtimeSessionId: "rt_1" },
    });

    const res = await fetch(`${ctx.base}/api/sessions/${sessionId}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: {
        id: number;
        sessionId: string;
        type: string;
        seq: number;
        payload: Record<string, unknown>;
        turnId: string;
        createdAt: number;
        messageId: string | null;
      }[];
      hasMore: boolean;
      lastEventId: number;
    };

    expect(body.events).toHaveLength(6);
    expect(body.hasMore).toBe(false);
    expect(body.events.map((e) => e.type)).toEqual([
      "thought",
      "plan",
      "tool_call",
      "tool_result",
      "usage",
      "meta",
    ]);
    // seq 会话内从 1 递增
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // 形状与 SseFrame 一致
    for (const e of body.events) {
      expect(e.sessionId).toBe(sessionId);
      expect(typeof e.id).toBe("number");
      expect(typeof e.createdAt).toBe("number");
      expect(e).toHaveProperty("messageId");
      expect(e).toHaveProperty("raw");
    }
    // botId 补全（与 SSE 出帧同一个 enricher）
    expect(body.events[0]?.payload["botId"]).toBe("bot_e1");
    // meta 的 payload 原样保留
    expect(body.events[5]?.payload["kind"]).toBe("session_resumed");
    // lastEventId = 本页最大全局 id，可直接当 SSE 首连游标
    expect(body.lastEventId).toBe(body.events[5]?.id);

    await ctx.close();
  }, 30_000);

  it("afterSeq 分页：只回更晚的事件，hasMore 正确", async () => {
    const ctx = await boot();
    const { sessionId } = seedBot(ctx.db, { id: "bot_e2", name: "分页" });
    for (let i = 0; i < 5; i += 1) {
      insertEvent(ctx.db, sessionId, "turn_1", "thought", { phase: "delta", text: `第${i}条` });
    }

    const first = (await (
      await fetch(`${ctx.base}/api/sessions/${sessionId}/events?afterSeq=0&limit=2`)
    ).json()) as { events: { seq: number }[]; hasMore: boolean; lastEventId: number };
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);

    const second = (await (
      await fetch(`${ctx.base}/api/sessions/${sessionId}/events?afterSeq=2&limit=2`)
    ).json()) as { events: { seq: number }[]; hasMore: boolean };
    expect(second.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(second.hasMore).toBe(true);

    const third = (await (
      await fetch(`${ctx.base}/api/sessions/${sessionId}/events?afterSeq=4&limit=2`)
    ).json()) as { events: { seq: number }[]; hasMore: boolean };
    expect(third.events.map((e) => e.seq)).toEqual([5]);
    expect(third.hasMore).toBe(false);

    // 翻到底之后再翻：空页 + hasMore=false，且 lastEventId 仍是会话最大值
    const beyond = (await (
      await fetch(`${ctx.base}/api/sessions/${sessionId}/events?afterSeq=99&limit=2`)
    ).json()) as { events: unknown[]; hasMore: boolean; lastEventId: number };
    expect(beyond.events).toEqual([]);
    expect(beyond.hasMore).toBe(false);
    expect(beyond.lastEventId).toBeGreaterThan(0);

    await ctx.close();
  }, 30_000);

  it("limit 上限 5000；非法值按默认处理而不是 400", async () => {
    const ctx = await boot();
    const { sessionId } = seedBot(ctx.db, { id: "bot_e3", name: "上限" });
    insertEvent(ctx.db, sessionId, "turn_1", "thought", { phase: "end", text: "唯一一条" });

    for (const q of ["limit=99999", "limit=-3", "limit=abc", "afterSeq=abc"]) {
      const res = await fetch(`${ctx.base}/api/sessions/${sessionId}/events?${q}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: unknown[] };
      expect(body.events).toHaveLength(1);
    }
    await ctx.close();
  }, 30_000);

  it("limit 硬上限 5000：6000 条事件一次最多回 5000 条且 hasMore=true", async () => {
    const ctx = await boot();
    const { sessionId } = seedBot(ctx.db, { id: "bot_cap", name: "上限封顶" });

    // 6000 条：验证「一次拉爆整库」的防护确实生效
    const write = ctx.db.transaction(() => {
      for (let i = 0; i < 6000; i += 1) {
        insertEvent(ctx.db, sessionId, "turn_big", "thought", { phase: "delta", text: `第${i}条` });
      }
    });
    write();

    const res = await fetch(`${ctx.base}/api/sessions/${sessionId}/events?afterSeq=0&limit=99999`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number }[]; hasMore: boolean };
    expect(body.events).toHaveLength(5000);
    expect(body.hasMore).toBe(true);
    expect(body.events[0]?.seq).toBe(1);
    expect(body.events[4999]?.seq).toBe(5000);

    // 续页能拿到剩下的 1000 条
    const next = (await (
      await fetch(`${ctx.base}/api/sessions/${sessionId}/events?afterSeq=5000&limit=5000`)
    ).json()) as { events: { seq: number }[]; hasMore: boolean };
    expect(next.events).toHaveLength(1000);
    expect(next.hasMore).toBe(false);

    await ctx.close();
  }, 60_000);

  it("会话不存在 → 404 session_not_found（与端点未实现的 not_found 区分）", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/sessions/sess_missing/events`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("session_not_found");
    await ctx.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 渠道游标语义
// ---------------------------------------------------------------------------

describe("HTTP · 渠道游标（P0-04 群聊不跳历史）", () => {
  it("GET /api/channels/:id 返回 lastEventIdBySession，且各会话游标独立", async () => {
    const ctx = await boot();
    const now = Date.now();
    // 一个群聊，两个 Bot 各一个 Session（主持人 + 发言人）
    ctx.db
      .prepare(
        `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
         VALUES ('ch_multi', 'group', '多会话群', ?, 'bot_h', ?)`,
      )
      .run(JSON.stringify(["bot_h", "bot_s"]), now);
    for (const [id, name] of [
      ["bot_h", "主持"],
      ["bot_s", "发言"],
    ] as const) {
      ctx.db
        .prepare(
          `INSERT INTO bots (id, name, persona, status, created_at, updated_at)
           VALUES (?, ?, '', 'active', ?, ?)`,
        )
        .run(id, name, now, now);
    }
    for (const [sid, bid] of [
      ["sess_h", "bot_h"],
      ["sess_s", "bot_s"],
    ] as const) {
      ctx.db
        .prepare(
          `INSERT INTO sessions (id, bot_id, channel_id, resume_state, status, started_at)
           VALUES (?, ?, 'ch_multi', 'fresh', 'idle', ?)`,
        )
        .run(sid, bid, now);
    }

    // 主持人先产生 2 条事件，发言人后产生 1 条（全局 id 更大）
    insertEvent(ctx.db, "sess_h", "t_h1", "thought", { phase: "end", text: "主持1" });
    insertEvent(ctx.db, "sess_h", "t_h1", "thought", { phase: "end", text: "主持2" });
    insertEvent(ctx.db, "sess_s", "t_s1", "thought", { phase: "end", text: "发言1" });

    const detail = (await (await fetch(`${ctx.base}/api/channels/ch_multi`)).json()) as {
      lastEventId: number;
      lastEventIdBySession: Record<string, number>;
      sessions: { id: string }[];
    };

    expect(detail.sessions).toHaveLength(2);
    expect(Object.keys(detail.lastEventIdBySession).sort()).toEqual(["sess_h", "sess_s"]);

    const hostCursor = detail.lastEventIdBySession["sess_h"] ?? 0;
    const speakerCursor = detail.lastEventIdBySession["sess_s"] ?? 0;
    // 各自是各自会话的最大 id
    expect(hostCursor).toBeGreaterThan(0);
    expect(speakerCursor).toBeGreaterThan(hostCursor);
    // 全局值 = 最大值（向后兼容字段）
    expect(detail.lastEventId).toBe(speakerCursor);

    // 用 sess_h 的游标回放 sess_h 的历史，必须拿到 2 条而不是 0 条
    // （若错用全局游标，`afterSeq` 语义之外还会漏掉 id 更小的两条）
    const replay = (await (
      await fetch(`${ctx.base}/api/sessions/sess_h/events?afterSeq=0`)
    ).json()) as { events: { seq: number }[] };
    expect(replay.events).toHaveLength(2);

    await ctx.close();
  }, 30_000);

  it("PATCH /api/channels/:id 写渠道工作区，并清掉该渠道的会话级覆盖（R2/G10）", async () => {
    const ctx = await boot();
    const { channelId, sessionId } = seedBot(ctx.db, { id: "bot_ws", name: "工作区" });
    ctx.db.prepare("UPDATE sessions SET workspace_path = ? WHERE id = ?").run(workDir, sessionId);

    const res = await fetch(`${ctx.base}/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspacePath: workDir }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { workspacePath: string | null } };
    expect(body.channel.workspacePath).toBe(workDir);

    // 渠道显式设置后，会话覆盖不能继续压着它 —— 否则设置值与实际生效值不一致
    const row = ctx.db
      .prepare("SELECT workspace_path FROM sessions WHERE id = ?")
      .get(sessionId) as { workspace_path: string | null };
    expect(row.workspace_path).toBeNull();

    await ctx.close();
  }, 30_000);

  it("没有事件的渠道：lastEventIdBySession 为空对象，lastEventId 为 0", async () => {
    const ctx = await boot();
    const { channelId } = seedBot(ctx.db, { id: "bot_empty", name: "空渠道" });
    const detail = (await (await fetch(`${ctx.base}/api/channels/${channelId}`)).json()) as {
      lastEventId: number;
      lastEventIdBySession: Record<string, number>;
    };
    expect(detail.lastEventId).toBe(0);
    expect(detail.lastEventIdBySession).toEqual({});
    await ctx.close();
  }, 30_000);
});
