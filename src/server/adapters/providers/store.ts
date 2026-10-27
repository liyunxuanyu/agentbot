import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../../config.js";
import type { ProviderConfig, ProviderProtocol } from "../../core/agent/provider.js";

/**
 * 模型供应商配置（`~/.agentbot/providers.json`，权限 0600）。
 *
 * 为什么是文件而不是表：apiKey 属于本地凭据，不该进业务数据库（备份/导出会把
 * 密钥一起带走）；现有 token 也是文件 + 权限收紧，沿用同一套做法。
 *
 * 本模块只做读写与校验，不发请求；协议客户端在 `openai-chat.ts` / `anthropic.ts`。
 */

const PROTOCOLS: readonly ProviderProtocol[] = ["openai-chat", "anthropic-messages"];

const providerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64).optional(),
  protocol: z.enum(["openai-chat", "anthropic-messages"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  contextWindow: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  supportsTools: z.boolean().default(true),
  supportsStreaming: z.boolean().default(true),
  headers: z.record(z.string()).optional(),
});

const fileSchema = z.object({
  defaultId: z.string().nullable().optional(),
  providers: z.array(providerSchema).default([]),
});

export interface ProviderFile {
  defaultId: string | null;
  providers: ProviderConfig[];
}

/** 前端可见的供应商形状：**永不回明文 apiKey**。 */
export interface ProviderDto {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsStreaming: boolean;
  /** 掩码，如 `sk-****abcd`。 */
  apiKeyMasked: string;
  isDefault: boolean;
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export function providerDto(p: ProviderConfig, defaultId: string | null): ProviderDto {
  return {
    id: p.id,
    name: p.name ?? p.id,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    model: p.model,
    contextWindow: p.contextWindow,
    maxOutputTokens: p.maxOutputTokens,
    supportsTools: p.supportsTools,
    supportsStreaming: p.supportsStreaming,
    apiKeyMasked: maskApiKey(p.apiKey),
    isDefault: p.id === defaultId,
  };
}

export function readProviderFile(path: string = config.providersPath): ProviderFile {
  if (!existsSync(path)) return { defaultId: null, providers: [] };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[providers] 配置格式无效，已按空配置处理：${parsed.error.issues[0]?.message ?? ""}`);
      return { defaultId: null, providers: [] };
    }
    const providers = parsed.data.providers as ProviderConfig[];
    const defaultId =
      parsed.data.defaultId && providers.some((p) => p.id === parsed.data.defaultId)
        ? parsed.data.defaultId
        : (providers[0]?.id ?? null);
    return { defaultId, providers };
  } catch (err) {
    console.warn(
      `[providers] 读取失败，已按空配置处理：${err instanceof Error ? err.message : String(err)}`,
    );
    return { defaultId: null, providers: [] };
  }
}

export function writeProviderFile(file: ProviderFile, path: string = config.providersPath): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  harden(path);
}

function harden(path: string): void {
  if (process.platform === "win32") return; // Windows 由文件 ACL 继承，权限收紧失败不阻断
  try {
    chmodSync(path, 0o600);
  } catch {
    console.warn("[providers] 无法 chmod providers.json");
  }
}

export function listProviders(): ProviderConfig[] {
  return readProviderFile().providers;
}

export function getProvider(id: string): ProviderConfig | null {
  return readProviderFile().providers.find((p) => p.id === id) ?? null;
}

/**
 * 解析本次会话要用的供应商：
 *   ① 显式绑定（Bot 的 provider_id）存在 → 用它；
 *   ② 否则用文件里的 defaultId；
 *   ③ 再否则用第一条。
 * 一个都没有返回 null（内置引擎不可用）。
 */
export function resolveProvider(providerId: string | null | undefined): ProviderConfig | null {
  const file = readProviderFile();
  if (providerId) {
    const bound = file.providers.find((p) => p.id === providerId);
    if (bound) return bound;
  }
  if (file.defaultId) {
    const def = file.providers.find((p) => p.id === file.defaultId);
    if (def) return def;
  }
  return file.providers[0] ?? null;
}

export function newProviderId(): string {
  return `prov_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function isProviderProtocol(v: unknown): v is ProviderProtocol {
  return typeof v === "string" && (PROTOCOLS as readonly string[]).includes(v);
}
