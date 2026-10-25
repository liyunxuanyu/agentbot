import {
  ProviderError,
  type ChatMessage,
  type ProviderClient,
  type ToolCall,
} from "./provider.js";
import { AGENT_LIMITS } from "./limits.js";
import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from "./tools/registry.js";

/**
 * 内置引擎的 agent loop。
 *
 * 一次 Turn = 若干次「调模型 → 执行工具 → 回灌结果」，直到模型不再要求工具。
 * 所有 I/O（HTTP、文件、进程）都在 provider / 工具实现里；本文件只做编排，
 * 因此可以用假 provider 与假工具做完整单测。
 */

export interface LoopUsageSample {
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
}

export interface AgentLoopCallbacks {
  onTextDelta(text: string): void;
  onReasoningDelta(text: string): void;
  onToolCall(call: ToolCall, tool: ToolDefinition | null): void;
  onToolResult(call: ToolCall, result: ToolResult): void;
  onUsage(sample: LoopUsageSample): void;
  askPermission(req: { action: "write" | "exec" | "network"; target: string; detail?: unknown }): Promise<boolean>;
}

export interface AgentLoopOptions {
  provider: ProviderClient;
  registry: ToolRegistry;
  /** 会被本函数追加 assistant / tool 消息（调用方保留同一数组作为会话历史）。 */
  messages: ChatMessage[];
  cwd: string;
  signal: AbortSignal;
  callbacks: AgentLoopCallbacks;
  maxIterations?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
}

export type LoopStopReason =
  | "end"
  | "length"
  | "cancelled"
  | "max_iterations"
  | "max_tool_calls"
  | "error";

export interface AgentLoopResult {
  stopReason: LoopStopReason;
  error?: { code: string; message: string; detail?: string };
  iterations: number;
  toolCalls: number;
}

function toolTarget(call: ToolCall): string {
  const args = call.args ?? {};
  const candidate = args["path"] ?? args["command"] ?? args["url"] ?? args["name"];
  return typeof candidate === "string" ? candidate : call.name;
}

function errorResult(message: string, started: number): ToolResult {
  return { ok: false, output: message, error: message, durationMs: Date.now() - started };
}

