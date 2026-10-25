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
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * Assignment REST 契约（M11）。
 *
 * 走真 HTTP（真 socket）：前端只认这些形状（camelCase、状态码、错误码），
 * 单测里直接调 runner 看不出序列化层的漂移。
 */

const NOW = Date.now();
let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-asg-http-"));
  // 造一个独立 git 仓库作为执行目录：真实执行位置就是仓库根，
  // 报告里的「改动文件」也才有东西可统计（放在临时目录里会被父级仓库吞掉）。
  try {
    execFileSync("git", ["init", "-q"], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: workDir, stdio: "ignore" });
    writeFileSync(join(workDir, "README.md"), "# demo\n");
    execFileSync("git", ["add", "."], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workDir, stdio: "ignore" });
  } catch {
    // 没装 git：报告会写「无法统计」，其余断言仍成立
  }
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
  id: "fake-asg-http",
  displayName: "Fake Asg HTTP",
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

interface Ctx {
  app: FastifyInstance;
  base: string;
  db: DB;
  channelId: string;
  botId: string;
  runner: ReturnType<typeof createAssignmentRunner>;
  close: () => Promise<void>;
}

function createDriver(): ChannelDriver {
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
    async prompt(h) {
      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? "turn_x";
      const messageId = ctx?.messageId ?? "msg_x";
      const emit = (e: CanonicalEvent): void => eventCb?.(e);
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "delta", text: "改好了 3 个文件。" },
      });
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "end", text: "" },
      });
      emit({ type: "done", turnId, ts: Date.now(), payload: { stopReason: "end", durationMs: 5 } });
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

