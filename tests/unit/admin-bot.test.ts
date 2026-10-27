import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { buildServer } from "../../src/server/http/server.js";
import type { ServerContext } from "../../src/server/http/server.js";
import { seedAdminBot, ADMIN_SEED_MARKER, ADMIN_BOT_NAME } from "../../src/server/core/bots/seed.js";
import { createBot } from "../../src/server/core/bots/create.js";
import { createCreateBotTool } from "../../src/server/core/agent/tools/builtin/create_bot.js";
import { runAgentLoop } from "../../src/server/core/agent/loop.js";
import type {
  ChatMessage,
  ProviderClient,
  ProviderCompletion,
  ProviderDelta,
  ProviderRequest,
} from "../../src/server/core/agent/provider.js";
import {
  createToolRegistry,
  type ToolContext,
  type ToolDefinition,
} from "../../src/server/core/agent/tools/registry.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * M3 / R6：管理员 Bot。
 *
 * 三块风险点各测一条：
 *   ① `create_bot` 必须走权限门禁（confirm 弹卡）—— 拒绝时创建逻辑一次都不能被调；
 *   ② 种子只在「空库 + 有供应商」时执行一次，删光 Bot 后重启不再冒出来；
 *   ③ `PATCH /api/bots/:id { role }` 改角色并写审计，不顺手放大权限边界。
 */

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-admin-"));
});
afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄占用
  }
});

const NOW = Date.now();

function newDb(): DB {
  return openDb(":memory:");
}

