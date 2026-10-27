import type { ProviderConfig, ProviderProtocol } from "../../core/agent/provider.js";
import { joinUrl, joinVersionedUrl, readErrorMessage } from "./http.js";

/**
 * 模型清单与能力推断。
 *
 * 两件事：
 *   ① 从供应商**已有的 key** 拉一份模型列表（`GET /models`）——用户不必背模型名；
 *   ② 给每个模型带出「上下文窗口 / 最大输出 token」的默认值，允许用户手改。
 *
 * 为什么要有第 ②：两个协议都不在模型列表里返回上下文窗口（[OI] 规范没有这个字段，
 * Anthropic 的 `/v1/models` 只有 id / display_name / created_at）。所以默认值来自
 * 一张内置对照表 + 命名规则兜底，而不是「问供应商要」——问不到的东西不能假装问到了。
 * 表里没有的模型标 `known: false`，前端提示「默认值来自命名推断，请核对」。
 */

/** 一次拉取的上限，防止某个网关返回几万条把界面撑爆。 */
const MAX_MODELS = 500;

export interface ModelMeta {
  /** 模型 id（原样，请求时用这个）。 */
  id: string;
  /** 展示名；供应商没给就用 id。 */
  label: string;
  /** 上下文窗口（token）；无法判断时为 null。 */
  contextWindow: number | null;
  /** 最大输出 token；无法判断时为 null。 */
  maxOutputTokens: number | null;
  /** true = 命中内置对照表；false = 命名规则推断。 */
  known: boolean;
}

