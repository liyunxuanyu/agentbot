import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinDriver } from "../../src/server/adapters/channels/builtin/driver.js";
import { setTurnContext, clearTurnContext } from "../../src/server/adapters/turn-context.js";
import { createWriteLock } from "../../src/server/core/group/write-lock.js";
import type {
  ProviderClient,
  ProviderCompletion,
  ProviderConfig,
  ProviderDelta,
  ProviderRequest,
} from "../../src/server/core/agent/provider.js";
import type { ToolDefinition } from "../../src/server/core/agent/tools/registry.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

class ScriptedProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  private index = 0;
  constructor(private readonly scripts: ProviderDelta[][]) {}
  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    const script = this.scripts[this.index++] ?? [{ kind: "finish", reason: "stop" }];
    for (const delta of script) yield delta;
  }
  async complete(_req: ProviderRequest): Promise<ProviderCompletion> {
    throw new Error("测试不支持降级");
  }
}

const PROVIDER: ProviderConfig = {
  id: "p1",
  name: "测试",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1:1",
  apiKey: "k",
  model: "m",
  contextWindow: null,
  maxOutputTokens: null,
  supportsTools: true,
  supportsStreaming: true,
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-driver-"));
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

function toolOf(executed: Record<string, unknown>[], permission: "read" | "write" = "write"): ToolDefinition {
  return {
    name: "act",
    description: "test",
    parameters: { type: "object", properties: {} },
    permission,
    source: "builtin",
    async execute(_ctx, args) {
      executed.push(args);
      return { ok: true, output: "tool-ok", durationMs: 1 };
    },
  };
}

async function runDriver(options: {
  scripts: ProviderDelta[][];
  tools: ToolDefinition[];
  onPermission?: (driver: ReturnType<typeof createBuiltinDriver>, h: Parameters<typeof setTurnContext>[0], req: { requestId: string }) => void;
}): Promise<{ events: CanonicalEvent[]; text: string }> {
  const events: CanonicalEvent[] = [];
  const driver = createBuiltinDriver({
    skillsDir: tempDir(),
    resolveProvider: () => PROVIDER,
    createClient: () => new ScriptedProvider(options.scripts),
    tools: options.tools,
  });
  const h = await driver.start(
    {
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
    },
    { cwd: tempDir(), sessionId: "s1", botId: "b1", providerId: "p1" },
  );
  driver.onEvent(h, (e) => events.push(e));
  driver.onPermission(h, (req) => {
    options.onPermission?.(driver, h, req);
  });
  await driver.newSession(h, { cwd: tempDir(), systemPrompt: "你是测试 Bot" });
  setTurnContext(h, { turnId: "t1", messageId: "m1", botId: "b1" });
  try {
    await driver.prompt(h, { text: "hi" });
  } finally {
    clearTurnContext(h);
  }
  const text = events
    .filter((e) => e.type === "message_delta")
    .map((e) => (e.payload as { text: string }).text)
    .join("");
  return { events, text };
}

describe("builtin driver", () => {
  it("流式文本 → message_delta start/delta/end + usage + done", async () => {
    const { events, text } = await runDriver({
      scripts: [
        [
          { kind: "text", text: "你好" },
          { kind: "usage", inputTokens: 3, outputTokens: 4, reported: true },
          { kind: "finish", reason: "stop" },
        ],
      ],
      tools: [],
    });
    expect(text).toBe("你好");
    const phases = events
      .filter((e) => e.type === "message_delta")
      .map((e) => (e.payload as { phase: string }).phase);
    expect(phases[0]).toBe("start");
    expect(phases).toContain("delta");
    expect(phases[phases.length - 1]).toBe("end");
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      payload: { inputTokens: 3, outputTokens: 4, reported: true, cumulative: false },
    });
    expect(events.find((e) => e.type === "done")).toMatchObject({
      payload: { stopReason: "end" },
    });
  });

  it("写工具先问权限，批准后执行并产出 tool_call/tool_result", async () => {
    const executed: Record<string, unknown>[] = [];
    const { events } = await runDriver({
      scripts: [
        [
          {
            kind: "tool_call",
            call: { id: "c1", name: "act", args: { path: "a" }, rawArguments: '{"path":"a"}' },
          },
          { kind: "finish", reason: "tool_calls" },
        ],
        [{ kind: "text", text: "完成" }, { kind: "finish", reason: "stop" }],
      ],
      tools: [toolOf(executed)],
      onPermission: (driver, h, req) => {
        void driver.respondPermission(h, req.requestId, { kind: "approve", scope: "once" });
      },
    });
    expect(executed).toEqual([{ path: "a" }]);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      payload: { callId: "c1", name: "act", status: "running" },
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      payload: { callId: "c1", status: "ok", output: "tool-ok" },
    });
    expect(events.find((e) => e.type === "done")).toMatchObject({ payload: { stopReason: "end" } });
  });

  it("拒绝后工具不执行，tool_result 是错误且整轮仍能正常结束", async () => {
    const executed: Record<string, unknown>[] = [];
    const { events } = await runDriver({
      scripts: [
        [
          {
            kind: "tool_call",
            call: { id: "c1", name: "act", args: { path: "a" }, rawArguments: '{"path":"a"}' },
          },
          { kind: "finish", reason: "tool_calls" },
        ],
        [{ kind: "text", text: "好的" }, { kind: "finish", reason: "stop" }],
      ],
      tools: [toolOf(executed)],
      onPermission: (driver, h, req) => {
        void driver.respondPermission(h, req.requestId, { kind: "deny" });
      },
    });
    expect(executed).toHaveLength(0);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      payload: { callId: "c1", status: "error" },
    });
    expect(events.find((e) => e.type === "done")).toMatchObject({ payload: { stopReason: "end" } });
  });

  it("没有供应商 → fatal provider_unavailable", async () => {
    const events: CanonicalEvent[] = [];
    const driver = createBuiltinDriver({
      skillsDir: tempDir(),
      resolveProvider: () => null,
      createClient: () => new ScriptedProvider([]),
      tools: [],
    });
    const h = await driver.start(
      {
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
      },
      { cwd: tempDir(), sessionId: "s2", botId: "b2" },
    );
    driver.onEvent(h, (e) => events.push(e));
    await driver.newSession(h, { cwd: tempDir() });
    setTurnContext(h, { turnId: "t2", messageId: "m2", botId: "b2" });
    await driver.prompt(h, { text: "hi" });
    clearTurnContext(h);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      payload: { code: "provider_unavailable", fatal: true },
    });
  });
});

