/**
 * 前端认的 REST DTO。
 *
 * 这些形状是 **前端对后端（M4/M5）的接口契约**，与 `src/shared/events.ts` 的
 * 事件模型互补：事件负责「增量」，REST 负责「首屏与权威副本」。
 *
 * 约定：
 *   - 字段名一律 camelCase，时间一律 epoch ms（与 DB 列一致，服务端只做列名转换）；
 *   - 「未上报」用 `null` 表达，不用 0（P0-12：不估算）；
 *   - Bot 的运行时信息**内联展开**（`runtime` 对象），前端不做第二次请求拼装；
 *   - 任何列表端点都返回对象而不是裸数组（`{ bots: [...] }`），便于将来加游标字段。
 *
 * 端点缺失时（404）前端降级为空态而不是报错 —— 见 `api/client.ts` 的 `isMissingEndpoint`。
 */

import type { EventType, MetaEventKind } from "@shared/events";

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

/** 能力值三态：true 支持 / false 不支持 / null 未上报（未知 ≠ 不支持）。 */
export type CapabilityValue = boolean | null;

export interface CapabilitySet {
  plan: CapabilityValue;
  /** 是否会上报权限请求。 */
  permission: CapabilityValue;
  /** 是否支持 session resume。 */
  resume: CapabilityValue;
  /** 上下文窗口（token），未上报为 null。 */
  contextWindow: number | null;
  /** 是否流式输出；false 时 UI 不显示假光标（UX §6.1）。 */
  streaming: boolean;
}

/**
 * `GET /api/meta` 的 runtimes 目前只给 id/displayName/protocol/version/healthStatus。
 * `capabilities` 由 M4 的探测补齐；缺省时前端按「未上报」渲染能力徽标。
 */
export interface RuntimeSummary {
  id: string;
  displayName: string;
  protocol: string;
  version: string | null;
  /** ready | missing | unhealthy | unprobed | timeout */
  healthStatus: string;
  capabilitiesSource: "probed" | "declared";
  capabilities?: CapabilitySet;
  /**
   * 以下字段 `/api/meta` 不返回、`/api/bots` 内联的运行时返回（后端 `RuntimeDto`）。
   *
   * 声明为可选而不是另起类型：`BotDto.runtime` 的类型就是 `RuntimeSummary`，
   * 但实际载荷是完整行。旧端点继续编译，同时让「运行时不可用的原因」直接读
   * `probeDetail`（P0-02「置灰 + 原因『需要 ≥ x.y』」）。
   */
  adapterName?: string;
  command?: string;
  minVersion?: string | null;
  /** ready | missing | timeout | unhealthy | unprobed（展示层可用性）。 */
  availability?: string;
  executable?: string | null;
  meetsMinVersion?: boolean | null;
  /** 后端给的人话原因，如「需要 ≥ 0.20.0，当前 0.1.0」。 */
  probeDetail?: string | null;
  lastProbeAt?: number | null;
  eventCapabilities?: string[];
  /** 该运行时不提供权限请求 → 必须跑在 worktree。 */
  requiresWorktree?: boolean;
}

export interface MetaDto {
  version: string;
  schemaVersion: number;
  startedAt: number;
  runtimes: RuntimeSummary[];
}

// ---------------------------------------------------------------------------
// 内置引擎：模型供应商 / MCP / 技能
// ---------------------------------------------------------------------------

export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export interface ProviderDto {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  contextWindow: number | null;
  /** 单次回复最大输出 token；null = 不传，由供应商默认。 */
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsStreaming: boolean;
  /** 掩码，如 `sk-****abcd`；明文永不下发。 */
  apiKeyMasked: string;
  isDefault: boolean;
}

/** 从供应商拉到的模型条目（上下文/输出上限是默认值，可手改）。 */
export interface ModelMeta {
  id: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** true = 命中内置对照表；false = 命名推断，需用户核对。 */
  known: boolean;
}

