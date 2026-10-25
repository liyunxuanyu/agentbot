import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type {
  ChannelDetailDto,
  ChannelDto,
  MessageDto,
  PermissionDto,
  SessionDto,
} from "../net/types";

/**
 * 当前会话：渠道、Session、首屏消息、连接状态。
 *
 * 与 `events` store 的分工：
 *   - 这里放「低频、结构性」的数据（渠道元信息、Session 列表、首屏 messages）；
 *   - `events` 放「高频」的 Turn 事件表（shallowRef）。
 *
 * 四态：`loading | error | empty | ready`。
 * 断线单独用 `connection` 表达（UX §4.4 错误态是「连接已断开，正在重连」，
 * 不是把整页替换成错误页）。
 */

export type ChannelStatus = "idle" | "loading" | "ready" | "empty" | "error";
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export const useSessionsStore = defineStore("sessions", () => {
  const channel = ref<ChannelDto | null>(null);
  const sessions = ref<SessionDto[]>([]);
  const messages = ref<MessageDto[]>([]);
  /** 首连 SSE 游标：REST 已覆盖到的最大 event id。 */
  const lastEventId = ref(0);

  const status = ref<ChannelStatus>("idle");
  const errorText = ref("");
  const connection = ref<ConnectionState>("connecting");
  const connectionAttempt = ref(0);

  /** 最近一次拉取是否因为端点缺失而空（M3 阶段的正常情况）。 */
  const endpointMissing = ref(false);

  const currentSession = computed<SessionDto | null>(() => {
    const list = sessions.value;
    return list.length > 0 ? (list[list.length - 1] ?? null) : null;
  });

  /** 待批权限（由 permissions store 写入；这里只读，用于锁定输入框）。 */
  const blockingPermissionCount = ref(0);

  function reset(): void {
    channel.value = null;
    sessions.value = [];
    messages.value = [];
    lastEventId.value = 0;
    status.value = "idle";
    errorText.value = "";
    connection.value = "connecting";
    connectionAttempt.value = 0;
    endpointMissing.value = false;
    blockingPermissionCount.value = 0;
  }

  /**
   * 拉会话首屏。
   *
   * 端点未实现时：`status = "empty"` + `endpointMissing = true`，
   * 页面显示会话空态（「发第一条消息」引导）而不是报错 —— 因为此时确实没有任何消息。
   */
  async function load(channelId: string, signal?: AbortSignal): Promise<void> {
    reset();
    status.value = "loading";

    try {
      const detail: ChannelDetailDto = await api.channel(channelId, signal);
      channel.value = detail.channel;
      sessions.value = detail.sessions;
      messages.value = detail.messages;
      lastEventId.value = detail.lastEventId;
      status.value = detail.messages.length === 0 ? "empty" : "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        // 渠道端点还没落地（M3）：给一个最小可用的渠道壳，让 SSE 与空态都能跑。
        // 名字留空由页面兜底成「会话」—— 拿 id 当名字会让用户以为那真是群名。
        endpointMissing.value = true;
        channel.value = {
          id: channelId,
          type: "dm",
          name: "",
          participantBotIds: [],
          hostBotId: null,
          lastMessagePreview: null,
          lastMessageAt: null,
          unread: 0,
          createdAt: Date.now(),
        };
        sessions.value = [];
        messages.value = [];
        lastEventId.value = 0;
        status.value = "empty";
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // 端点已实现但这个渠道不存在：channel 留空，由页面显示「没有这个会话」。
        // 这不是「空会话」，两者文案必须不同（前者是删除/错链，后者是还没聊过）。
        channel.value = null;
        sessions.value = [];
        messages.value = [];
        status.value = "empty";
        return;
      }
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取会话失败";
    }
  }

  function setConnection(state: ConnectionState): void {
    connection.value = state;
    if (state === "open") connectionAttempt.value = 0;
    if (state === "reconnecting") connectionAttempt.value += 1;
  }

  /** 把 SSE 收到的用户消息插进本地列表（发送后乐观渲染）。 */
  function appendMessage(row: MessageDto): void {
    messages.value = [...messages.value, row];
  }

  /**
   * 记录「刚发送出去的这一轮属于哪个 Session」。
   *
   * 新建会话（例如刚建的群聊）在发送前 `sessions` 是空的，渠道详情拿不到 sessionId，
   * SSE 也就无从建连。发送响应里第一次带回它，页面据此建连；刷新后以 REST 的
   * `sessions` 列表为准（这里只是补一条占位，不覆盖已有行）。
   */
  function noteSession(input: {
    id: string;
    channelId: string;
    botId: string;
    startedAt: number;
  }): void {
    if (sessions.value.some((s) => s.id === input.id)) return;
    sessions.value = [
      ...sessions.value,
      {
        id: input.id,
        channelId: input.channelId,
        botId: input.botId,
        runtimeId: null,
        resumeState: "fresh",
        status: "running",
        startedAt: input.startedAt,
        endedAt: null,
        messageCount: 0,
        tokensIn: null,
        tokensOut: null,
      },
    ];
  }

  /** 用 REST 补拉后的最新消息整体替换（重连补齐缺口）。 */
  function setMessages(rows: MessageDto[]): void {
    messages.value = rows;
    if (status.value === "empty" && rows.length > 0) status.value = "ready";
  }

  /** 已知的所有 turnId（按消息创建时间），用于重建 Turn 顺序。 */
  const turnOrder = computed(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const m of messages.value) {
      if (!seen.has(m.turnId)) {
        seen.add(m.turnId);
        order.push(m.turnId);
      }
    }
    return order;
  });

  return {
    channel,
    sessions,
    messages,
    lastEventId,
    status,
    errorText,
    connection,
    connectionAttempt,
    endpointMissing,
    currentSession,
    blockingPermissionCount,
    reset,
    load,
    setConnection,
    appendMessage,
    noteSession,
    setMessages,
    turnOrder,
  };
});

/** 权限 store 用同一个 DTO 形状（单独文件里定义 store，这里只导出类型别名）。 */
export type { PermissionDto };
