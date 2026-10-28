import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { eventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor, type Supervisor } from "../../src/server/core/process/supervisor.js";
import { isProcessAlive, killTreeSync } from "../../src/server/core/process/kill-tree.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import { createAssignmentRunner } from "../../src/server/core/assignment/runner.js";
import { buildServer } from "../../src/server/http/server.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  PermissionDecision,
  ProbeResult,
  RuntimePermissionRequest,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * 起真实 HTTP 服务（真 socket）验证 M5+M6 的 REST 契约。
 *
 * 为什么必须走 HTTP 而不是直接调 resolver：前端只认 `GET /api/permissions`
 * 的形状（camelCase、字段齐全）与 `POST /api/permissions/:id/decision` 的语义。
 * 这两条一旦漂移，卡片就永远显示不出来，而单测里看不出来。
 *
 * 驱动仍是真的 spawn 一个 node 子进程（pid 真实），这样「cancel 后进程消失」
 * 与「越界不转发运行时」都能被真正验证。
 */

const NODE = process.execPath;
const HANG = "setInterval(()=>{},1000)";
/**
 * 边界外目标：必须是一个在工作区之外、且在两种平台上都能被正确解析的绝对路径。
 * 之前硬编码 `C:\Windows\...`，在 POSIX 上会被当成工作区内的相对文件名（含冒号与
 * 反斜杠），于是裁决从 denied 变成 pending —— 测试前提不成立，不是实现的问题。
 */
const OUTSIDE_TARGET =
  process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-http-"));
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
  id: "http-proc",
  displayName: "HTTP Proc",
  protocol: "cli-stdio",
  launch: { command: "node", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: true,
    resume: true,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "done", "error", "permission_request"],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "acp",
  executionLocations: ["local"],
};

interface ScriptedDriver extends ChannelDriver {
  /** 下一个 prompt 要请求的权限（null = 不请求，直接 done）。 */
  nextPermission: RuntimePermissionRequest | null;
  /** prompt 是否挂住不返回（模拟长任务，用于取消测试）。 */
  hangPrompt: boolean;
  responded: { requestId: string; decision: PermissionDecision }[];
  /** 是否收到过 respondPermission（断言「越界不转发」用）。 */
  respondCount(): number;
  promptCount(): number;
  pids: number[];
  fireExit(code: number): void;
}

function createScriptedDriver(): ScriptedDriver {
  let handle: SessionHandle | null = null;
  let exitCb: ((i: { code: number | null; stderrTail: string }) => void) | null = null;
  let permCb: ((r: RuntimePermissionRequest) => void) | null = null;
  let eventCb: ((e: { type: string; turnId: string; ts: number; payload: unknown }) => void) | null =
    null;
  let releasePrompt: (() => void) | null = null;
  let prompts = 0;
  let responds = 0;
  let disposed = false;
  const children = new Map<number, ReturnType<typeof spawn>>();
  const pids: number[] = [];

  const driver: ScriptedDriver = {
    protocol: "cli-stdio",
    nextPermission: null,
    hangPrompt: false,
    responded: [],
    async start() {
      const child = spawn(NODE, ["-e", HANG], { stdio: "ignore", windowsHide: true });
      const pid = child.pid ?? null;
      if (pid !== null) {
        pids.push(pid);
        children.set(pid, child);
      }
      handle = { sessionId: "s", pid, runtimeSessionId: null };
      child.on("close", (code) => {
        if (disposed) return;
        exitCb?.({ code, stderrTail: "" });
      });
      return handle;
    },
    async initialize(): Promise<ProbeResult> {
      return {
        capabilities: DECL.capabilities,
        source: "probed",
        version: "1.0.0",
        healthStatus: "healthy",
      };
    },
    async newSession() {
      return { runtimeSessionId: "rt_http" };
    },
    async resumeSession() {
      return { ok: false, reason: "测试：不支持" };
    },
    async prompt() {
      prompts += 1;
      const req = driver.nextPermission;
      if (req) {
        // 让调用栈先返回，模拟运行时异步上报
        await new Promise((r) => setTimeout(r, 10));
        permCb?.(req);
      }
      if (driver.hangPrompt) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
    },
    async cancel() {
      // 故意不响应：验证编排层 1s 后树杀
    },
    async respondPermission(_h, requestId, decision) {
      responds += 1;
      driver.responded.push({ requestId, decision });
      // 用户决策后运行时继续跑完：补一个 done
      const ctx = handle;
      void ctx;
      setTimeout(() => {
        eventCb?.({
          type: "done",
          turnId: "turn_from_driver",
          ts: Date.now(),
          payload: { stopReason: "end", durationMs: 5 },
        });
      }, 5);
    },
    onEvent(_h, cb) {
      eventCb = cb as typeof eventCb;
    },
    onPermission(_h, cb) {
      permCb = cb;
    },
    onExit(_h, cb) {
      exitCb = cb;
    },
    async dispose() {
      disposed = true;
      releasePrompt?.();
    },
    respondCount: () => responds,
    promptCount: () => prompts,
    pids,
    fireExit(code) {
      exitCb?.({ code, stderrTail: "boom" });
    },
  };
  return driver;
}

