import { AGENT_LIMITS } from "../../limits.js";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { truncateText } from "../truncate.js";

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").replace(/\s+/g, " ").trim() : "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title, text: decodeEntities(text) };
}

async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= limit) {
        truncated = true;
        break;
      }
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text: text.slice(0, limit), truncated };
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "GET 一个 http(s) 网页并转成纯文本（超时 20s，上限 64KB）。只支持 GET，拒绝其它协议。访问网络需要用户批准。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL" },
    },
    required: ["url"],
  },
  permission: "network",
  source: "builtin",
  async execute(ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const raw = typeof args["url"] === "string" ? args["url"].trim() : "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      const message = `URL 无效：${raw}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      const message = `只允许 http(s)，拒绝：${url.protocol}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), AGENT_LIMITS.webFetchTimeoutMs);
    timer.unref?.();

    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "AgentBot/0.1 (+local)" },
      });
      if (!res.ok) {
        const message = `HTTP ${res.status} ${res.statusText}`;
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }
      if (!res.body) {
        const message = "响应没有正文";
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const read = await readLimited(res.body, AGENT_LIMITS.maxFetchBytes);
      const body = /html|xml/i.test(contentType) ? htmlToText(read.text) : { title: "", text: read.text };
      const header = [`URL: ${url.toString()}`];
      if (body.title.length > 0) header.push(`Title: ${body.title}`);
      const truncated = truncateText(`${header.join("\n")}\n\n${body.text}`, {
        maxBytes: AGENT_LIMITS.maxFetchBytes,
      });
      return {
        ok: true,
        output: truncated.text,
        ...(truncated.truncated || read.truncated ? { truncated: true } : {}),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = controller.signal.aborted
        ? "请求超时或已取消"
        : `请求失败：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
