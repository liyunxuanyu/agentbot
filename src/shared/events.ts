/**
 * 统一事件模型 —— 前端只认这一套语义，不认任何运行时协议。
 *
 * 9 类可渲染事件之外的协议状态（slash commands、config 变更、上下文压缩、
 * Session 重建标记）一律走 `meta`：落库但不进渲染流，也不计入事件能力掩码。
 */

export const EVENT_TYPES = [
  "message_delta",
  "thought",
  "tool_call",
  "tool_result",
  "plan",
  "permission_request",
  "usage",
  "done",
  "error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** 内部状态事件：必须落库（重启后 Session 分隔条不能丢），但永不渲染。 */
export type MetaEventKind =
  | "compaction"
  | "session_rebuilt"
  | "session_resumed"
  | "commands_update"
  | "config_update"
  | "unknown_protocol";

export type StoredEventType = EventType | "meta";

export interface MessageDeltaPayload {
  messageId: string;
  phase: "start" | "delta" | "end";
  text: string;
}

export interface ThoughtPayload {
  phase: "start" | "delta" | "end";
  text: string;
}

export interface ToolCallPayload {
  callId: string;
  name: string;
  kind?: string;
  input?: unknown;
  status: "pending" | "running";
}

export interface ToolResultPayload {
  callId: string;
  status: "ok" | "error";
  output: string;
  exitCode?: number;
  truncated?: boolean;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "done";
}

export interface PlanPayload {
  /** 全量替换，不是增量 —— 运行时每次给完整计划。 */
  entries: PlanEntry[];
}

/**
 * 权限动作。
 *
 * `admin` 是内置引擎的管理动作（`create_bot`）：它不是文件写，但同样要经过
 * 四档权限裁决与审计（plan 下工具被裁掉，confirm/auto 下弹卡，full 下自动批）。
 */
export type PermissionAction = "write" | "read" | "exec" | "network" | "admin";

/** 四档权限模式（会话级属性；群聊里每个 Bot 的会话各自独立）。 */
export type PermissionMode = "confirm" | "auto" | "plan" | "full";

/** 边界裁决结果，由核心填充，通道不感知边界逻辑。 */
export type BoundaryVerdict = "allowed" | "denied" | "pending";

export interface PermissionRequestPayload {
  requestId: string;
  action: PermissionAction;
  target: string;
  boundaryVerdict: BoundaryVerdict;
}

export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  /** false 表示运行时没上报，UI 显示 `—` 而不是 0。 */
  reported: boolean;
  cumulative?: boolean;
  /** 缓存命中（读）token：OpenAI cached_tokens / Anthropic cache_read_input_tokens。 */
  cachedInputTokens?: number;
  /** 缓存写入 token：Anthropic cache_creation_input_tokens；OpenAI 无此口径。 */
  cacheWriteTokens?: number;
  /** 本轮实际使用的模型（会话内可切）。 */
  model?: string;
}

export interface DonePayload {
  stopReason: "end" | "cancelled" | "max_tokens" | "error";
  durationMs: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  detail?: string;
  /** true 表示这一轮结束；false 表示可恢复的警告。 */
  fatal: boolean;
}

export interface MetaPayload {
  kind: MetaEventKind;
  data?: unknown;
}

export interface PayloadByType {
  message_delta: MessageDeltaPayload;
  thought: ThoughtPayload;
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  plan: PlanPayload;
  permission_request: PermissionRequestPayload;
  usage: UsagePayload;
  done: DonePayload;
  error: ErrorPayload;
  meta: MetaPayload;
}

/**
 * 通道层产出的事件。`raw` 只在「类型已声明但字段解析失败」时携带原始 JSON，
 * 保证可降级渲染而不是丢数据。
 */
export interface CanonicalEvent<T extends StoredEventType = StoredEventType> {
  type: T;
  turnId: string;
  ts: number;
  payload: PayloadByType[T];
  raw?: unknown;
}

export function isRenderableType(t: StoredEventType): t is EventType {
  return t !== "meta";
}