interface Ctx {
  app: FastifyInstance;
  base: string;
  db: DB;
  driver: ScriptedDriver;
  supervisor: Supervisor;
  botId: string;
  channelId: string;
  sessionId: string;
  close: () => Promise<void>;
}

async function boot(boundary: {
  dirs: string[];
  shell?: boolean;
  permissionMode?: "confirm" | "auto" | "plan" | "full";
}): Promise<Ctx> {
  const db = openDb(":memory:");
  const now = Date.now();
  const botId = "bot_http";
  const channelId = "ch_http";
  const sessionId = "sess_http";

  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, command, protocol, capabilities,
        event_capabilities, health_status, created_at)
     VALUES ('rt_http', 'http-proc', 'HTTP Proc', 'builtin', 'node', 'cli-stdio', ?, ?, 'ready', ?)`,
  ).run(JSON.stringify(DECL.capabilities), JSON.stringify(DECL.eventCapabilities), now);
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, default_runtime_id, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, '小助', '简洁。', 'rt_http', 'local', ?, 'active', ?, ?, 0, 0, ?, ?)`,
  ).run(
    botId,
    workDir,
    JSON.stringify(boundary.dirs),
    boundary.shell ? 1 : 0,
    now,
    now,
  );

  const driver = createScriptedDriver();
  const supervisor = createSupervisor({
    db,
    bus: eventBus,
    resolveRuntime: () => ({ runtimeId: "rt_http", declaration: DECL, driver }),
    idleReapMs: 0,
    log: () => undefined,
  });
  const permissions = createPermissionResolver({
    db,
    bus: eventBus,
    isSessionAlive: (sid) => supervisor.isAlive(sid),
    sessionCwdOf: () => workDir,
    respond: (sid, id, decision) => supervisor.respondPermission(sid, id, decision),
    setHeld: (sid, held) => supervisor.setHeld(sid, held),
    setSessionStatus: (sid, status) => supervisor.setStatus(sid, status),
    log: () => undefined,
  });
  supervisor.addListener({
    onPermission: (sid, request) => {
      const turn = supervisor.activeTurn(sid);
      void permissions.handle({
        sessionId: sid,
        botId: turn?.botId ?? botId,
        turnId: turn?.turnId ?? "turn_unknown",
        request,
        source: turn?.source ?? "interactive",
      });
    },
    onExit: (sid, _info, crashed) => {
      permissions.invalidateSession(sid, crashed ? "运行时进程已崩溃" : "运行时进程已结束");
    },
  });

  const orchestrator = createTurnOrchestrator({
    db,
    bus: eventBus,
    lock: createSessionLock(),
    resolveRuntime: () => ({ runtimeId: "rt_http", declaration: DECL, driver }),
    supervisor,
  });

  const app = buildServer(
    {
      db,
      runtimes: [],
      schemaVersion: 1,
      startedAt: now,
      resolveRuntime: () => ({ runtimeId: "rt_http", declaration: DECL, driver }),
      orchestrator,
      permissions,
      // M11 的 Assignment 端点由这里注入；本文件不测它，给一个最小可用的 runner
      assignments: createAssignmentRunner({
        db,
        orchestrator,
        isRuntimeAvailable: () => true,
        log: () => undefined,
      }),
    },
    { authEnabled: false, webRoot: join(workDir, "no-web") },
  );

  const base = await listenEphemeral(app);

  // 预建 Session（首次发送会自动建，但这里显式建方便断言）
  db.prepare(
    `INSERT INTO sessions
       (id, bot_id, channel_id, runtime_id, resume_state, status, permission_mode, started_at)
     VALUES (?, ?, ?, 'rt_http', 'fresh', 'created', ?, ?)`,
  ).run(sessionId, botId, channelId, boundary.permissionMode ?? "confirm", now);

  return {
    app,
    base,
    db,
    driver,
    supervisor,
    botId,
    channelId,
    sessionId,
    close: async () => {
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      for (const pid of driver.pids) if (isProcessAlive(pid)) killTreeSync(pid);
      db.close();
    },
  };
}

