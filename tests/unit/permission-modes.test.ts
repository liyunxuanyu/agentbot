import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import type { PermissionDecision } from "../../src/server/adapters/contract.js";
import type { PermissionAction } from "../../src/shared/events.js";
import { createBuiltinDriver } from "../../src/server/adapters/channels/builtin/driver.js";
import { clearTurnContext, setTurnContext } from "../../src/server/adapters/turn-context.js";
import type { AdapterDeclaration } from "../../src/server/adapters/contract.js";
import type { ToolDefinition } from "../../src/server/core/agent/tools/registry.js";
import type {
  ProviderClient,
  ProviderCompletion,
  ProviderConfig,
  ProviderDelta,
  ProviderRequest,
} from "../../src/server/core/agent/provider.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * M2 / R4 / R5：四档权限模式、会话内模型热切换、计划模式工具裁剪。
 *
 * 权限矩阵直接打 resolver（它是唯一裁决入口）：四档 × 写/执行/联网/管理
 * 逐格断言状态、decided_by 与「有没有回传运行时」。驱动层再补两条只有
 * 真实一轮 agent loop 才看得到的：plan 的工具列表被裁、模型覆盖只影响后续轮次。
 */

const NOW = Date.now();
let root = "";
let allowedDir = "";
let outsideDir = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentbot-modes-"));
  allowedDir = join(root, "allowed");
  outsideDir = join(root, "outside");
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 句柄偶发未释放
  }
});

// ---------------------------------------------------------------------------
// 四档 × 动作矩阵
// ---------------------------------------------------------------------------

interface Fixture {
  db: DB;
  resolver: ReturnType<typeof createPermissionResolver>;
  responded: { requestId: string; decision: PermissionDecision }[];
  request(action: PermissionAction, target: string): Promise<void>;
  rowOf(requestId: string): {
    status: string;
    decision: string | null;
    decided_by: string | null;
    boundary_verdict: string;
    target: string;
  };
  close(): void;
}

const modes = ["confirm", "auto", "plan", "full"] as const;

async function fixtureFor(mode: (typeof modes)[number]): Promise<Fixture> {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write,
                       permission_mode, created_at, updated_at)
     VALUES ('b1', '执行者', '', 'local', ?, 'active', ?, 1, 1, 0, ?, ?, ?)`,
  ).run(allowedDir, JSON.stringify([allowedDir]), mode, NOW, NOW);
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
     VALUES ('ch1', 'dm', '私聊', '["b1"]', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, status, permission_mode, started_at)
     VALUES ('s1', 'b1', 'ch1', 'running', ?, ?)`,
  ).run(mode, NOW);

  const responded: { requestId: string; decision: PermissionDecision }[] = [];
  const resolver = createPermissionResolver({
    db,
    bus: createEventBus({ ringSize: 20 }),
    isSessionAlive: () => true,
    sessionCwdOf: () => allowedDir,
    respond: async (_s, requestId, decision) => {
      responded.push({ requestId, decision });
      return true;
    },
    setHeld: () => undefined,
    setSessionStatus: () => undefined,
    log: () => undefined,
  });

  let counter = 0;
  return {
    db,
    resolver,
    responded,
    async request(action, target) {
      counter += 1;
      await resolver.handle({
        sessionId: "s1",
        botId: "b1",
        turnId: `t${counter}`,
        request: { requestId: `r${counter}`, action, target },
        source: "interactive",
      });
    },
    rowOf(requestId) {
      const row = db.prepare("SELECT * FROM permission_requests WHERE id = ?").get(requestId) as
        | {
            status: string;
            decision: string | null;
            decided_by: string | null;
            boundary_snapshot: string;
            target: string;
          }
        | undefined;
      if (!row) throw new Error(`权限记录不存在：${requestId}`);
      const snapshot = JSON.parse(row.boundary_snapshot) as { verdict?: string };
      return {
        status: row.status,
        decision: row.decision,
        decided_by: row.decided_by,
        boundary_verdict: snapshot.verdict ?? "unknown",
        target: row.target,
      };
    },
    close() {
      resolver.dispose();
      db.close();
    },
  };
}