function insertBuiltinRuntime(db: DB): void {
  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, command, protocol, capabilities,
        event_capabilities, health_status, created_at)
     VALUES ('builtin', 'builtin', '内置引擎', 'builtin', 'internal', 'builtin', ?, '[]', 'ready', ?)`,
  ).run(JSON.stringify({ plan: true, permissionRequest: true, streaming: true }), NOW);
}

function toolCtx(
  overrides: Partial<ToolContext> & Pick<ToolContext, "askPermission">,
): ToolContext {
  return {
    cwd: workDir,
    signal: new AbortController().signal,
    permissionMode: "confirm",
    botRole: "admin",
    ...overrides,
  };
}

/** 只投递一次工具调用、之后正常收尾的假 provider。 */
class OneToolCallProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  private served = false;

  constructor(
    private readonly name: string,
    private readonly args: Record<string, unknown>,
  ) {}

  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    if (!this.served) {
      this.served = true;
      yield {
        kind: "tool_call",
        call: {
          id: "call_create_bot",
          name: this.name,
          args: this.args,
          rawArguments: JSON.stringify(this.args),
        },
      };
      yield { kind: "finish", reason: "tool_calls" };
      return;
    }
    yield { kind: "text", text: "已完成" };
    yield { kind: "finish", reason: "stop" };
  }

  async complete(_req: ProviderRequest): Promise<ProviderCompletion> {
    throw new Error("测试不支持非流式降级");
  }
}

/** 走真实 agent loop 调一次工具，记录 loop 发起的权限询问。 */
async function runToolViaLoop(
  tool: ToolDefinition,
  approve: boolean,
): Promise<{ asked: { action: string; target: string }[]; messages: ChatMessage[] }> {
  const asked: { action: string; target: string }[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "请创建一个 Bot" }];
  const result = await runAgentLoop({
    provider: new OneToolCallProvider(tool.name, { name: "研究员" }),
    registry: createToolRegistry([tool]),
    messages,
    cwd: workDir,
    signal: new AbortController().signal,
    botRole: "admin",
    callbacks: {
      onTextDelta: () => undefined,
      onReasoningDelta: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onUsage: () => undefined,
      async askPermission(req) {
        asked.push({ action: req.action, target: req.target });
        return approve;
      },
    },
  });
  expect(result.stopReason).toBe("end");
  return { asked, messages };
}

// ---------------------------------------------------------------------------
// create_bot 工具
// ---------------------------------------------------------------------------

describe("create_bot 工具（R6 / G4）", () => {
  it("管理员 → 调用创建逻辑并回执名称与 id；权限询问只由 loop 发起", async () => {
    const calls: unknown[] = [];
    const tool = createCreateBotTool((input) => {
      calls.push(input);
      return { ok: true, botId: "bot_new", name: input.name };
    });

    let asked = 0;
    const result = await tool.execute(
      toolCtx({
        async askPermission() {
          asked += 1;
          return false;
        },
      }),
      { name: "研究员", persona: "负责调研", providerId: "p1" },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("研究员");
    expect(result.output).toContain("bot_new");
    expect(calls).toEqual([
      { name: "研究员", persona: "负责调研", providerId: "p1" },
    ]);
    // 回归：工具自己再问一次会落两张 admin 卡，第二张永远 pending、轮次收不了口
    expect(asked).toBe(0);
  });

  it("非管理员 → 直接拒绝，不进入创建逻辑", async () => {
    let called = 0;
    let asked = 0;
    const tool = createCreateBotTool(() => {
      called += 1;
      return { ok: true, botId: "bot_new", name: "x" };
    });

    const result = await tool.execute(
      toolCtx({
        botRole: "member",
        async askPermission() {
          asked += 1;
          return true;
        },
      }),
      { name: "普通 Bot 建不了" },
    );

    expect(result.ok).toBe(false);
    expect(called).toBe(0);
    expect(asked).toBe(0);
    expect(result.error).toContain("管理员");
  });

  it("参数缺失 → 不进入创建逻辑", async () => {
    let called = 0;
    const tool = createCreateBotTool(() => {
      called += 1;
      return { ok: true, botId: "x", name: "x" };
    });
    const result = await tool.execute(toolCtx({ askPermission: async () => true }), { name: "   " });
    expect(result.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("经 loop 调用：一次工具调用只产生一次 admin 权限请求，批准后创建", async () => {
    const calls: unknown[] = [];
    const tool = createCreateBotTool((input) => {
      calls.push(input);
      return { ok: true, botId: "bot_new", name: input.name };
    });

    const { asked, messages } = await runToolViaLoop(tool, true);

    expect(asked).toEqual([{ action: "admin", target: "研究员" }]);
    expect(calls).toHaveLength(1);
    expect(messages.find((m) => m.role === "tool")?.content).toContain("bot_new");
  });

  it("经 loop 调用：用户拒绝 → 创建逻辑一次都不执行，回执可操作话术", async () => {
    let called = 0;
    const tool = createCreateBotTool(() => {
      called += 1;
      return { ok: true, botId: "bot_new", name: "x" };
    });

    const { asked, messages } = await runToolViaLoop(tool, false);

    expect(asked).toEqual([{ action: "admin", target: "研究员" }]);
    expect(called).toBe(0);
    expect(messages.find((m) => m.role === "tool")?.content).toContain("用户拒绝");
  });
});

// ---------------------------------------------------------------------------
// 管理员种子
// ---------------------------------------------------------------------------

describe("管理员种子（Q16）", () => {
  it("没有供应商 → 跳过，不写标记；配好供应商后再启动能补种", () => {
    const db = newDb();
    try {
      insertBuiltinRuntime(db);
      const first = seedAdminBot(db, {
        hasProviders: false,
        runtimeId: "builtin",
        log: () => undefined,
      });
      expect(first).toEqual({ seeded: false, reason: "no_provider" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number }).n).toBe(0);

      // 没有写标记：下一次（已配供应商）仍会尝试
      const marker = db
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .get(ADMIN_SEED_MARKER);
      expect(marker).toBeUndefined();

      const second = seedAdminBot(db, {
        hasProviders: true,
        runtimeId: "builtin",
        log: () => undefined,
      });
      expect(second.seeded).toBe(true);
      const bot = db
        .prepare("SELECT name, role, permission_mode FROM bots WHERE id = ?")
        .get(second.botId) as { name: string; role: string; permission_mode: string };
      expect(bot).toEqual({ name: ADMIN_BOT_NAME, role: "admin", permission_mode: "confirm" });
    } finally {
      db.close();
    }
  });

  it("只执行一次：第二次调用直接 already_seeded，删光 Bot 后也不会再冒出来", () => {
    const db = newDb();
    try {
      insertBuiltinRuntime(db);
      const first = seedAdminBot(db, {
        hasProviders: true,
        runtimeId: "builtin",
        log: () => undefined,
      });
      expect(first.seeded).toBe(true);

      const second = seedAdminBot(db, {
        hasProviders: true,
        runtimeId: "builtin",
        log: () => undefined,
      });
      expect(second).toEqual({ seeded: false, reason: "already_seeded" });

      // 用户删光 Bot 后重启：标记仍在，不再种
      db.prepare("DELETE FROM bots").run();
      const third = seedAdminBot(db, {
        hasProviders: true,
        runtimeId: "builtin",
        log: () => undefined,
      });
      expect(third).toEqual({ seeded: false, reason: "already_seeded" });
    } finally {
      db.close();
    }
  });

  it("已有 Bot → 不替用户做决定", () => {
    const db = newDb();
    try {
      insertBuiltinRuntime(db);
      const created = createBot(
        db,
        { name: "用户自己的 Bot", runtimeId: "builtin" },
        {
          runtimeExists: () => true,
          runtimeRequiresWorktree: () => false,
          runtimeDisplayName: () => "内置引擎",
          providerExists: () => true,
        },
      );
      expect(created.outcome.ok).toBe(true);

      const result = seedAdminBot(db, {
        hasProviders: true,
        runtimeId: "builtin",
        log: () => undefined,
      });
      expect(result).toEqual({ seeded: false, reason: "has_bots" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// role 切换（HTTP）
// ---------------------------------------------------------------------------

interface Ctx {
  app: FastifyInstance;
  base: string;
  db: DB;
  close: () => Promise<void>;
}

async function boot(): Promise<Ctx> {
  const db = newDb();
  const app = buildServer(
    {
      db,
      runtimes: [],
      schemaVersion: 3,
      startedAt: NOW,
      resolveRuntime: () => null,
      // PATCH /api/bots/:id 不触达这三个依赖；给最小桩，避免把整个进程装起来
      orchestrator: {} as ServerContext["orchestrator"],
      permissions: { dispose: () => undefined } as unknown as ServerContext["permissions"],
      assignments: { stop: () => undefined } as unknown as ServerContext["assignments"],
    },
    { authEnabled: false, webRoot: join(workDir, "no-web") },
  );
  const base = await listenEphemeral(app);
  return {
    app,
    base,
    db,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

async function patchJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("角色切换（R6）", () => {
  let ctx: Ctx | null = null;

  afterEach(async () => {
    await ctx?.close();
    ctx = null;
    vi.restoreAllMocks();
  });

  it("PATCH role=admin → 落库并写审计；切回 member 同样生效", async () => {
    ctx = await boot();
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO bots (id, name, persona, execution_location, repo_path, status,
                           allow_dirs, allow_shell, allow_network, auto_approve_write,
                           created_at, updated_at)
         VALUES ('b1', '候选管理员', '', 'local', NULL, 'active', '[]', 0, 0, 0, ?, ?)`,
      )
      .run(now, now);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    const promoted = await patchJson(ctx.base, "/api/bots/b1", { role: "admin" });
    expect(promoted.status).toBe(200);
    expect(promoted.body["role"]).toBe("admin");
    expect(
      (ctx.db.prepare("SELECT role FROM bots WHERE id = 'b1'").get() as { role: string }).role,
    ).toBe("admin");
    expect(logs.some((line) => line.includes("[audit]") && line.includes("admin"))).toBe(true);

    // 角色切换不放宽权限边界（G4）
    const bot = ctx.db
      .prepare("SELECT permission_mode, allow_shell, allow_network FROM bots WHERE id = 'b1'")
      .get() as { permission_mode: string; allow_shell: number; allow_network: number };
    expect(bot).toEqual({ permission_mode: "confirm", allow_shell: 0, allow_network: 0 });

    const demoted = await patchJson(ctx.base, "/api/bots/b1", { role: "member" });
    expect(demoted.status).toBe(200);
    expect(demoted.body["role"]).toBe("member");
  });

  it("非法 role → 400，不改库", async () => {
    ctx = await boot();
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO bots (id, name, persona, execution_location, repo_path, status,
                           allow_dirs, allow_shell, allow_network, auto_approve_write,
                           created_at, updated_at)
         VALUES ('b2', '普通 Bot', '', 'local', NULL, 'active', '[]', 0, 0, 0, ?, ?)`,
      )
      .run(now, now);

    const res = await patchJson(ctx.base, "/api/bots/b2", { role: "owner" });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("invalid_boundary");
    expect(
      (ctx.db.prepare("SELECT role FROM bots WHERE id = 'b2'").get() as { role: string }).role,
    ).toBe("member");
  });

  it("GET /api/admin/bots 只返回管理员，并带总 Bot 数", async () => {
    ctx = await boot();
    const now = Date.now();
    const insert = ctx.db.prepare(
      `INSERT INTO bots (id, name, persona, role, execution_location, repo_path, status,
                         allow_dirs, allow_shell, allow_network, auto_approve_write,
                         created_at, updated_at)
       VALUES (?, ?, '', ?, 'local', NULL, 'active', '[]', 0, 0, 0, ?, ?)`,
    );
    insert.run("b_admin", "管理员", "admin", now, now);
    insert.run("b_member", "成员", "member", now, now);

    const res = await fetch(`${ctx.base}/api/admin/bots`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bots: { id: string; role: string }[];
      totalBots: number;
    };
    expect(body.totalBots).toBe(2);
    expect(body.bots.map((b) => b.id)).toEqual(["b_admin"]);
  });
});
