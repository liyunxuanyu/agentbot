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
  joinVersionedUrl,
  providerHttpError,
  readErrorMessage,
  sseFrames,
} from "./http.js";

/**
 * Anthropic Messages 协议。
 *
 * 与 OpenAI 的三处结构差异都在本文件消化：
 *   - system 是顶层字段，不在 messages 里；
 *   - 工具调用是 content block（tool_use / tool_result），不是 message.tool_calls；
 *   - 流式事件带 `event:` 名，参数是 `input_json_delta` 拼出来的 JSON。
 */

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** 缓存命中（读）。 */
  cache_read_input_tokens?: number;
  /** 缓存写入。 */
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
  model?: string;
  error?: { message?: string };
}

function mapFinish(reason: string | null | undefined): ProviderFinish {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
    case "stop":
      return "stop";
    default:
      return "stop";
  }
}

function mapMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
  const systems: string[] = [];
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.length > 0) systems.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args ?? parseToolArguments(call.rawArguments) ?? {},
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: [{ type: "text", text: m.content }] });
  }

  // Anthropic 要求 user/assistant 交替；连续同角色合并成一条，避免 400。
  const merged: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const item of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === item.role) last.content.push(...item.content);
    else merged.push(item);
  }
  return { system: systems.join("\n\n"), messages: merged };
}

function headersOf(cfg: ProviderConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": "2023-06-01",
    // 部分兼容网关只认 Bearer；Anthropic 官方会忽略它。
    authorization: `Bearer ${cfg.apiKey}`,
    ...(cfg.headers ?? {}),
  };
}

function bodyOf(cfg: ProviderConfig, req: ProviderRequest, stream: boolean): string {
  const mapped = mapMessages(req.messages);
  return JSON.stringify({
    model: cfg.model,
    max_tokens: req.maxOutputTokens ?? 4096,
    ...(mapped.system.length > 0 ? { system: mapped.system } : {}),
    messages: mapped.messages,
    stream,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools.length > 0 && cfg.supportsTools
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
  });
}

function toolCallOf(id: string | undefined, name: string, rawArguments: string): ToolCall {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
    args: parseToolArguments(rawArguments),
    rawArguments,
  };
}

