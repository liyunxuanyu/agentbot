import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../config.js";
import type { ProviderConfig, ProviderProtocol } from "../../core/agent/provider.js";
import builtinCatalog from "./model-catalog.json" with { type: "json" };
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
 * 一张**可维护的对照表** + 命名规则兜底，而不是「问供应商要」——问不到的东西不能
 * 假装问到了。表里没有的模型标 `known: false`，前端提示「默认值来自命名推断，请核对」。
 *
 * 表分两层：
 *   - 内置：`model-catalog.json`，随代码分发，升级时整体替换；
 *   - 用户覆盖：`~/.agentbot/model-catalog.json`，逐条追加/覆盖，优先于内置。
 * 用户改了内置表也不会丢，因为内置那份不进 `~/.agentbot`。
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
  /** true = 命中对照表；false = 命名规则推断。 */
  known: boolean;
}

/** 对照表里的一条规则。 */
export interface CatalogEntry {
  /** 正则（对模型 id 小写后匹配）。 */
  match: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** 来源说明，展示在设置页，方便用户判断可信度。 */
  note?: string;
}

export interface CatalogFile {
  version: number;
  updatedAt: string;
  note?: string;
  sources?: string[];
  models: CatalogEntry[];
}

export const CATALOG_PATH = join(config.home, "model-catalog.json");

function normalizeEntries(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row["match"] !== "string" || row["match"].length === 0) continue;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
    out.push({
      match: row["match"],
      contextWindow: num(row["contextWindow"]),
      maxOutputTokens: num(row["maxOutputTokens"]),
      ...(typeof row["note"] === "string" ? { note: row["note"] } : {}),
    });
  }
  return out;
}

/** 读用户覆盖表；文件不存在或格式坏了都返回空数组（内置表仍然生效）。 */
export function readUserCatalog(path: string = CATALOG_PATH): CatalogEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return [];
    return normalizeEntries((raw as { models?: unknown }).models);
  } catch (err) {
    console.warn(
      `[models] 用户模型表读取失败，已忽略：${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** 内置表（只读，来自打包进产物的 JSON）。 */
export function builtinEntries(): CatalogEntry[] {
  return normalizeEntries((builtinCatalog as { models?: unknown }).models);
}

/**
 * 写用户覆盖表（整表替换）。
 *
 * 校验放在调用方之外：这里只负责「把已经合法的条目落盘」，
 * 正则能否编译由 `validateCatalogEntries` 先判，避免把坏规则写进文件后
 * 每次启动都打一堆警告。
 */
export function writeUserCatalog(entries: CatalogEntry[], path: string = CATALOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: CatalogFile = {
    version: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    note: "用户覆盖表：优先于内置表命中。改完保存即生效。",
    models: entries,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  // 内容变了，编译缓存必须立刻失效（否则本次进程内仍按旧表推断）
  regexCache = null;
}

/** 校验一批条目；返回错误清单（空 = 全部合法）。 */
export function validateCatalogEntries(
  entries: { match: string; contextWindow: number | null; maxOutputTokens: number | null }[],
): string[] {
  const errors: string[] = [];
  entries.forEach((e, i) => {
    const label = `第 ${i + 1} 条`;
    if (typeof e.match !== "string" || e.match.trim().length === 0) {
      errors.push(`${label}：匹配规则不能为空`);
      return;
    }
    try {
      new RegExp(e.match, "i");
    } catch {
      errors.push(`${label}：正则无效（${e.match}）`);
    }
    if (e.contextWindow !== null && (!Number.isInteger(e.contextWindow) || e.contextWindow <= 0)) {
      errors.push(`${label}：上下文窗口必须是正整数或留空`);
    }
    if (
      e.maxOutputTokens !== null &&
      (!Number.isInteger(e.maxOutputTokens) || e.maxOutputTokens <= 0)
    ) {
      errors.push(`${label}：最大输出必须是正整数或留空`);
    }
    if (
      e.contextWindow !== null &&
      e.maxOutputTokens !== null &&
      e.maxOutputTokens > e.contextWindow
    ) {
      errors.push(`${label}：最大输出不能大于上下文窗口`);
    }
  });
  return errors;
}

/**
 * 生效的对照表 = 用户覆盖在前 + 内置在后。
 * 用户条目优先命中，所以想改某个模型只需写一条更靠前（或同 match）的规则。
 */
export function effectiveCatalog(): CatalogEntry[] {
  return [...readUserCatalog(), ...builtinEntries()];
}

/** 编译后的正则缓存：每次 infer 都 new RegExp 会在拉 500 个模型时明显变慢。 */
let regexCache: { key: string; list: { re: RegExp; entry: CatalogEntry }[] } | null = null;

function compiled(): { re: RegExp; entry: CatalogEntry }[] {
  const entries = effectiveCatalog();
  const key = entries.map((e) => `${e.match}|${e.contextWindow}|${e.maxOutputTokens}`).join("\n");
  if (regexCache && regexCache.key === key) return regexCache.list;
  const list: { re: RegExp; entry: CatalogEntry }[] = [];
  for (const entry of entries) {
    try {
      list.push({ re: new RegExp(entry.match, "i"), entry });
    } catch {
      // 坏正则跳过，不影响其它规则
      console.warn(`[models] 对照表规则无效，已跳过：${entry.match}`);
    }
  }
  regexCache = { key, list };
  return list;
}

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
  for (const { re, entry } of compiled()) {
    if (re.test(lower)) {
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
