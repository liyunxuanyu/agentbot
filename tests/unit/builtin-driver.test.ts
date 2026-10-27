import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinDriver } from "../../src/server/adapters/channels/builtin/driver.js";
import { setTurnContext, clearTurnContext } from "../../src/server/adapters/turn-context.js";
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
