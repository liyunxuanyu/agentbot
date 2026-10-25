import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  requiresWorktree,
  worktreeRiskMessage,
} from "../../src/server/core/permissions/worktree-guard.js";
import { resolveSessionCwd, WorktreeNotReadyError } from "../../src/server/core/process/session-cwd.js";
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import { listenEphemeral } from "./http-listen.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * CLI 运行时强制 worktree（用户裁定的安全底线）。
 *
 * 覆盖四件事：
 *   ① `requiresWorktree` 只看 `permission.channel === 'none'`；
 *   ② 新建 Bot 绑定这类运行时 → 执行位置强制 worktree，缺 repoPath 保存失败；
 *   ③ 改成 local 不带 confirmRisk → 400 risk_confirmation_required（带文案）；
 *   ④ worktree 未就绪时发送被阻止（409 worktree_not_ready），**不静默降级**。
 *
 * 用真 HTTP + 真 git 仓库：判定、落库、错误码三层的漂移都在这条链上。
 */

const NOW = Date.now();
const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-guard-"));
  if (HAS_GIT) {
    execFileSync("git", ["init", "-q"], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: workDir, stdio: "ignore" });
    writeFileSync(join(workDir, "README.md"), "# demo\n");
    execFileSync("git", ["add", "."], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workDir, stdio: "ignore" });
  }
});

afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄占用
  }
});

// ---------------------------------------------------------------------------
// ① 纯判定
// ---------------------------------------------------------------------------

describe("requiresWorktree 判定", () => {
  it("permission.channel === 'none' → true（ZCode / DSH 这类无权限通道的运行时）", () => {
    expect(requiresWorktree({ displayName: "ZCode", permission: { channel: "none" } })).toBe(true);
  });

  it("有权限通道 → false（ACP 反向请求 / JSON-RPC 审批）", () => {
    expect(requiresWorktree({ permission: { channel: "acp-reverse" } })).toBe(false);
    expect(requiresWorktree({ permission: { channel: "jsonrpc-approval" } })).toBe(false);
  });

  it("缺字段 / null 一律 false（判定只看明确声明，不猜）", () => {
    expect(requiresWorktree(null)).toBe(false);
    expect(requiresWorktree(undefined)).toBe(false);
    expect(requiresWorktree({})).toBe(false);
    expect(requiresWorktree({ permission: null })).toBe(false);
    expect(requiresWorktree({ permission: {} })).toBe(false);
  });

  it("风险文案说清「谁 / 为什么 / 后果」，不是空泛提示", () => {
    const text = worktreeRiskMessage("ZCode");
    expect(text).toContain("ZCode");
    expect(text).toContain("不提供权限请求");
    expect(text).toContain("无法拦截文件写入");
    expect(text).toContain("local");
  });
});

// ---------------------------------------------------------------------------
// HTTP 夹具
// ---------------------------------------------------------------------------

const PERMISSIONED_DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake-permissioned",
  displayName: "Fake ACP",
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
  executionLocations: ["local", "worktree"],
};

/** 无权限通道的运行时：这就是 ZCode / DSH 的形态。 */
const NO_PERMISSION_DECL: AdapterDeclaration = {
  ...PERMISSIONED_DECL,
  id: "fake-cli-none",
  displayName: "ZCode",
  permission: { channel: "none", defaultTimeoutPolicy: "reject" },
};