describe("四档权限模式矩阵", () => {
  it("confirm：边界内的写/执行/联网/管理都弹卡等待用户", async () => {
    const f = await fixtureFor("confirm");
    try {
      await f.request("write", join(allowedDir, "a.md"));
      await f.request("exec", "echo hi");
      await f.request("network", "example.com");
      await f.request("admin", "创建 Bot：小助手");

      const rows = f.db
        .prepare("SELECT id, action, status FROM permission_requests ORDER BY created_at ASC")
        .all() as { id: string; action: string; status: string }[];
      expect(rows.map((r) => r.action)).toEqual(["write", "exec", "network", "admin"]);
      expect(rows.every((r) => r.status === "pending")).toBe(true);
      expect(f.responded).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("auto：边界内写自动批准并留审计；执行/联网/管理仍然问", async () => {
    const f = await fixtureFor("auto");
    try {
      await f.request("write", join(allowedDir, "a.md"));
      const write = f.rowOf("r1");
      expect(write.status).toBe("decided");
      expect(write.decision).toBe("approve");
      expect(write.decided_by).toBe("mode:auto");
      expect(f.responded).toEqual([
        { requestId: "r1", decision: { kind: "approve", scope: "once" } },
      ]);

      await f.request("exec", "echo hi");
      await f.request("network", "example.com");
      await f.request("admin", "创建 Bot：小助手");
      expect(["r2", "r3", "r4"].map((id) => f.rowOf(id).status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
    } finally {
      f.close();
    }
  });

  it("auto：边界外的写仍直接拒绝（不弹卡、不转发）", async () => {
    const f = await fixtureFor("auto");
    try {
      await f.request("write", join(outsideDir, "a.md"));
      const row = f.rowOf("r1");
      expect(row.status).toBe("denied_boundary");
      expect(f.responded[0]?.decision.kind).toBe("deny");
    } finally {
      f.close();
    }
  });

  it("plan：写/执行/联网/管理一律拒绝并回传 deny；读自动批准", async () => {
    const f = await fixtureFor("plan");
    try {
      await f.request("write", join(allowedDir, "a.md"));
      await f.request("exec", "echo hi");
      await f.request("network", "example.com");
      await f.request("admin", "创建 Bot：小助手");

      for (const id of ["r1", "r2", "r3", "r4"]) {
        const row = f.rowOf(id);
        expect(row.status).toBe("denied_mode");
        expect(row.decision).toBe("reject");
        expect(row.decided_by).toBe("mode:plan");
      }
      expect(f.responded.map((r) => r.decision.kind)).toEqual(["deny", "deny", "deny", "deny"]);

      await f.request("read", join(outsideDir, "secret.txt"));
      const read = f.rowOf("r5");
      expect(read.status).toBe("decided");
      expect(read.decision).toBe("approve");
      expect(read.decided_by).toBe("mode:plan");
    } finally {
      f.close();
    }
  });

  it("full：绕过 Bot 边界，四类动作全部批准并逐条写审计", async () => {
    const f = await fixtureFor("full");
    try {
      await f.request("write", join(outsideDir, "a.md"));
      await f.request("exec", "rm -rf /tmp/whatever");
      await f.request("network", "example.com");
      await f.request("admin", "创建 Bot：小助手");

      for (const id of ["r1", "r2", "r3", "r4"]) {
        const row = f.rowOf(id);
        expect(row.status).toBe("decided");
        expect(row.decision).toBe("approve");
        expect(row.decided_by).toBe("mode:full");
        expect(row.boundary_verdict).toBe("allowed");
      }
      expect(f.responded.map((r) => r.decision.kind)).toEqual([
        "approve",
        "approve",
        "approve",
        "approve",
      ]);
      const count = f.db
        .prepare("SELECT COUNT(*) AS n FROM permission_requests WHERE status = 'decided'")
        .get() as { n: number };
      expect(count.n).toBe(4);
    } finally {
      f.close();
    }
  });

  it("切到 plan 时挂起的写类请求立即置 rejected（读请求不动）", async () => {
    const f = await fixtureFor("confirm");
    try {
      await f.request("write", join(allowedDir, "a.md"));
      await f.request("read", join(allowedDir, "a.md"));
      expect(f.rowOf("r1").status).toBe("pending");
      expect(f.rowOf("r2").status).toBe("pending");

      f.db.prepare("UPDATE sessions SET permission_mode = 'plan' WHERE id = 's1'").run();
      const rejected = f.resolver.rejectPendingWrites("s1", "已切换到计划模式（只读）");
      expect(rejected).toBe(1);
      expect(f.rowOf("r1").status).toBe("denied_mode");
      expect(f.rowOf("r2").status).toBe("pending");
    } finally {
      f.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 驱动层：计划模式裁工具、模型热切换
// ---------------------------------------------------------------------------

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "builtin",
  displayName: "内置引擎",
  protocol: "builtin",
  launch: { command: "x", args: [] },
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
  permission: { channel: "internal", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "native",
  executionLocations: ["local"],
};

class CapturingProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  readonly requests: ProviderRequest[] = [];
  constructor(private readonly scripts: ProviderDelta[][] = []) {}
  async *stream(req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    this.requests.push(req);
    const script = this.scripts.shift() ?? [
      { kind: "text", text: "好的" },
      { kind: "finish", reason: "stop" },
    ];
    for (const delta of script) yield delta;
  }
  async complete(): Promise<ProviderCompletion> {
    throw new Error("测试不支持降级");
  }
}

const PROVIDER: ProviderConfig = {
  id: "p1",
  name: "供应商一",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1:1",
  apiKey: "k",
  model: "base-model",
  contextWindow: null,
  maxOutputTokens: null,
  supportsTools: true,
  supportsStreaming: true,
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-modes-driver-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

function toolOf(name: string, permission: "read" | "write"): ToolDefinition {
  return {
    name,
    description: "test",
    parameters: { type: "object", properties: {} },
    permission,
    source: "builtin",
    async execute() {
      return { ok: true, output: `${name}-ok`, durationMs: 1 };
    },
  };
}

describe("计划模式工具裁剪（G3）", () => {
  it("plan：写类工具从 tools 列表消失，系统提示说明只读；读工具保留", async () => {
    const provider = new CapturingProvider();
    const driver = createBuiltinDriver({
      skillsDir: tempDir(),
      resolveProvider: () => PROVIDER,
      createClient: () => provider,
      tools: [toolOf("look", "read"), toolOf("mutate", "write")],
    });
    const h = await driver.start(DECL, {
      cwd: tempDir(),
      sessionId: "s_plan",
      botId: "b1",
      providerId: "p1",
    });
    driver.onEvent(h, () => undefined);
    await driver.newSession(h, { cwd: tempDir(), systemPrompt: "你是测试 Bot" });

    driver.setControls!(h, { permissionMode: "plan" });
    setTurnContext(h, { turnId: "t1", messageId: "m1", botId: "b1" });
    try {
      await driver.prompt(h, { text: "看看就好" });
    } finally {
      clearTurnContext(h);
    }

    const sent = provider.requests[0];
    const names = (sent?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["look"]);
    expect(sent?.messages[0]?.content).toContain("计划模式");
  });
});

describe("会话级模型热切换（R4）", () => {
  it("覆盖只影响后续轮次；清空后回落到供应商默认模型", async () => {
    const provider = new CapturingProvider();
    const configs: ProviderConfig[] = [];
    const driver = createBuiltinDriver({
      skillsDir: tempDir(),
      resolveProvider: () => PROVIDER,
      createClient: (cfg) => {
        configs.push(cfg);
        return provider;
      },
      tools: [],
    });
    const h = await driver.start(DECL, {
      cwd: tempDir(),
      sessionId: "s_model",
      botId: "b1",
      providerId: "p1",
    });
    driver.onEvent(h, () => undefined);
    await driver.newSession(h, { cwd: tempDir(), systemPrompt: "" });

    const say = async (text: string, turn: string): Promise<void> => {
      setTurnContext(h, { turnId: turn, messageId: `m_${turn}`, botId: "b1" });
      try {
        await driver.prompt(h, { text });
      } finally {
        clearTurnContext(h);
      }
    };

    await say("第一轮", "t1");
    expect(configs[0]?.model).toBe("base-model");

    driver.setControls!(h, { model: "fast-model" });
    await say("第二轮", "t2");
    expect(configs[1]?.model).toBe("fast-model");

    driver.setControls!(h, { model: null });
    await say("第三轮", "t3");
    expect(configs[2]?.model).toBe("base-model");
  });
});
