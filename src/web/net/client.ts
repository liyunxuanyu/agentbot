/**
 * REST 封装。
 *
 * 目录名为什么是 `net/` 而不是 `api/`：Vite 的 dev 代理把 `/api` 前缀整体转发给后端，
 * 模块 URL 一旦落在这个前缀下（`/api/client.ts`）就会被代理吞掉并返回 401。
 * 请求路径仍是 `/api/...`，但**源码目录不能叫 api**。实测踩到，改目录比改
 * vite.config 侵入更小（本轮不允许改工具链配置）。
 *
 * 三件事：
 *   ① token 引导（P0-14「UI 刷新不需重新输入 token」）：
 *      首次带 `?t=` 打开时把 token 存进 sessionStorage 并立刻 `history.replaceState`
 *      抹掉 URL 里的 token（架构 §8）。之后所有请求都靠 cookie（服务端在带 ?t= 时
 *      种 HttpOnly cookie），fetch 只需 `credentials: "same-origin"`；
 *      sessionStorage 里的副本用于「cookie 丢了但标签页还在」的兜底。
 *   ② 统一错误：非 2xx 抛 `ApiError`，调用方按 `status` 分支到错误态/空态。
 *   ③ 端点未落地时降级：M3 阶段 `/api/bots` 等端点还不存在（M4/M5 补），
 *      404 由 `isMissingEndpoint()` 识别，页面走空态而不是报错。
 */

const TOKEN_KEY = "agentbot.token";

/** 从 URL 取 `?t=`，存起来并从地址栏抹掉。必须在应用挂载前调用一次。 */
export function bootstrapToken(): void {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("t");
  if (fromQuery) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromQuery);
    } catch {
      // 隐私模式下 sessionStorage 可能不可写；cookie 仍在，不影响使用
    }
    // token 留在地址栏会被截图/分享泄漏；服务端已经种了 cookie，这里直接抹
    url.searchParams.delete("t");
    const clean = url.pathname + (url.search || "") + url.hash;
    window.history.replaceState(window.history.state, "", clean);
    return;
  }
  // 无 ?t= 时什么都不做：cookie 由浏览器自动带上
}

export function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 同上
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /**
     * 响应体（非 2xx 时的 JSON）。字段级错误靠它读取：
     * `400 {error:"invalid_bot", fields:[{field,code,message}]}` —— 前端要把
     * message 挂到对应输入框下方，而不是弹一个笼统的 toast（P0-03/P0-09）。
     */
    readonly body?: unknown,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }

  /** 取字段级错误列表（没有就返回空数组）。 */
  fieldErrors(): { field: string; index?: number; code: string; message: string }[] {
    const b = this.body;
    if (typeof b !== "object" || b === null) return [];
    const raw = (b as { fields?: unknown }).fields;
    if (!Array.isArray(raw)) return [];
    const out: { field: string; index?: number; code: string; message: string }[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec["field"] !== "string") continue;
      out.push({
        field: rec["field"],
        ...(typeof rec["index"] === "number" ? { index: rec["index"] } : {}),
        code: typeof rec["code"] === "string" ? rec["code"] : "invalid",
        message: typeof rec["message"] === "string" ? rec["message"] : "取值无效",
      });
    }
    return out;
  }

  /** 后端给的文案（如 `risk_confirmation_required` 的风险说明）。 */
  messageText(): string | null {
    const b = this.body;
    if (typeof b !== "object" || b === null) return null;
    const m = (b as { message?: unknown }).message;
    return typeof m === "string" ? m : null;
  }

  /**
   * 响应体里的 `message`（与 `messageText()` 同源，供模板/调用方当属性读）。
   *
   * `worktree_not_ready` 的原因只在这个字段里（`409 {error, message}`）：
   * 会话页要显示「为什么不能发」而不是原始错误码（P0-13）。
   */
  get bodyMessage(): string | null {
    return this.messageText();
  }
}

/**
 * 端点还没实现（M3 阶段常见）：调用方应走空态而不是错误态。
 *
 * 判定依据是**路由未注册**而不是「任意 404」：后端对未匹配的 `/api/*` 统一回
 * `404 {"error":"not_found"}`（`http/server.ts` 的 setNotFoundHandler）。
 * 而一个已实现但查不到资源的端点会回更具体的 code（如 `channel_not_found`），
 * 那种 404 是真实错误，必须走错误态而不是空态 —— 否则「会话被删了」会被
 * 显示成「还没有消息」，用户永远不知道发生了什么。
 */
export function isMissingEndpoint(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 501) return true;
  return err.status === 404 && err.code === "not_found";
}