// ---------------------------------------------------------------------------
// G7：同一渠道的写类工具串行（两个 Bot 并发写同一文件）
// ---------------------------------------------------------------------------

/** 记录执行区间的写工具：模拟真实写文件需要的耗时。 */
function slowWriteTool(spans: { who: string; start: number; end: number }[], who: string, ms: number): ToolDefinition {
  return {
    name: "act",
    description: "test",
    parameters: { type: "object", properties: {} },
    permission: "write",
    source: "builtin",
    async execute() {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      spans.push({ who, start, end: Date.now() });
      return { ok: true, output: "written", durationMs: Date.now() - start };
    },
  };
}

const BUILTIN_DECL_LOCAL = {
  schemaVersion: 1 as const,
  id: "builtin",
  displayName: "内置引擎",
  protocol: "builtin" as const,
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
  permission: { channel: "internal" as const, defaultTimeoutPolicy: "reject" as const },
  resumeStrategy: "native" as const,
  executionLocations: ["local" as const],
};

function twoToolScript(): ProviderDelta[][] {
  return [
    [
      { kind: "tool_call", call: { id: "c1", name: "act", args: { path: "same.txt" }, rawArguments: '{"path":"same.txt"}' } },
      { kind: "finish", reason: "tool_calls" },
    ],
    [{ kind: "text", text: "完成" }, { kind: "finish", reason: "stop" }],
  ];
}