interface KnownModel {
  /** 匹配规则：小写包含即命中，按数组顺序取第一条。 */
  match: RegExp;
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * 内置对照表。数值取各家公开文档的**默认/常见上限**，只作为表单默认值，
 * 用户可改；宁可保守（偏小）也不要写大——写大会让请求被供应商拒绝。
 */
const KNOWN: readonly KnownModel[] = [
  // Anthropic
  { match: /claude.*opus.*4/, contextWindow: 200_000, maxOutputTokens: 32_000 },
  { match: /claude.*sonnet.*4/, contextWindow: 200_000, maxOutputTokens: 64_000 },
  { match: /claude.*haiku.*4/, contextWindow: 200_000, maxOutputTokens: 32_000 },
  { match: /claude-3[-.]7-sonnet/, contextWindow: 200_000, maxOutputTokens: 64_000 },
  { match: /claude-3[-.]5-sonnet/, contextWindow: 200_000, maxOutputTokens: 8_192 },
  { match: /claude-3[-.]5-haiku/, contextWindow: 200_000, maxOutputTokens: 8_192 },
  { match: /claude-3-(opus|sonnet|haiku)/, contextWindow: 200_000, maxOutputTokens: 4_096 },
  { match: /^claude/, contextWindow: 200_000, maxOutputTokens: 8_192 },

  // [OI]
  { match: /gpt-5/, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { match: /gpt-4\.1/, contextWindow: 1_047_576, maxOutputTokens: 32_768 },
  { match: /gpt-4o-mini/, contextWindow: 128_000, maxOutputTokens: 16_384 },
  { match: /gpt-4o/, contextWindow: 128_000, maxOutputTokens: 16_384 },
  { match: /gpt-4-turbo/, contextWindow: 128_000, maxOutputTokens: 4_096 },
  { match: /^gpt-4/, contextWindow: 8_192, maxOutputTokens: 4_096 },
  { match: /^o[134](-|$)/, contextWindow: 200_000, maxOutputTokens: 100_000 },

  // DeepSeek（含本机在用的 pix 网关）
  { match: /deepseek.*(v4|v3\.2|v3)/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { match: /deepseek-reasoner|deepseek-r1/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { match: /deepseek/, contextWindow: 64_000, maxOutputTokens: 8_192 },

  // Google
  { match: /gemini-2\.5/, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  { match: /gemini-2\.0/, contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  { match: /gemini-1\.5/, contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  { match: /^gemini/, contextWindow: 128_000, maxOutputTokens: 8_192 },

  // 国产与常见开源
  { match: /qwen.*(max|plus|turbo)/, contextWindow: 131_072, maxOutputTokens: 8_192 },
  { match: /^qwen/, contextWindow: 32_768, maxOutputTokens: 8_192 },
  { match: /glm-4\.[5-9]|glm-4-plus/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { match: /^glm/, contextWindow: 128_000, maxOutputTokens: 4_096 },
  { match: /kimi|moonshot/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { match: /llama-?3\.[1-9]/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { match: /^llama/, contextWindow: 8_192, maxOutputTokens: 4_096 },
  { match: /mistral|mixtral/, contextWindow: 32_768, maxOutputTokens: 8_192 },
];

/** 命名规则兜底：带 200k / 128k 之类字样的模型，尽量从名字里读出窗口。 */
function inferFromName(id: string): { contextWindow: number | null; maxOutputTokens: number | null } {
  const lower = id.toLowerCase();
  const window = /(\d{2,4})\s*k\b/.exec(lower);
  if (window?.[1] !== undefined) {
    const k = Number.parseInt(window[1], 10);
    if (Number.isFinite(k) && k >= 4 && k <= 2048) {
      return { contextWindow: k * 1024, maxOutputTokens: Math.min(8_192, Math.max(1_024, k * 64)) };
    }
  }
  return { contextWindow: null, maxOutputTokens: null };
}

/** 给一个模型 id 推断默认能力。 */
export function inferModelMeta(id: string, label?: string): ModelMeta {
  const lower = id.toLowerCase();
  for (const entry of KNOWN) {
    if (entry.match.test(lower)) {
      return {
        id,
        label: label ?? id,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        known: true,
      };
    }
  }
  const inferred = inferFromName(id);
  return {
    id,
    label: label ?? id,
    contextWindow: inferred.contextWindow,
    maxOutputTokens: inferred.maxOutputTokens,
    known: false,
  };
}

export class ModelListError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
}

/**
 * 拉取模型列表。
 *
 * 两个协议的路径与鉴权头不同，都在这里消化；调用方只拿到 `ModelMeta[]`。
 * 失败抛 `ModelListError`（含供应商原始错误，便于用户判断是 key 错还是网关不支持）。
 */
export async function fetchModels(
  cfg: Pick<ProviderConfig, "protocol" | "baseUrl" | "apiKey" | "headers">,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ModelMeta[]> {
  const url =
    cfg.protocol === "anthropic-messages"
      ? joinVersionedUrl(cfg.baseUrl, "v1", "/models")
      : joinUrl(cfg.baseUrl, "/models");

  const headers: Record<string, string> =
    cfg.protocol === "anthropic-messages"
      ? {
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          ...(cfg.headers ?? {}),
        }
      : {
          authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.headers ?? {}),
        };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new ModelListError(await readErrorMessage(res), res.status);
    }
    const raw: unknown = await res.json();
    const list = extractList(raw);
    if (list === null) {
      throw new ModelListError("供应商返回的模型列表格式无法识别（既不是 data 也不是 models 数组）");
    }
    return list
      .slice(0, MAX_MODELS)
      .map((m) => {
        const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
        const label =
          typeof m.display_name === "string" && m.display_name.length > 0 ? m.display_name : undefined;
        return id.length > 0 ? inferModelMeta(id, label) : null;
      })
      .filter((m): m is ModelMeta => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (err) {
    if (err instanceof ModelListError) throw err;
    if (controller.signal.aborted) {
      throw new ModelListError(`拉取模型列表超时（${opts.timeoutMs ?? 20_000}ms）`);
    }
    throw new ModelListError(
      `拉取模型列表失败：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** [OI] 回 `{data:[…]}`；部分网关回 `{models:[…]}`；也兼容直接给数组。 */
function extractList(raw: unknown): RawModel[] | null {
  if (Array.isArray(raw)) return raw as RawModel[];
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as { data?: unknown; models?: unknown };
  if (Array.isArray(obj.data)) return obj.data as RawModel[];
  if (Array.isArray(obj.models)) return obj.models as RawModel[];
  return null;
}

/** 协议默认的上下文窗口兜底（供应商与模型都判断不出来时用）。 */
export function defaultWindowFor(protocol: ProviderProtocol): number {
  return protocol === "anthropic-messages" ? 200_000 : 128_000;
}
