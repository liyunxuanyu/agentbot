import { defineStore } from "pinia";
import { markRaw, ref, shallowRef, triggerRef } from "vue";
import type { MetaEventKind } from "@shared/events";
import type { MessageDto } from "../net/types";
import { dividerText, type RawEvent } from "../lib/turnModel";

/**
 * 事件表（高频路径，架构 §7）。
 *
 * 性能约束（20–50 事件/秒，长会话不能卡）：
 *   - 事件表用 `shallowRef<Map<turnId, RawEvent[]>>`，**不进深代理**；
 *   - 追加时 `markRaw(event)` + 原地 push + 手动 `triggerRef`，一次只触发一个依赖；
 *   - 只有「新增 Turn / 清空」才重建 Map（结构变化本来就少）。
 *
 * 去重：SSE 层已按 id 去过一遍（重连时 Last-Event-ID 续推会与本地重叠），
 * 这里再按「每 Turn 的最大 id」兜一次 —— 成本极低，但能挡住「同一帧从两个来源到达」
 * 这类只在调试时才复现的问题。
 *
 * meta 不进事件表：它只生成 Session 分隔条（`dividers`），不参与 Turn 渲染。
 */

export interface SessionDivider {
  /** 触发它的 meta 事件 id（去重用）。 */
  eventId: number;
  kind: MetaEventKind;
  text: string;
  ts: number;
  turnId: string;
}

interface TurnBucket {
  botId: string;
  events: RawEvent[];
  /** 已收最大 id，用于二次去重。 */
  maxId: number;
}

