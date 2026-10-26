import type { DB } from "../core/db/db.js";
import type { RuntimeRecord } from "../adapters/probe.js";
import { requiresWorktree } from "../core/permissions/worktree-guard.js";

/**
 * REST 的读取查询（DTO 装配）。
 *
 * 为什么放在 http/ 而不是 core/repo/：这一层做的是「把行拼成前端契约形状」，
 * 属于表现层职责（`scripts/check-boundaries.mjs` 也把 http/ 排除在协议检查外）。
 * core/repo 的四个文件是 M2 定稿的纯 SQL 仓储，本模块不往那里塞 DTO 逻辑。
 *
 * 所有形状对齐 `src/web/net/types.ts`：
 *   - camelCase、时间 epoch ms、未上报用 null；
 *   - Bot 的 runtime 内联展开，前端不做第二次请求。
 */

export interface CapabilityDto {
  plan: boolean | null;
  permission: boolean | null;
  resume: boolean | null;
  contextWindow: number | null;
  streaming: boolean;
}

export interface RuntimeDto {
  id: string;
  displayName: string;
  protocol: string;
  version: string | null;
  healthStatus: string;
  capabilitiesSource: "probed" | "declared";
  capabilities: CapabilityDto;
  /** 以下为 M4 补充字段（前端类型里可选，旧字段不动）。 */
  adapterName: string;
  command: string;
  minVersion: string | null;
  /** 展示层可用性：ready | missing | timeout | unhealthy | unprobed。 */
  availability: string;
  executable: string | null;
  meetsMinVersion: boolean | null;
  probeDetail: string | null;
  lastProbeAt: number | null;
  /** 该运行时实际会产出的事件类型（能力掩码）。 */
  eventCapabilities: string[];
  /**
   * 该运行时是否强制 worktree（`permission.channel === 'none'`）。
   *
   * 前端据此：绑定时把执行位置锁成 worktree、改成 local 时弹二次确认、
   * 会话头显示「此运行时不提供权限请求，已在 worktree 隔离」。
   */
  requiresWorktree: boolean;
}

/** Tri → 前端的三态：true / false / null（未知 ≠ 不支持）。 */
function triOf(v: boolean | "unknown"): boolean | null {
  return v === "unknown" ? null : v;
}

export function toRuntimeDto(record: RuntimeRecord): RuntimeDto {
  return {
    id: record.id,
    displayName: record.displayName,
    protocol: record.protocol,
    version: record.version,
    healthStatus: record.availability,
    // 如实报来源：只有真的拿到了运行时的能力上报才叫 probed
    capabilitiesSource: record.capabilitiesSource,
    capabilities: {
      plan: triOf(record.capabilities.plan),
      permission: triOf(record.capabilities.permissionRequest),
      resume: triOf(record.capabilities.resume),
      contextWindow: record.capabilities.contextWindow,
      // 前端 streaming 是 boolean（false 时不画假光标）；未知按 false 处理
      streaming: record.capabilities.streaming === true,
    },
    adapterName: record.adapterName,
    command: record.command,
    minVersion: record.minVersion,
    availability: record.availability,
    executable: record.executable,
    meetsMinVersion: record.meetsMinVersion,
    probeDetail: record.probeDetail,
    lastProbeAt: record.lastProbeAt,
    eventCapabilities: record.eventCapabilities,
    requiresWorktree: requiresWorktree({
      permission: { channel: record.permissionChannel ?? undefined },
    }),
  };}

export type BotState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";

export interface BotDto {
  id: string;
  name: string;
  persona: string;
  avatar: string | null;
  colorIndex: number;
  runtime: RuntimeDto | null;
  /** 内置引擎绑定的模型供应商 id；其它运行时为 null。 */
  providerId: string | null;
  /** 管理员 Bot：多一个 create_bot 工具（不自动获得 full 权限）。 */
  role: "member" | "admin";
  /** Bot 默认权限模式；会话显式设置优先于它。 */
  permissionMode: "confirm" | "auto" | "plan" | "full";
  executionLocation: "local" | "worktree";
  /** 默认工作区（`bots.repo_path`）；未设置时前端显示「未设置默认工作区」。 */
  defaultWorkspace: string | null;
  effectivePath: string | null;
  worktreeState: "ready" | "missing" | "failed" | null;
  status: "active" | "archived";
  state: BotState;
  stateSince: number | null;
  pendingPermissions: number;
  lastActiveAt: number | null;
  createdAt: number;
}