/** 上下文溢出：保留 system + 最近 4 条，其余丢掉。 */
function trimForOverflow(messages: ChatMessage[]): boolean {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length <= 4) return false;
  messages.splice(0, messages.length, ...system, ...rest.slice(-4));
  return true;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? AGENT_LIMITS.maxIterations;
  const maxToolCalls = opts.maxToolCalls ?? AGENT_LIMITS.maxToolCalls;
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    signal: opts.signal,
    askPermission: (req) => opts.callbacks.askPermission(req),
  };

  let iterations = 0;
  let toolCallCount = 0;
  let overflowRetried = false;

  while (iterations < maxIterations) {
    if (opts.signal.aborted) return { stopReason: "cancelled", iterations, toolCalls: toolCallCount };
    iterations += 1;

    const providerTools = opts.registry.toProviderTools();
    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    let finish: "stop" | "tool_calls" | "length" | "error" = "stop";
    let streamFailed: ProviderError | null = null;

    try {
      for await (const delta of opts.provider.stream({
        messages: opts.messages,
        tools: providerTools,
        signal: opts.signal,
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      })) {
        if (opts.signal.aborted) {
          return { stopReason: "cancelled", iterations, toolCalls: toolCallCount };
        }
        switch (delta.kind) {
          case "text":
            text += delta.text;
            opts.callbacks.onTextDelta(delta.text);
            break;
          case "reasoning":
            reasoning += delta.text;
            opts.callbacks.onReasoningDelta(delta.text);
            break;
          case "tool_call":
            toolCalls.push(delta.call);
            break;
          case "usage":
            opts.callbacks.onUsage({
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              reported: delta.reported,
            });
            break;
          case "finish":
            finish = delta.reason;
            break;
        }
      }
    } catch (err) {
      if (opts.signal.aborted) {
        return { stopReason: "cancelled", iterations, toolCalls: toolCallCount };
      }
      streamFailed = err instanceof ProviderError ? err : new ProviderError(
        err instanceof Error ? err.message : String(err),
        "stream",
      );
    }

    if (streamFailed) {
      if (streamFailed.code === "context_overflow" && !overflowRetried) {
        overflowRetried = true;
        if (trimForOverflow(opts.messages)) continue;
      }
      // 流被掐（pix 网关已知问题）→ 降级一次非流式，已产出文本保留
      try {
        const completion = await opts.provider.complete({
          messages: opts.messages,
          tools: providerTools,
          signal: opts.signal,
          ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        });
        if (completion.text.length > 0) {
          if (text.length === 0) {
            text = completion.text;
            opts.callbacks.onTextDelta(completion.text);
          } else if (!completion.text.startsWith(text)) {
            const suffix = `\n${completion.text}`;
            text += suffix;
            opts.callbacks.onTextDelta(suffix);
          } else if (completion.text.length > text.length) {
            const suffix = completion.text.slice(text.length);
            text = completion.text;
            opts.callbacks.onTextDelta(suffix);
          }
        }
        if (completion.reasoning.length > 0) {
          if (reasoning.length === 0) {
            reasoning = completion.reasoning;
            opts.callbacks.onReasoningDelta(completion.reasoning);
          } else if (completion.reasoning.length > reasoning.length) {
            const suffix = completion.reasoning.slice(reasoning.length);
            reasoning = completion.reasoning;
            opts.callbacks.onReasoningDelta(suffix);
          }
        }
        toolCalls.splice(0, toolCalls.length, ...completion.toolCalls);
        finish = completion.finish;
        if (completion.usage) opts.callbacks.onUsage(completion.usage);
      } catch (fallbackError) {
        const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return {
          stopReason: "error",
          error: {
            code: streamFailed.code === "context_overflow" ? "context_overflow" : "stream_interrupted",
            message:
              streamFailed.code === "context_overflow"
                ? "上下文超出模型窗口，且裁剪后仍然失败"
                : "模型流中断，降级为非流式后仍失败",
            detail: `${streamFailed.message}；${detail}`,
          },
          iterations,
          toolCalls: toolCallCount,
        };
      }
    }

    if (text.length > 0 || toolCalls.length > 0 || reasoning.length > 0) {
      opts.messages.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning } : {}),
      });
    }

    if (finish === "error") {
      return {
        stopReason: "error",
        error: { code: "provider_error", message: "模型返回了错误结束原因" },
        iterations,
        toolCalls: toolCallCount,
      };
    }
    if (finish === "length") return { stopReason: "length", iterations, toolCalls: toolCallCount };
    if (toolCalls.length === 0) return { stopReason: "end", iterations, toolCalls: toolCallCount };

    for (const call of toolCalls) {
      if (opts.signal.aborted) {
        return { stopReason: "cancelled", iterations, toolCalls: toolCallCount };
      }
      if (toolCallCount >= maxToolCalls) {
        return { stopReason: "max_tool_calls", iterations, toolCalls: toolCallCount };
      }
      toolCallCount += 1;

      const started = Date.now();
      if (call.args === null) {
        const result = errorResult(
          `参数不是合法 JSON，请重新调用并给出合法 JSON。原文：${call.rawArguments.slice(0, 2000)}`,
          started,
        );
        opts.callbacks.onToolCall(call, null);
        opts.callbacks.onToolResult(call, result);
        opts.messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `错误：${result.error ?? result.output}`,
        });
        continue;
      }

      const tool = opts.registry.get(call.name);
      if (!tool) {
        const result = errorResult(`未知工具：${call.name}。可用工具见系统提示。`, started);
        opts.callbacks.onToolCall(call, null);
        opts.callbacks.onToolResult(call, result);
        opts.messages.push({ role: "tool", toolCallId: call.id, content: `错误：${result.error}` });
        continue;
      }

      opts.callbacks.onToolCall(call, tool);

      if (tool.permission !== null && tool.permission !== "read") {
        const allowed = await opts.callbacks.askPermission({
          action: tool.permission,
          target: toolTarget(call),
          detail: { tool: tool.name, args: call.args },
        });
        if (!allowed) {
          const result = errorResult(
            "用户拒绝了这个操作（或超出 Bot 边界）。请换一种做法，或直接说明需要什么权限。不要重复同一个调用。",
            started,
          );
          opts.callbacks.onToolResult(call, result);
          opts.messages.push({ role: "tool", toolCallId: call.id, content: `错误：${result.error}` });
          continue;
        }
      }

      let result: ToolResult;
      try {
        result = await tool.execute(toolCtx, call.args);
      } catch (err) {
        result = errorResult(
          `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
          started,
        );
      }
      opts.callbacks.onToolResult(call, result);
      opts.messages.push({
        role: "tool",
        toolCallId: call.id,
        content: result.ok ? result.output : `错误：${result.error ?? result.output}`,
      });
    }
  }

  return { stopReason: "max_iterations", iterations, toolCalls: toolCallCount };
}
