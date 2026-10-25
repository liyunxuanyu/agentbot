/**
 * 模型供应商的纯接口层（内置引擎 N1）。
 *
 * 这里只描述「一次对话调用需要什么、会产出什么」，不含任何 HTTP / 协议细节。
 * 真正的线上协议实现放在 `adapters/providers/`，依赖方向是：
 *
 *   core/agent/loop.ts → core/agent/provider.ts ← adapters/providers/*
 *
 * 这样 agent loop 与工具执行可以完全用假 provider 做单测。
 */

export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export interface ProviderConfig {
  id: string;
  /** 展示名；缺省用 id。 */
  name?: string;
  protocol: ProviderProtocol;
  /** 不含 `/chat/completions` 或 `/v1/messages` 的根地址。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 上下文窗口（token）；未知为 null（不估算、不裁剪）。 */
  contextWindow: number | null;
  supportsTools: boolean;
  supportsStreaming: boolean;
  /** 额外请求头（某些网关要求 x-title 之类）。 */
  headers?: Record<string, string>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象；解析失败时为 null，rawArguments 保留原文。 */
  args: Record<string, unknown> | null;
  rawArguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息可能带工具调用。 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时必填。 */
  toolCallId?: string;
  /** 提供方回传的推理文本（有则进 thought 事件）。 */
  reasoning?: string;
}

/** 交给模型的工具描述（JSON Schema）。 */
export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  messages: ChatMessage[];
  tools: ProviderTool[];
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export type ProviderFinish = "stop" | "tool_calls" | "length" | "error";

export type ProviderDelta =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "usage"; inputTokens: number; outputTokens: number; reported: boolean }
  | { kind: "finish"; reason: ProviderFinish };

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
}

export interface ProviderCompletion {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: ProviderUsage | null;
  finish: ProviderFinish;
}

export interface ProviderClient {
  readonly protocol: ProviderProtocol;
  stream(req: ProviderRequest): AsyncIterable<ProviderDelta>;
  /** 流被掐时的降级路径（也用于 provider 不支持流式时）。 */
  complete(req: ProviderRequest): Promise<ProviderCompletion>;
}

export type ProviderErrorCode =
  | "http"
  | "network"
  | "stream"
  | "context_overflow"
  | "aborted"
  | "invalid_response";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** 把 arguments 字符串解析成对象；失败返回 null（由 loop 回灌「参数不是合法 JSON」）。 */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
