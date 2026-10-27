import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import {
  getProvider,
  isProviderProtocol,
  listProviders,
  newProviderId,
  providerDto,
  readProviderFile,
  writeProviderFile,
  type ProviderDto,
} from "../../adapters/providers/store.js";
import { createProviderClient } from "../../adapters/providers/index.js";
import {
  builtinEntries,
  CATALOG_PATH,
  defaultWindowFor,
  fetchModels,
  ModelListError,
  readUserCatalog,
  validateCatalogEntries,
  writeUserCatalog,
  type CatalogEntry,
} from "../../adapters/providers/models.js";
import builtinCatalog from "../../adapters/providers/model-catalog.json" with { type: "json" };
import type { ProviderConfig, ProviderProtocol } from "../../core/agent/provider.js";

/**
 * 模型供应商端点（内置引擎 N1）。
 *
 *   GET    /api/providers              → 列表（apiKey 只回掩码）
 *   POST   /api/providers              → 新增
 *   PATCH  /api/providers/:id          → 修改（apiKey 省略 = 不变）
 *   DELETE /api/providers/:id          → 删除
 *   POST   /api/providers/:id/test     → 发一次最小请求测连通性
 *   POST   /api/providers/:id/default  → 设为默认供应商
 *
 * 纪律：**任何响应都不含明文 apiKey**，日志也不打印。
 */

interface FieldError {
  field: string;
  code: string;
  message: string;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface ProviderBody {
  id?: unknown;
  name?: unknown;
  protocol?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  supportsTools?: unknown;
  supportsStreaming?: unknown;
  headers?: unknown;
}

/** 拉模型清单的入参：新建时给全量，编辑时给 id 即可。 */
interface ModelListBody {
  id?: unknown;
  protocol?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  headers?: unknown;
}

function readHeaders(raw: unknown, fields: FieldError[]): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fields.push({ field: "headers", code: "not_object", message: "headers 必须是键值对象" });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      fields.push({ field: "headers", code: "not_string", message: `headers.${key} 必须是字符串` });
      return undefined;
    }
    out[key] = value;
  }
  return out;
}

function readProviderInput(
  body: ProviderBody,
  fields: FieldError[],
  opts: { requireId: boolean },
): Partial<ProviderConfig> & { id?: string } {
  const out: Partial<ProviderConfig> & { id?: string } = {};

  if (opts.requireId) {
    if (typeof body.id === "string" && body.id.length > 0) {
      if (!ID_PATTERN.test(body.id)) {
        fields.push({
          field: "id",
          code: "invalid_value",
          message: "id 只能包含字母、数字、- 和 _，且不超过 64 个字符",
        });
      } else {
        out.id = body.id;
      }
    }
  }

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      fields.push({ field: "name", code: "invalid_value", message: "名称不能为空" });
    } else if (body.name.length > 64) {
      fields.push({ field: "name", code: "too_long", message: "名称最多 64 个字符" });
    } else {
      out.name = body.name.trim();
    }
  }

  if (body.protocol !== undefined) {
    if (!isProviderProtocol(body.protocol)) {
      fields.push({
        field: "protocol",
        code: "invalid_value",
        message: "协议只能是 openai-chat 或 anthropic-messages",
      });
    } else {
      out.protocol = body.protocol;
    }
  }

  if (body.baseUrl !== undefined) {
    if (typeof body.baseUrl !== "string" || !isHttpUrl(body.baseUrl.trim())) {
      fields.push({ field: "baseUrl", code: "invalid_value", message: "baseUrl 必须是 http(s) 地址" });
    } else {
      out.baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
    }
  }

  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
      fields.push({ field: "apiKey", code: "invalid_value", message: "apiKey 不能为空" });
    } else {
      out.apiKey = body.apiKey.trim();
    }
  }

  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim().length === 0) {
      fields.push({ field: "model", code: "invalid_value", message: "model 不能为空" });
    } else {
      out.model = body.model.trim();
    }
  }

  if (body.contextWindow !== undefined) {
    if (body.contextWindow === null) out.contextWindow = null;
    else if (typeof body.contextWindow !== "number" || !Number.isInteger(body.contextWindow) || body.contextWindow <= 0) {
      fields.push({
        field: "contextWindow",
        code: "invalid_value",
        message: "contextWindow 必须是正整数或 null",
      });
    } else out.contextWindow = body.contextWindow;
  }

  if (body.maxOutputTokens !== undefined) {
    if (body.maxOutputTokens === null) out.maxOutputTokens = null;
    else if (typeof body.maxOutputTokens !== 'number' || !Number.isInteger(body.maxOutputTokens) || body.maxOutputTokens <= 0) {
      fields.push({
        field: 'maxOutputTokens',
        code: 'invalid_value',
        message: 'maxOutputTokens 必须是正整数或 null',
      });
    } else out.maxOutputTokens = body.maxOutputTokens;
  }

  if (body.supportsTools !== undefined) {
    if (typeof body.supportsTools !== "boolean") {
      fields.push({ field: "supportsTools", code: "invalid_value", message: "supportsTools 必须是布尔值" });
    } else out.supportsTools = body.supportsTools;
  }

  if (body.supportsStreaming !== undefined) {
    if (typeof body.supportsStreaming !== "boolean") {
      fields.push({
        field: "supportsStreaming",
        code: "invalid_value",
        message: "supportsStreaming 必须是布尔值",
      });
    } else out.supportsStreaming = body.supportsStreaming;
  }

  const headers = readHeaders(body.headers, fields);
  if (headers !== undefined) out.headers = headers;

  return out;
}

