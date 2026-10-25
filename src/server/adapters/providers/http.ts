import { ProviderError } from "../../core/agent/provider.js";

/**
 * 供应商 HTTP 公共层：URL 拼接、429/5xx 退避、SSE 切分。
 *
 * 只被 `adapters/providers/*` 使用；core 不 import 这里。
 */

export function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

/** 网关根地址可能已经带 `/v1`，避免拼成 `/v1/v1/messages`。 */
export function joinVersionedUrl(baseUrl: string, version: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const hasVersion = new RegExp(`/${version}$`).test(base);
  return `${base}${hasVersion ? "" : `/${version}`}${suffix}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError("请求已取消", "aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError("请求已取消", "aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 429 / 5xx 退避重试 2 次（1s、3s）。
 * 4xx（除 429）不重试：参数/密钥错误重试多少次都一样，只会让用户多等 4 秒。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw new ProviderError("请求已取消", "aborted");
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.status !== 429 && res.status < 500) return res;
      lastError = new ProviderError(`供应商返回 ${res.status}`, "http", res.status);
      if (attempt < 2) await sleep(attempt === 0 ? 1000 : 3000, signal);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (signal.aborted) throw new ProviderError("请求已取消", "aborted");
      lastError = err;
      if (attempt < 2) await sleep(attempt === 0 ? 1000 : 3000, signal);
    }
  }
  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError(
    `供应商不可用：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    "network",
  );
}

export interface SseFrame {
  event: string | null;
  data: string;
}

/** 把 fetch 的响应体切成 SSE 帧（兼容 `event:` 与纯 `data:` 两种写法）。 */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          yield { event: line.slice(6).trim(), data: "" };
          continue;
        }
        if (line.startsWith("data:")) {
          yield { event: null, data: line.slice(5).trim() };
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield { event: null, data: tail.slice(5).trim() };
  } finally {
    reader.releaseLock();
  }
}

export async function readErrorMessage(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // 忽略读取失败
  }
  if (text.length === 0) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const nested = typeof parsed.error === "object" && parsed.error !== null ? parsed.error.message : undefined;
    const msg = typeof nested === "string" ? nested : typeof parsed.error === "string" ? parsed.error : parsed.message;
    if (typeof msg === "string" && msg.length > 0) return `${res.status} ${msg}`;
  } catch {
    // 非 JSON
  }
  return `${res.status} ${text.slice(0, 500)}`;
}

export function isContextOverflow(message: string): boolean {
  return /context[_\s-]?length|maximum context|too many tokens|context window/i.test(message);
}

export function providerHttpError(status: number, message: string): ProviderError {
  if (isContextOverflow(message)) return new ProviderError(message, "context_overflow", status);
  return new ProviderError(message, "http", status);
}