export interface ModelListResponse {
  ok: boolean;
  latencyMs: number;
  count: number;
  models: ModelMeta[];
  fallbackContextWindow?: number;
  error?: string;
  status?: number;
}

export interface ProvidersResponse {
  providers: ProviderDto[];
  defaultId: string | null;
}

export interface ProviderInput {
  name?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
}

export interface ProviderTestResponse {
  ok: boolean;
  latencyMs: number;
  model: string;
  error?: string;
}

export type McpConnectionStatus = "connecting" | "connected" | "unavailable" | "disabled";

export interface McpServerDto {
  id: string;
  command: string;
  args: string[];
  enabled: boolean;
  /** 工具权限性质（R5-c）：read 的 server 在计划模式下仍然可用；null = 未声明（exec）。 */
  permission: McpServerPermission | null;
  status: McpConnectionStatus;
  error: string | null;
  toolCount: number;
  tools: { name: string; description: string }[];
}

export interface McpServersResponse {
  servers: McpServerDto[];
  running: boolean;
}

export type McpServerPermission = "read" | "write" | "exec" | "network";

export interface McpServerInput {
  id?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  permission?: McpServerPermission;
}

export interface SkillDto {
  name: string;
  description: string;
  dirName: string;
  path: string;
  /** 来自内置技能包（N2）：技能页显示「内置」徽标。 */
  builtin: boolean;
}

export interface SkillsResponse {
  skills: SkillDto[];
  dir: string;
  /** 仅 rescan 返回：本次补装的内置技能目录名（N2）。 */
  installed?: string[];
}

// ---------------------------------------------------------------------------
// 初始化引导（N1）
// ---------------------------------------------------------------------------

export type SetupStepKey = "runtime" | "provider" | "admin" | "workspace" | "skills";

export interface SetupStepDto {
  key: SetupStepKey;
  label: string;
  done: boolean;
  /** 可选步骤：跳过不影响「是否需要打开引导」。 */
  optional: boolean;
  detail: string;
}

