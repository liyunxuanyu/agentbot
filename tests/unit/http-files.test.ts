import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "../../src/server/core/db/db.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import { createAssignmentRunner } from "../../src/server/core/assignment/runner.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { buildServer } from "../../src/server/http/server.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * 文件查看 / diff 端点（2026-10-28 移动端反馈）。
 *
 * 这里**不起真实运行时**：只验证 HTTP 层的工作区解析、路径边界与 git 读取。
 * 用一个最小声明把 Bot 绑到内置协议上（`resolveRuntime` 返回 null 即可，
 * 这些端点不碰运行时）。
 */

let root = "";
let workspace = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentbot-files-"));
  workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "note.txt"), "hello\n");
  writeFileSync(join(workspace, "other.txt"), "outside\n");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  writeFileSync(join(workspace, "sub", "deep.txt"), "deep\n");
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "secret.txt"), "secret\n");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 句柄未释放时忽略
  }
});

const DECL = {
  schemaVersion: 1 as const,
  id: "builtin",
  displayName: "内置引擎",
  protocol: "builtin" as const,
  launch: { command: "(内置)", args: [] },
  detect: { versionArgs: [], versionPattern: "x" },
  capabilities: {
    plan: true,
    permissionRequest: true,
    resume: true,
    images: false,
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: [],
  permission: { channel: "internal" as const, defaultTimeoutPolicy: "reject" as const },
  resumeStrategy: "native" as const,
  executionLocations: ["local" as const],
};

interface Ctx {
  app: FastifyInstance;
  base: string;
  close(): Promise<void>;
}

async function boot(): Promise<Ctx> {
  const db = openDb(":memory:");
  const now = Date.now();
  const botId = "bot_files";
  const channelId = "ch_files";
  const sessionId = "sess_files";

  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, command, protocol, capabilities,
        event_capabilities, health_status, created_at)
     VALUES ('builtin', 'builtin', '内置引擎', 'builtin', '(内置)', 'builtin', ?, '[]', 'ready', ?)`,
  ).run(JSON.stringify(DECL.capabilities), now);
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, default_runtime_id, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, '读手', '', 'builtin', 'local', ?, 'active', '[]', 0, 0, 0, ?, ?)`,
  ).run(botId, workspace, now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
     VALUES (?, ?, ?, 'builtin', 'fresh', 'created', ?)`,
  ).run(sessionId, botId, channelId, now);

  const bus = createEventBus({ ringSize: 50 });
  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime: () => null,
    idleReapMs: 0,
    log: () => undefined,
  });
  const permissions = createPermissionResolver({
    db,
    bus,
    isSessionAlive: () => false,
    sessionCwdOf: () => workspace,
    respond: async () => false,
    setHeld: () => undefined,
    setSessionStatus: () => undefined,
    log: () => undefined,
  });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock: createSessionLock(),
    resolveRuntime: () => null,
    supervisor,
  });
  const app = buildServer(
    {
      db,
      runtimes: [],
      schemaVersion: 1,
      startedAt: now,
      resolveRuntime: () => null,
      orchestrator,
      permissions,
      assignments: createAssignmentRunner({
        db,
        orchestrator,
        isRuntimeAvailable: () => false,
        log: () => undefined,
      }),
    },
    { authEnabled: false, webRoot: join(root, "no-web") },
  );
  const base = await listenEphemeral(app);
  return {
    app,
    base,
    async close() {
      await app.close();
      permissions.dispose();
      db.close();
    },
  };
}

describe("GET /api/files", () => {
  it("读工作区内的文本文件", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/files?botId=bot_files&sessionId=sess_files&path=note.txt`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; size: number; path: string };
    expect(body.content).toBe("hello\n");
    expect(body.size).toBe(6);
    expect(body.path).toBe("note.txt");
    await ctx.close();
  });

  it("子目录文件可读", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/files?botId=bot_files&path=sub/deep.txt`);
    expect(res.status).toBe(200);
    await ctx.close();
  });

  it("`..` 越出工作区 → 403（不泄露文件）", async () => {
    const ctx = await boot();
    const res = await fetch(
      `${ctx.base}/api/files?botId=bot_files&path=${encodeURIComponent("../outside/secret.txt")}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_outside_workspace");
    await ctx.close();
  });

  it("绝对路径指到工作区外 → 403", async () => {
    const ctx = await boot();
    const res = await fetch(
      `${ctx.base}/api/files?botId=bot_files&path=${encodeURIComponent(join(root, "outside", "secret.txt"))}`,
    );
    expect(res.status).toBe(403);
    await ctx.close();
  });

  it("文件不存在 → 404；目录 → 400；缺 path → 400", async () => {
    const ctx = await boot();
    expect((await fetch(`${ctx.base}/api/files?botId=bot_files&path=nope.txt`)).status).toBe(404);
    expect((await fetch(`${ctx.base}/api/files?botId=bot_files&path=sub`)).status).toBe(400);
    expect((await fetch(`${ctx.base}/api/files?botId=bot_files`)).status).toBe(400);
    await ctx.close();
  });

  it("Bot 不存在 → 404", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/files?botId=bot_none&path=note.txt`);
    expect(res.status).toBe(404);
    await ctx.close();
  });
});

describe("GET /api/files/tree", () => {
  it("列出工作区文件，跳过 .git 与 node_modules", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/files/tree?botId=bot_files&sessionId=sess_files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { path: string; type: string }[]; truncated: boolean };
    const paths = body.entries.map((e) => e.path);
    expect(paths).toContain("note.txt");
    expect(paths).toContain("sub/deep.txt");
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(body.truncated).toBe(false);
    await ctx.close();
  });
});

describe("GET /api/files/changes", () => {
  it("非 git 目录：如实回 git:false，不编造改动", async () => {
    const ctx = await boot();
    const res = await fetch(`${ctx.base}/api/files/changes?botId=bot_files&sessionId=sess_files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { git: boolean; files: unknown[]; message?: string };
    expect(body.git).toBe(false);
    expect(body.files).toEqual([]);
    expect(body.message).toContain("不是 git 仓库");
    await ctx.close();
  });
});