describe("G7 写锁", () => {
  it("同一渠道两个 Bot 并发写：执行区间不重叠", async () => {
    const spans: { who: string; start: number; end: number }[] = [];
    const lock = createWriteLock();
    const cwd = tempDir();

    async function runBot(botId: string, sessionId: string, ms: number): Promise<void> {
      const driver = createBuiltinDriver({
        skillsDir: tempDir(),
        resolveProvider: () => PROVIDER,
        createClient: () => new ScriptedProvider(twoToolScript()),
        tools: [slowWriteTool(spans, botId, ms)],
        writeLock: lock,
      });
      const h = await driver.start(BUILTIN_DECL_LOCAL, {
        cwd,
        sessionId,
        botId,
        channelId: "ch_shared",
        providerId: "p1",
      });
      driver.onPermission(h, (req) => {
        void driver.respondPermission(h, req.requestId, { kind: "approve", scope: "once" });
      });
      await driver.newSession(h, { cwd, systemPrompt: "测试" });
      setTurnContext(h, { turnId: `t_${botId}`, messageId: `m_${botId}`, botId });
      try {
        await driver.prompt(h, { text: "写文件" });
      } finally {
        clearTurnContext(h);
      }
    }

    await Promise.all([runBot("b1", "s1", 50), runBot("b2", "s2", 20)]);

    expect(spans).toHaveLength(2);
    spans.sort((a, b) => a.start - b.start);
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  });

  it("不同渠道的两个 Bot 仍并行（写锁按渠道隔离）", async () => {
    const spans: { who: string; start: number; end: number }[] = [];
    const lock = createWriteLock();
    const cwd = tempDir();

    async function runBot(botId: string, sessionId: string, channelId: string): Promise<void> {
      const driver = createBuiltinDriver({
        skillsDir: tempDir(),
        resolveProvider: () => PROVIDER,
        createClient: () => new ScriptedProvider(twoToolScript()),
        tools: [slowWriteTool(spans, botId, 50)],
        writeLock: lock,
      });
      const h = await driver.start(BUILTIN_DECL_LOCAL, {
        cwd,
        sessionId,
        botId,
        channelId,
        providerId: "p1",
      });
      driver.onPermission(h, (req) => {
        void driver.respondPermission(h, req.requestId, { kind: "approve", scope: "once" });
      });
      await driver.newSession(h, { cwd, systemPrompt: "测试" });
      setTurnContext(h, { turnId: `t_${botId}`, messageId: `m_${botId}`, botId });
      try {
        await driver.prompt(h, { text: "写文件" });
      } finally {
        clearTurnContext(h);
      }
    }

    const started = Date.now();
    await Promise.all([runBot("b1", "s1", "chA"), runBot("b2", "s2", "chB")]);
    const elapsed = Date.now() - started;

    expect(spans).toHaveLength(2);
    // 并行：两个 50ms 的写操作若串行会 ≥100ms
    expect(elapsed).toBeLessThan(95);
  });

  it("读类工具不被写锁影响：并发读仍然并行", async () => {
    const lock = createWriteLock();
    // 用一个占位的长写操作占住渠道
    const hold = lock.run("ch_read", () => new Promise<void>((r) => setTimeout(r, 80)));
    await new Promise((r) => setTimeout(r, 5));

    let readEnded: number | null = null;
    const started = Date.now();
    const driver = createBuiltinDriver({
      skillsDir: tempDir(),
      resolveProvider: () => PROVIDER,
      createClient: () =>
        new ScriptedProvider([
          [{ kind: "tool_call", call: { id: "c1", name: "act", args: {}, rawArguments: "{}" } }, { kind: "finish", reason: "tool_calls" }],
          [{ kind: "finish", reason: "stop" }],
        ]),
      tools: [
        {
          name: "act",
          description: "read",
          parameters: { type: "object", properties: {} },
          permission: "read",
          source: "builtin",
          async execute() {
            readEnded = Date.now();
            return { ok: true, output: "read-ok", durationMs: 0 };
          },
        },
      ],
      writeLock: lock,
    });
    const h = await driver.start(BUILTIN_DECL_LOCAL, {
      cwd: tempDir(),
      sessionId: "s_read",
      botId: "b1",
      channelId: "ch_read",
      providerId: "p1",
    });
    await driver.newSession(h, { cwd: tempDir(), systemPrompt: "测试" });
    setTurnContext(h, { turnId: "t_read", messageId: "m_read", botId: "b1" });
    try {
      await driver.prompt(h, { text: "读" });
    } finally {
      clearTurnContext(h);
    }

    // 读操作在写锁被占用的 80ms 内就完成了
    expect(readEnded).not.toBeNull();
    expect((readEnded ?? 0) - started).toBeLessThan(60);
    await hold;
  });
});

// ---------------------------------------------------------------------------
// R5-c：计划模式下 MCP 写类工具被裁掉，读类保留
// ---------------------------------------------------------------------------

/** 最小 MCP 管理器桩：只实现驱动用到的 `tools()`。 */
function fakeMcp(toolList: ToolDefinition[]): { tools: () => ToolDefinition[] } {
  return { tools: () => toolList };
}

function mcpTool(name: string, permission: "read" | "exec" | "write" | "network"): ToolDefinition {
  return {
    name,
    description: "mcp stub",
    parameters: { type: "object", properties: {} },
    permission,
    source: "mcp",
    mcp: { server: "stub", tool: name },
    async execute() {
      return { ok: true, output: "mcp-ok", durationMs: 1 };
    },
  };
}

/** 记录每轮交给模型的工具名。 */
class CapturingToolsProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  toolNames: string[][] = [];
  async *stream(req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    this.toolNames.push(req.tools.map((t) => t.name));
    yield { kind: "finish", reason: "stop" };
  }
  async complete(): Promise<ProviderCompletion> {
    throw new Error("测试不支持降级");
  }
}