function createDriver(decl: AdapterDeclaration, opts: { fail?: boolean } = {}): ChannelDriver {
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  const handle: SessionHandle = { sessionId: "s", pid: null, runtimeSessionId: "rt" };
  return {
    protocol: "cli-stdio",
    async start() {
      return handle;
    },
    async initialize() {
      return {
        capabilities: decl.capabilities,
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
    async prompt(h) {
      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? "turn_x";
      const messageId = ctx?.messageId ?? "msg_x";
      if (opts.fail) {
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
        payload: { messageId, phase: "delta", text: "好的" },
      } as CanonicalEvent);
      eventCb?.({
        type: "done",
        turnId,
        ts: Date.now(),
        payload: { stopReason: "end", durationMs: 1 },
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

interface Ctx {
  app: FastifyInstance;
  base: string;
  db: DB;
  channelId: string;
  /** 当前绑定的运行时（测试里可切换）。 */
  setRuntime: (decl: AdapterDeclaration) => void;
  close: () => Promise<void>;
}

async function boot(): Promise<Ctx> {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const channelId = "ch_guard";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', '[]', NULL, ?)`,
  ).run(channelId, NOW);

  // 两个运行时都进缓存：一个有权限通道，一个没有（`_probe.permissionChannel` 是 DTO 的读取来源）
  const insertRuntime = (id: string, name: string, channel: string): void => {
    db.prepare(
      `INSERT INTO runtime_definitions
         (id, adapter_name, display_name, source, command, protocol, capabilities,
          event_capabilities, health_status, created_at)
       VALUES (?, ?, ?, 'builtin', 'fake', 'cli-stdio', ?, ?, 'ready', ?)`,
    ).run(
      id,
      id,
      name,
      JSON.stringify({
        plan: true,
        permissionRequest: channel !== "none",
        resume: false,
        images: "unknown",
        streaming: true,
        contextWindow: null,
        _probe: { availability: "ready", source: "probed", permissionChannel: channel },
      }),
      JSON.stringify(["message_delta", "done", "error"]),
      NOW,
    );
  };
  insertRuntime("rt_acp", "Fake ACP", "acp-reverse");
  insertRuntime("rt_none", "ZCode", "none");

  let decl = PERMISSIONED_DECL;
  let driver = createDriver(PERMISSIONED_DECL);
  const resolveRuntime = () => ({ runtimeId: decl.id === "fake-cli-none" ? "rt_none" : "rt_acp", declaration: decl, driver });

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

  const app = buildServer(
    {
      db,
      runtimes: [],
      schemaVersion: 1,
      startedAt: NOW,
      resolveRuntime,
      orchestrator,
      permissions,
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

  return {
    app,
    base,
    db,
    channelId,
    setRuntime(next) {
      decl = next;
      driver = createDriver(next);
    },
    close: async () => {
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      db.close();
    },
  };
}

async function postBot(
  ctx: Ctx,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ctx.base}/api/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// ② 新建：强制 worktree
// ---------------------------------------------------------------------------

describe("新建 Bot：无权限通道的运行时强制 worktree", () => {
  it("GET /api/runtimes 的 runtime 带 requiresWorktree（前端据此提示）", async () => {
    const ctx = await boot();
    const body = (await (await fetch(`${ctx.base}/api/runtimes`)).json()) as {
      runtimes: { id: string; requiresWorktree: boolean }[];
    };
    const none = body.runtimes.find((r) => r.id === "rt_none");
    const acp = body.runtimes.find((r) => r.id === "rt_acp");
    expect(none?.requiresWorktree).toBe(true);
    expect(acp?.requiresWorktree).toBe(false);
    await ctx.close();
  });

  it("绑 ZCode 但不填 repoPath → 400，且错误说明「不提供权限请求」", async () => {
    const ctx = await boot();
    const res = await postBot(ctx, { name: "研究助手", runtimeId: "rt_none" });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("invalid_bot");
    const fields = res.body["fields"] as { field: string; code: string; message: string }[];
    const repoErr = fields.find((f) => f.field === "repoPath");
    expect(repoErr?.code).toBe("required");
    expect(repoErr?.message).toContain("不提供权限请求");
    expect(repoErr?.message).toContain("worktree");

    // 失败时不落库
    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number };
    expect(count.n).toBe(0);
    await ctx.close();
  });

  it("绑 ZCode + 合法 repoPath → 201，executionLocation 被强制成 worktree（即使用户传 local）", async () => {
    if (!HAS_GIT) return;
    const ctx = await boot();
    const res = await postBot(ctx, {
      name: "研究助手",
      runtimeId: "rt_none",
      executionLocation: "local", // 用户想放 local：新建流程不给这个口子
      repoPath: workDir,
    });
    expect(res.status).toBe(201);
    const bot = res.body["bot"] as { id: string; executionLocation: string; runtime: { requiresWorktree: boolean } };
    expect(bot.executionLocation).toBe("worktree");
    expect(bot.runtime.requiresWorktree).toBe(true);

    const row = ctx.db
      .prepare("SELECT execution_location, repo_path FROM bots WHERE id = ?")
      .get(bot.id) as { execution_location: string; repo_path: string };
    expect(row.execution_location).toBe("worktree");
    expect(row.repo_path).toBeTruthy();

    // 保存后立刻建 worktree（失败也不回滚保存，但这里应当成功）
    const exec = res.body["execution"] as { worktreeState: string | null; worktreePath: string | null };
    expect(exec.worktreeState).toBe("ready");
    expect(exec.worktreePath).toBeTruthy();

    // 清理：worktree 落在 ~/.agentbot/wt，测试后移除
    if (exec.worktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", exec.worktreePath], {
          cwd: workDir,
          stdio: "ignore",
        });
      } catch {
        rmSync(exec.worktreePath, { recursive: true, force: true });
      }
    }
    await ctx.close();
  });

  it("绑有权限通道的运行时 → 默认 local，不要求 repoPath", async () => {
    const ctx = await boot();
    const res = await postBot(ctx, { name: "写手", runtimeId: "rt_acp" });
    expect(res.status).toBe(201);
    const bot = res.body["bot"] as { executionLocation: string; runtime: { requiresWorktree: boolean } };
    expect(bot.executionLocation).toBe("local");
    expect(bot.runtime.requiresWorktree).toBe(false);
    await ctx.close();
  });

  it("名称重复 → 400 duplicate（P0-03 内联报错）", async () => {
    const ctx = await boot();
    await postBot(ctx, { name: "重名", runtimeId: "rt_acp" });
    const res = await postBot(ctx, { name: "重名", runtimeId: "rt_acp" });
    expect(res.status).toBe(400);
    const fields = res.body["fields"] as { field: string; code: string }[];
    expect(fields.find((f) => f.field === "name")?.code).toBe("duplicate");
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// ③ 编辑：local 需要 confirmRisk
// ---------------------------------------------------------------------------

describe("编辑 Bot：改成 local 需要二次确认", () => {
  it("换成无权限通道的运行时 + local，不带 confirmRisk → 400 risk_confirmation_required + 风险文案", async () => {
    const ctx = await boot();
    const created = await postBot(ctx, { name: "写手", runtimeId: "rt_acp" });
    const botId = (created.body["bot"] as { id: string }).id;

    const res = await fetch(`${ctx.base}/api/bots/${botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeId: "rt_none", executionLocation: "local" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("risk_confirmation_required");
    expect(body.message).toContain("ZCode");
    expect(body.message).toContain("不提供权限请求");
    expect(body.message).toContain("无法拦截文件写入");

    // 未落库：运行时与执行位置都没变
    const row = ctx.db
      .prepare("SELECT default_runtime_id, execution_location FROM bots WHERE id = ?")
      .get(botId) as { default_runtime_id: string; execution_location: string };
    expect(row.default_runtime_id).toBe("rt_acp");
    expect(row.execution_location).toBe("local");
    await ctx.close();
  });

  it("带 confirmRisk:true → 保存成功，但 Session 启动时仍强制 worktree", async () => {
    if (!HAS_GIT) return;
    const ctx = await boot();
    const created = await postBot(ctx, { name: "写手", runtimeId: "rt_acp" });
    const botId = (created.body["bot"] as { id: string }).id;

    // 先给仓库路径，再确认风险切到 local
    const res = await fetch(`${ctx.base}/api/bots/${botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeId: "rt_none",
        executionLocation: "local",
        repoPath: workDir,
        confirmRisk: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; requiresWorktree: boolean };
    expect(body.ok).toBe(true);
    expect(body.requiresWorktree).toBe(true);

    const row = ctx.db
      .prepare("SELECT default_runtime_id, execution_location, repo_path FROM bots WHERE id = ?")
      .get(botId) as { default_runtime_id: string; execution_location: string; repo_path: string };
    // 用户确实保存成了 local（他的选择被尊重）
    expect(row.default_runtime_id).toBe("rt_none");
    expect(row.execution_location).toBe("local");

    // 但兜底生效：resolveSessionCwd 强制 worktree
    ctx.setRuntime(NO_PERMISSION_DECL);
    const resolved = resolveSessionCwd(ctx.db, botId, NO_PERMISSION_DECL);
    expect(resolved.forcedWorktree).toBe(true);
    expect(resolved.cwd).not.toBe(workDir);
    expect(resolved.cwd).toContain("wt");

    // 清理 worktree
    try {
      execFileSync("git", ["worktree", "remove", "--force", resolved.cwd], {
        cwd: workDir,
        stdio: "ignore",
      });
    } catch {
      rmSync(resolved.cwd, { recursive: true, force: true });
    }
    await ctx.close();
  });

  it("只改边界字段（allowShell）不受影响 —— 历史数据仍可编辑", async () => {
    const ctx = await boot();
    const created = await postBot(ctx, { name: "老 Bot", runtimeId: "rt_none", repoPath: workDir });
    const botId = (created.body["bot"] as { id: string }).id;

    const res = await fetch(`${ctx.base}/api/bots/${botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowShell: true }),
    });
    expect(res.status).toBe(200);
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// ④ worktree 未就绪 → 409，不降级
// ---------------------------------------------------------------------------

describe("worktree 未就绪：阻止发送而不是降级到 local", () => {
  it("resolveSessionCwd 抛 WorktreeNotReadyError（缺 repoPath）", async () => {
    const ctx = await boot();
    const created = await postBot(ctx, { name: "无仓库", runtimeId: "rt_none", repoPath: workDir });
    const botId = (created.body["bot"] as { id: string }).id;
    // 把仓库路径清掉，模拟「用户删了目录 / 历史数据没有 repo_path」
    ctx.db.prepare("UPDATE bots SET repo_path = NULL, worktree_path = NULL WHERE id = ?").run(botId);

    expect(() => resolveSessionCwd(ctx.db, botId, NO_PERMISSION_DECL)).toThrow(WorktreeNotReadyError);
    try {
      resolveSessionCwd(ctx.db, botId, NO_PERMISSION_DECL);
    } catch (err) {
      expect((err as WorktreeNotReadyError).code).toBe("worktree_not_ready");
      expect((err as Error).message).toContain("必须使用 worktree");
    }
    await ctx.close();
  });

  it("POST /api/messages → 409 worktree_not_ready（带 message，且不落消息）", async () => {    const ctx = await boot();
    const created = await postBot(ctx, { name: "无仓库", runtimeId: "rt_none", repoPath: workDir });
    const botId = (created.body["bot"] as { id: string }).id;
    ctx.db.prepare("UPDATE bots SET repo_path = NULL, worktree_path = NULL WHERE id = ?").run(botId);

    // 把 Bot 放进会话（发送要求会话里有它）
    ctx.db
      .prepare("UPDATE channels SET participant_bot_ids = ? WHERE id = ?")
      .run(JSON.stringify([botId]), ctx.channelId);
    ctx.setRuntime(NO_PERMISSION_DECL);

    const res = await fetch(`${ctx.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, text: "你好" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("worktree_not_ready");
    expect(body.message).toContain("worktree");

    // 消息没有落库：发送前就被挡住了
    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(count.n).toBe(0);
    await ctx.close();
  });
});