interface BotRow {
  id: string;
  name: string;
  persona: string;
  avatar: string | null;
  default_runtime_id: string | null;
  provider_id: string | null;
  role: string;
  permission_mode: string;
  execution_location: string;
  repo_path: string | null;
  worktree_path: string | null;
  worktree_state: string | null;
  status: string;
  created_at: number;
}

interface SessionRow {
  id: string;
  bot_id: string;
  channel_id: string;
  runtime_id: string | null;
  runtime_session_id: string | null;
  resume_state: string;
  status: string;
  workspace_path: string | null;
  provider_id: string | null;
  model: string | null;
  permission_mode: string;
  started_at: number;
  ended_at: number | null;
}

/** Bot 六态：由最新 Session 状态 + 待批权限推导（UI 层语义，见 types.ts）。 */
function deriveBotState(sessionStatus: string | null, pendingPermissions: number): BotState {
  if (pendingPermissions > 0) return "blocked";
  switch (sessionStatus) {
    case "running":
      return "working";
    case "starting":
    case "created":
      return "thinking";
    case "waiting_permission":
      return "waiting";
    case "idle":
    case "ready":
    case "reaped":
      return "done";
    default:
      return "idle";
  }
}

export function listBots(db: DB, runtimes: Map<string, RuntimeDto>): BotDto[] {
  const bots = db
    .prepare(
      `SELECT id, name, persona, avatar, default_runtime_id, provider_id, role,
              permission_mode, execution_location,
              repo_path, worktree_path, worktree_state, status, created_at
         FROM bots
        WHERE status = 'active'
        ORDER BY created_at ASC`,
    )
    .all() as BotRow[];

  if (bots.length === 0) return [];

  const ids = bots.map((b) => b.id);
  const placeholders = ids.map(() => "?").join(",");

  // 每个 Bot 的最新 Session（一次查询，避免 N+1）
  const sessions = db
    .prepare(
      `SELECT s.* FROM sessions s
         JOIN (SELECT bot_id, MAX(started_at) AS mx FROM sessions
                WHERE bot_id IN (${placeholders}) GROUP BY bot_id) m
           ON s.bot_id = m.bot_id AND s.started_at = m.mx`,
    )
    .all(...ids) as SessionRow[];
  const sessionByBot = new Map(sessions.map((s) => [s.bot_id, s]));

  const pendingRows = db
    .prepare(
      `SELECT bot_id, COUNT(*) AS n FROM permission_requests
        WHERE status = 'pending' AND bot_id IN (${placeholders})
        GROUP BY bot_id`,
    )
    .all(...ids) as { bot_id: string; n: number }[];
  const pendingByBot = new Map(pendingRows.map((r) => [r.bot_id, r.n]));

  const lastActiveRows = db
    .prepare(
      `SELECT bot_id, MAX(created_at) AS ts FROM usage_records
        WHERE bot_id IN (${placeholders}) GROUP BY bot_id`,
    )
    .all(...ids) as { bot_id: string; ts: number }[];
  const lastActiveByBot = new Map(lastActiveRows.map((r) => [r.bot_id, r.ts]));

  return bots.map((row, index) => {
    const session = sessionByBot.get(row.id) ?? null;
    const pending = pendingByBot.get(row.id) ?? 0;
    const runtime = row.default_runtime_id ? (runtimes.get(row.default_runtime_id) ?? null) : null;
    const effectivePath =
      row.execution_location === "worktree" ? row.worktree_path : row.repo_path;

    return {
      id: row.id,
      name: row.name,
      persona: row.persona,
      avatar: row.avatar,
      // 身份色序号 1–8：按创建顺序轮转，保证同一 Bot 颜色稳定
      colorIndex: (index % 8) + 1,
      runtime,
      providerId: row.provider_id ?? null,
      role: row.role === "admin" ? "admin" : "member",
      permissionMode:
        row.permission_mode === "auto" || row.permission_mode === "plan" || row.permission_mode === "full"
          ? row.permission_mode
          : "confirm",
      executionLocation: row.execution_location === "worktree" ? "worktree" : "local",
      defaultWorkspace: row.repo_path ?? null,
      effectivePath: effectivePath ?? null,
      worktreeState:
        row.worktree_state === "ready" || row.worktree_state === "missing" || row.worktree_state === "failed"
          ? row.worktree_state
          : null,
      status: row.status === "archived" ? "archived" : "active",
      state: deriveBotState(session?.status ?? null, pending),
      stateSince: session?.started_at ?? null,
      pendingPermissions: pending,
      lastActiveAt: lastActiveByBot.get(row.id) ?? session?.started_at ?? null,
      createdAt: row.created_at,
    };
  });
}