function requireComplete(input: Partial<ProviderConfig>, fields: FieldError[]): void {
  const required: (keyof ProviderConfig)[] = ["protocol", "baseUrl", "apiKey", "model"];
  for (const key of required) {
    if (input[key] === undefined) {
      fields.push({ field: String(key), code: "required", message: `${String(key)} 不能为空` });
    }
  }
}

function dtoOf(p: ProviderConfig, defaultId: string | null): ProviderDto {
  return providerDto(p, defaultId);
}

export function registerProviderRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/providers", async () => {
    const file = readProviderFile();
    return { providers: file.providers.map((p) => dtoOf(p, file.defaultId)), defaultId: file.defaultId };
  });

  app.post<{ Body: ProviderBody }>("/api/providers", async (req, reply) => {
    const body = req.body ?? {};
    const fields: FieldError[] = [];
    const input = readProviderInput(body, fields, { requireId: false });
    requireComplete(input, fields);
    const id = input.id ?? newProviderId();
    const file = readProviderFile();
    if (file.providers.some((p) => p.id === id)) {
      fields.push({ field: "id", code: "duplicate", message: `供应商 id 已存在：${id}` });
    }
    if (fields.length > 0) return json(reply, 400, { error: "invalid_provider", fields });

    const provider: ProviderConfig = {
      id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      protocol: input.protocol as ProviderProtocol,
      baseUrl: input.baseUrl as string,
      apiKey: input.apiKey as string,
      model: input.model as string,
      contextWindow: input.contextWindow ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      supportsTools: input.supportsTools ?? true,
      supportsStreaming: input.supportsStreaming ?? true,
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
    };
    const next = {
      defaultId: file.defaultId ?? provider.id,
      providers: [...file.providers, provider],
    };
    writeProviderFile(next);
    ctx.onProvidersChanged?.();
    return json(reply, 201, { provider: dtoOf(provider, next.defaultId) });
  });

  app.patch<{ Params: { id: string }; Body: ProviderBody }>(
    "/api/providers/:id",
    async (req, reply) => {
      const file = readProviderFile();
      const current = file.providers.find((p) => p.id === req.params.id);
      if (!current) return json(reply, 404, { error: "provider_not_found" });

      const body = req.body ?? {};
      const fields: FieldError[] = [];
      const input = readProviderInput(body, fields, { requireId: false });
      if (fields.length > 0) return json(reply, 400, { error: "invalid_provider", fields });

      const updated: ProviderConfig = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.supportsTools !== undefined ? { supportsTools: input.supportsTools } : {}),
        ...(input.supportsStreaming !== undefined ? { supportsStreaming: input.supportsStreaming } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
      };
      const next = {
        defaultId: file.defaultId,
        providers: file.providers.map((p) => (p.id === current.id ? updated : p)),
      };
      writeProviderFile(next);
      ctx.onProvidersChanged?.();
      return { provider: dtoOf(updated, next.defaultId) };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req, reply) => {
    const file = readProviderFile();
    if (!file.providers.some((p) => p.id === req.params.id)) {
      return json(reply, 404, { error: "provider_not_found" });
    }
    const providers = file.providers.filter((p) => p.id !== req.params.id);
    const defaultId = file.defaultId === req.params.id ? (providers[0]?.id ?? null) : file.defaultId;
    writeProviderFile({ defaultId, providers });
    ctx.onProvidersChanged?.();
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/default", async (req, reply) => {
    const file = readProviderFile();
    if (!file.providers.some((p) => p.id === req.params.id)) {
      return json(reply, 404, { error: "provider_not_found" });
    }
    writeProviderFile({ defaultId: req.params.id, providers: file.providers });
    ctx.onProvidersChanged?.();
    return { ok: true, defaultId: req.params.id };
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (req, reply) => {
    const provider = getProvider(req.params.id);
    if (!provider) return json(reply, 404, { error: "provider_not_found" });

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref?.();
    try {
      const client = createProviderClient(provider);
      await client.complete({
        messages: [{ role: "user", content: "Reply with OK." }],
        tools: [],
        maxOutputTokens: 8,
        signal: controller.signal,
      });
      return { ok: true, latencyMs: Date.now() - started, model: provider.model };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        model: provider.model,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  });

  // 供内置驱动复用：列出可用供应商（不含密钥），避免两处各读一次文件。
  app.get("/api/providers/available", async () => {
    const providers = listProviders();
    return { count: providers.length, defaultId: readProviderFile().defaultId };
  });

  /**
   * `GET /api/providers/catalog` —— 模型能力对照表。
   *
   * 分两层返回：`builtin` 随代码分发（只读），`user` 来自
   * `~/.agentbot/model-catalog.json`（用户可编辑，优先命中）。
   * 设置页用它展示「当前生效的规则」，用户想加模型就改用户表，不动代码。
   */
  app.get("/api/providers/catalog", async () => {
    return {
      builtin: builtinEntries(),
      user: readUserCatalog(),
      userPath: CATALOG_PATH,
      builtinVersion: (builtinCatalog as { version?: number }).version ?? 1,
      builtinUpdatedAt: (builtinCatalog as { updatedAt?: string }).updatedAt ?? "",
      sources: (builtinCatalog as { sources?: string[] }).sources ?? [],
    };
  });

  /**
   * `PUT /api/providers/catalog` —— 整表替换用户覆盖表。
   *
   * 整表替换而不是逐条增删：前端就是一个可编辑列表，用户改完一次提交，
   * 语义最直白，也避免「删到一半失败」留下半套规则。
   * 校验失败整批不落盘，返回每条的错误。
   */
  app.put<{ Body: { models?: unknown } }>("/api/providers/catalog", async (req, reply) => {
    const raw = req.body?.models;
    if (!Array.isArray(raw)) {
      return json(reply, 400, {
        error: "invalid_catalog",
        fields: [{ field: "models", code: "not_array", message: "models 必须是数组" }],
      });
    }
    if (raw.length > 200) {
      return json(reply, 400, {
        error: "invalid_catalog",
        fields: [{ field: "models", code: "too_many", message: "最多 200 条规则" }],
      });
    }

    const entries: CatalogEntry[] = [];
    const shapeErrors: string[] = [];
    raw.forEach((item, i) => {
      if (typeof item !== "object" || item === null) {
        shapeErrors.push(`第 ${i + 1} 条：必须是对象`);
        return;
      }
      const row = item as Record<string, unknown>;
      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
        return Number.isFinite(n) ? Math.floor(n) : null;
      };
      entries.push({
        match: typeof row["match"] === "string" ? row["match"].trim() : "",
        contextWindow: num(row["contextWindow"]),
        maxOutputTokens: num(row["maxOutputTokens"]),
        ...(typeof row["note"] === "string" && row["note"].trim().length > 0
          ? { note: row["note"].trim() }
          : {}),
      });
    });

    const errors = [...shapeErrors, ...validateCatalogEntries(entries)];
    if (errors.length > 0) {
      return json(reply, 400, { error: "invalid_catalog", fields: errors.map((m) => ({ field: "models", code: "invalid", message: m })) });
    }

    writeUserCatalog(entries);
    return { ok: true, user: entries, userPath: CATALOG_PATH };
  });

  /**
   * `POST /api/providers/catalog/test` —— 用某条规则试匹配一个模型 id。
   * 让用户不必「保存后去拉一遍模型」才知道正则写对没有。
   */
  app.post<{ Body: { match?: unknown; modelId?: unknown } }>(
    "/api/providers/catalog/test",
    async (req, reply) => {
      const match = typeof req.body?.match === "string" ? req.body.match : "";
      const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : "";
      if (match.length === 0 || modelId.length === 0) {
        return json(reply, 400, {
          error: "invalid_test",
          fields: [{ field: "match", code: "required", message: "需要 match 与 modelId" }],
        });
      }
      let hit = false;
      try {
        hit = new RegExp(match, "i").test(modelId.toLowerCase());
      } catch {
        return json(reply, 400, {
          error: "invalid_regex",
          fields: [{ field: "match", code: "invalid", message: "正则无效" }],
        });
      }
      return { ok: true, hit, modelId, match };
    },
  );

  /**
   * `POST /api/providers/models` —— 用「表单里正在填的」baseUrl / apiKey / protocol
   * 拉一份模型清单。新建供应商时还没落盘，所以不能按 id 取，必须吃 body。
   *
   * 编辑已有供应商时只需给 id（apiKey 留空表示用已存的）。
   * 响应带每个模型的上下文窗口 / 最大输出默认值，供表单「带出来」。
   */
  app.post<{ Body: ModelListBody }>("/api/providers/models", async (req, reply) => {
    const body = req.body ?? {};
    let protocol: ProviderProtocol | undefined;
    let baseUrl: string | undefined;
    let apiKey: string | undefined;
    let headers: Record<string, string> | undefined;

    const existingId = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
    if (existingId) {
      const existing = getProvider(existingId);
      if (!existing) return json(reply, 404, { error: "provider_not_found" });
      protocol = existing.protocol;
      baseUrl = existing.baseUrl;
      apiKey = existing.apiKey;
      headers = existing.headers;
    }

    if (isProviderProtocol(body.protocol)) protocol = body.protocol;
    if (typeof body.baseUrl === "string" && body.baseUrl.trim().length > 0) {
      baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
    }
    // 明文 key 只在内存里用一次，不写日志、不回响应
    if (typeof body.apiKey === "string" && body.apiKey.trim().length > 0) {
      apiKey = body.apiKey.trim();
    }
    const parsedHeaders = readHeaders(body.headers, []);
    if (parsedHeaders !== undefined) headers = parsedHeaders;

    const fields: FieldError[] = [];
    if (protocol === undefined) {
      fields.push({ field: "protocol", code: "required", message: "需要 protocol 或已有供应商 id" });
    }
    if (baseUrl === undefined) {
      fields.push({ field: "baseUrl", code: "required", message: "需要 baseUrl 或已有供应商 id" });
    }
    if (apiKey === undefined) {
      fields.push({ field: "apiKey", code: "required", message: "需要 apiKey 或已有供应商 id" });
    }
    if (fields.length > 0) return json(reply, 400, { error: "invalid_provider", fields });

    const started = Date.now();
    try {
      const models = await fetchModels({
        protocol: protocol as ProviderProtocol,
        baseUrl: baseUrl as string,
        apiKey: apiKey as string,
        ...(headers !== undefined ? { headers } : {}),
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        count: models.length,
        models,
        /** 供应商与模型都判断不出窗口时的兜底值，前端可显示为「默认」。 */
        fallbackContextWindow: defaultWindowFor(protocol as ProviderProtocol),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        count: 0,
        models: [],
        error: message,
        ...(err instanceof ModelListError && err.status !== undefined ? { status: err.status } : {}),
      };
    }
  });
}
