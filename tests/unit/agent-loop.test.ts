import { describe, expect, it } from "vitest";
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
  type ToolDefinition,
  type ToolPermission,
} from "../../src/server/core/agent/tools/registry.js";

class ScriptedProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  private index = 0;
  constructor(private readonly scripts: ProviderDelta[][]) {}

  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    const script = this.scripts[this.index++] ?? [{ kind: "finish", reason: "stop" }];
    for (const delta of script) yield delta;
  }

  async complete(_req: ProviderRequest): Promise<ProviderCompletion> {
    throw new Error("测试不支持非流式降级");
  }
}

function toolOf(
  permission: ToolPermission,
  executed: Record<string, unknown>[],
  name = "act",
): ToolDefinition {
  return {
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    permission,
    source: "builtin",
    async execute(_ctx, args) {
      executed.push(args);
      return { ok: true, output: `executed:${JSON.stringify(args)}`, durationMs: 1 };
    },
  };
}

const toolCall = (id: string, args: Record<string, unknown> | null, raw = JSON.stringify(args ?? {})): ProviderDelta => ({
  kind: "tool_call",
  call: { id, name: "act", args, rawArguments: raw },
});

function baseOptions(provider: ProviderClient, tools: ToolDefinition[], overrides: Record<string, unknown> = {}) {
  const usage: { inputTokens: number; outputTokens: number; reported: boolean }[] = [];
  const text: string[] = [];
  return {
    provider,
    registry: createToolRegistry(tools),
    messages: [{ role: "user" as const, content: "go" }] as ChatMessage[],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    callbacks: {
      onTextDelta: (t: string) => text.push(t),
      onReasoningDelta: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onUsage: (u: { inputTokens: number; outputTokens: number; reported: boolean }) => usage.push(u),
      askPermission: async () => true,
    },
    ...overrides,
    // 测试断言用
    __text: text,
    __usage: usage,
  };
}

