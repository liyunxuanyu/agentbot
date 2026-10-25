import type {
  EventType,
  PayloadByType,
  PlanPayload,
  StoredEventType,
} from "../../../shared/events.js";

export type { EventType, StoredEventType };

/**
 * 服务端事件模型。
 *
 * 事件语义（9 类 + meta）一律复用 `src/shared/events.ts`，这里只补两样东西：
 * 落库行 `EventRow` 与写入上下文 `IngestContext`。
 *
 * seq 语义（架构 §4）：
 *   - 会话内单调递增，从 1 开始，由 `events` repo 在写事务里
 *     `UPDATE sessions SET seq_counter = seq_counter + 1` 后读回，单写者保证；
 *   - 只用于 UI 排序与虚拟滚动分页，跨会话没有可比性；
 *   - SSE 重连游标用 `events.id`（全局 AUTOINCREMENT），不用 seq。
 */

/**
 * plan 是全量替换而非增量：落库时补 `replace: true`，
 * 前端据此整块替换计划列表，不按 callId/序号追加。
 */
export interface StoredPlanPayload extends PlanPayload {
  replace: true;
}

/** 落库后的 payload：与 shared 的 payload 一一对应，只有 plan 多一个 replace 标记。 */
export type StoredPayload =
  | Exclude<PayloadByType[StoredEventType], PlanPayload>
  | StoredPlanPayload;

/** `events` 表的一行，列名转驼峰；JSON 字段已解析。 */
export interface EventRow {
  id: number;
  sessionId: string;
  messageId: string | null;
  turnId: string;
  type: StoredEventType;
  seq: number;
  payload: StoredPayload;
  /** 非空表示该事件发生过降级（或通道主动带了原始数据），前端渲染「未知事件」折叠块。 */
  raw: unknown | null;
  createdAt: number;
}

/**
 * 一次 ingest 的写入上下文。
 *
 * `messageId` 是「当前轮次的助手消息」：`message_delta` 自带 messageId 时以 payload 为准，
 * 其余类型的事件都挂在这条消息下（没有则为 null）。
 */
export interface IngestContext {
  sessionId: string;
  messageId: string | null;
  turnId: string;
  /** 运行时声明的能力掩码；不在其中的可渲染类型直接丢弃。 */
  eventCapabilities: readonly EventType[];
}

export type DropReason = "not_declared";

export type IngestResult =
  | { dropped: true; reason: DropReason }
  | {
      dropped: false;
      row: EventRow;
      /** true 表示 payload 字段缺失、已用安全默认值落库（raw 保留原始 JSON）。 */
      degraded: boolean;
      warnings: string[];
    };