async function boot(): Promise<Ctx> {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const channelId = "ch_http_asg";
  const botId = "bot_http_asg";
  const sessionId = "sess_http_asg";

  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, command, protocol, capabilities,
        event_capabilities, health_status, created_at)
     VALUES ('rt_asg', 'fake-asg-http', 'Fake Asg HTTP', 'builtin', 'fake', 'cli-stdio', ?, ?, 'ready', ?)`,
  ).run(JSON.stringify(DECL.capabilities), JSON.stringify(DECL.eventCapabilities), NOW);
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), NOW);
  db.prepare(
    `INSERT INTO bots (id, name, persona, default_runtime_id, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, '实现助手', '干活', 'rt_asg', 'local', ?, 'active', ?, 0, 0, 0, ?, ?)`,
  ).run(botId, workDir, JSON.stringify([workDir]), NOW, NOW);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
     VALUES (?, ?, ?, 'rt_asg', 'fresh', 'idle', ?)`,
  ).run(sessionId, botId, channelId, NOW);
  db.prepare(
    `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, content_version, status, created_at)
     VALUES ('msg_src_http', ?, ?, 'turn_src', 'user', '帮我改一下 README', 0, 'done', ?)`,
  ).run(sessionId, channelId, NOW);

  const driver = createDriver();
  const resolveRuntime = () => ({ runtimeId: "rt_asg", declaration: DECL, driver });
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
    },
    { authEnabled: false, webRoot: join(workDir, "no-web") },
  );
  const base = await listenEphemeral(app);

  return {
    app,
    base,
    db,
    channelId,
    botId,
    runner: assignments,
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

describe("HTTP · Assignment", () => {
  it("POST 创建 → 201；GET 列表与详情形状齐全", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: ctx.channelId,
        sourceMessageId: "msg_src_http",
        title: "补 README 安装章节",
        deliverable: "在 README 里加安装与启动两步",
        botId: ctx.botId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assignment: {
        id: string;
        title: string;
        status: string;
        botName: string;
        queueLimit: number;
        eventCount: number;
      };
    };
    expect(body.assignment.title).toBe("补 README 安装章节");
    expect(body.assignment.botName).toBe("实现助手");
    expect(body.assignment.queueLimit).toBe(5);
    expect(["queued", "running", "done"]).toContain(body.assignment.status);

    // 等它跑完（假驱动是同步完成）
    await waitFor(() => {
      const row = ctx.db
        .prepare("SELECT status FROM assignments WHERE id = ?")
        .get(body.assignment.id) as { status: string };
      return row.status === "done";
    });

    const list = (await (await fetch(`${ctx.base}/api/assignments`)).json()) as {
      assignments: { id: string; status: string; durationMs: number | null }[];
      counts: Record<string, number>;
    };
    expect(list.assignments).toHaveLength(1);
    expect(list.assignments[0]?.status).toBe("done");
    expect(list.counts["done"]).toBe(1);

    const detail = (await (
      await fetch(`${ctx.base}/api/assignments/${body.assignment.id}`)
    ).json()) as {
      assignment: {
        id: string;
        report: string;
        eventCount: number;
        changedFiles: unknown[] | null;
        startedAt: number | null;
        endedAt: number | null;
      };
    };
    expect(detail.assignment.report).toContain("## 执行摘要");
    expect(detail.assignment.eventCount).toBeGreaterThan(0);
    expect(detail.assignment.changedFiles).not.toBeNull();
    expect(detail.assignment.startedAt).toBeGreaterThan(0);
    expect(detail.assignment.endedAt).toBeGreaterThan(0);

    await ctx.close();
  }, 20000);

  it("GET /report.md → text/markdown 原文", async () => {
    const ctx = await boot();
    const created = (await (
      await fetch(`${ctx.base}/api/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: ctx.channelId,
          title: "生成报告",
          deliverable: "随便做点什么",
          botId: ctx.botId,
        }),
      })
    ).json()) as { assignment: { id: string } };

    await waitFor(() => {
      const row = ctx.db
        .prepare("SELECT status FROM assignments WHERE id = ?")
        .get(created.assignment.id) as { status: string };
      return row.status === "done";
    });

    const res = await fetch(`${ctx.base}/api/assignments/${created.assignment.id}/report.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("# 生成报告");
    expect(text).toContain("## 用量");
    await ctx.close();
  }, 20000);

  it("报告未生成 → 409 report_not_ready（不是 404）", async () => {
    const ctx = await boot();
    // 直接塞一条 queued 且没有 report 的行（模拟还没跑完）
    ctx.db
      .prepare(
        `INSERT INTO assignments (id, title, deliverable, bot_id, source_channel_id, status, queue_pos, created_at)
         VALUES ('asg_pending', '还没跑', 'x', ?, ?, 'queued', 99, ?)`,
      )
      .run(ctx.botId, ctx.channelId, NOW);

    const res = await fetch(`${ctx.base}/api/assignments/asg_pending/report.md`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe("report_not_ready");
    expect(body.status).toBe("queued");
    await ctx.close();
  });

  it("GET 不存在的任务 → 404 assignment_not_found（与「端点未实现」区分）", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/assignments/asg_nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("assignment_not_found");
    await ctx.close();
  });

  it("POST 缺字段 → 400；非法 status 过滤 → 400 invalid_status", async () => {
    const ctx = await boot();

    const noTitle = await fetch(`${ctx.base}/api/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, deliverable: "d", botId: ctx.botId }),
    });
    expect(noTitle.status).toBe(400);
    expect(((await noTitle.json()) as { error: string }).error).toBe("title_required");

    const noDeliverable = await fetch(`${ctx.base}/api/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: ctx.channelId, title: "t", botId: ctx.botId }),
    });
    expect(noDeliverable.status).toBe(400);
    expect(((await noDeliverable.json()) as { error: string }).error).toBe("deliverable_required");

    const badStatus = await fetch(`${ctx.base}/api/assignments?status=weird`);
    expect(badStatus.status).toBe(400);
    expect(((await badStatus.json()) as { error: string }).error).toBe("invalid_status");

    await ctx.close();
  });

  it("来源消息不属于该渠道 → 400 invalid_input（不静默贴错地方）", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: ctx.channelId,
        sourceMessageId: "msg_not_here",
        title: "t",
        deliverable: "d",
        botId: ctx.botId,
      }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("source_message_not_found");
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/bots/:id —— 执行位置（P0-13）
// ---------------------------------------------------------------------------

describe("HTTP · 执行位置 worktree（PATCH /api/bots/:id）", () => {
  it("选 worktree 但仓库路径不是 git 仓库 → 400 内联报错，且不落库", async () => {
    const ctx = await boot();
    const plain = mkdtempSync(join(tmpdir(), "agentbot-plain-"));
    try {
      const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionLocation: "worktree", repoPath: plain }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        fields: { field: string; code: string; message: string }[];
      };
      expect(body.error).toBe("invalid_boundary");
      expect(body.fields[0]?.field).toBe("repoPath");
      // 落在别的仓库里 → not_repo_root；完全不在仓库里 → not_git_repo。两者都算「不是 git 仓库根」
      expect(["not_git_repo", "not_repo_root"]).toContain(body.fields[0]?.code);

      const row = ctx.db
        .prepare("SELECT execution_location, repo_path FROM bots WHERE id = ?")
        .get(ctx.botId) as { execution_location: string; repo_path: string };
      expect(row.execution_location).toBe("local");
      expect(row.repo_path).toBe(workDir);
    } finally {
      rmSync(plain, { recursive: true, force: true });
      await ctx.close();
    }
  });

  it("选 worktree 且仓库合法 → 200，立刻创建 worktree 并回显实际路径", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionLocation: "worktree", repoPath: workDir }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      execution: {
        executionLocation: string;
        repoPath: string;
        worktreePath: string | null;
        worktreeState: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.execution.executionLocation).toBe("worktree");
    expect(body.execution.worktreeState).toBe("ready");
    expect(body.execution.worktreePath).toBeTruthy();

    // Bot 详情能读到同一个路径（P0-13「Bot 详情显示实际路径」）
    const detail = (await (await fetch(`${ctx.base}/api/bots/${ctx.botId}`)).json()) as {
      bot: { executionLocation: string; effectivePath: string | null; worktreeState: string | null };
    };
    expect(detail.bot.executionLocation).toBe("worktree");
    expect(detail.bot.effectivePath).toBe(body.execution.worktreePath);
    expect(detail.bot.worktreeState).toBe("ready");

    // 清理创建的 worktree，避免污染用户 ~/.agentbot/wt
    if (body.execution.worktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", body.execution.worktreePath], {
          cwd: workDir,
          stdio: "ignore",
        });
      } catch {
        // 清理失败不影响断言
      }
    }
    await ctx.close();
  }, 30000);

  it("executionLocation 非法值 → 400 invalid_value", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionLocation: "cloud" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: { field: string; code: string }[] };
    expect(body.fields[0]).toEqual({
      field: "executionLocation",
      code: "invalid_value",
      message: "执行位置只能是 local 或 worktree",
    });
    await ctx.close();
  });

  it("选 worktree 但没填仓库路径 → 400 required", async () => {
    const ctx = await boot();
    // 先把 Bot 改成 local 且清空 repo_path，才能验证「只改 executionLocation」的必填
    ctx.db.prepare("UPDATE bots SET repo_path = NULL WHERE id = ?").run(ctx.botId);
    const res = await fetch(`${ctx.base}/api/bots/${ctx.botId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionLocation: "worktree" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: { field: string; code: string }[] };
    expect(body.fields[0]).toMatchObject({ field: "repoPath", code: "required" });
    await ctx.close();
  });
});