async function runWithMode(
  mode: "plan" | "confirm",
  mcpTools: ToolDefinition[],
  opts: { builtin?: boolean } = {},
): Promise<string[]> {
  const provider = new CapturingToolsProvider();
  const driver = createBuiltinDriver({
    skillsDir: tempDir(),
    resolveProvider: () => PROVIDER,
    createClient: () => provider,
    // builtin=true 时用真实内置工具全集，否则空表（只看 MCP）
    ...(opts.builtin === true ? {} : { tools: [] as ToolDefinition[] }),
    // 驱动只调 tools()，McpManager 的其余方法不需要
    mcp: fakeMcp(mcpTools) as unknown as Parameters<
      typeof createBuiltinDriver
    >[0] extends { mcp?: infer M }
      ? M
      : never,
  });
  const h = await driver.start(BUILTIN_DECL_LOCAL, {
    cwd: tempDir(),
    sessionId: `s_${mode}`,
    botId: "b1",
    channelId: "ch1",
    providerId: "p1",
    permissionMode: mode,
  });
  await driver.newSession(h, { cwd: tempDir(), systemPrompt: "测试" });
  setTurnContext(h, { turnId: `t_${mode}`, messageId: `m_${mode}`, botId: "b1" });
  try {
    await driver.prompt(h, { text: "hi" });
  } finally {
    clearTurnContext(h);
  }
  return provider.toolNames[0] ?? [];
}

describe("R5-c MCP 工具的计划模式裁剪", () => {
  const tools = [
    mcpTool("mcp__stub__read_thing", "read"),
    mcpTool("mcp__stub__write_thing", "exec"),
    mcpTool("mcp__stub__net_thing", "network"),
    mcpTool("mcp__stub__file_thing", "write"),
  ];

  it("plan：发给模型的 tools 列表不含任何 MCP 写类工具，读类仍在", async () => {
    const names = await runWithMode("plan", tools);
    expect(names).toContain("mcp__stub__read_thing");
    expect(names).not.toContain("mcp__stub__write_thing");
    expect(names).not.toContain("mcp__stub__net_thing");
    expect(names).not.toContain("mcp__stub__file_thing");
  });

  it("confirm：所有 MCP 工具都在（与计划模式对比）", async () => {
    const names = await runWithMode("confirm", tools);
    for (const t of tools) expect(names).toContain(t.name);
  });

  it("plan 下内置写类工具也已裁掉（回归保护）", async () => {
    const names = await runWithMode("plan", [], { builtin: true });
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_shell");
    expect(names).toContain("read_file");
  });
});

// ---------------------------------------------------------------------------
// N3-1 / N4：Bot 的技能启用列表影响系统提示索引
// ---------------------------------------------------------------------------

class PromptCapturingProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  systemPrompts: string[] = [];
  async *stream(req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    const sys = req.messages.find((m) => m.role === "system");
    this.systemPrompts.push(sys?.content ?? "");
    yield { kind: "finish", reason: "stop" };
  }
  async complete(): Promise<ProviderCompletion> {
    throw new Error("测试不支持降级");
  }
}

describe("技能启用列表（N3-1 / N4）", () => {
  const skillNames = ["file-basics", "shell-basics", "long-tail"];

  function skillsDirWithThree(): string {
    const dir = tempDir();
    for (const name of skillNames) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} 的说明\n---\n`,
        "utf8",
      );
    }
    return dir;
  }

  async function promptWith(enabledSkills: string[] | null): Promise<string> {
    const provider = new PromptCapturingProvider();
    const dir = skillsDirWithThree();
    const driver = createBuiltinDriver({
      skillsDir: dir,
      resolveProvider: () => PROVIDER,
      createClient: () => provider,
      tools: [],
    });
    const h = await driver.start(BUILTIN_DECL_LOCAL, {
      cwd: dir,
      sessionId: `s_${String(enabledSkills)}`,
      botId: "b1",
      channelId: "ch1",
      providerId: "p1",
      enabledSkills,
    });
    await driver.newSession(h, { cwd: dir, systemPrompt: "测试" });
    setTurnContext(h, { turnId: "t1", messageId: "m1", botId: "b1" });
    try {
      await driver.prompt(h, { text: "hi" });
    } finally {
      clearTurnContext(h);
    }
    return provider.systemPrompts[0] ?? "";
  }

  it("启用白名单：索引只有列出的技能", async () => {
    const prompt = await promptWith(["file-basics", "shell-basics"]);
    expect(prompt).toContain("- file-basics");
    expect(prompt).toContain("- shell-basics");
    expect(prompt).not.toContain("- long-tail");
    // 未启用但有目录 → 提示可发现
    expect(prompt).toContain("还有 1 个技能未在本 Bot 启用");
  });

  it("空数组：索引为空，但提示可用 list_skills 发现", async () => {
    const prompt = await promptWith([]);
    expect(prompt).not.toContain("- file-basics");
    expect(prompt).toContain("未启用任何技能索引");
    expect(prompt).toContain("list_skills");
  });

  it("null：全部启用（老 Bot 行为不变）", async () => {
    const prompt = await promptWith(null);
    for (const name of skillNames) expect(prompt).toContain(`- ${name}`);
  });
});