describe("GET /api/files/changes（git 仓库）", () => {
  it("列出改动并给出单文件 diff（含未跟踪文件）", async () => {
    const { execFileSync } = await import("node:child_process");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const run = (args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    try {
      run(["init"]);
      run(["config", "user.email", "t@t"]);
      run(["config", "user.name", "t"]);
      writeFileSync(join(repo, "a.txt"), "one\n");
      run(["add", "-A"]);
      run(["commit", "-m", "init"]);
    } catch {
      // 环境没有 git：跳过（CI 与本机都有，Windows 也装了 Git for Windows）
      return;
    }

    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");

    const db = openDb(":memory:");
    const now = Date.now();
    db.prepare(
      `INSERT INTO runtime_definitions
         (id, adapter_name, display_name, source, command, protocol, capabilities,
          event_capabilities, health_status, created_at)
       VALUES ('builtin', 'builtin', '内置引擎', 'builtin', '(内置)', 'builtin', ?, '[]', 'ready', ?)`,
    ).run(JSON.stringify(DECL.capabilities), now);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, host_channel, created_at)
       VALUES ('ch_repo', 'dm', '私聊', '["bot_repo"]', NULL, ?)`.replace("host_channel", "host_bot_id"),
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, name, persona, default_runtime_id, execution_location, repo_path, status,
                         allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
       VALUES ('bot_repo', '写手', '', 'builtin', 'local', ?, 'active', '[]', 0, 0, 0, ?, ?)`,
    ).run(repo, now, now);
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
       VALUES ('sess_repo', 'bot_repo', 'ch_repo', 'builtin', 'fresh', 'created', ?)`,
    ).run(now);

    const bus = createEventBus({ ringSize: 10 });
    const supervisor = createSupervisor({ db, bus, resolveRuntime: () => null, idleReapMs: 0, log: () => undefined });
    const permissions = createPermissionResolver({
      db,
      bus,
      isSessionAlive: () => false,
      sessionCwdOf: () => repo,
      respond: async () => false,
      setHeld: () => undefined,
      setSessionStatus: () => undefined,
      log: () => undefined,
    });
    const orchestrator = createTurnOrchestrator({
      db,
      bus,
      lock: createSessionLock(),
      resolveRuntime: () => null,
      supervisor,
    });
    const app = buildServer(
      {
        db,
        runtimes: [],
        schemaVersion: 1,
        startedAt: now,
        resolveRuntime: () => null,
        orchestrator,
        permissions,
        assignments: createAssignmentRunner({ db, orchestrator, isRuntimeAvailable: () => false, log: () => undefined }),
      },
      { authEnabled: false, webRoot: join(root, "no-web") },
    );
    const base = await listenEphemeral(app);

    const list = await fetch(`${base}/api/files/changes?botId=bot_repo&sessionId=sess_repo`);
    const listBody = (await list.json()) as {
      git: boolean;
      files: { path: string; status: string }[];
    };
    expect(listBody.git).toBe(true);
    const paths = listBody.files.map((f) => f.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("new.txt");

    const one = await fetch(`${base}/api/files/changes?botId=bot_repo&sessionId=sess_repo&path=a.txt`);
    const diffBody = (await one.json()) as { diff: string; status: string };
    expect(diffBody.diff).toContain("-one");
    expect(diffBody.diff).toContain("+two");

    // 未跟踪文件按「全文新增」合成 diff：必须带 /dev/null 头、不能多出尾部空行、
    // 增删行数要一起给（git 的 numstat 不统计未跟踪文件）
    const untracked = await fetch(`${base}/api/files/changes?botId=bot_repo&sessionId=sess_repo&path=new.txt`);
    const untrackedBody = (await untracked.json()) as {
      diff: string;
      insertions: number | null;
      deletions: number | null;
    };
    expect(untrackedBody.diff).toContain("+fresh");
    expect(untrackedBody.diff.startsWith("--- /dev/null\n+++ b/new.txt\n")).toBe(true);
    // 文件以换行结尾：只有一行新增，不能凭空多出一条空 `+`
    expect(untrackedBody.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toEqual([
      "+fresh",
    ]);
    expect(untrackedBody.insertions).toBe(1);
    expect(untrackedBody.deletions).toBe(0);

    // 列表视图不应为每个文件跑 git diff：只回路径与增删行数（diff 字段不出现）
    const listBody2 = (await (await fetch(`${base}/api/files/changes?botId=bot_repo&sessionId=sess_repo`)).json()) as {
      files: { path: string; insertions: number | null }[];
    };
    const newEntry = listBody2.files.find((f) => f.path === "new.txt");
    expect(newEntry?.insertions).toBe(1);

    await app.close();
    permissions.dispose();
    db.close();
  }, 20000);
});
