import {
  parseToolArguments,
  ProviderError,
  type ChatMessage,
  type ProviderClient,
  type ProviderCompletion,
  type ProviderConfig,
  type ProviderDelta,
  type ProviderFinish,
  type ProviderRequest,
  type ToolCall,
} from "../../core/agent/provider.js";
import {
  fetchWithRetry,
  joinUrl,
  providerHttpError,
  readErrorMessage,
  sseFrames,
} from "./http.js";

/**
 * OpenAI Chat Completions 协议（也覆盖兼容该协议的网关）。
 *
 * 只在这里出现 `chat/completions`、`tool_calls` 等线上字段；core 完全不知道。
 */

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: OpenAiToolCallDelta[];
  };
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: {
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}

interface OpenAiChunk {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI 的缓存命中口径。 */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  model?: string;
  error?: { message?: string } | string;
}

function mapFinish(reason: string | null | undefined): ProviderFinish {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "stop":
    case "end_turn":
      return "stop";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

function mapMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.rawArguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function headersOf(cfg: ProviderConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
    ...(cfg.headers ?? {}),
  };
}

function bodyOf(cfg: ProviderConfig, req: ProviderRequest, stream: boolean): string {
  return JSON.stringify({
    model: cfg.model,
    messages: mapMessages(req.messages),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools.length > 0 && cfg.supportsTools
      ? {
          tools: req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  });
}

function usageOf(
  chunk: OpenAiChunk,
  fallbackModel: string,
): {
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
  cachedInputTokens: number;
  model: string;
} | null {
  if (!chunk.usage) return null;
  return {
    inputTokens: typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0,
    outputTokens: typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0,
    reported: true,
    // 缺失按 0 记：OpenAI 口径没有「未上报缓存」这种状态，0 就是没命中
    cachedInputTokens:
      typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number"
        ? chunk.usage.prompt_tokens_details.cached_tokens
        : 0,
    model: typeof chunk.model === "string" && chunk.model.length > 0 ? chunk.model : fallbackModel,
  };
}

function toolCallOf(id: string | undefined, name: string, rawArguments: string): ToolCall {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
    args: parseToolArguments(rawArguments),
    rawArguments,
  };
}

export function createOpenAiChatClient(cfg: ProviderConfig): ProviderClient {
  const url = joinUrl(cfg.baseUrl, "/chat/completions");

  async function complete(req: ProviderRequest): Promise<ProviderCompletion> {
    const res = await fetchWithRetry(
      url,
      { method: "POST", headers: headersOf(cfg), body: bodyOf(cfg, req, false) },
      req.signal,
    );
    if (!res.ok) throw providerHttpError(res.status, await readErrorMessage(res));

    let json: OpenAiChunk;
    try {
      json = (await res.json()) as OpenAiChunk;
    } catch (err) {
      throw new ProviderError(
        `供应商返回了非 JSON 响应：${err instanceof Error ? err.message : String(err)}`,
        "invalid_response",
      );
    }
    const err = json.error;
    if (err) {
      const message = typeof err === "string" ? err : (err.message ?? "供应商返回错误");
      throw providerHttpError(0, message);
    }
    const choice = json.choices?.[0];
    if (!choice) throw new ProviderError("供应商响应里没有 choices", "invalid_response");
    const message = choice.message ?? {};
    const toolCalls = (message.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === "string" && c.function.name.length > 0)
      .map((c) => toolCallOf(c.id, c.function?.name ?? "", c.function?.arguments ?? ""));
    const usage = usageOf(json, cfg.model);
    return {
      text: typeof message.content === "string" ? message.content : "",
      reasoning:
        typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : typeof message.reasoning === "string"
            ? message.reasoning
            : "",
      toolCalls,
      usage,
      finish: toolCalls.length > 0 ? "tool_calls" : mapFinish(choice.finish_reason),
    };
  }

  async function* stream(req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    if (!cfg.supportsStreaming) {
      const done = await complete(req);
      if (done.text.length > 0) yield { kind: "text", text: done.text };
      if (done.reasoning.length > 0) yield { kind: "reasoning", text: done.reasoning };
      for (const call of done.toolCalls) yield { kind: "tool_call", call };
      if (done.usage) yield { kind: "usage", ...done.usage };
      yield { kind: "finish", reason: done.finish };
      return;
    }

    const res = await fetchWithRetry(
      url,
      { method: "POST", headers: headersOf(cfg), body: bodyOf(cfg, req, true) },
      req.signal,
    );
    if (!res.ok) throw providerHttpError(res.status, await readErrorMessage(res));
    if (!res.body) throw new ProviderError("供应商没有返回响应体", "invalid_response");

    const calls = new Map<number, { id?: string; name: string; args: string }>();
    let finish: ProviderFinish = "stop";

    for await (const frame of sseFrames(res.body)) {
      if (req.signal.aborted) throw new ProviderError("请求已取消", "aborted");
      if (frame.data.length === 0 || frame.data === "[DONE]") continue;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(frame.data) as OpenAiChunk;
      } catch {
        continue; // 网关偶尔插入非 JSON 行，跳过即可
      }
      const err = chunk.error;
      if (err) {
        const message = typeof err === "string" ? err : (err.message ?? "供应商返回错误");
        throw providerHttpError(0, message);
      }

      const usage = usageOf(chunk, cfg.model);
      if (usage) yield { kind: "usage", ...usage };

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { kind: "text", text: delta.content };
      }
      const reasoning =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : "";
      if (reasoning.length > 0) yield { kind: "reasoning", text: reasoning };

      for (const tc of delta.tool_calls ?? []) {
        const index = typeof tc.index === "number" ? tc.index : calls.size;
        const current = calls.get(index) ?? { name: "", args: "" };
        if (typeof tc.id === "string" && tc.id.length > 0) current.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name.length > 0) {
          current.name = tc.function.name;
        }
        if (typeof tc.function?.arguments === "string") current.args += tc.function.arguments;
        calls.set(index, current);
      }

      if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
    }

    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (call.name.length === 0) continue;
      yield { kind: "tool_call", call: toolCallOf(call.id, call.name, call.args) };
      finish = "tool_calls";
    }
    yield { kind: "finish", reason: finish };
  }

  return { protocol: "openai-chat", stream, complete };
}