async function sendMessage(ctx: Ctx, text: string): Promise<{ turnId: string; sessionId: string }> {
  const res = await fetch(`${ctx.base}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId: ctx.channelId, text }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { turnId: string; sessionId: string };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("HTTP · Bot 边界读写（P0-09）", () => {
  it("GET /api/bots/:id 返回 boundary 与 grants", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bot: { id: string };
      boundary: { allowDirs: string[]; allowShell: boolean; autoApproveWrite: boolean };
      grants: unknown[];
    };
    expect(body.bot.id).toBe(ctx.botId);
    expect(body.boundary.allowDirs).toHaveLength(1);
    expect(body.boundary.allowShell).toBe(false);
    expect(body.boundary.autoApproveWrite).toBe(false);
    expect(body.grants).toEqual([]);
    await ctx.close();
  });

  it("PATCH 目录不存在 → 400 + 字段级错误（内联报错）", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowDirs: [join(workDir, "ghost-dir")] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fields: { field: string; index: number; code: string; message: string }[];
    };
    expect(body.error).toBe("invalid_boundary");
    expect(body.fields[0]?.field).toBe("allowDirs");
    expect(body.fields[0]?.index).toBe(0);
    expect(body.fields[0]?.code).toBe("not_found");

    // 失败时不落库
    const row = ctx.db
      .prepare("SELECT allow_dirs FROM bots WHERE id = ?")
      .get(ctx.botId) as { allow_dirs: string };
    expect(JSON.parse(row.allow_dirs)).toEqual([workDir]);
    await ctx.close();
  });

  it("PATCH 相对路径 → 400 not_absolute", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowDirs: ["relative/dir"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: { code: string }[] };
    expect(body.fields[0]?.code).toBe("not_absolute");
    await ctx.close();
  });

  it("PATCH 合法目录 → 200，边界版本号推进（进行中请求按旧版本判定）", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const before = ctx.db
      .prepare("SELECT updated_at FROM bots WHERE id = ?")
      .get(ctx.botId) as { updated_at: number };

    await new Promise((r) => setTimeout(r, 5));
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowDirs: [workDir], allowShell: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; boundary: { allowShell: boolean; version: number } };
    expect(body.ok).toBe(true);
    expect(body.boundary.allowShell).toBe(true);
    expect(body.boundary.version).toBeGreaterThan(before.updated_at);
    await ctx.close();
  });

  it("PATCH 非布尔值 → 400 not_boolean", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowShell: "yes" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: { field: string; code: string }[] };
    expect(body.fields[0]).toEqual({ field: "allowShell", code: "not_boolean", message: "必须是布尔值" });
    await ctx.close();
  });
});

describe("HTTP · 权限卡片端到端", () => {
  it("边界内写：卡片出现 → GET 字段齐全 → 决策后解锁", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const target = join(workDir, "README.md");
    ctx.driver.nextPermission = { requestId: "perm_http_in", action: "write", target };

    const sent = await sendMessage(ctx, "改一下 README");
    expect(sent.sessionId).toBe(ctx.sessionId);

    // 1s 内出现（PRD P0-08）——这里等 3s 是给 CI 余量
    await waitFor(async () => {
      const res = await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`);
      const body = (await res.json()) as { permissions: unknown[] };
      return body.permissions.length > 0;
    });

    const res = await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      permissions: {
        id: string;
        sessionId: string;
        botId: string;
        turnId: string;
        action: string;
        target: string;
        boundaryVerdict: string;
        timeoutPolicy: string;
        status: string;
        heldSince: number | null;
        expiresAt: number | null;
        decision: string | null;
        decidedBy: string | null;
        decidedAt: number | null;
        createdAt: number;
      }[];
    };
    const row = body.permissions.find((p) => p.id === "perm_http_in");
    expect(row).toBeTruthy();
    // 前端倒计时 / 挂起态 / 已决态依赖的字段，一个都不能少
    expect(row!.timeoutPolicy).toBe("reject");
    expect(row!.status).toBe("pending");
    expect(row!.boundaryVerdict).toBe("allowed");
    expect(row!.expiresAt).toBeGreaterThan(Date.now());
    expect(row!.heldSince).toBeNull();
    expect(row!.decidedAt).toBeNull();
    expect(row!.decidedBy).toBeNull();
    expect(row!.turnId).toBe(sent.turnId);
    expect(row!.action).toBe("write");
    expect(row!.target.toLowerCase()).toContain("readme.md");

    // 决策
    const decide = await fetch(`${ctx.base}/api/permissions/perm_http_in/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decide.status).toBe(204);
    expect(ctx.driver.responded.at(-1)?.decision.kind).toBe("approve");

    const after = (await (
      await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
    ).json()) as { permissions: { id: string; status: string; decidedBy: string; decidedAt: number }[] };
    const decided = after.permissions.find((p) => p.id === "perm_http_in")!;
    expect(decided.status).toBe("decided");
    expect(decided.decidedBy).toBe("user");
    expect(decided.decidedAt).toBeGreaterThan(0);

    // 重复决策 → 409（不是 500，也不是静默成功）
    const again = await fetch(`${ctx.base}/api/permissions/perm_http_in/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(again.status).toBe(409);

    await ctx.close();
  }, 30000);

  it("越界写：卡片标 denied_boundary，运行时**没有**收到任何转发", async () => {
    const ctx = await boot({ dirs: [workDir] });
    ctx.driver.nextPermission = {
      requestId: "perm_http_out",
      action: "write",
      target: OUTSIDE_TARGET,
    };

    await sendMessage(ctx, "写到系统目录");

    await waitFor(async () => {
      const body = (await (
        await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
      ).json()) as { permissions: { id: string }[] };
      return body.permissions.some((p) => p.id === "perm_http_out");
    });

    const body = (await (
      await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
    ).json()) as {
      permissions: { id: string; status: string; boundaryVerdict: string; timeoutPolicy: string }[];
    };
    const row = body.permissions.find((p) => p.id === "perm_http_out")!;
    expect(row.status).toBe("denied_boundary");
    expect(row.boundaryVerdict).toBe("denied");

    // 唯一一次 respondPermission 是「拒绝」，没有把请求转发给运行时等待用户
    expect(ctx.driver.respondCount()).toBe(1);
    expect(ctx.driver.responded[0]?.decision.kind).toBe("deny");

    // 决策端点对已决请求返回 409（前端不会误以为还能批）
    const decide = await fetch(`${ctx.base}/api/permissions/perm_http_out/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decide.status).toBe(409);

    await ctx.close();
  }, 30000);

  it("越界写（auto）：直接拒绝，运行时收到 deny，不产生待批卡片", async () => {
    const ctx = await boot({ dirs: [workDir], permissionMode: "auto" });
    ctx.driver.nextPermission = {
      requestId: "perm_http_auto_out",
      action: "write",
      target: OUTSIDE_TARGET,
    };

    await sendMessage(ctx, "写到系统目录");
    await waitFor(() => ctx.driver.respondCount() > 0);

    const body = (await (
      await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
    ).json()) as { permissions: { id: string; status: string }[] };
    const row = body.permissions.find((p) => p.id === "perm_http_auto_out")!;
    expect(row.status).toBe("denied_boundary");
    expect(ctx.driver.responded[0]?.decision.kind).toBe("deny");
    await ctx.close();
  }, 30000);

  it("remember_session：同动作第二次请求自动批准，不再产生 pending 卡", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const target = join(workDir, "notes.md");
    ctx.driver.nextPermission = { requestId: "perm_r1", action: "write", target };

    await sendMessage(ctx, "写 notes");
    await waitFor(async () => {
      const body = (await (
        await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
      ).json()) as { permissions: { id: string }[] };
      return body.permissions.some((p) => p.id === "perm_r1");
    });

    await fetch(`${ctx.base}/api/permissions/perm_r1/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "remember_session" }),
    });

    // Bot 详情的「预授权列表」能看到这条
    const botBody = (await (await fetch(`${ctx.base}/api/bots/${ctx.botId}`)).json()) as {
      grants: { scope: string; actionKey: string }[];
    };
    expect(botBody.grants).toHaveLength(1);
    expect(botBody.grants[0]?.scope).toBe("session");

    // 第二次同动作
    ctx.driver.nextPermission = { requestId: "perm_r2", action: "write", target };
    await sendMessage(ctx, "再写一次 notes");
    await waitFor(async () => {
      const body = (await (
        await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
      ).json()) as { permissions: { id: string; status: string }[] };
      return body.permissions.some((p) => p.id === "perm_r2");
    });

    const body = (await (
      await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
    ).json()) as { permissions: { id: string; status: string }[] };
    expect(body.permissions.find((p) => p.id === "perm_r2")?.status).toBe("decided");

    await ctx.close();
  }, 30000);

  it("GET 缺 sessionId → 400；会话不存在 → 404 session_not_found", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const noQuery = await fetch(`${ctx.base}/api/permissions`);
    expect(noQuery.status).toBe(400);

    const missing = await fetch(`${ctx.base}/api/permissions?sessionId=sess_nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("session_not_found");
    await ctx.close();
  });

  it("decision body 非法 → 400 decision_invalid", async () => {
    const ctx = await boot({ dirs: [workDir] });
    const res = await fetch(`${ctx.base}/api/permissions/perm_x/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(400);
    await ctx.close();
  });
});