export interface SetupStateResponse {
  /** 必需项（运行时 / 供应商 / 管理员）有任意一项没完成。 */
  needsSetup: boolean;
  completed: number;
  total: number;
  steps: SetupStepDto[];
  skillCount: number;
  skillsDir: string;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

/** Bot 六态（UI 层语义，映射自 Session 状态）。 */
export type BotState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";

export type ExecutionLocation = "local" | "worktree";

export type PermissionMode = "confirm" | "auto" | "plan" | "full";

export interface BotDto {
  id: string;
  name: string;
  persona: string;
  /** 头像首字；null 时前端取 name 首字。 */
  avatar: string | null;
  /** 身份色序号 1–8（tokens.css 的 --bot-N）。 */
  colorIndex: number;
  /** 绑定的运行时；null 表示未绑定（发送会被阻止）。 */
  runtime: RuntimeSummary | null;
  /** 内置引擎绑定的模型供应商 id；其它运行时为 null。 */
  providerId: string | null;
  /** 管理员 Bot：多一个 create_bot 工具（不自动获得 full 权限）。 */
  role: "member" | "admin";
  /** Bot 默认权限模式；会话显式设置优先于它。 */
  permissionMode: PermissionMode;
  /**
   * 启用的技能目录名（N3-1 / N4）。
   * null = 全部启用（迁移前的老 Bot）；[] = 一个都不注入；其它 = 白名单。
   */
  enabledSkills: string[] | null;
  executionLocation: ExecutionLocation;
  /** 默认工作区（bots.repo_path）；未设置时显示「未设置默认工作区」。 */
  defaultWorkspace: string | null;
  /** 实际生效的路径：worktree 时是 worktreePath，local 时是 repoPath。 */
  effectivePath: string | null;
  worktreeState: "ready" | "missing" | "failed" | null;
  status: "active" | "archived";
  state: BotState;
  /** 状态开始时间（生成中用来算已进行时长）。 */
  stateSince: number | null;
  /** 待批权限数。 */
  pendingPermissions: number;
  /** 最近一次活动时间（相对时间显示用）。 */
  lastActiveAt: number | null;
  createdAt: number;
}

export interface BotsResponse {
  bots: BotDto[];
}

// ---------------------------------------------------------------------------
// 渠道 / 会话 / 消息
// ---------------------------------------------------------------------------

export type ChannelType = "dm" | "group" | "task";

export interface ChannelDto {
  id: string;
  type: ChannelType;
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

export interface ChannelsResponse {
  channels: ChannelDto[];
}

export type ResumeState = "fresh" | "resumed" | "rebuilt";

export interface SessionDto {
  id: string;
  channelId: string;
  botId: string;
  runtimeId: string | null;
  resumeState: ResumeState;
  /** created | starting | ready | running | waiting_permission | idle | reaped | crashed | ended | failed */
  status: string;
  /** 会话级工作区覆盖；null 表示走回退链。 */
  workspacePath: string | null;
  /** 会话级供应商覆盖；null 表示用 Bot 默认供应商。 */
  providerId: string | null;
  /** 会话级模型覆盖；null 表示用供应商默认模型。 */
  model: string | null;
  permissionMode: PermissionMode;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "streaming" | "done" | "interrupted" | "failed";

/** `messages` 表的一行。`content` 是正文唯一权威副本（P0-04/P0-15）。 */
export interface MessageDto {
  id: string;
  sessionId: string;
  channelId: string;
  turnId: string;
  role: MessageRole;
  content: string;
  contentVersion: number;
  status: MessageStatus;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: number;
}

export interface MessagesResponse {
  messages: MessageDto[];
}

/**
 * `GET /api/channels/:id` —— 会话视图首屏一次拿全。
 *
 * `lastEventId` 是「历史已经覆盖到的最大 events.id」，前端拿它作为 SSE 首连游标，
 * 正好补上「REST 拉历史 → 建立连接」之间的空隙（架构 §7）。
 */
export interface ChannelDetailDto {
  channel: ChannelDto;
  sessions: SessionDto[];
  messages: MessageDto[];
  lastEventId: number;
}

/**
 * `GET /api/sessions/:id/events?afterSeq=&limit=` —— 历史事件回放（P0-04 / P0-05）。
 *
 * 形状与 SSE 帧**逐字段一致**（服务端两条路径共用 `toEventDto`），前端走同一条
 * turnModel 装配路径。刷新页面后靠它重建思考 / 工具 / 计划 / 用量块；
 * `meta` 也在内（Session 分隔条刷新后不能丢）。
 *
 * `lastEventId` 是本页覆盖到的最大全局 id，直接作为 SSE 首连游标 ——
 * 这样「REST 拉历史」与「SSE 续推」之间没有缺口，也不会重复回放。
 */
export interface SessionEventsPageDto {
  events: SseFrame[];
  hasMore: boolean;
  lastEventId: number;
}

// ---------------------------------------------------------------------------
// SSE 帧（与 src/server/http/sse.ts 的 SseFrame 一一对应）
// ---------------------------------------------------------------------------

export interface SseFrame {
  id: number;
  sessionId: string;
  messageId: string | null;
  turnId: string;
  type: EventType | "meta";
  seq: number;
  payload: unknown;
  raw: unknown | null;
  createdAt: number;
}

/** `replay_truncated` 帧：回放超过上限，需要用 REST 补齐缺口。 */
export interface ReplayTruncatedPayload {
  lastEventId: number;
  hint: string;
}

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

export type PermissionTimeoutPolicy = "reject" | "hold" | "preauth";
export type PermissionDecision = "approve" | "reject" | "remember_session" | "remember_bot";

/**
 * `GET /api/permissions?sessionId=` 的一条待批/已决记录。
 *
 * 事件流的 `permission_request` payload 只有
 * `{ requestId, action, target, boundaryVerdict }`，**不含超时策略与截止时间**。
 * 卡片要显示 120s 倒计时或「已挂起 1h 20m」，必须靠这个端点补：
 *   - `timeoutPolicy` 决定卡片是阻断型（reject）还是挂起型（hold）；
 *   - `expiresAt` 决定倒计时终点；
 *   - `status` 决定是待批卡还是已决审计行。
 * 端点缺失时前端按 `reject` + 120s 兜底（见 `stores/permissions.ts`）。
 */
export interface PermissionDto {
  id: string;
  sessionId: string;
  botId: string;
  turnId: string;
  action: "write" | "read" | "exec" | "network" | "admin";
  target: string;
  /** allowed | denied | pending */
  boundaryVerdict: "allowed" | "denied" | "pending";
  timeoutPolicy: PermissionTimeoutPolicy;
  /** pending | decided | denied_timeout | denied_hard_timeout | denied_boundary | invalidated */
  status: string;
  heldSince: number | null;
  expiresAt: number | null;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

export interface PermissionsResponse {
  permissions: PermissionDto[];
}

// ---------------------------------------------------------------------------
// 文件查看 / 改动 diff（GET /api/files、GET /api/files/changes）
// ---------------------------------------------------------------------------

export interface FileContentDto {
  path: string;
  workspace: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface ChangedFileDto {
  path: string;
  status: string;
  insertions: number | null;
  deletions: number | null;
}

export interface FileChangesDto {
  git: boolean;
  workspace: string;
  files: ChangedFileDto[];
  message?: string;
}

export interface FileTreeEntryDto {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
}

export interface FileTreeDto {
  workspace: string;
  path: string;
  entries: FileTreeEntryDto[];
  truncated: boolean;
}

export interface FileDiffDto {
  git: boolean;
  workspace: string;
  path: string;
  status: string;
  diff: string;
  insertions: number | null;
  deletions: number | null;
  message?: string;
}

// ---------------------------------------------------------------------------
// 发送 / 取消 / 转任务
// ---------------------------------------------------------------------------

export interface SendMessageRequest {
  channelId: string;
  text: string;
  /** 群聊里显式 @ 的 Bot；不传则由主持人决定。 */
  mentionBotIds?: string[];
}

export interface SendMessageResponse {
  messageId: string;
  turnId: string;
  sessionId: string;
  /** true 表示会话锁被占用，已排队（P0-15 双标签页）。 */
  queued?: boolean;
  position?: number;
}

// ---------------------------------------------------------------------------
// meta 事件（不进渲染流，只驱动 Session 分隔条）
// ---------------------------------------------------------------------------

export interface MetaPayloadShape {
  kind: MetaEventKind;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// M14：详情页 / 列表页的完整 DTO（形状与 src/server/http/dto.ts 一一对应）
// ---------------------------------------------------------------------------

/**
 * `GET /api/runtimes` 的完整行。
 *
 * 比 `RuntimeSummary`（`/api/meta` 的精简版）多出**展示与判定**需要的字段：
 * `availability` 区分「没装」与「装了但初始化失败」（P0-01 文案完全不同），
 * `requiresWorktree` 决定改绑时要不要二次确认（P0-13 安全底线）。
 */
export interface RuntimeDetailDto extends RuntimeSummary {
  capabilities: CapabilitySet;
  adapterName: string;
  command: string;
  minVersion: string | null;
  /** ready | missing | timeout | unhealthy | unprobed */
  availability: string;
  executable: string | null;
  meetsMinVersion: boolean | null;
  probeDetail: string | null;
  lastProbeAt: number | null;
  /** 该运行时实际会产出的事件类型（能力掩码）。 */
  eventCapabilities: string[];
  /** 该运行时不提供权限请求 → 必须跑在 worktree。 */
  requiresWorktree: boolean;
}

export interface RuntimesResponse {
  runtimes: RuntimeDetailDto[];
}

/** 契约里的 5 种协议（顺序与后端 `PROTOCOL_KINDS` 一致）。 */
export type RuntimeProtocol =
  | "acp"
  | "codex-app-server"
  | "opencode-http"
  | "claude-sdk"
  | "cli-stdio";

/** `POST /api/runtimes` —— 手动添加自定义启动命令（P0-01）。 */
export interface CreateRuntimeRequest {
  /** 只允许字母、数字、- 和 _，且以字母或数字开头（≤64 字符）。 */
  id: string;
  displayName: string;
  protocol: RuntimeProtocol;
  command: string;
  /** 启动参数；每项一个 argv 元素。 */
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  detect?: {
    command?: string;
    versionArgs?: string[];
    versionPattern?: string;
    timeoutMs?: number;
  };
}

export interface CreateRuntimeResponse {
  /** 添加后立即探测一次；探测抛错时仍返回已落库的行。 */
  runtime: RuntimeDetailDto | null;
}

/** `POST /api/runtimes/:id/probe` —— 单运行时重探（P0-01「重试」）。 */
export interface ProbeRuntimeResponse {
  runtime: RuntimeDetailDto;
}

/** `DELETE /api/bots/:id` 的处理方式（P0-03）。 */
export type DeleteBotMode = "cascade" | "archive";

export interface DeleteBotRequest {
  /** 必须与 Bot 名称完全一致（后端不做 trim/大小写宽容）。 */
  confirmName: string;
  mode: DeleteBotMode;
}

export interface DeleteBotResponse {
  ok: boolean;
  mode: DeleteBotMode;
  botId: string;
  /** 各表实际删除行数（cascade）；archive 为空对象。 */
  deleted: Record<string, number>;
  /** cascade 保留的用量记录条数（P0-12「删除 Bot 后历史用量保留」）。 */
  usageRecordsKept?: number;
  /** 未被删除的 worktree 路径（P0-13：不自动删用户文件）。 */
  worktreeKept?: string | null;
}

/** 权限边界（P0-09）。`version` 即 `bots.updated_at`，进行中的请求按旧版本判定。 */
export interface BoundaryDto {
  allowDirs: string[];
  allowShell: boolean;
  allowNetwork: boolean;
  autoApproveWrite: boolean;
  version: number;
}

/** 预授权（「记住」产生的授权记录）。 */
export interface GrantDto {
  id: string;
  actionKey: string;
  scope: "session" | "bot";
  sessionId: string | null;
  expiresAt: number | null;
  createdAt: number;
}

/** `GET /api/bots/:id` —— 详情页一次拿全（Bot + 边界 + 预授权）。 */
export interface BotDetailResponse {
  bot: BotDto | null;
  boundary: BoundaryDto | null;
  grants: GrantDto[];
}

/** `PATCH /api/bots/:id` 的响应。 */
export interface BotPatchResponse {
  ok: boolean;
  /** 角色（R6）：PATCH 带 role 时回新值，不带时回当前值。 */
  role?: "member" | "admin";
  /** 默认权限模式：PATCH 带 permissionMode 时回新值，不带时回当前值。 */
  permissionMode?: PermissionMode;
  boundary: BoundaryDto | null;
  execution: ExecutionConfigDto | null;
  requiresWorktree: boolean;
}

export interface ExecutionConfigDto {
  executionLocation: ExecutionLocation;
  repoPath: string | null;
  worktreePath: string | null;
  worktreeState: "ready" | "missing" | "failed" | null;
}

/** `POST /api/bots` 的响应。 */
export interface BotCreateResponse {
  bot: BotDto | null;
  boundary: BoundaryDto | null;
  execution: ExecutionConfigDto | null;
}

/** 后端字段级错误（`400 {error, fields:[…]}`）。 */
export interface FieldErrorDto {
  field: string;
  index?: number;
  code: string;
  message: string;
}

// ---- 记忆（P0-10）----

/** 记忆作用域：bot = 全局；channel = 本群聊共享；session = 仅来源会话。 */
export type MemoryScope = "bot" | "channel" | "session";

export interface MemoryEntryDto {
  id: string;
  botId: string;
  content: string;
  sourceSessionId: string | null;
  scope: MemoryScope;
  channelId: string | null;
  /** 群聊记忆由别的 Bot 写入时标明来源（R3）；本 Bot 自己的条目没有。 */
  sourceBotId?: string;
  sourceBotName?: string | null;
  /** summary → 'auto'（UI 标「自动摘要」）。 */
  source: "manual" | "auto";
  kind: "manual" | "summary";
  injected: boolean;
  version: number;
  updatedAt: number;
  createdAt: number;
}

/** 本轮注入估算（「本轮注入估算 3,120 / 6,000 字符」的唯一口径）。 */
export interface MemoryInjectionDto {
  budget: number;
  usedChars: number;
  includedCount: number;
  truncatedCount: number;
  personaChars: number;
  personaTruncated: boolean;
}

export interface MemoryResponse {
  entries: MemoryEntryDto[];
  injection: MemoryInjectionDto;
}

export interface MemoryMutateResponse {
  entry?: MemoryEntryDto | null;
  injection: MemoryInjectionDto;
}

export interface SummarizeResponse {
  ok: boolean;
  entryId: string | null;
  skipped: boolean;
  reason: string | null;
  chars: number | null;
  injection: MemoryInjectionDto;
}

// ---- 任务（P0-07）----

export type AssignmentStatus = "queued" | "running" | "done" | "failed" | "timeout";

export interface ChangedFileDto {
  path: string;
  added: number | null;
  deleted: number | null;
}

export interface AssignmentDto {
  id: string;
  title: string;
  deliverable: string;
  botId: string;
  botName: string;
  runtimeName: string | null;
  sourceChannelId: string | null;
  sessionId: string | null;
  status: AssignmentStatus;
  queuePosition: number | null;
  queueLimit: number;
  report: string | null;
  failReason: string | null;
  executionLocation: ExecutionLocation;
  worktreePath: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  durationMs: number | null;
  eventCount: number;
  changedFiles: ChangedFileDto[] | null;
}

export interface AssignmentsResponse {
  assignments: AssignmentDto[];
  counts: Record<string, number>;
}

export interface AssignmentDetailResponse {
  assignment: AssignmentDto;
}

// ---- 定时任务（P0-11）----

export type TriggerType = "once" | "interval" | "daily";

export interface ScheduleDto {
  id: string;
  name: string;
  botId: string;
  botName: string | null;
  channelId: string;
  channelName: string | null;
  prompt: string;
  triggerType: TriggerType;
  /** 人类可读规则（「每 30 分钟」）。 */
  trigger: string;
  delayMinutes: number | null;
  intervalMinutes: number | null;
  atTime: string | null;
  nextRunAt: number | null;
  lastResult: string | null;
  lastRunAt: number | null;
  failCount: number;
  enabled: boolean;
  status: "active" | "paused" | "completed" | "bot_archived";
  autoPaused: boolean;
  createdAt: number;
}

export interface SchedulesResponse {
  schedules: ScheduleDto[];
  schedulerRunning: boolean;
  minIntervalMinutes: number;
}

// ---- 用量（P0-12）----

export type UsageRange = "today" | "7d" | "30d" | "all";

export interface UsageRowDto {
  botId: string;
  botName: string | null;
  deleted: boolean;
  colorIndex: number | null;
  runtimeId: string | null;
  runtimeName: string | null;
  mode: "interactive" | "headless";
  multiplier: number;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 缓存命中（读）token；该行没有任何缓存上报时为 null。 */
  cachedInputTokens: number | null;
  /** 缓存写入 token；该行没有任何缓存上报时为 null。 */
  cacheWriteTokens: number | null;
  /** 命中率分母：只算缓存字段已上报的请求的输入 token（R8）；未上报为 null。 */
  cacheInputTokens: number | null;
  /** 命中率 0–100（1 位小数）；未上报为 null。 */
  cacheHitRate: number | null;
  unreportedRequests: number;
  share: number;
}

export interface UsageResponseDto {
  range: UsageRange;
  from: number | null;
  to: number;
  rows: UsageRowDto[];
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    /** 合计命中率的分母：只算缓存字段已上报的请求（R8）。 */
    cacheInputTokens: number;
    /** 合计命中率；没有任何缓存上报时为 null。 */
    cacheHitRate: number | null;
    unreportedRequests: number;
  };
}

// ---- 会话控制（R2 / R4 / R5 / R7）----

/** `PATCH /api/sessions/:id/controls` 的请求体。 */
export interface SessionControlsInput {
  providerId?: string | null;
  model?: string | null;
  permissionMode?: PermissionMode;
  workspacePath?: string | null;
}

export interface SessionControlsResponse {
  ok: boolean;
  session: SessionDto | null;
  /** 跨协议切换时的提示（建议新开会话）。 */
  warning?: string;
  /** 切到 plan 时被拒绝的挂起写请求数。 */
  rejectedPending?: number;
  /** 切到 full 时被自动批准的挂起请求数（2026-10-28）。 */
  approvedPending?: number;
}

/** `PATCH /api/channels/:id` 的响应。 */
export interface ChannelPatchResponse {
  ok: boolean;
  channel: ChannelDto;
}

/** `POST /api/sessions/:id/compact` 的响应。 */
export interface CompactResponse {
  ok: boolean;
  result: {
    ok: boolean;
    removedMessages: number;
    summaryChars: number;
    beforeTokens: number;
    afterTokens: number;
    trigger: "auto" | "manual";
    reason?: string;
  } | null;
}

// ---- 安全与数据（P0-14 / P0-12 边界）----

export interface TokenStatusResponse {
  preview: string;
  url: string | null;
  activeStreams: number;
}

export interface TokenResetResponse {
  token: string;
  url: string;
  closedStreams: number;
}

export interface PurgeResponse {
  ok: boolean;
  deleted: Record<string, number>;
  closedStreams: number;
}

/** 数据整理预览：归档/删除 Bot 后留下的孤儿数据。 */
/** 可勾选的整理项。 */
export type TidyTarget = "channels" | "orphanSessions" | "memories" | "orphanUsage";

export interface TidyPreview {
  channels: { id: string; type: string; name: string; participantCount: number }[];
  /** 渠道还在、但所属 Bot 已不存在的会话。 */
  orphanSessions: { id: string; channelId: string; channelName: string; botId: string }[];
  sessions: number;
  messages: number;
  events: number;
  memories: number;
  /** 所属 Bot 已不存在的用量记录数。 */
  orphanUsage: number;
}

export interface TidyResponse {
  ok: boolean;
  targets: TidyTarget[];
  preview: TidyPreview;
  deleted: Record<string, number>;
}

/** 模型能力对照表（可维护）。 */
export interface CatalogEntry {
  match: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  note?: string;
}

export interface ModelCatalogResponse {
  /** 内置表（随代码分发，只读）。 */
  builtin: CatalogEntry[];
  /** 用户覆盖表（~/.agentbot/model-catalog.json）。 */
  user: CatalogEntry[];
  /** 用户表路径，便于用户直接编辑。 */
  userPath: string;
  builtinVersion: number;
  builtinUpdatedAt: string;
  sources: string[];
}

/** 群聊发送响应（`POST /api/messages` 在 group 渠道上多出的字段）。 */
export interface GroupSendResponse extends SendMessageResponse {
  speakers: { botId: string; reason: string }[];
  calls: number;
  skipReason: string | null;
  degraded: string | null;
  notice: string | null;
  warnings: string[];
}