export interface ChannelDto {
  id: string;
  type: "dm" | "group" | "task";
  name: string;
  participantBotIds: string[];
  hostBotId: string | null;
  /** 群聊/会话工作区；null 表示走回退链（Bot 默认工作区 → 服务进程 cwd）。 */
  workspacePath: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: number | null;
  unread: number;
  createdAt: number;
}

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  participant_bot_ids: string;
  host_bot_id: string | null;
  workspace_path: string | null;
  created_at: number;
}

function parseIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toChannelDto(db: DB, row: ChannelRow): ChannelDto {
  const last = db
    .prepare(
      `SELECT content, created_at FROM messages
        WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(row.id) as { content: string; created_at: number } | undefined;

  return {
    id: row.id,
    type: row.type === "group" ? "group" : row.type === "task" ? "task" : "dm",
    name: row.name,
    participantBotIds: parseIds(row.participant_bot_ids),
    hostBotId: row.host_bot_id,
    workspacePath: row.workspace_path ?? null,
    lastMessagePreview: last ? last.content.slice(0, 80) : null,
    lastMessageAt: last?.created_at ?? null,
    // 未读数没有独立表（M4 不做已读状态），如实为 0 而不是编一个数
    unread: 0,
    createdAt: row.created_at,
  };
}

export function listChannels(db: DB): ChannelDto[] {
  const rows = db
    .prepare("SELECT * FROM channels ORDER BY created_at DESC")
    .all() as ChannelRow[];
  return rows.map((row) => toChannelDto(db, row));
}

export function getChannel(db: DB, channelId: string): ChannelDto | null {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as
    | ChannelRow
    | undefined;
  return row ? toChannelDto(db, row) : null;
}

export interface SessionDto {
  id: string;
  channelId: string;
  botId: string;
  runtimeId: string | null;
  resumeState: "fresh" | "resumed" | "rebuilt";
  status: string;
  /** 会话级工作区覆盖；null 表示走回退链。 */
  workspacePath: string | null;
  /** 会话级模型覆盖；null 表示用 Bot 的默认供应商 / 供应商默认模型。 */
  providerId: string | null;
  model: string | null;
  permissionMode: "confirm" | "auto" | "plan" | "full";
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export function listSessionsByChannel(db: DB, channelId: string): SessionDto[] {
  const rows = db
    .prepare("SELECT * FROM sessions WHERE channel_id = ? ORDER BY started_at ASC")
    .all(channelId) as SessionRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const counts = db
    .prepare(
      `SELECT session_id, COUNT(*) AS n,
              SUM(COALESCE(tokens_in,0)) AS tin, SUM(COALESCE(tokens_out,0)) AS tout,
              SUM(CASE WHEN tokens_in IS NULL AND tokens_out IS NULL THEN 0 ELSE 1 END) AS reported
         FROM messages WHERE session_id IN (${placeholders}) GROUP BY session_id`,
    )
    .all(...ids) as { session_id: string; n: number; tin: number; tout: number; reported: number }[];
  const byId = new Map(counts.map((c) => [c.session_id, c]));

  return rows.map((row) => {
    const agg = byId.get(row.id);
    // 未上报用 null（P0-12 不估算）；有一条上报过就给聚合值
    const reported = (agg?.reported ?? 0) > 0;
    return {
      id: row.id,
      channelId: row.channel_id,
      botId: row.bot_id,
      runtimeId: row.runtime_id,
      resumeState:
        row.resume_state === "resumed" ? "resumed" : row.resume_state === "rebuilt" ? "rebuilt" : "fresh",
      status: row.status,
      workspacePath: row.workspace_path ?? null,
      providerId: row.provider_id ?? null,
      model: row.model ?? null,
      permissionMode:
        row.permission_mode === "auto" || row.permission_mode === "plan" || row.permission_mode === "full"
          ? row.permission_mode
          : "confirm",
      startedAt: row.started_at,
      endedAt: row.ended_at,
      messageCount: agg?.n ?? 0,
      tokensIn: reported ? (agg?.tin ?? 0) : null,
      tokensOut: reported ? (agg?.tout ?? 0) : null,
    };
  });
}

export interface MessageDto {
  id: string;
  sessionId: string;
  channelId: string;
  turnId: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentVersion: number;
  status: string;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  channel_id: string;
  turn_id: string;
  role: string;
  content: string;
  content_version: number;
  status: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: number;
}

export function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    channelId: row.channel_id,
    turnId: row.turn_id,
    role: row.role === "user" ? "user" : row.role === "system" ? "system" : "assistant",
    content: row.content,
    contentVersion: row.content_version,
    status: row.status,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
  };
}

/** 渠道首屏消息：取最近 N 条，按时间升序返回（前端直接渲染）。 */
export function listChannelMessages(db: DB, channelId: string, limit = 200): MessageDto[] {
  // 同毫秒用 rowid 兜底（插入顺序）：`id` 是随机 UUID，用它排序会把同一毫秒
  // 写入的 user / assistant 排反（P0-15「重启后顺序一致」）。
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE channel_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(channelId, limit) as MessageRow[];
  return rows.reverse().map(toMessageDto);
}

/**
 * SSE 首连游标：该渠道所有 Session 里最大的 events.id。
 *
 * 前端拿它建连，正好补上「REST 拉历史 → 建立连接」之间的空隙（架构 §7）。
 *
 * **注意**：渠道里可能有多个 Session（群聊每个发言人一个），把全局最大值当
 * 某个 Session 的游标会把它之前的事件整段跳过。所以 `GET /api/channels/:id`
 * 必须同时给 `lastEventIdBySession`；这个全局值只作向后兼容保留。
 */
export function lastEventIdOfChannel(db: DB, channelId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(e.id) AS mx FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.channel_id = ?`,
    )
    .get(channelId) as { mx: number | null } | undefined;
  return row?.mx ?? 0;
}

