import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createOpenAiChatClient } from "../../src/server/adapters/providers/openai-chat.js";
import { createAnthropicClient } from "../../src/server/adapters/providers/anthropic.js";
import type { ProviderConfig } from "../../src/server/core/agent/provider.js";

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

function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const out: T[] = [];
    for await (const item of iter) out.push(item);
    return out;
  })();
}

describe("OpenAI Chat Completions 客户端", () => {
  it("流式：正文、tool_calls 增量拼接、usage、finish", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\""}}]}}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]}}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
      },
      async (baseUrl) => {
        const client = createOpenAiChatClient({ ...CFG, baseUrl });
        const deltas = await collect(
          client.stream({
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
          }),
        );
        const text = deltas.filter((d) => d.kind === "text").map((d) => (d as { text: string }).text).join("");
        expect(text).toBe("你好");
        const call = deltas.find((d) => d.kind === "tool_call");
        expect(call).toMatchObject({
          kind: "tool_call",
          call: { id: "call_1", name: "read_file", args: { path: "a.txt" } },
        });
        expect(deltas.find((d) => d.kind === "usage")).toMatchObject({
          inputTokens: 10,
          outputTokens: 5,
          reported: true,
        });
        expect(deltas[deltas.length - 1]).toEqual({ kind: "finish", reason: "tool_calls" });
      },
    );
  });

  it("非流式：解析 message.tool_calls 与 usage", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "ok",
                  tool_calls: [
                    { id: "call_2", function: { name: "grep", arguments: '{"pattern":"x"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
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
        expect(result.text).toBe("ok");
        expect(result.toolCalls[0]).toMatchObject({ id: "call_2", name: "grep", args: { pattern: "x" } });
        expect(result.usage).toEqual({
          inputTokens: 3,
          outputTokens: 2,
          reported: true,
          // R8：网关没给 prompt_tokens_details 时不补 0 —— 缓存命中率未知，
          // 用量页显示 —，不能把它当成「0 命中」稀释合计。
          model: "test-model",
        });
        expect(result.finish).toBe("tool_calls");
      },
    );
  });
});

describe("Anthropic Messages 客户端", () => {
  it("流式：text_delta、tool_use input_json_delta、usage、stop_reason", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames: [string, unknown][] = [
          ["message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }],
          [
            "content_block_start",
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "grep", input: {} } },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pattern":"x"}' } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
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
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
          }),
        );
        const text = deltas.filter((d) => d.kind === "text").map((d) => (d as { text: string }).text).join("");
        expect(text).toBe("Hi");
        expect(deltas.find((d) => d.kind === "tool_call")).toMatchObject({
          call: { id: "toolu_1", name: "grep", args: { pattern: "x" } },
        });
        expect(deltas.find((d) => d.kind === "usage")).toMatchObject({
          inputTokens: 12,
          outputTokens: 7,
          reported: true,
        });
        expect(deltas[deltas.length - 1]).toEqual({ kind: "finish", reason: "tool_calls" });
      },
    );
  });

  it("非流式：text + tool_use blocks", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            content: [
              { type: "text", text: "hello" },
              { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "b.txt" } },
            ],
            stop_reason: "tool_use",
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
        expect(result.text).toBe("hello");
        expect(result.toolCalls[0]).toMatchObject({ id: "toolu_2", name: "read_file", args: { path: "b.txt" } });
        expect(result.finish).toBe("tool_calls");
      },
    );
  });
});