/** 鉴权失败：整个应用该切到「去控制台取带 token 的 URL」门页。 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * 把 token 附到请求 URL 上。
 *
 * 为什么不用自定义 header：后端的 `extractToken()` 只认 `?t=` 与 `agentbot_token`
 * cookie 两种来源（见 `src/server/http/auth.ts`），自定义 header 会被忽略。
 *
 * 为什么每次都附而不是只靠 cookie：开发态前端由 Vite 提供 HTML，带 `?t=` 的首次
 * 页面请求到不了后端，cookie 也就种不下来；把 token 跟着每个 API/SSE 请求走，
 * 两种环境都能用。cookie 仍会在第一次带 `?t=` 的 API 请求后种下，之后是双保险。
 */
function withToken(path: string): string {
  const token = storedToken();
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}t=${encodeURIComponent(token)}`;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** 外部取消（切页/关面板时避免 setState 到已卸载组件）。 */
  signal?: AbortSignal;
  /** 覆盖默认超时（默认 15s；SSE 不走这里）。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 外部 signal 与内部超时合并：任一触发都中止
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(withToken(path), {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(0, "aborted", "请求已取消");
    }
    // 网络层失败（服务没起来）：status 0，页面显示「本地服务没有响应」
    throw new ApiError(0, "network_error", "本地服务没有响应");
  }
  clearTimeout(timeout);

  if (!res.ok) {
    let code = "http_error";
    let body: unknown = undefined;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      body = parsed;
      if (typeof parsed.error === "string") code = parsed.error;
    } catch {
      // 非 JSON 错误体（例如代理返回的 HTML）不解析
    }
    throw new ApiError(res.status, code, undefined, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// 端点封装（形状见 api/types.ts；M4/M5 按这个契约实现）
// ---------------------------------------------------------------------------

import type {
  AssignmentDetailResponse,
  AssignmentsResponse,
  BotCreateResponse,
  BotDetailResponse,
  BotPatchResponse,
  BotsResponse,
  ChannelDetailDto,
  ChannelDto,
  ChannelPatchResponse,
  ChannelsResponse,
  CompactResponse,
  CreateRuntimeRequest,
  CreateRuntimeResponse,
  DeleteBotRequest,
  DeleteBotResponse,
  ExecutionLocation,
  MemoryMutateResponse,
  MemoryResponse,
  MemoryScope,
  McpServerDto,
  McpServerInput,
  McpServersResponse,
  MetaDto,
  ModelListResponse,
  PermissionsResponse,
  PermissionMode,
  ProbeRuntimeResponse,
  ProviderDto,
  ProviderInput,
  ProviderProtocol,
  ProvidersResponse,
  ProviderTestResponse,
  PurgeResponse,
  TidyPreview,
  TidyResponse,
  TidyTarget,
  ModelCatalogResponse,
  CatalogEntry,
  RuntimesResponse,
  ScheduleDto,
  SchedulesResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionControlsInput,
  SessionControlsResponse,
  SessionEventsPageDto,
  SkillsResponse,
  SummarizeResponse,
  TokenResetResponse,
  TokenStatusResponse,
  TriggerType,
  UsageRange,
  UsageResponseDto,
} from "./types";

/** 新建渠道的请求体（`POST /api/channels`）。 */
export interface CreateChannelRequest {
  type: "dm" | "group";
  participantBotIds: string[];
  name?: string;
  hostBotId?: string;
}

export const api = {
  meta: (signal?: AbortSignal) => request<MetaDto>("/api/meta", { signal }),

  bots: (signal?: AbortSignal) => request<BotsResponse>("/api/bots", { signal }),

  /** 管理员 Bot 列表（R6）：管理页/标识用，不另开一套模型。 */
  adminBots: (signal?: AbortSignal) =>
    request<{ bots: import("./types").BotDto[]; totalBots: number }>("/api/admin/bots", { signal }),

  channels: (signal?: AbortSignal) => request<ChannelsResponse>("/api/channels", { signal }),

  createChannel: (body: CreateChannelRequest) =>
    request<{ channel: ChannelDto }>("/api/channels", { method: "POST", body }),

  /** 会话首屏：渠道 + Session 列表 + 消息 + SSE 首连游标。 */
  channel: (channelId: string, signal?: AbortSignal) =>
    request<ChannelDetailDto>(`/api/channels/${encodeURIComponent(channelId)}`, { signal }),

  /** 群聊/会话工作区（R2）：群聊里全员共用，不要求 git。 */
  patchChannel: (channelId: string, body: { workspacePath: string | null }) =>
    request<ChannelPatchResponse>(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      body,
    }),

  /**
   * 会话控制（R4/R5/R2）：供应商、模型、权限模式、工作区。
   * 只影响后续轮次与尚未裁决的调用；切 plan 时后端会把挂起写请求置 rejected。
   */
  patchSessionControls: (sessionId: string, body: SessionControlsInput) =>
    request<SessionControlsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/controls`,
      { method: "PATCH", body },
    ),

  /** 手动压缩上下文（R7）。force 缺省 true。 */
  compactSession: (sessionId: string, body: { force?: boolean } = {}) =>
    request<CompactResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
      method: "POST",
      body,
      timeoutMs: 120_000,
    }),

  /**
   * 历史事件回放（P0-04「刷新后从最后一条已落库事件继续」）。
   *
   * 分页游标是会话内 `seq`（不是全局 `id`），因为 `seq` 才是 UI 排序键。
   * 默认一次 2000 条，上限 5000；刷新时用 5000 拉全量，`hasMore` 为 true 继续翻页。
   * 返回的 `lastEventId` 是本页最大全局 id，直接给 SSE 当首连游标。
   */
  sessionEvents: (sessionId: string, afterSeq = 0, limit = 5000, signal?: AbortSignal) =>
    request<SessionEventsPageDto>(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
      { signal, timeoutMs: 30_000 },
    ),

  /**
   * 发消息。
   *
   * **超时必须比默认 15s 长**：群聊要等主持人决策完才回响应，而主持人决策上限是
   * 20s（`config.limits.groupDecisionMs`）。用默认 15s 会让群聊发送**必然**被
   * 前端判成「请求已取消」，消息其实已经落库、派发也在后台跑 —— 用户看到失败、
   * 实际成功，是最糟的一类错误。60s 覆盖「决策 20s + 慢网络余量」。
   */
  sendMessage: (body: SendMessageRequest) =>
    request<SendMessageResponse>("/api/messages", { method: "POST", body, timeoutMs: 60_000 }),

  /** 中断当前 Turn（P0-04「1s 内向运行时发出 cancel」）。 */
  cancelTurn: (sessionId: string, turnId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      body: { turnId },
    }),

  permissions: (sessionId: string, signal?: AbortSignal) =>
    request<PermissionsResponse>(
      `/api/permissions?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    ),

  decidePermission: (requestId: string, decision: string) =>
    request<void>(`/api/permissions/${encodeURIComponent(requestId)}/decision`, {
      method: "POST",
      body: { decision },
    }),

  // -------------------------------------------------------------------------
  // M14：运行时 / Bot 详情 / 记忆
  // -------------------------------------------------------------------------

  runtimes: (signal?: AbortSignal) => request<RuntimesResponse>("/api/runtimes", { signal }),

  // -------------------------------------------------------------------------
  // 内置引擎：模型供应商 / MCP / 技能
  // -------------------------------------------------------------------------

  providers: (signal?: AbortSignal) =>
    request<ProvidersResponse>("/api/providers", { signal }),

  createProvider: (body: ProviderInput & { apiKey: string }) =>
    request<{ provider: ProviderDto }>("/api/providers", { method: "POST", body }),

  updateProvider: (id: string, body: Partial<ProviderInput>) =>
    request<{ provider: ProviderDto }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),

  deleteProvider: (id: string) =>
    request<void>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  setDefaultProvider: (id: string) =>
    request<{ ok: boolean; defaultId: string }>(
      `/api/providers/${encodeURIComponent(id)}/default`,
      { method: "POST" },
    ),

  testProvider: (id: string) =>
    request<ProviderTestResponse>(`/api/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
      timeoutMs: 25_000,
    }),

  /** 用表单里正在填的 baseUrl/apiKey 拉模型清单；编辑已有供应商时给 id 即可。 */
  listProviderModels: (body: {
    id?: string;
    protocol?: ProviderProtocol;
    baseUrl?: string;
    apiKey?: string;
  }) =>
    request<ModelListResponse>("/api/providers/models", {
      method: "POST",
      body,
      timeoutMs: 30_000,
    }),

  /** 数据整理预览（只统计）。 */
  tidyPreview: (signal?: AbortSignal) =>
    request<{ preview: TidyPreview; targets: TidyTarget[] }>("/api/admin/tidy", { signal }),

  /** 执行数据整理（不可逆，需 confirm + 勾选的类别）。 */
  tidyApply: (targets: TidyTarget[]) =>
    request<TidyResponse>("/api/admin/tidy", {
      method: "POST",
      body: { confirm: true, targets },
      timeoutMs: 60_000,
    }),

  /** 模型能力对照表（内置 + 用户覆盖）。 */
  modelCatalog: (signal?: AbortSignal) =>
    request<ModelCatalogResponse>("/api/providers/catalog", { signal }),

  /** 整表替换用户覆盖表。 */
  saveModelCatalog: (models: CatalogEntry[]) =>
    request<{ ok: boolean; user: CatalogEntry[]; userPath: string }>("/api/providers/catalog", {
      method: "PUT",
      body: { models },
    }),

  /** 试匹配一条规则（不落盘）。 */
  testCatalogRule: (match: string, modelId: string) =>
    request<{ ok: boolean; hit: boolean }>("/api/providers/catalog/test", {
      method: "POST",
      body: { match, modelId },
    }),

  mcpServers: (signal?: AbortSignal) =>
    request<McpServersResponse>("/api/mcp", { signal }),

  createMcpServer: (body: McpServerInput) =>
    request<{ server: McpServerDto | null }>("/api/mcp", { method: "POST", body, timeoutMs: 30_000 }),

  updateMcpServer: (id: string, body: Partial<McpServerInput>) =>
    request<{ server: McpServerDto | null }>(`/api/mcp/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      timeoutMs: 30_000,
    }),

  deleteMcpServer: (id: string) =>
    request<void>(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 30_000 }),

  reconnectMcpServer: (id: string) =>
    request<{ ok: boolean; server: McpServerDto | null }>(
      `/api/mcp/${encodeURIComponent(id)}/reconnect`,
      { method: "POST", timeoutMs: 30_000 },
    ),

  skills: (signal?: AbortSignal) => request<SkillsResponse>("/api/skills", { signal }),

  rescanSkills: () =>
    request<SkillsResponse>("/api/skills/rescan", { method: "POST", timeoutMs: 30_000 }),

  /**
   * 手动添加自定义运行时（P0-01）。
   *
   * 后端先落 `unprobed` 行再探测（可能 3s detect + 10s health），所以超时放宽到 30s。
   * 重复可执行文件回 `409 {error:"already_exists", existingId, message}` —— 前端据此
   * 跳到已有条目，而不是当成普通失败（PRD 边界）。
   */
  createRuntime: (body: CreateRuntimeRequest) =>
    request<CreateRuntimeResponse>("/api/runtimes", { method: "POST", body, timeoutMs: 30_000 }),

  /** 单运行时重探（只影响这一行；其余行状态不动）。 */
  probeRuntime: (runtimeId: string) =>
    request<ProbeRuntimeResponse>(
      `/api/runtimes/${encodeURIComponent(runtimeId)}/probe`,
      { method: "POST", timeoutMs: 30_000 },
    ),

  bot: (botId: string, signal?: AbortSignal) =>
    request<BotDetailResponse>(`/api/bots/${encodeURIComponent(botId)}`, { signal }),

  createBot: (body: {
    name: string;
    persona?: string;
    runtimeId?: string;
    providerId?: string;
    executionLocation?: ExecutionLocation;
    repoPath?: string;
  }) => request<BotCreateResponse>("/api/bots", { method: "POST", body }),

  /**
   * 改 Bot（边界 / 运行时 / 执行位置）。
   *
   * `confirmRisk: true` 是「无权限通道的运行时放到 local」的二次确认令牌：
   * 不带它后端回 `400 risk_confirmation_required` + 风险文案，前端据此弹确认框。
   */
  patchBot: (
    botId: string,
    body: {
      allowDirs?: string[];
      allowShell?: boolean;
      allowNetwork?: boolean;
      autoApproveWrite?: boolean;
      runtimeId?: string;
      providerId?: string | null;
      executionLocation?: ExecutionLocation;
      repoPath?: string;
      /** 人格（≤4000 字符）；保存后下一条消息即生效（P0-03）。 */
      persona?: string;
      /** 管理员角色（R6）：admin 多一个 create_bot 工具。 */
      role?: "member" | "admin";
      /** Bot 默认权限模式（新会话继承；已有会话不受影响）。 */
      permissionMode?: PermissionMode;
      confirmRisk?: boolean;
    },
  ) => request<BotPatchResponse>(`/api/bots/${encodeURIComponent(botId)}`, { method: "PATCH", body }),

  /**
   * 删除 Bot（P0-03）。
   *
   * body 必须同时给 `confirmName`（与名称完全一致）与 `mode`：
   * cascade = 删会话/记忆/定时任务但保留用量；archive = 只置 archived。
   * worktree 由后端原样返回路径、不删除（P0-13）。
   */
  deleteBot: (botId: string, body: DeleteBotRequest) =>
    request<DeleteBotResponse>(`/api/bots/${encodeURIComponent(botId)}`, {
      method: "DELETE",
      body,
    }),

  memory: (botId: string, signal?: AbortSignal) =>
    request<MemoryResponse>(`/api/bots/${encodeURIComponent(botId)}/memory`, { signal }),

  createMemory: (
    botId: string,
    body: {
      content: string;
      injected?: boolean;
      kind?: "manual" | "summary";
      /** 缺省 bot（全局）；channel / session 需带对应归属。 */
      scope?: MemoryScope;
      sourceSessionId?: string;
      channelId?: string;
    },
  ) =>
    request<MemoryMutateResponse>(`/api/bots/${encodeURIComponent(botId)}/memory`, {
      method: "POST",
      body,
    }),

  patchMemory: (botId: string, memId: string, body: { content?: string; injected?: boolean }) =>
    request<MemoryMutateResponse>(
      `/api/bots/${encodeURIComponent(botId)}/memory/${encodeURIComponent(memId)}`,
      { method: "PATCH", body },
    ),

  deleteMemory: (botId: string, memId: string) =>
    request<{ ok: boolean }>(
      `/api/bots/${encodeURIComponent(botId)}/memory/${encodeURIComponent(memId)}`,
      { method: "DELETE" },
    ),

  summarizeMemory: (botId: string, sessionId?: string) =>
    request<SummarizeResponse>(`/api/bots/${encodeURIComponent(botId)}/memory/summarize`, {
      method: "POST",
      body: sessionId ? { sessionId } : {},
    }),

  // -------------------------------------------------------------------------
  // M14：任务 / 定时 / 用量 / 安全
  // -------------------------------------------------------------------------

  assignments: (params: { status?: string; botId?: string; channelId?: string } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.botId) q.set("botId", params.botId);
    if (params.channelId) q.set("channelId", params.channelId);
    const qs = q.toString();
    return request<AssignmentsResponse>(`/api/assignments${qs ? `?${qs}` : ""}`, { signal });
  },

  assignment: (id: string, signal?: AbortSignal) =>
    request<AssignmentDetailResponse>(`/api/assignments/${encodeURIComponent(id)}`, { signal }),

  createAssignment: (body: {
    channelId: string;
    title: string;
    deliverable: string;
    botId: string;
    sourceMessageId?: string;
  }) => request<AssignmentDetailResponse>("/api/assignments", { method: "POST", body }),

  schedules: (signal?: AbortSignal) =>
    request<SchedulesResponse>("/api/schedules", { signal }),

  createSchedule: (body: {
    name: string;
    botId: string;
    channelId: string;
    prompt: string;
    triggerType: TriggerType;
    delayMinutes?: number;
    intervalMinutes?: number;
    atTime?: string;
  }) => request<{ schedule: ScheduleDto }>("/api/schedules", { method: "POST", body }),

  patchSchedule: (id: string, body: { enabled?: boolean; name?: string; prompt?: string }) =>
    request<{ ok: boolean; schedule: ScheduleDto | null }>(
      `/api/schedules/${encodeURIComponent(id)}`,
      { method: "PATCH", body },
    ),

  deleteSchedule: (id: string) =>
    request<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  usage: (
    params: { range?: UsageRange; botId?: string; runtimeId?: string } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (params.range) q.set("range", params.range);
    if (params.botId) q.set("botId", params.botId);
    if (params.runtimeId) q.set("runtimeId", params.runtimeId);
    const qs = q.toString();
    return request<UsageResponseDto>(`/api/usage${qs ? `?${qs}` : ""}`, { signal });
  },

  /** 导出 URL（浏览器直接下载，不走 fetch —— 需要带 token）。 */
  usageCsvUrl: (params: { range?: UsageRange; botId?: string; runtimeId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.range) q.set("range", params.range);
    if (params.botId) q.set("botId", params.botId);
    if (params.runtimeId) q.set("runtimeId", params.runtimeId);
    return withToken(`/api/usage/export.csv${q.toString() ? `?${q.toString()}` : ""}`);
  },

  tokenStatus: (signal?: AbortSignal) =>
    request<TokenStatusResponse>("/api/token", { signal }),

  resetToken: () => request<TokenResetResponse>("/api/token/reset", { method: "POST" }),

  purgeAll: (confirm: string) =>
    request<PurgeResponse>("/api/admin/purge", { method: "POST", body: { confirm } }),
};