export const useEventsStore = defineStore("events", () => {
  /** turnId → 事件桶。桶内数组是 raw，不进响应式代理。 */
  const buckets = shallowRef<Map<string, TurnBucket>>(new Map());
  /** 流式文本累积：messageId → text。同样绕开深代理。 */
  const streamingText = shallowRef<Record<string, string>>({});
  /** messages 表副本：messageId → MessageDto（正文权威副本）。 */
  const messages = shallowRef<Map<string, MessageDto>>(new Map());
  /** Session 分隔条（meta 驱动，按事件 id 去重）。 */
  const dividers = ref<SessionDivider[]>([]);
  /** 帧计数器：UI 用来判断「有新内容」并自动滚底。 */
  const frameCount = ref(0);
  /** 最近一帧的时间（心跳超时/「最后活动」显示用）。 */
  const lastFrameAt = ref(0);

  function bucketOf(turnId: string, botId: string): TurnBucket {
    const map = buckets.value;
    let bucket = map.get(turnId);
    if (!bucket) {
      bucket = { botId, events: [], maxId: 0 };
      map.set(turnId, bucket);
    }
    return bucket;
  }

  /**
   * 收一帧可渲染事件。
   *
   * 调用方必须保证帧已经通过 SSE 层去重；这里只做「同 Turn 单调 id」的兜底，
   * 并且**只在真的写入时才 triggerRef**，避免空转触发重渲染。
   */
  function pushEvent(ev: RawEvent, botId: string): boolean {
    const bucket = bucketOf(ev.turnId, botId);
    if (ev.id <= bucket.maxId) return false;
    bucket.maxId = ev.id;

    bucket.events.push(markRaw(ev));

    if (ev.type === "message_delta") {
      const payload = ev.payload as { messageId?: unknown; phase?: unknown; text?: unknown };
      const mid = typeof payload.messageId === "string" ? payload.messageId : ev.messageId;
      if (mid) {
        const text = typeof payload.text === "string" ? payload.text : "";
        const phase = payload.phase;
        const table = streamingText.value;
        if (phase === "start") {
          // 新一段消息：整段替换（原型里一条 message 一个气泡）
          table[mid] = text;
        } else if (text.length > 0) {
          table[mid] = (table[mid] ?? "") + text;
        }
      }
    }

    // 结构变化（新 Turn 或新消息）在外部用 rebuild 触发；这里只刷数据
    triggerRef(buckets);
    triggerRef(streamingText);
    frameCount.value += 1;
    lastFrameAt.value = ev.createdAt;
    return true;
  }

  /** 本地提示的合成 id：负数，永远不会和库里的正 id 撞。 */
  let localNoteSeq = -1;

  /**
   * 插入一条本地系统提示（不改库，只在当前页面的分隔条位置显示）。
   *
   * 用途：手动压缩完成、切 plan 时批量拒绝挂起请求。这些动作后端已落审计，
   * 但不会为 UI 补发一条 meta 帧；本地插一条能让用户看到「刚才发生了什么」。
   */
  function pushLocalNote(text: string, kind: MetaEventKind = "compaction"): void {
    dividers.value = [
      ...dividers.value,
      { eventId: localNoteSeq--, kind, text, ts: Date.now(), turnId: "" },
    ];
  }

  /** 收一帧 meta：只生成分隔条，绝不进 Turn 渲染。 */
  function pushMeta(ev: RawEvent): void {
    const payload = ev.payload as { kind?: unknown };
    const kind = (typeof payload.kind === "string" ? payload.kind : "unknown_protocol") as MetaEventKind;
    const text = dividerText(kind);
    if (!text) return;
    if (dividers.value.some((d) => d.eventId === ev.id)) return;
    dividers.value = [
      ...dividers.value,
      { eventId: ev.id, kind, text, ts: ev.createdAt, turnId: ev.turnId },
    ];
  }

  /**
   * 用 REST 拉到的消息覆盖本地（P0-04 第 2 条）。
   *
   * `messages.content` 是权威副本：重连后先拿它整体覆盖，再回放事件；
   * 不用事件累积重建正文。
   */
  function replaceMessages(rows: readonly MessageDto[]): void {
    const map = new Map<string, MessageDto>();
    for (const row of rows) map.set(row.id, markRaw(row));
    messages.value = map;
    triggerRef(messages);

    // 已有权威正文的消息不再需要流式累积（避免「覆盖后又被旧的累积文本盖回去」）
    const table = { ...streamingText.value };
    let changed = false;
    for (const row of rows) {
      if (table[row.id] !== undefined) {
        delete table[row.id];
        changed = true;
      }
    }
    if (changed) {
      streamingText.value = table;
      triggerRef(streamingText);
    }
  }

  /** 单条消息更新（流式收口、重连补拉单条）。 */
  function upsertMessage(row: MessageDto): void {
    const map = new Map(messages.value);
    map.set(row.id, markRaw(row));
    messages.value = map;
    triggerRef(messages);
  }

  /** 清空（切渠道时调用）。 */
  function reset(): void {
    buckets.value = new Map();
    streamingText.value = {};
    messages.value = new Map();
    dividers.value = [];
    frameCount.value = 0;
    lastFrameAt.value = 0;
    triggerRef(buckets);
    triggerRef(streamingText);
    triggerRef(messages);
  }

  /** 只清事件（保留 messages）：重连补拉历史时用。 */
  function clearEvents(): void {
    buckets.value = new Map();
    streamingText.value = {};
    frameCount.value = 0;
    triggerRef(buckets);
    triggerRef(streamingText);
  }

  function turnEvents(turnId: string): readonly RawEvent[] {
    return buckets.value.get(turnId)?.events ?? [];
  }

  function botIdOfTurn(turnId: string): string | null {
    return buckets.value.get(turnId)?.botId ?? null;
  }

  /** 已知 turnId 列表，按首帧时间升序。 */
  function turnIds(): string[] {
    const entries = [...buckets.value.entries()];
    entries.sort((a, b) => (a[1].events[0]?.createdAt ?? 0) - (b[1].events[0]?.createdAt ?? 0));
    return entries.map(([id]) => id);
  }

  /** 某 Turn 的 assistant 消息（来自 messages 表）。 */
  function messagesOfTurn(turnId: string): MessageDto[] {
    const out: MessageDto[] = [];
    for (const row of messages.value.values()) {
      if (row.turnId === turnId && row.role === "assistant") out.push(row);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /** 某 Turn 的用户消息（同上，渲染用户气泡用）。 */
  function userMessagesOfTurn(turnId: string): MessageDto[] {
    const out: MessageDto[] = [];
    for (const row of messages.value.values()) {
      if (row.turnId === turnId && row.role === "user") out.push(row);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  return {
    buckets,
    streamingText,
    messages,
    dividers,
    frameCount,
    lastFrameAt,
    pushEvent,
    pushMeta,
    pushLocalNote,
    replaceMessages,
    upsertMessage,
    reset,
    clearEvents,
    turnEvents,
    botIdOfTurn,
    turnIds,
    messagesOfTurn,
    userMessagesOfTurn,
  };
});