export function createAnthropicClient(cfg: ProviderConfig): ProviderClient {
  const url = joinVersionedUrl(cfg.baseUrl, "v1", "/messages");

  async function complete(req: ProviderRequest): Promise<ProviderCompletion> {
    const res = await fetchWithRetry(
      url,
      { method: "POST", headers: headersOf(cfg), body: bodyOf(cfg, req, false) },
      req.signal,
    );
    if (!res.ok) throw providerHttpError(res.status, await readErrorMessage(res));

    let json: AnthropicResponse;
    try {
      json = (await res.json()) as AnthropicResponse;
    } catch (err) {
      throw new ProviderError(
        `供应商返回了非 JSON 响应：${err instanceof Error ? err.message : String(err)}`,
        "invalid_response",
      );
    }
    if (json.error) throw providerHttpError(0, json.error.message ?? "供应商返回错误");
    const blocks = json.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    const toolCalls = blocks
      .filter((b) => b.type === "tool_use" && typeof b.name === "string")
      .map((b) =>
        toolCallOf(b.id, b.name ?? "", JSON.stringify(b.input ?? {})),
      );
    const usage =
      json.usage && (typeof json.usage.input_tokens === "number" || typeof json.usage.output_tokens === "number")
        ? {
            inputTokens: json.usage.input_tokens ?? 0,
            outputTokens: json.usage.output_tokens ?? 0,
            reported: true,
            // R8：缓存字段缺失 = 供应商没上报（用量页显示 —），不补 0；
            // 明确给了 0 才是「真的没命中」。
            ...(typeof json.usage.cache_read_input_tokens === "number"
              ? { cachedInputTokens: json.usage.cache_read_input_tokens }
              : {}),
            ...(typeof json.usage.cache_creation_input_tokens === "number"
              ? { cacheWriteTokens: json.usage.cache_creation_input_tokens }
              : {}),
            model: json.model ?? cfg.model,
          }
        : null;
    return {
      text,
      reasoning: "",
      toolCalls,
      usage,
      finish: toolCalls.length > 0 ? "tool_calls" : mapFinish(json.stop_reason),
    };
  }

  async function* stream(req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    if (!cfg.supportsStreaming) {
      const done = await complete(req);
      if (done.text.length > 0) yield { kind: "text", text: done.text };
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

    const tools = new Map<number, { id: string; name: string; json: string }>();
    let currentEvent: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    // R8：缓存字段只在真的出现过时才上报（undefined = 供应商没说，不是 0）
    let cachedInputTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let sawUsage = false;
    let finish: ProviderFinish = "stop";

    for await (const frame of sseFrames(res.body)) {
      if (req.signal.aborted) throw new ProviderError("请求已取消", "aborted");
      if (frame.event !== null) {
        currentEvent = frame.event;
        continue;
      }
      if (frame.data.length === 0) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type =
        currentEvent ??
        (typeof payload["type"] === "string" ? (payload["type"] as string) : "");

      switch (type) {
        case "message_start": {
          const message = payload["message"] as
            | { usage?: AnthropicUsage; model?: string }
            | undefined;
          if (typeof message?.usage?.input_tokens === "number") {
            inputTokens = message.usage.input_tokens;
            sawUsage = true;
          }
          if (typeof message?.usage?.cache_read_input_tokens === "number") {
            cachedInputTokens = message.usage.cache_read_input_tokens;
            sawUsage = true;
          }
          if (typeof message?.usage?.cache_creation_input_tokens === "number") {
            cacheWriteTokens = message.usage.cache_creation_input_tokens;
            sawUsage = true;
          }
          break;
        }
        case "content_block_start": {
          const index = typeof payload["index"] === "number" ? payload["index"] : 0;
          const block = payload["content_block"] as AnthropicBlock | undefined;
          if (block?.type === "tool_use") {
            tools.set(index, {
              id: block.id ?? `call_${index}`,
              name: block.name ?? "",
              json: "",
            });
          }
          break;
        }
        case "content_block_delta": {
          const index = typeof payload["index"] === "number" ? payload["index"] : 0;
          const delta = payload["delta"] as
            | { type?: string; text?: string; thinking?: string; partial_json?: string }
            | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            yield { kind: "text", text: delta.text };
          } else if (
            (delta?.type === "thinking_delta" || delta?.type === "reasoning_delta") &&
            typeof delta.thinking === "string" &&
            delta.thinking.length > 0
          ) {
            yield { kind: "reasoning", text: delta.thinking };
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const current = tools.get(index);
            if (current) current.json += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const index = typeof payload["index"] === "number" ? payload["index"] : 0;
          const call = tools.get(index);
          if (call && call.name.length > 0) {
            yield { kind: "tool_call", call: toolCallOf(call.id, call.name, call.json) };
            finish = "tool_calls";
            tools.delete(index);
          }
          break;
        }
        case "message_delta": {
          const delta = payload["delta"] as { stop_reason?: string | null } | undefined;
          if (delta?.stop_reason) finish = mapFinish(delta.stop_reason);
          const usage = payload["usage"] as { output_tokens?: number } | undefined;
          if (typeof usage?.output_tokens === "number") {
            outputTokens = usage.output_tokens;
            sawUsage = true;
          }
          break;
        }
        case "error": {
          const error = payload["error"] as { message?: string } | undefined;
          throw providerHttpError(0, error?.message ?? "供应商返回流式错误");
        }
        case "message_stop":
          break;
        default:
          break;
      }
    }

    if (sawUsage) {
      yield {
        kind: "usage",
        inputTokens,
        outputTokens,
        reported: true,
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        model: cfg.model,
      };
    }
    for (const [, call] of tools) {
      if (call.name.length > 0) yield { kind: "tool_call", call: toolCallOf(call.id, call.name, call.json) };
    }
    yield { kind: "finish", reason: finish };
  }

  return { protocol: "anthropic-messages", stream, complete };
}