/**
 * 按 Session 分别给 SSE 首连游标（`{ [sessionId]: maxEventId }`）。
 *
 * 前端按 Session 各建一条 SSE 连接、各用自己的游标 —— 这是群聊历史不丢的
 * 唯一正确做法（渠道级全局游标会把主 Session 的事件整段跳过）。
 * 没有事件的 Session 不出现在结果里（前端按 `?? 0` 兜底）。
 */
export function lastEventIdsBySession(db: DB, channelId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, MAX(e.id) AS mx
         FROM sessions s
         JOIN events e ON e.session_id = s.id
        WHERE s.channel_id = ?
        GROUP BY s.id`,
    )
    .all(channelId) as { session_id: string; mx: number | null }[];

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (typeof row.mx === "number") out[row.session_id] = row.mx;
  }
  return out;
}

/**
 * 出帧时补 `payload.botId`（M4）。
 *
 * 为什么不在 ingest 补：M2 的 ingest 把 payload 规整成「已知字段」，额外键会被
 * 丢掉；而前端要求事件带 botId —— 群聊里主持人 ≠ 发言人，只靠主持人兜底会让
 * Turn 头写错名字。归属是确定的（一个 Session 只属于一个 Bot），按 sessionId
 * 查一次即可，结果缓存，避免每帧查库。
 */
export function createBotIdEnricher(db: DB): (row: { sessionId: string; payload: unknown }) => unknown {
  const cache = new Map<string, string | null>();
  return (row) => {
    const payload = row.payload;
    if (typeof payload !== "object" || payload === null) return payload;
    if ("botId" in (payload as Record<string, unknown>)) return payload;

    let botId = cache.get(row.sessionId);
    if (botId === undefined) {
      const found = db.prepare("SELECT bot_id FROM sessions WHERE id = ?").get(row.sessionId) as
        | { bot_id: string }
        | undefined;
      botId = found?.bot_id ?? null;
      cache.set(row.sessionId, botId);
    }
    if (botId === null) return payload;
    return { ...(payload as Record<string, unknown>), botId };
  };
}

export function getSession(db: DB, sessionId: string): SessionRow | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | SessionRow
    | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// 事件回放（P0-04 / P0-05）
// ---------------------------------------------------------------------------

/**
 * 一条历史事件。**形状与 SSE 帧的 `data` 完全一致**（`SseFrame`）。
 *
 * 为什么必须一致：前端把 REST 历史与 SSE 增量放进同一个事件表，
 * 两条路径产出不同形状会让「刷新后历史事件消失 / 字段缺失」这类问题
 * 只在刷新时复现。前端 `RawEvent` 按同一套字段读。
 */
export interface EventDto {
  id: number;
  sessionId: string;
  messageId: string | null;
  turnId: string;
  type: string;
  seq: number;
  payload: unknown;
  raw: unknown | null;
  createdAt: number;
}

/**
 * 事件行 → DTO。
 *
 * `enrich` 用于补 `payload.botId`（M4）：与 SSE 出帧走同一个 enricher，
 * 保证「历史」与「实时」里同一事件的 payload 逐字段相同。
 * `meta` 事件也原样返回 —— 前端靠它生成 Session 分隔条，漏掉它刷新后分隔条全丢。
 */
export function toEventDto(
  row: { id: number; sessionId: string; messageId: string | null; turnId: string; type: string; seq: number; payload: unknown; raw: unknown | null; createdAt: number },
  enrich?: (row: { sessionId: string; payload: unknown }) => unknown,
): EventDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    turnId: row.turnId,
    type: row.type,
    seq: row.seq,
    payload: enrich === undefined ? row.payload : enrich(row),
    raw: row.raw,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 记忆（M7 / P0-10）
// ---------------------------------------------------------------------------

/**
 * 记忆条目 DTO。
 *
 * `kind` 是库里的原值（manual | summary），`source` 是前端语义
 * （summary → 'auto'，用于标「自动摘要」）。两个都给：前端按 source 渲染徽标，
 * 按 kind 决定是否允许「回滚历史版本」（P1-03）时不必再翻译一次。
 */
export interface MemoryEntryDto {
  id: string;
  botId: string;
  content: string;
  /** 来源会话；手写条目可为 null。 */
  sourceSessionId: string | null;
  /** 作用域：bot = 该 Bot 全局；session = 仅来源会话；channel = 群聊内共享。 */
  scope: "bot" | "channel" | "session";
  channelId: string | null;
  source: "manual" | "auto";
  kind: "manual" | "summary";
  /** 是否参与下一轮注入。 */
  injected: boolean;
  version: number;
  updatedAt: number;
  createdAt: number;
}

interface MemoryRow {
  id: string;
  botId: string;
  content: string;
  sourceSessionId: string | null;
  scope: string;
  channelId: string | null;
  kind: string;
  injected: boolean;
  version: number;
  updatedAt: number;
  createdAt: number;
}

export function toMemoryDto(row: MemoryRow): MemoryEntryDto {
  const kind: "manual" | "summary" = row.kind === "summary" ? "summary" : "manual";
  return {
    id: row.id,
    botId: row.botId,
    content: row.content,
    sourceSessionId: row.sourceSessionId,
    scope:
      row.scope === "session" ? "session" : row.scope === "channel" ? "channel" : "bot",
    channelId: row.channelId,
    source: kind === "summary" ? "auto" : "manual",
    kind,
    injected: row.injected,
    version: row.version,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

/** 本轮注入估算（记忆页顶部「本轮注入估算 3,120 / 6,000 字符」）。 */
export interface MemoryInjectionDto {
  budget: number;
  usedChars: number;
  /** 实际注入条数。 */
  includedCount: number;
  /** 因预算被截断的条数（PRD：显示「已截断 N 条」）。 */
  truncatedCount: number;
  /** 人格占用字符数（含标题）。 */
  personaChars: number;
  personaTruncated: boolean;
}

// ---------------------------------------------------------------------------
// 用量（M13 / P0-12）
// ---------------------------------------------------------------------------

/**
 * 用量聚合行。
 *
 * 形状对齐原型 `USAGE` 与 UI §8.3 的列：Bot（头像/名称/身份色）+ 运行时 chip
 * + 请求数 / 输入 / 输出 / 占比条。**未上报用 null**（前端渲染 `—`，不估算）。
 */
export interface UsageRowDto {
  botId: string;
  /** Bot 已删除时为 null，前端显示「已删除 Bot」。 */
  botName: string | null;
  deleted: boolean;
  colorIndex: number | null;
  runtimeId: string | null;
  runtimeName: string | null;
  mode: "interactive" | "headless";
  /** 倍率提示（headless 通常 >1）；1 表示无额外倍率。 */
  multiplier: number;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 缓存命中（读）token；未上报为 null。 */
  cachedInputTokens: number | null;
  /** 缓存写入 token；OpenAI 无此口径，按 0 记录。 */
  cacheWriteTokens: number | null;
  /**
   * 缓存命中率（0–100，1 位小数）：缓存读 / (输入 + 缓存读)。
   * 未上报缓存口径时为 null（前端显示「未上报」而不是 0）。
   */
  cacheHitRate: number | null;
  unreportedRequests: number;
  /** 占总 token 的百分比（0–100，1 位小数）。 */
  share: number;
}

export interface UsageTotalsDto {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** 合计命中率；没有任何缓存上报时为 null。 */
  cacheHitRate: number | null;
  unreportedRequests: number;
}

export interface UsageResponseDto {
  range: "today" | "7d" | "30d" | "all";
  from: number | null;
  to: number;
  rows: UsageRowDto[];
  totals: UsageTotalsDto;
}