describe("HTTP · 取消与进程树杀（POST /api/sessions/:id/cancel）", () => {
  it("Turn 进行中取消 → 1s 内进程消失，消息 interrupted", async () => {
    const ctx = await boot({ dirs: [workDir] });
    ctx.driver.nextPermission = null;
    // prompt 挂住：模拟真正在跑的长任务（否则驱动立刻返回，Turn 已经收口了）
    ctx.driver.hangPrompt = true;

    const sent = await sendMessage(ctx, "跑个长任务");
    await waitFor(() => ctx.supervisor.isAlive(sent.sessionId));
    await waitFor(() => ctx.supervisor.activeTurn(sent.sessionId) !== null);
    const pid = ctx.driver.pids[0]!;
    expect(isProcessAlive(pid)).toBe(true);

    const started = Date.now();
    const res = await fetch(`${ctx.base}/api/sessions/${sent.sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: sent.turnId }),
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);

    // 1s 等待 + 树杀 + 收口
    expect(elapsed).toBeLessThan(2500);
    expect(isProcessAlive(pid)).toBe(false);

    const msg = ctx.db
      .prepare("SELECT status FROM messages WHERE turn_id = ? AND role = 'assistant'")
      .get(sent.turnId) as { status: string };
    expect(msg.status).toBe("interrupted");

    // 再取消一次 → 409 turn_not_running（幂等且不谎称成功）
    const again = await fetch(`${ctx.base}/api/sessions/${sent.sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: sent.turnId }),
    });
    expect(again.status).toBe(409);

    await ctx.close();
  }, 30000);

  it("进程崩溃 → 该会话的待批请求转 invalidated（不占满 24h）", async () => {
    const ctx = await boot({ dirs: [workDir] });
    ctx.driver.nextPermission = {
      requestId: "perm_crash",
      action: "write",
      target: join(workDir, "crash.md"),
    };
    await sendMessage(ctx, "写文件");

    await waitFor(async () => {
      const body = (await (
        await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
      ).json()) as { permissions: { id: string; status: string }[] };
      return body.permissions.some((p) => p.id === "perm_crash" && p.status === "pending");
    });

    ctx.driver.fireExit(9);

    await waitFor(async () => {
      const body = (await (
        await fetch(`${ctx.base}/api/permissions?sessionId=${ctx.sessionId}`)
      ).json()) as { permissions: { id: string; status: string }[] };
      return body.permissions.some((p) => p.id === "perm_crash" && p.status === "invalidated");
    });

    await ctx.close();
  }, 30000);
});
