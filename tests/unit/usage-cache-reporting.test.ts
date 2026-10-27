import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createOpenAiChatClient } from "../../src/server/adapters/providers/openai-chat.js";
import { createAnthropicClient } from "../../src/server/adapters/providers/anthropic.js";
import type { ProviderConfig } from "../../src/server/core/agent/provider.js";

/**
 * R8：缓存字段「未上报」与「真实 0 命中」必须区分。
 *
 * 两个协议各测一遍：
 *   - 网关只回 prompt/completion（无 prompt_tokens_details / cache_*）→
 *     usage 里没有 cachedInputTokens（undefined），用量页显示 —；
 *   - 网关回 cached_tokens: 0 / cache_read_input_tokens: 0 → 是真实的 0，保留。
 *
 * 这两条如果只测一条，另一个协议很容易在后续重构里悄悄回退成 `?? 0`。
 */

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const CFG: ProviderConfig = {
  id: "p",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1",
  apiKey: "test-key",
  model: "test-model",
  contextWindow: null,
  maxOutputTokens: null,
  supportsTools: true,
  supportsStreaming: true,
};

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const out: T[] = [];
    for await (const item of iter) out.push(item);
    return out;
  })();
}

describe("OpenAI 缓存字段（R8）", () => {
  it("没有 prompt_tokens_details → cachedInputTokens 缺失，不补 0", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        );
      },
      async (baseUrl) => {
        const client = createOpenAiChatClient({ ...CFG, baseUrl });
        const result = await client.complete({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        });
        expect(result.usage).not.toBeNull();
        expect(result.usage?.inputTokens).toBe(100);
        expect(result.usage?.reported).toBe(true);
        // 关键断言：字段不存在（而不是 0）
        expect(result.usage).not.toHaveProperty("cachedInputTokens");
      },
    );
  });

  it("prompt_tokens_details.cached_tokens = 0 → 保留真实的 0", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
      },
      async (baseUrl) => {
        const client = createOpenAiChatClient({ ...CFG, baseUrl });
        const result = await client.complete({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        });
        expect(result.usage?.cachedInputTokens).toBe(0);
        // 命中 0：input 不扣减
        expect(result.usage?.inputTokens).toBe(100);
      },
    );
  });

  it("有命中时 input 扣掉缓存部分（两端口径归一）", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 60 },
            },
          }),
        );
      },
      async (baseUrl) => {
        const client = createOpenAiChatClient({ ...CFG, baseUrl });
        const result = await client.complete({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        });
        expect(result.usage?.cachedInputTokens).toBe(60);
        expect(result.usage?.inputTokens).toBe(40);
      },
    );
  });
});

describe("Anthropic 缓存字段（R8）", () => {
  it("流式：没有 cache_* 字段 → usage 里不出现缓存字段", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames: [string, unknown][] = [
          ["message_start", { type: "message_start", message: { usage: { input_tokens: 20 } } }],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
          ],
          [
            "message_delta",
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
          ],
          ["message_stop", { type: "message_stop" }],
        ];
        for (const [event, data] of frames) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      },
      async (baseUrl) => {
        const client = createAnthropicClient({ ...CFG, baseUrl, protocol: "anthropic-messages" });
        const deltas = await collect(
          client.stream({
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
          }),
        );
        const usage = deltas.find((d) => d.kind === "usage");
        expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 5, reported: true });
        expect(usage).not.toHaveProperty("cachedInputTokens");
        expect(usage).not.toHaveProperty("cacheWriteTokens");
      },
    );
  });

  it("流式：cache_read_input_tokens = 0 → 保留真实的 0", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames: [string, unknown][] = [
          [
            "message_start",
            {
              type: "message_start",
              message: { usage: { input_tokens: 20, cache_read_input_tokens: 0 } },
            },
          ],
          [
            "message_delta",
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
          ],
          ["message_stop", { type: "message_stop" }],
        ];
        for (const [event, data] of frames) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      },
      async (baseUrl) => {
        const client = createAnthropicClient({ ...CFG, baseUrl, protocol: "anthropic-messages" });
        const deltas = await collect(
          client.stream({
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
          }),
        );
        const usage = deltas.find((d) => d.kind === "usage");
        expect(usage).toHaveProperty("cachedInputTokens", 0);
        // 没给 cache_creation_input_tokens：写入字段仍然缺失
        expect(usage).not.toHaveProperty("cacheWriteTokens");
      },
    );
  });

  it("非流式：没有 cache_* 字段 → 不补 0", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: "hello" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 4, output_tokens: 6 },
          }),
        );
      },
      async (baseUrl) => {
        const client = createAnthropicClient({ ...CFG, baseUrl, protocol: "anthropic-messages" });
        const result = await client.complete({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        });
        expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 6, reported: true });
        expect(result.usage).not.toHaveProperty("cachedInputTokens");
        expect(result.usage).not.toHaveProperty("cacheWriteTokens");
      },
    );
  });
});