describe("agent loop", () => {
  it("执行工具 → 回灌结果 → 继续调用模型，直到模型不再要工具", async () => {
    const executed: Record<string, unknown>[] = [];
    const provider = new ScriptedProvider([
      [toolCall("c1", { path: "a.txt" }), { kind: "finish", reason: "tool_calls" }],
      [{ kind: "text", text: "done" }, { kind: "finish", reason: "stop" }],
    ]);
    const opts = baseOptions(provider, [toolOf("write", executed)]);
    const result = await runAgentLoop(opts);
    expect(result.stopReason).toBe("end");
    expect(result.toolCalls).toBe(1);
    expect(executed).toEqual([{ path: "a.txt" }]);
    expect(opts.__text.join("")).toBe("done");
    const toolMessage = opts.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("executed");
  });

  it("用户拒绝 → 工具不执行，回灌可操作的话术", async () => {
    const executed: Record<string, unknown>[] = [];
    const provider = new ScriptedProvider([
      [toolCall("c1", { path: "a.txt" }), { kind: "finish", reason: "tool_calls" }],
      [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }],
    ]);
    const opts = baseOptions(provider, [toolOf("write", executed)], {
      callbacks: {
        onTextDelta: () => undefined,
        onReasoningDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onUsage: () => undefined,
        askPermission: async () => false,
      },
    });
    const result = await runAgentLoop(opts);
    expect(result.stopReason).toBe("end");
    expect(executed).toHaveLength(0);
    const toolMessage = opts.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("用户拒绝");
    expect(toolMessage?.content).toContain("不要重复");
  });

  it("权限请求的目标优先取 url（MCP 浏览器工具只有 url，没有 path）", async () => {
    const executed: Record<string, unknown>[] = [];
    const asked: { action: string; target: string }[] = [];
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "c1",
            name: "mcp__playwright__browser_navigate",
            args: { url: "https://example.com/a" },
            rawArguments: '{"url":"https://example.com/a"}',
          },
        },
        { kind: "finish", reason: "tool_calls" },
      ],
      [{ kind: "finish", reason: "stop" }],
    ]);
    const opts = baseOptions(provider, [toolOf("network", executed, "mcp__playwright__browser_navigate")], {
      callbacks: {
        onTextDelta: () => undefined,
        onReasoningDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onUsage: () => undefined,
        askPermission: async (req: { action: string; target: string }) => {
          asked.push(req);
          return true;
        },
      },
    });
    await runAgentLoop(opts);
    // 旧顺序先看 path：navigate 只有 url，目标会退化成工具名，卡片上「目标」
    // 显示一串 mcp__... 而不是网址，授权指纹也无法按主机归一化。
    expect(asked[0]?.target).toBe("https://example.com/a");

    // 什么目标参数都没有的 MCP 工具：退回工具名（无法预判它要访问哪）
    const asked2: { target: string }[] = [];
    const provider2 = new ScriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "c2",
            name: "mcp__playwright__browser_evaluate",
            args: { code: "document.title" },
            rawArguments: '{"code":"document.title"}',
          },
        },
        { kind: "finish", reason: "tool_calls" },
      ],
      [{ kind: "finish", reason: "stop" }],
    ]);
    const opts2 = baseOptions(provider2, [toolOf("network", executed, "mcp__playwright__browser_evaluate")], {
      callbacks: {
        onTextDelta: () => undefined,
        onReasoningDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onUsage: () => undefined,
        askPermission: async (req: { target: string }) => {
          asked2.push(req);
          return true;
        },
      },
    });
    await runAgentLoop(opts2);
    expect(asked2[0]?.target).toBe("mcp__playwright__browser_evaluate");
  });

  it("只读工具不需要权限", async () => {
    const executed: Record<string, unknown>[] = [];
    let asked = 0;
    const provider = new ScriptedProvider([
      [toolCall("c1", { path: "a.txt" }), { kind: "finish", reason: "tool_calls" }],
      [{ kind: "finish", reason: "stop" }],
    ]);
    const opts = baseOptions(provider, [toolOf("read", executed)], {
      callbacks: {
        onTextDelta: () => undefined,
        onReasoningDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onUsage: () => undefined,
        askPermission: async () => {
          asked += 1;
          return true;
        },
      },
    });
    await runAgentLoop(opts);
    expect(executed).toHaveLength(1);
    expect(asked).toBe(0);
  });

  it("未知工具 → tool_result 报错，不中断整轮", async () => {
    const provider = new ScriptedProvider([
      [
        { kind: "tool_call", call: { id: "c1", name: "nope", args: {}, rawArguments: "{}" } },
        { kind: "finish", reason: "tool_calls" },
      ],
      [{ kind: "finish", reason: "stop" }],
    ]);
    const opts = baseOptions(provider, []);
    const result = await runAgentLoop(opts);
    expect(result.stopReason).toBe("end");
    expect(opts.messages.find((m) => m.role === "tool")?.content).toContain("未知工具");
  });

  it("工具参数不是合法 JSON → 回灌原文让模型重试", async () => {
    const executed: Record<string, unknown>[] = [];
    const provider = new ScriptedProvider([
      [toolCall("c1", null, "{oops"), { kind: "finish", reason: "tool_calls" }],
      [{ kind: "finish", reason: "stop" }],
    ]);
    const opts = baseOptions(provider, [toolOf("write", executed)]);
    await runAgentLoop(opts);
    expect(executed).toHaveLength(0);
    const toolMessage = opts.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("不是合法 JSON");
    expect(toolMessage?.content).toContain("{oops");
  });

  it("达到 maxIterations 停止并给出上限原因", async () => {
    const executed: Record<string, unknown>[] = [];
    const scripts: ProviderDelta[][] = Array.from({ length: 5 }, (_, i) => [
      toolCall(`c${i}`, { n: i }),
      { kind: "finish", reason: "tool_calls" },
    ]);
    const opts = baseOptions(new ScriptedProvider(scripts), [toolOf("write", executed)], {
      maxIterations: 2,
    });
    const result = await runAgentLoop(opts);
    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterations).toBe(2);
    expect(executed).toHaveLength(2);
  });

  it("达到 maxToolCalls 后不再执行后续工具", async () => {
    const executed: Record<string, unknown>[] = [];
    const provider = new ScriptedProvider([
      [
        toolCall("c1", { n: 1 }),
        toolCall("c2", { n: 2 }),
        { kind: "finish", reason: "tool_calls" },
      ],
    ]);
    const opts = baseOptions(provider, [toolOf("write", executed)], { maxToolCalls: 1 });
    const result = await runAgentLoop(opts);
    expect(result.stopReason).toBe("max_tool_calls");
    expect(executed).toEqual([{ n: 1 }]);
  });

  it("usage 样本按调用逐条上报", async () => {
    const provider = new ScriptedProvider([
      [
        { kind: "usage", inputTokens: 10, outputTokens: 2, reported: true },
        { kind: "text", text: "a" },
        { kind: "finish", reason: "stop" },
      ],
    ]);
    const opts = baseOptions(provider, []);
    await runAgentLoop(opts);
    expect(opts.__usage).toEqual([{ inputTokens: 10, outputTokens: 2, reported: true }]);
  });
});
