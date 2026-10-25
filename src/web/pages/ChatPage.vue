<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type { GroupSendResponse, MessageDto, SseFrame } from "../net/types";
import type { RawEvent } from "../lib/turnModel";
import { buildPendingTurnView, buildTurnView, type TurnView } from "../lib/turnModel";
import { useBotsStore } from "../stores/bots";
import { useEventsStore } from "../stores/events";
import { useSessionsStore } from "../stores/sessions";
import { usePermissionsStore } from "../stores/permissions";
import { useUiStore } from "../stores/ui";
import { useSseStream } from "../composables/useSseStream";
import { openStream, type SseConnection } from "../net/stream";
import { useHotkeys } from "../composables/useHotkeys";
import { useVirtualList } from "../composables/useVirtualList";
import { botVars } from "../lib/botVars";
import { clockTime, num } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import Composer from "../components/chat/Composer.vue";
import StreamRowItem from "../components/chat/StreamRowItem.vue";
import PermissionBlock from "../components/chat/PermissionBlock.vue";
import EmptyState from "../components/common/EmptyState.vue";
import AppModal from "../components/common/AppModal.vue";

/**
 * /chat/:channelId —— 会话视图（UX §4.4，最复杂页）。
 *
 * 数据装配三条线：
 *   ① REST 首屏：`GET /api/channels/:id` → 渠道 + Session + messages（正文权威副本）+ 首连游标；
 *   ② SSE：`GET /api/stream?sessionId=` → 9 类事件进 Turn，`meta` 只生成 Session 分隔条；
 *   ③ 权限：事件流给出「出现了」的信号，`/api/permissions` 给出超时策略与截止时间。
 *
 * 两条硬规则（架构 §7 / PRD P0-04、P0-15）：
 *   - 正文以 `messages.content` 为准：`events.replaceMessages()` 拿到 REST 数据后
 *     清掉同名消息的流式累积，页面刷新不会靠重放事件重建正文；
 *   - SSE 重连按 `id` 去重（在 `api/stream.ts`），这里只管合并。
 *
 * 性能：Turn 列表走 `@tanstack/vue-virtual`，只有可视区 ±5 渲染；
 * 事件表在 store 里是 `shallowRef`，本页只做 `computed` 派生。
 */
const props = defineProps<{ channelId: string }>();

const router = useRouter();
const route = useRoute();
const bots = useBotsStore();
const sessions = useSessionsStore();
const events = useEventsStore();
const permissions = usePermissionsStore();
const ui = useUiStore();

const { channel, status, errorText, connection, endpointMissing, currentSession } =
  storeToRefs(sessions);
const { dividers, frameCount } = storeToRefs(events);
const { blocking, all: allPermissions, hasBlocking } = storeToRefs(permissions);

const streamEl = ref<HTMLElement | null>(null);
/** 用户是否贴着底部（决定新帧要不要自动滚）。 */
const pinnedToBottom = ref(true);
/** 折叠的 Turn（默认完成的收起，生成中的展开）。 */
const collapsed = ref<Map<string, boolean>>(new Map());

// ---------------------------------------------------------------------------
// pending Turn（P0-04：发送后立刻有「正在处理」的反馈）
// ---------------------------------------------------------------------------
/**
 * POST 已经返回、但首个 SSE 事件还没到的这一段时间。
 *
 * 为什么必须存在：ZCode 是 `streaming: false` 的 CLI 通道，一轮 15–30s 才整段
 * 返回。只乐观插入用户消息的话，这 20 秒里界面上没有任何「已发送 / 正在处理」
 * 的信号 —— 用户的原话是「我都不知道有没有发送成功」。
 *
 * 形状：
 *   - DM：`turnId` 就是 POST 返回的 turnId，首个事件到达时同 id 合并；
 *   - 群聊：POST 只返回主持人那一轮（锚点）的 turnId，首个发言人的 turnId 要等
 *     派发开始后才知道。这里用合成 key 占位，拿到首个新 Turn 后立即让位。
 *
 * 只在内存里：刷新后以服务端数据为准，不会残留。
 */
interface PendingTurnState {
  /** 渲染用 turnId（DM = 真实 turnId；群聊 = 合成 key）。 */
  key: string;
  /** 真实 turnId；群聊首个发言人未知时为 null。 */
  turnId: string | null;
  botId: string;
  sessionId: string;
  startedAt: number;
  /** 运行时是否逐 token 流式（决定等待文案）。 */
  streamingRuntime: boolean;
  /** 发送请求开始的时间：群聊用它识别「本轮新 Turn」的时间下界。 */
  since: number;
  /** 群聊锚点（主持人那一轮）：它属于 host，不能被当成首个发言人的 Turn。 */
  anchorTurnId: string;
  /** 停止时发往的 turnId（群聊是锚点 Turn，cancel 可能 409）。 */
  cancelTurnId: string;
}

const pendingTurn = ref<PendingTurnState | null>(null);

/** 发送失败的本地行（POST 非 2xx：用户消息要标失败并可重发）。 */
interface FailedSend {
  id: string;
  text: string;
  reason: string;
  ts: number;
}

const failedSends = ref<FailedSend[]>([]);

/** Bot 绑定的运行时是否流式；未上报按「流式」处理（不能对未知运行时说死）。 */
function runtimeStreams(botId: string): boolean {
  return bots.findBot(botId)?.runtime?.capabilities?.streaming !== false;
}

// ---------------------------------------------------------------------------
// 历史事件回放（P0-04 / P0-05）
// ---------------------------------------------------------------------------
/**
 * 刷新后事件全丢的根因是「首连游标取了渠道级最大 lastEventId，从不回放历史」。
 * 修法：进入会话先按 `seq` 分页把该 Session 的全部事件拉回来（走 turnModel 同一条
 * 装配路径），再拿 `lastEventId` 作为 SSE 首连游标续推 —— REST 与 SSE 之间无缺口。
 *
 * 每个 Session 单独回放：群聊一轮可能有多个发言人，各自落在自己的 Session 上；
 * 只回放主 Session 会让其他发言人的思考/工具/用量块刷新后消失。
 */
const replayedSessions = ref<Set<string>>(new Set());
/** sessionId → 已回放到的最大全局 event id（SSE 首连游标）。 */
const sessionCursors = ref<Map<string, number>>(new Map());
/** 同一 Session 的并发回放合并成一次（主连接 + 额外连接可能同时要求）。 */
const replayJobs = new Map<string, Promise<void>>();

function markReplayed(sessionId: string, cursor?: number): void {
  const next = new Set(replayedSessions.value);
  next.add(sessionId);
  replayedSessions.value = next;
  if (cursor !== undefined) {
    sessionCursors.value = new Map(sessionCursors.value).set(sessionId, cursor);
  }
}

async function replaySession(sessionId: string, signal?: AbortSignal): Promise<void> {
  const running = replayJobs.get(sessionId);
  if (running) return running;

  const job = (async () => {
    let afterSeq = 0;
    let cursor = 0;
    // 上限保护：正常会话远小于 50 页（50 × 5000）；异常游标不该把页面卡死
    for (let page = 0; page < 50; page += 1) {
      const res = await api.sessionEvents(sessionId, afterSeq, 5000, signal);
      for (const frame of res.events) ingestFrame(frame, "history");
      cursor = Math.max(cursor, res.lastEventId);
      const last = res.events[res.events.length - 1];
      if (!res.hasMore || !last) break;
      afterSeq = last.seq + 1;
    }
    markReplayed(sessionId, cursor);
  })();

  replayJobs.set(sessionId, job);
  try {
    await job;
  } finally {
    replayJobs.delete(sessionId);
  }
}

/** 回放当前渠道下所有已知 Session（主 Session + 群聊其他发言人）。 */
async function replayAllSessions(signal?: AbortSignal): Promise<void> {
  const ids = new Set<string>();
  for (const s of sessions.sessions) ids.add(s.id);
  if (activeSessionId.value) ids.add(activeSessionId.value);

  await Promise.all(
    [...ids].map(async (id) => {
      try {
        await replaySession(id, signal);
      } catch (err) {
        if (err instanceof ApiError && err.code === "aborted") return;
        // 回放失败不能让整页空白：标记为已回放，SSE 从 0 兜底重放
        // （events store 按 id 去重，不会重复渲染）。
        markReplayed(id, 0);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// 首屏加载
// ---------------------------------------------------------------------------
let loadAbort: AbortController | null = null;
/** 渠道端点存在但这个 id 查不到（≠ M3 阶段的端点缺失）。 */
const channelMissing = ref(false);

async function loadChannel(): Promise<void> {
  loadAbort?.abort();
  loadAbort = new AbortController();

  // 渠道名需要 Bot 列表来拼参与者，先确保 Bot 已加载
  if (bots.bots.length === 0) await bots.load();

  channelMissing.value = false;
  // 重新拉取时以 REST 的 Session 列表为准：丢弃上次发送留下的占位与额外连接
  sentSessionId.value = null;
  closeExtraStreams();
  events.reset();
  permissions.reset();
  collapsed.value = new Map();
  pendingTurn.value = null;
  failedSends.value = [];
  replayedSessions.value = new Set();
  sessionCursors.value = new Map();

  await sessions.load(props.channelId, loadAbort.signal);
  if (status.value === "error") return;

  // 渠道端点已就绪但找不到这个渠道：明确报「没有这个会话」，而不是拿 id 当名字。
  // 端点缺失（M3）时 `channel` 是我们造的壳，此时不算「找不到」。
  if (!endpointMissing.value && !sessions.channel) {
    channelMissing.value = true;
    return;
  }
  channelMissing.value = false;

  // 消息进 events store（它是正文权威副本的持有者）
  events.replaceMessages(sessions.messages);

  // 先回放历史事件，再让 SSE 建连（streamEnabled 依赖 replayedSessions）：
  // 顺序反了会出现「SSE 推历史 → 紧接着 reset 抹掉」的空态（实测踩到）。
  await replayAllSessions(loadAbort.signal);
  if (loadAbort.signal.aborted) return;

  // 权限权威状态：必须在回放之后拉，否则历史 permission_request 的占位会盖住
  // 已经 decided / denied 的真实状态。
  const sid = activeSessionId.value ?? currentSession.value?.id;
  if (sid) await permissions.load(sid, loadAbort.signal);

  // 历史 Turn 默认收起（原型：已完成折叠；生成中展开）
  await nextTick();
  scrollToBottom();
}

/**
 * 轻量刷新：只重拉消息与 Session 列表，**不清事件表、不重建连接**。
 *
 * 用途：群聊里主持人降级提示、定时任务触发块都是 `messages.role='system'` 行，
 * 它们不进事件流（`meta` 也不承载），只有 REST 能拿到。发完一轮后补拉一次，
 * 用户才能看到「本轮为什么没人说话」这类解释（UX 原则 5）。
 */
async function refreshMessages(): Promise<void> {
  try {
    const detail = await api.channel(props.channelId);
    sessions.channel = detail.channel;
    sessions.sessions = detail.sessions;
    sessions.setMessages(detail.messages);
    events.replaceMessages(detail.messages);
    await nextTick();
    if (pinnedToBottom.value) scrollToBottomSoon();
  } catch {
    // 补拉失败不影响已渲染的内容；下次整页刷新会拿到权威副本
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
/**
 * 当前会话 id（SSE 的 sessionId）。
 *
 * 来源优先级从高到低：
 *   ① URL 的 `?session=`（UX §2.1：只读会话透镜）；
 *   ② 渠道详情返回的 Session 列表最新一条（主路径）；
 *   ③ 本次发送响应里带回的 Session（新建会话时 ② 还没有，见下）；
 *   ④ null —— 不建连接（渠道还没加载完，或确实没有 Session）。
 *
 * ③ 为什么必须有：新建的群里还没人说过话，`/api/channels/:id` 的 `sessions` 是空的，
 * 发送响应才第一次带回 sessionId。不记下来，这个会话就**永远**连不上事件流，
 * 第一条消息的流式内容全部丢失（实测踩到）。刷新后以 ② 的权威值为准。
 */
const sentSessionId = ref<string | null>(null);

const activeSessionId = computed(() => {
  const fromQuery = route.query["session"];
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  return currentSession.value?.id ?? sentSessionId.value;
});

/**
 * SSE 首连游标：**优先用历史回放拿到的 `lastEventId`**。
 *
 * 刷新后 REST 已经把该 Session 的全部历史事件装进 store，此时从最大 id 续推
 * 才不会重复回放；没有回放结果（端点缺失 / 回放失败）时退回 0（从头回放，
 * events store 按 id 去重，最多多一点流量，不会重复渲染）。
 *
 * 不能用渠道级 `sessions.lastEventId`：它是「该渠道所有 Session 里最大的
 * events.id」，群聊里别的 Session 的事件 id 更大时，主 Session 的事件会全部
 * 落在游标之前被跳过（实测踩到）。所以群聊必须 0 / 本 Session 游标。
 */
const lastEventId = computed(() => {
  const sid = activeSessionId.value;
  if (sid) {
    const cursor = sessionCursors.value.get(sid);
    if (cursor !== undefined) return cursor;
  }
  return channel.value?.type === "group" ? 0 : sessions.lastEventId;
});

/**
 * 只在 **REST 首屏 + 历史回放都已落地** 之后才建连接。
 *
 * 这不是保守，是正确性要求：`loadChannel()` 开头会 `events.reset()` 清空事件表，
 * 如果 SSE 先连上并把历史重放进来，紧接着 reset 会把刚收到的帧全部抹掉 ——
 * 页面就永远停在空态（实测踩到）。回放完成后再建连，保证「先清空、再回放、
 * 再续推」的顺序，也避免 REST 与 SSE 各推一遍同一条事件。
 */
const streamEnabled = computed(() => {
  const sid = activeSessionId.value;
  return (
    (status.value === "empty" || status.value === "ready") &&
    sid !== null &&
    replayedSessions.value.has(sid) &&
    !channelMissing.value
  );
});

const sse = useSseStream({
  sessionId: computed(() => activeSessionId.value),
  lastEventId,
  enabled: streamEnabled,
  onFrame: handleFrame,
  onMeta: handleMeta,
  onReplayTruncated: () => {
    // 回放超上限：走 REST 补历史（M4 起有 /api/channels/:id，直接重拉）
    ui.toast("事件回放超出上限，已重新拉取历史");
    void loadChannel();
  },
});

// ---------------------------------------------------------------------------
// 群聊：每个发言人有自己的 Session，必须逐 Session 建连接
// ---------------------------------------------------------------------------
/**
 * 群聊里一轮可能有多个 Bot 发言，每个 Bot 的 Turn 落在**它自己的 Session** 上。
 * 主连接只覆盖 `activeSessionId` 一个 Session，其余发言人的流式内容收不到 ——
 * 表现就是「主持人决策完了、系统块也出来了，但发言人的 Turn 一直是空的」。
 *
 * 所以：为渠道里所有「不是主连接那个」的 Session 各开一条只收不发的连接。
 * 单聊时这个列表恒为空（只有一个 Session），行为与之前完全一致。
 */
const extraConns = new Map<string, SseConnection>();

const extraSessionIds = computed(() => {
  const main = activeSessionId.value;
  return sessions.sessions
    .map((s) => s.id)
    // 先回放完再建连：否则额外连接会从 0 把历史再推一遍，
    // 与 REST 回放竞争同一批 turn bucket（去重能挡住，但白跑一遍帧）
    .filter((id) => id !== main && replayedSessions.value.has(id));
});

/**
 * 运行中新出现的 Session（群聊后来的发言人 / 新建会话）**先回放再建 SSE**。
 *
 * 为什么需要这个 watcher：`loadChannel` 只处理进入页面时已知的 Session；
 * 群聊一轮里发言人会话可能在发送后几秒才由 dispatcher 建出来，`refreshMessages`
 * 把它带进 `sessions.sessions` 时还没有历史。不回放就直接建连（或干脆不建，
 * 因为 extraSessionIds 过滤了未回放的 id）会让该发言人的流式内容整段丢失。
 */
const unreplayedSessionIds = computed<string[]>(() => {
  const ids = new Set<string>(sessions.sessions.map((s) => s.id));
  const active = activeSessionId.value;
  if (active) ids.add(active);
  return [...ids].filter((id) => !replayedSessions.value.has(id));
});

watch(
  unreplayedSessionIds,
  (ids) => {
    for (const id of ids) {
      void replaySession(id).catch(() => markReplayed(id, 0));
    }
  },
  { immediate: true },
);

function syncExtraStreams(): void {
  if (channelMissing.value || status.value === "loading" || status.value === "idle") return;
  const wanted = new Set(extraSessionIds.value);

  // 关掉不再需要的
  for (const [id, conn] of [...extraConns]) {
    if (!wanted.has(id)) {
      conn.close();
      extraConns.delete(id);
    }
  }

  // 开新的：游标用该 Session 回放到的最大 id，SSE 只续推增量。
  // 回放失败时 sessionCursors 里是 0（从头回放，events store 按 id 去重）。
  for (const id of wanted) {
    if (extraConns.has(id)) continue;
    const conn = openStream({
      sessionId: id,
      lastEventId: sessionCursors.value.get(id) ?? 0,
      onFrame: (frame: SseFrame) => {
        if (frame.sessionId !== id) return;
        // meta 帧也要走同一条路：它驱动 Session 分隔条，不进渲染流
        ingestFrame(frame, "live");
      },
    });
    extraConns.set(id, conn);
  }
}

watch([extraSessionIds, status], () => syncExtraStreams(), { immediate: true });

function closeExtraStreams(): void {
  for (const conn of extraConns.values()) conn.close();
  extraConns.clear();
}

watch(connection, (v) => {
  if (v === "open") sessions.setConnection("open");
});

/**
 * 事件入 store 的唯一入口 —— **实时帧与历史回放共用**。
 *
 * 两条路径必须走同一段代码：只给 SSE 写一份、REST 回放另写一份，迟早会出现
 * 「刷新后权限卡/思考块不出现」这类只在一条路径复现的偏差（critic 实测的根因之一）。
 *
 * `source` 只影响副作用：
 *   - live：permission_request 立刻占位并拉权威状态（卡片要快）；
 *   - history：占位即可，权威状态由回放结束后的 `permissions.load()` 统一校正
 *     （历史里绝大多数请求早已 decided，不该再弹一张待批卡）。
 */
function ingestFrame(frame: SseFrame, source: "live" | "history"): boolean {
  // 只处理本渠道的帧（多标签页 / 群聊多 Session 时可能短暂重叠）。
  // 群聊的额外连接也走这里，所以判断依据是「Session 属于本渠道」而不是「等于主 Session」。
  if (!isSessionOfThisChannel(frame.sessionId)) return false;

  const botId = resolveBotId(frame);
  const raw: RawEvent = {
    id: frame.id,
    sessionId: frame.sessionId,
    messageId: frame.messageId,
    turnId: frame.turnId,
    type: frame.type,
    seq: frame.seq,
    payload: frame.payload,
    raw: frame.raw,
    createdAt: frame.createdAt,
  };

  // meta 只更新 Session 分隔条与内部状态，绝不进渲染流
  if (frame.type === "meta") {
    events.pushMeta(raw);
    return true;
  }

  // 权限请求：先占位（避免 1s 后才看到卡片），再用端点校正
  if (frame.type === "permission_request") {
    const p = frame.payload as {
      requestId?: unknown;
      action?: unknown;
      target?: unknown;
      boundaryVerdict?: unknown;
    };
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (requestId) {
      permissions.placeholder({
        requestId,
        sessionId: frame.sessionId,
        botId,
        turnId: frame.turnId,
        action:
          p.action === "write" || p.action === "read" || p.action === "exec" || p.action === "network"
            ? p.action
            : "read",
        target: typeof p.target === "string" ? p.target : "",
        boundaryVerdict:
          p.boundaryVerdict === "denied" ? "denied" : p.boundaryVerdict === "allowed" ? "allowed" : "pending",
        createdAt: frame.createdAt,
      });
      if (source === "live") {
        // 端点存在时拉权威状态（超时策略/截止时间/已决状态只有它有）
        const sid = activeSessionId.value;
        if (sid) void permissions.load(sid);
        bots.bumpPending(botId, 1);
      }
    }
  }

  // done / error：Turn 收口，清掉该 Turn 的「生成中」
  return events.pushEvent(raw, botId);
}

function handleFrame(frame: SseFrame): void {
  const accepted = ingestFrame(frame, "live");
  if (!accepted) return;
  if (pinnedToBottom.value) scrollToBottomSoon();
}

/** meta 只更新 Session 分隔条与内部状态，绝不进渲染流。 */
function handleMeta(frame: SseFrame): void {
  ingestFrame(frame, "live");
  if (pinnedToBottom.value) scrollToBottomSoon();
}

/**
 * 这一帧的 Session 是否属于当前渠道。
 *
 * 群聊有多个 Session（每个发言 Bot 一个），所以不能只比 `activeSessionId`。
 * 判断依据是渠道详情返回的 `sessions` 列表；列表还没加载时退回「等于主 Session」，
 * 保证单聊行为不变（单聊只有一个 Session）。
 */
function isSessionOfThisChannel(sessionId: string): boolean {
  if (sessions.sessions.some((s) => s.id === sessionId)) return true;
  // 首屏加载中（切渠道时 sessions 已被清空）：旧连接的迟到帧不属于新页面
  if (status.value === "loading" || status.value === "idle") return false;
  return activeSessionId.value === null || sessionId === activeSessionId.value;
}

/**
 * 解析一帧事件属于哪个 Bot。
 *
 * 顺序（群聊里一轮可能有多个 Bot，必须逐 Turn 归属，不能整页取一个）：
 *   ① 事件 payload 自带 `botId`（M4 起编排层会带，最可靠）；
 *   ② 该 Turn 的助手消息属于哪个 Session，就用那个 Session 的 botId；
 *   ③ 单聊渠道 → 唯一的参与者；
 *   ④ 群聊兜底：主持人（只在 ①② 都拿不到时，宁可显示主持人也不要显示「未知 Bot」）。
 */
function resolveBotId(frame: SseFrame): string {
  const payload = frame.payload as { botId?: unknown } | null;
  if (payload && typeof payload.botId === "string") return payload.botId;

  const viaMessage = botIdOfTurnFromMessages(frame.turnId);
  if (viaMessage) return viaMessage;

  const ch = channel.value;
  if (ch) {
    if (ch.type === "dm" && ch.participantBotIds[0]) return ch.participantBotIds[0];
    if (ch.hostBotId) return ch.hostBotId;
    if (ch.participantBotIds[0]) return ch.participantBotIds[0];
  }
  return bots.bots[0]?.id ?? "";
}

/** sessionId → botId（渠道详情返回的 Session 列表）。 */
const sessionBotMap = computed(() => {
  const map = new Map<string, string>();
  for (const s of sessions.sessions) map.set(s.id, s.botId);
  return map;
});

/**
 * 某 Turn 的助手消息属于哪个 Bot。
 *
 * 这是群聊正确性的关键：`events` 的 payload 在 M4 之前不带 botId，
 * 而「主持人」和「本轮实际发言的 Bot」通常不是同一个 ——
 * 一律用主持人兜底会让整页 Turn 头都写「主理人」（实测踩到）。
 * 消息表里有 `sessionId`，Session 表里有 `botId`，两跳就能拿到真实归属。
 */
function botIdOfTurnFromMessages(turnId: string): string | null {
  for (const m of sessions.messages) {
    if (m.turnId !== turnId) continue;
    const botId = sessionBotMap.value.get(m.sessionId);
    if (botId) return botId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn 列表（虚拟滚动）
// ---------------------------------------------------------------------------
/**
 * pending Turn 的渲染 key 与「是否还在等首个事件」。
 *
 * `pendingActive` 为 false 时说明该 turnId 已经有事件了：此时正常装配路径
 * 会把它画成真实 Turn，pending 必须让位，否则同一个 turnId 会出现两个 Turn。
 */
const pendingKey = computed(() => pendingTurn.value?.key ?? null);

const pendingActive = computed(() => {
  const p = pendingTurn.value;
  if (!p) return false;
  return p.turnId === null || events.turnEvents(p.turnId).length === 0;
});

/**
 * 群聊 pending 期间要遮蔽的真实 Turn。
 *
 * 派发开始后，发言人的 assistant 消息行会先落库；`refreshMessages`（发送后
 * 1.2s / 6s 各一次）会把它带进 `sessions.messages`。此时事件还没到，
 * 若同时渲染 pending 与这个空 Turn，界面上就是两个 Turn。
 *
 * 这里按「归属 Bot + 本次发送之后创建 + 不是主持人锚点」识别它，暂时不渲染；
 * 首个事件到达后 pending 退场，真实 Turn 自然接上（同一个 turnId，只出现一次）。
 */
const pendingShadowedTurnIds = computed<Set<string>>(() => {
  const p = pendingTurn.value;
  if (!p || p.turnId !== null) return new Set<string>();
  const set = new Set<string>();
  for (const m of sessions.messages) {
    if (m.role !== "assistant") continue;
    if (m.turnId === p.anchorTurnId) continue;
    if (m.createdAt < p.since) continue;
    if (sessionBotMap.value.get(m.sessionId) !== p.botId) continue;
    set.add(m.turnId);
  }
  for (const id of events.turnIds()) {
    if (id === p.anchorTurnId) continue;
    if (events.botIdOfTurn(id) !== p.botId) continue;
    const first = events.turnEvents(id)[0];
    if (first && first.createdAt >= p.since) set.add(id);
  }
  return set;
});

/**
 * 需要渲染成 Turn 的 turnId。
 *
 * 只保留「有助手消息或有事件」的 Turn：
 *   - 用户消息行单独渲染（`.msg--user`），它的 turnId 不需要一个空 Turn 来承载；
 *   - 系统消息（主持人降级提示、定时任务触发块）也单独成行，同理。
 * 不筛的话，每一条用户消息和系统消息都会生成一个**没有内容、状态默认 streaming**
 * 的 Turn —— 界面上表现为一个永远转圈的空壳（实测踩到）。
 *
 * pending 是例外：它还没有任何事件，但必须有一个 Turn 来承载「生成中 + 秒数」。
 * 它只在没有同 id 事件时追加，且 `turnIds` 本身去重，所以不会出现两个 Turn。
 */
const turnIds = computed<string[]>(() => {
  const withAssistant = new Set<string>();
  for (const m of sessions.messages) {
    if (m.role === "assistant") withAssistant.add(m.turnId);
  }
  const eventTurns = new Set(events.turnIds());
  const shadowed = pendingShadowedTurnIds.value;

  const seen = new Set<string>();
  const order: string[] = [];
  for (const turnId of sessions.turnOrder) {
    if (shadowed.has(turnId)) continue;
    if (!withAssistant.has(turnId) && !eventTurns.has(turnId)) continue;
    seen.add(turnId);
    order.push(turnId);
  }
  for (const turnId of eventTurns) {
    if (shadowed.has(turnId)) continue;
    if (!seen.has(turnId)) {
      seen.add(turnId);
      order.push(turnId);
    }
  }

  // pending 排在最后：它的 startedAt 一定晚于所有已有 Turn，rows 会按时间再排一次。
  const pk = pendingKey.value;
  if (pk !== null && pendingActive.value && !seen.has(pk)) order.push(pk);
  return order;
});

const blockingTurnIds = computed(() => permissions.blockingTurnIds());

/**
 * 构建全部 TurnView。Turn 数量通常 <100，构建成本可接受；虚拟滚动只省 DOM。
 *
 * `fallbackRebuild` 只在「渠道/消息端点不可用」时打开：此时没有 messages 表的
 * 权威正文可取，只能靠事件累积拼出正文，页面会同时显示一条降级提示。
 * 端点一旦就绪（M4），这里自动回到「messages.content 为准」的正常路径。
 */
const turnViews = computed<TurnView[]>(() =>
  turnIds.value.map((turnId) => {
    const p = pendingTurn.value;
    if (p && pendingActive.value && turnId === p.key) {
      return buildPendingTurnView({
        turnId: p.key,
        botId: p.botId,
        startedAt: p.startedAt,
        streamingRuntime: p.streamingRuntime,
      });
    }
    const botId = events.botIdOfTurn(turnId) ?? resolveTurnBot(turnId);
    return buildTurnView({
      turnId,
      botId,
      events: events.turnEvents(turnId),
      messages: events.messagesOfTurn(turnId),
      streamingText: events.streamingText,
      blockingTurnIds: blockingTurnIds.value,
      fallbackRebuild: endpointMissing.value,
    });
  }),
);

/**
 * 最新一轮的 turnId（按装配顺序的最后一个）。
 *
 * 用途只有一个：让「刚收口的那一轮」保持展开（见 `isCollapsed`）。
 * 用户等完 15–30s 后答案立刻缩成一行摘要，等于逼他再点一次 —— 试用反馈
 * 原话「回答的信息，默认是折叠的」。上一条会自动收起，单展开仍然成立。
 */
const latestTurnId = computed<string | null>(
  () => turnViews.value[turnViews.value.length - 1]?.turnId ?? null,
);

/**
 * pending 的退场：首个事件到达（或群聊里首个新 Turn 出现）就交给正常路径。
 *
 * 注意这里只清 `pendingTurn`，不做「把事件搬进 pending」之类的合并 ——
 * pending 与真实 Turn 共用同一个 turnId（DM）或直接让位（群聊合成 key），
 * 从结构上就不可能出现两个 Turn。
 */
watch(
  () => events.frameCount,
  () => {
    const p = pendingTurn.value;
    if (!p) return;

    if (p.turnId !== null) {
      if (events.turnEvents(p.turnId).length > 0) pendingTurn.value = null;
      return;
    }

    // 群聊：找「本轮派发产生的新 Turn」，且归属 Bot 是第一个发言人。
    const hit = events.turnIds().find((id) => {
      // 主持人那一轮（锚点）不是发言人的 Turn；即使主持人本人也在名单里，
      // 它的决策轮与发言轮是两个 turnId。
      if (id === p.anchorTurnId) return false;
      if (events.botIdOfTurn(id) !== p.botId) return false;
      const list = events.turnEvents(id);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return false;
      // 必须是本次发送之后才开始的 Turn：上一轮同 Bot 仍在跑时不能抢走 pending。
      if (first.createdAt < p.since) return false;
      return last.createdAt >= p.since;
    });
    if (hit) pendingTurn.value = null;
  },
);

// SSE 断开但 REST 补拉到了终态：pending 也必须退场，不能一直挂着。
watch(
  () => sessions.messages,
  () => {
    const p = pendingTurn.value;
    if (!p || p.turnId === null) return;
    const row = sessions.messages.find((m) => m.turnId === p.turnId && m.role === "assistant");
    if (row && row.status !== "streaming") pendingTurn.value = null;
  },
);

function resolveTurnBot(turnId: string): string {
  // ① 消息 → Session → Bot（群聊里唯一可靠的归属来源）
  const viaMessage = botIdOfTurnFromMessages(turnId);
  if (viaMessage) return viaMessage;
  // ② 单聊：唯一的参与者
  const ch = channel.value;
  if (ch?.type === "dm" && ch.participantBotIds[0]) return ch.participantBotIds[0];
  // ③ 群聊兜底
  if (ch?.hostBotId) return ch.hostBotId;
  return ch?.participantBotIds[0] ?? bots.bots[0]?.id ?? "";
}

/**
 * 主持人决策块（UX F2-2：`研究助手（理由）、实现助手（理由）` + `本轮调用 2/3`）。
 *
 * 主持人那一轮的助手消息正文就是它返回的 JSON（`{"speakers":[…],"skipReason":""}`）——
 * 把它当普通气泡渲染，用户会看到一坨 JSON。这里按 turnId 解析出来，
 * TurnItem 用它替换气泡，渲染成「本轮发言人」系统块。
 *
 * 解析失败（不是 JSON / 没有 speakers 键）就返回 null，退回普通气泡 ——
 * 宁可直接显示原文，也不要吞掉主持人的话。
 */
interface HostDecision {
  speakers: { botId: string; reason: string }[];
  skipReason: string;
  /** 解析成决策的原始消息 id：这些消息不再画成普通气泡（避免 JSON 与系统块重复）。 */
  rawMessageIds: string[];
}

/**
 * 从自由文本里抠出第一个 JSON 对象（主持人常带 ```json 围栏或前后寒暄）。
 *
 * 与后端 `group/host.ts` 的 `extractJsonObject` 同口径。只认 `startsWith("{")`
 * 会让「围栏包裹的 JSON」漏成普通气泡 —— critic 实测的原始 JSON 重复显示
 * 就是这条路径（后端解析成功、前端解析失败）。
 */
function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 主持人那一轮的助手消息（**只认主持人 Bot 的 Session**）。
 *
 * 不能把「任何含 speakers 的 JSON」都当主持人决策：群里的普通 Bot 也可能
 * 合法地返回一段含 speakers 字段的 JSON（例如它在总结接口）。按 Session → Bot
 * 归属过滤后，只有主持人的决策轮会被折叠。
 */
function hostAssistantMessages(): MessageDto[] {
  const ch = channel.value;
  if (ch?.type !== "group" || !ch.hostBotId) return [];
  const out: MessageDto[] = [];
  for (const m of sessions.messages) {
    if (m.role !== "assistant" || m.content.trim().length === 0) continue;
    if (sessionBotMap.value.get(m.sessionId) !== ch.hostBotId) continue;
    out.push(m);
  }
  return out;
}

const hostDecisions = computed<Map<string, HostDecision>>(() => {
  const map = new Map<string, HostDecision>();
  if (channel.value?.type !== "group") return map;

  for (const message of hostAssistantMessages()) {
    const parsed = extractJsonObject(message.content);
    if (!isRecordValue(parsed) || !Array.isArray(parsed["speakers"])) continue;

    const speakers: { botId: string; reason: string }[] = [];
    for (const item of parsed["speakers"]) {
      if (!isRecordValue(item)) continue;
      const botId = typeof item["botId"] === "string" ? item["botId"] : "";
      if (!botId) continue;
      speakers.push({
        botId,
        reason: typeof item["reason"] === "string" ? item["reason"] : "",
      });
    }

    const existing = map.get(message.turnId);
    if (existing) {
      existing.rawMessageIds.push(message.id);
      continue;
    }
    map.set(message.turnId, {
      speakers,
      skipReason: typeof parsed["skipReason"] === "string" ? parsed["skipReason"] : "",
      rawMessageIds: [message.id],
    });
  }
  return map;
});

/**
 * 主持人回复「像 JSON 但解析不出 speakers」的轮次（围栏坏掉 / 模型跑题）。
 *
 * 这类内容同样不能当普通气泡展示：用户看到的是一坨原始 JSON，而系统块已经
 * 用「本轮无 Bot 发言」解释了结果。折叠成一行说明，原文仍留在 DB 里。
 */
const hostRawTurnIds = computed<Set<string>>(() => {
  const set = new Set<string>();
  if (channel.value?.type !== "group") return set;
  for (const message of hostAssistantMessages()) {
    if (hostDecisions.value.has(message.turnId)) continue;
    const text = message.content.trim();
    const looksJson = text.startsWith("{") || /```(?:json)?/i.test(text);
    if (looksJson) set.add(message.turnId);
  }
  return set;
});

/** 本轮最多 3 个发言人（PRD P0-06）。 */
const MAX_SPEAKERS = 3;

// ---------------------------------------------------------------------------
// 活动行（UX §5.1「单展开」的第二半）
// ---------------------------------------------------------------------------
/** 用户点「点击接管」指定的焦点 Turn。 */
const takeoverTurnId = ref<string | null>(null);

/** 折叠 Turn 的一句话摘要：正在跑什么（优先最新的 tool_call，其次思考/正文）。 */
function currentActivity(turn: TurnView): string {
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    const item = turn.items[i];
    if (!item) continue;
    if (item.kind === "tool_call") {
      const input = item.input as Record<string, unknown> | null;
      const target =
        input && typeof input === "object"
          ? (["command", "path", "file", "cmd"] as const)
              .map((k) => input[k])
              .find((v): v is string => typeof v === "string" && v.length > 0)
          : undefined;
      return target ? `${item.name} ${target}` : item.name;
    }
    if (item.kind === "thought") return "思考中";
    if (item.kind === "message" && item.text.length > 0) return "正在生成回复";
  }
  return "正在运行";
}

/** 已进行时长（活动行右侧的 `12s`）。 */
function elapsedShort(turn: TurnView): string {
  const ms = Math.max(0, Date.now() - turn.startedAt);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * 进度条百分比。
 *
 * 事件流不提供总进度（运行时也不上报），所以这里用「已产生的事件数」做一个
 * 有上限的估计，而不是假装知道百分比：40% 起步，每 5 条事件 +10%，封顶 92%，
 * 收口时（本行消失前）不会到 100 —— 避免让用户以为「快好了」。
 * 原型同样用固定/半固定值（`pct == null ? 40 : it.pct`）。
 */
function activityPct(turn: TurnView): number {
  return Math.min(92, 40 + turn.items.length * 10);
}

function onTakeover(turnId: string): void {
  takeoverTurnId.value = turnId;
}

/** 流条目：Turn + Session 分隔条按时间交织。 */
interface StreamRow {
  key: string;
  kind: "turn" | "divider" | "user" | "fence" | "act" | "sys";
  turn?: TurnView;
  dividerText?: string;
  userText?: string;
  /** 系统消息正文（主持人降级提示、定时任务触发块）。 */
  sysText?: string;
  /** 轮次栅栏：本轮参与者与合计 token。 */
  fence?: { participants: string[]; tokens: number };
  /** 活动行（UX §5.1 单展开的第二半）：折叠掉的并行 Turn。 */
  act?: { turnId: string; botId: string; what: string; dur: string; pct: number };
  ts: number;
}

/**
 * 发送失败行（POST 非 2xx）。
 *
 * 不塞进 `sessions.messages`：服务端根本没有这条消息，塞进去会被下一次
 * `refreshMessages` 抹掉。它只是「用户这次尝试」的本地记录，重发成功后删除。
 */
interface FailedRow {
  key: string;
  kind: "fail";
  failText: string;
  failReason: string;
  ts: number;
  /** 失败行没有 Turn；显式声明让模板里 `entry.row.turn` 在联合类型下仍可读。 */
  turn?: undefined;
}

type Row = StreamRow | FailedRow;

/** 模板里把 Row 收窄回 StreamRowItem 认识的形状（fail 行由 ChatPage 自己渲染）。 */
function asStreamRow(row: Row): StreamRow {
  return row as StreamRow;
}

function failedRowOf(row: Row): FailedRow | null {
  return row.kind === "fail" ? row : null;
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];

  // 用户消息（来自 messages 表）单独成行，插在对应 Turn 之前
  const userMsgs = sessions.messages.filter((m) => m.role === "user");
  const userRows: StreamRow[] = userMsgs.map((m) => ({
    key: `u-${m.id}`,
    kind: "user",
    userText: m.content,
    ts: m.createdAt,
  }));

  /**
   * 系统消息（`messages.role === 'system'`）必须单独成行。
   *
   * 它们承载「缺席的解释」（UX 原则 5）：主持人不可用/超时降级、丢弃了不存在的 Bot、
   * 定时任务触发。这些行不渲染的话，用户看到的是一轮没有回复的空 Turn，
   * 分不清「没发生」和「坏了」—— 群聊 F2 的失败分支全靠它。
   */
  const sysRows: StreamRow[] = sessions.messages
    .filter((m) => m.role === "system")
    .map((m) => ({
      key: `s-${m.id}`,
      kind: "sys",
      sysText: m.content,
      ts: m.createdAt,
    }));

  const dividerRows: StreamRow[] = dividers.value.map((d) => ({
    key: `d-${d.eventId}`,
    kind: "divider",
    dividerText: d.text,
    ts: d.ts,
  }));

  // 发送失败：POST 没有落库，用户消息只能本地呈现；红条 + 重发由模板渲染。
  const failRows: FailedRow[] = failedSends.value.map((f) => ({
    key: f.id,
    kind: "fail",
    failText: f.text,
    failReason: f.reason,
    ts: f.ts,
  }));

  // ---- 单展开（UX §5.1 第 2 条）----
  // 同一时刻最多一个 Turn 展开流式。群聊里多个 Bot 并行时，最晚开始的那个保持展开，
  // 其余折叠成 40px 活动行（点击接管 = 把焦点换过去）。
  // 只有「同时在跑」才有意义：已收口的 Turn 本来就已经折叠成一行头部，不需要活动行。
  const streamingTurns = turnViews.value.filter((t) => t.status === "streaming");
  const focusedTurnId =
    streamingTurns.length > 1 ? streamingTurns[streamingTurns.length - 1]?.turnId : null;
  /** 用户点「点击接管」后手动指定焦点；优先于「最晚开始」。 */
  const focusOverride = focusedTurnId ? (takeoverTurnId.value ?? focusedTurnId) : null;

  const turnRows: StreamRow[] = [];
  for (const t of turnViews.value) {
    if (focusOverride && t.status === "streaming" && t.turnId !== focusOverride) {
      turnRows.push({
        key: `a-${t.turnId}`,
        kind: "act",
        act: {
          turnId: t.turnId,
          botId: t.botId,
          what: currentActivity(t),
          dur: elapsedShort(t),
          pct: activityPct(t),
        },
        ts: t.startedAt,
      });
      continue;
    }
    turnRows.push({ key: `t-${t.turnId}`, kind: "turn", turn: t, ts: t.startedAt });
  }

  out.push(...userRows, ...sysRows, ...dividerRows, ...turnRows, ...failRows);
  out.sort((a, b) => a.ts - b.ts);

  // ---- 轮次栅栏（UX §5.1 第 4 条）----
  // 一轮 = 一条用户消息之后、下一条用户消息之前的所有 Turn。
  // 两个前提缺一不插：
  //   ① 这一轮必须以用户消息开头（否则是历史片段，插栅栏等于凭空划界）；
  //   ② 整轮都已收口（生成中就插会让用户以为这轮已经结束）。
  const fences: StreamRow[] = [];
  let bucket: TurnView[] = [];
  let hasUserLead = false;
  const flush = (): void => {
    if (bucket.length > 0 && hasUserLead) {
      const allTerminal = bucket.every(
        (t) => t.status === "done" || t.status === "failed" || t.status === "interrupted",
      );
      if (allTerminal) {
        const participants: string[] = [];
        for (const t of bucket) if (!participants.includes(t.botId)) participants.push(t.botId);
        const tokens = bucket.reduce(
          (sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0),
          0,
        );
        const last = bucket[bucket.length - 1];
        if (last) {
          fences.push({
            key: `f-${last.turnId}`,
            kind: "fence",
            fence: { participants, tokens },
            ts: last.endedAt ?? last.startedAt,
          });
        }
      }
    }
    bucket = [];
    hasUserLead = false;
  };
  for (const row of out) {
    if (row.kind === "user") {
      flush();
      hasUserLead = true;
    } else if (row.kind === "divider") {
      flush();
    } else if (row.kind === "turn" && row.turn) {
      bucket.push(row.turn);
    }
  }
  flush();

  const merged = [...out, ...fences];
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
});

const scrollRef = computed(() => streamEl.value);

const virtual = useVirtualList({
  scrollRef,
  count: computed(() => rows.value.length),
  getKey: (i) => rows.value[i]?.key ?? String(i),
  estimateSize: 180,
  overscan: 5,
});

/** 短会话（≤20 行）不虚拟化，避免测量抖动；长会话才开。 */
const virtualEnabled = computed(() => rows.value.length > 20);

interface VisibleRow {
  row: Row;
  index: number;
  /** 虚拟化时的布局信息；短会话下为 undefined。 */
  start?: number;
}

const visibleRows = computed<VisibleRow[]>(() => {
  if (!virtualEnabled.value) {
    return rows.value.map((row, index) => ({ row, index }));
  }
  const out: VisibleRow[] = [];
  for (const vi of virtual.items.value) {
    const row = rows.value[vi.index];
    if (row) out.push({ row, index: vi.index, start: vi.start });
  }
  return out;
});

// ---------------------------------------------------------------------------
// 滚动
// ---------------------------------------------------------------------------
function onScroll(): void {
  const el = streamEl.value;
  if (!el) return;
  // 距底 120px 内视为「贴底」：新帧到达时自动跟随
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  markStuck();
}

function scrollToBottom(): void {
  const el = streamEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

let scrollRaf = 0;
function scrollToBottomSoon(): void {
  if (scrollRaf !== 0) return;
  scrollRaf = window.requestAnimationFrame(() => {
    scrollRaf = 0;
    scrollToBottom();
  });
}

/** 吸顶判定：Turn 头贴在流容器顶边即视为吸顶（原型 markStuck）。 */
function markStuck(): void {
  const el = streamEl.value;
  if (!el) return;
  const streamTop = el.getBoundingClientRect().top;
  for (const head of el.querySelectorAll<HTMLElement>(".turn-head")) {
    const turn = head.closest<HTMLElement>(".turn");
    if (!turn) continue;
    const rect = head.getBoundingClientRect();
    turn.classList.toggle("is-stuck", rect.top <= streamTop + 1 && rect.bottom > streamTop + 8);
  }
}

// 新帧到达时：贴底则跟随；同时刷新吸顶状态
watch(frameCount, () => {
  if (pinnedToBottom.value) scrollToBottomSoon();
  nextTick(markStuck);
});

// ---------------------------------------------------------------------------
// 折叠（单展开：同一时刻最多一个展开的「生成中」Turn）
// ---------------------------------------------------------------------------
function isCollapsed(turn: TurnView): boolean {
  // 生成中 / pending / 有阻断权限 / 已中断 → 强制展开（用户必须能看见正在发生的事）
  if (
    turn.status === "pending" ||
    turn.status === "streaming" ||
    turn.hasBlockingPermission ||
    turn.status === "interrupted"
  ) {
    return false;
  }
  // 用户显式点过就以用户为准（空回复/主持人块也只是「默认展开」，仍可手动收起）
  const override = collapsed.value.get(turn.turnId);
  if (override !== undefined) return override;
  // 空回复（P0-04）：降级块 + 重发是这一轮的「结论」，收起等于把异常藏起来
  if (
    turn.items.some(
      (item) => item.kind === "message" && !item.streaming && item.text.length === 0,
    )
  ) {
    return false;
  }
  // 主持人决策（P0-06）：系统块解释了「这一轮为什么是这几个人 / 为什么没人说话」，
  // 收起后用户只剩一圈空 Turn（实测 critic 需要它常显）
  if (hostDecisions.value.has(turn.turnId) || hostRawTurnIds.value.has(turn.turnId)) {
    return false;
  }
  // 默认：只有「正常完成」收起（原型 `collapsed = status === 'done' && !expanded`）。
  // 失败与排队保持展开 —— 失败轮要露出错误块与「重发」，排队轮要露出原因，
  // 收起会让用户以为「没发生」（违反 UX 原则 5「缺席要可解释」）。
  //
  // 例外：**最新一轮保持展开**。用户刚等完 15–30s，答案立刻缩成一行摘要等于
  // 逼他再点一次才看得到（试用反馈原话「回答的信息，默认是折叠的」）。
  // 上一条会被自动收起，所以「单展开」仍然成立。
  if (turn.turnId === latestTurnId.value) return false;
  return turn.status === "done";
}

function toggleTurn(turnId: string): void {
  const turn = turnViews.value.find((t) => t.turnId === turnId);
  if (!turn) return;
  const wasPinned = pinnedToBottom.value;
  const isLast = turnId === latestTurnId.value;
  const next = new Map(collapsed.value);
  next.set(turnId, !isCollapsed(turn));
  collapsed.value = next;

  // 展开/收起会改变这一行的高度（实测展开 +138px），但 scrollTop 不会跟着变：
  // 贴底时展开最新一轮，新露出的正文直接落在视口下方，看起来像「点了没反应」。
  // 所以这里要把滚动位置补上：
  //   - 原本贴底 → 继续保持贴底；
  //   - 动的是最新一轮 → 滚到底，让刚展开的正文（或收起后的摘要行）进入视野。
  // 老轮次在历史中间被展开时不动滚动 —— 用户是特意翻上去看的，跳到底会打断阅读。
  if (wasPinned || isLast) settleScrollAfterToggle();
}

/**
 * 折叠状态变化后重新贴底。
 *
 * 需要等两帧：
 *   ① 第一帧：Vue patch 完 DOM，虚拟列表的 ResizeObserver 量到新行高；
 *   ② 第二帧：virtualizer 按新总高重排行位置，此时 scrollHeight 才是最终值。
 * 只等 `nextTick` 不够 —— 那时 scrollHeight 还是旧的，滚下去会差一截。
 */
function settleScrollAfterToggle(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollToBottom();
      markStuck();
    });
  });
}

// ---------------------------------------------------------------------------
// 发送 / 停止 / 重发
// ---------------------------------------------------------------------------
const composer = ref<InstanceType<typeof Composer> | null>(null);
const sending = ref(false);

/** 有阻断型权限时锁定输入框（UX 6.2 L1）。 */
const composerLocked = computed(() => hasBlocking.value);

/** 流尾吸附的那一张阻断卡：最老的一张（先来先处置）。 */
const blockingPermission = computed(() => blocking.value[0] ?? null);
const composerDisabled = computed(() => status.value === "error" || connection.value === "closed");

/** 正在生成的 Turn（发送键变停止键）。pending 也算：用户已经发出去了。 */
const streamingTurn = computed(
  () =>
    turnViews.value.find((t) => t.status === "streaming" || t.status === "pending") ?? null,
);

const placeholder = computed(() => `给 ${channel.value?.name || "会话"} 发消息…`);

/**
 * 发送一条消息（P0-04 / P0-06 共用主路径）。
 *
 * 「发送」与「重发」必须是同一条代码：重发若走另一条分支，很容易又退回
 * 「把原文填进输入框」的伪实现（critic 实测）。`mentionBotIds` 只在群聊里非空。
 */
async function sendText(text: string, mentionBotIds: string[] = []): Promise<boolean> {
  if (sending.value) return false;
  sending.value = true;
  // 群聊的「本轮新 Turn」判定下界：请求发出前的时间（服务器与浏览器同机同时钟）。
  const sendStartedAt = Date.now();
  try {
    const res = await api.sendMessage({
      channelId: props.channelId,
      text,
      ...(mentionBotIds.length > 0 ? { mentionBotIds } : {}),
    });
    // 乐观渲染：先把自己的消息插进流（服务端 SSE 会再推一次同 id 的帧，按 id 去重）
    sessions.appendMessage({
      id: res.messageId,
      sessionId: res.sessionId,
      channelId: props.channelId,
      turnId: res.turnId,
      role: "user",
      content: text,
      contentVersion: 0,
      status: "done",
      tokensIn: null,
      tokensOut: null,
      createdAt: Date.now(),
    });
    events.replaceMessages(sessions.messages);

    // -----------------------------------------------------------------------
    // 立刻建 pending Turn（P0-04 的硬要求）
    //
    // 不能等 SSE 第一条事件：ZCode 是非流式 CLI，一轮 15–30s 才整段返回，
    // 这期间事件表是空的。只插入用户消息的话，界面 20 秒完全静止 ——
    // 用户无法判断「发出去了吗 / 模型在想吗」。
    //
    // botId 必须是**本轮实际执行的 Bot**：群聊里主持人 ≠ 发言人，拿主持人
    // 会让 pending 的头像和名字都是错的。
    // -----------------------------------------------------------------------
    const ch = channel.value;
    const groupRes = ch?.type === "group" ? (res as GroupSendResponse) : null;
    const pendingBotId =
      groupRes !== null
        ? (groupRes.speakers?.[0]?.botId ?? "")
        : (ch?.participantBotIds[0] ?? "");
    if (pendingBotId.length > 0) {
      const startedAt = Date.now();
      // DM：POST 的 turnId 就是这一轮；群聊：首个发言人的 turnId 要等派发，
      // 先用合成 key 占位，首个新 Turn 出现时让位（见 pendingTurn 的注释）。
      const realTurnId = groupRes !== null ? null : res.turnId;
      // 竞态兜底：极快的运行时可能在 POST 返回前就把首个事件推完了。
      // 此时真实 Turn 已经在流里，再建 pending 就是两个 Turn。
      const alreadyStarted =
        groupRes !== null
          ? events.turnIds().some((id) => {
              if (id === res.turnId) return false;
              if (events.botIdOfTurn(id) !== pendingBotId) return false;
              const first = events.turnEvents(id)[0];
              return first !== undefined && first.createdAt >= sendStartedAt;
            })
          : events.turnEvents(res.turnId).length > 0;
      if (!alreadyStarted) {
        pendingTurn.value = {
          key: realTurnId ?? `pending:${pendingBotId}:${startedAt}`,
          turnId: realTurnId,
          botId: pendingBotId,
          sessionId: res.sessionId,
          startedAt,
          streamingRuntime: runtimeStreams(pendingBotId),
          since: sendStartedAt,
          anchorTurnId: res.turnId,
          cancelTurnId: res.turnId,
        };
      }
    }

    // 记住这次发送落到的 Session：新建会话在发送前没有任何 Session，
    // 不记下来的话 SSE 永远不会建连（见 activeSessionId 的说明）。
    if (res.sessionId) {
      const isNew = !sessions.sessions.some((s) => s.id === res.sessionId);
      if (isNew) {
        sessions.noteSession({
          id: res.sessionId,
          channelId: props.channelId,
          botId: sessions.channel?.participantBotIds[0] ?? "",
          startedAt: Date.now(),
        });
        // 新 Session 先回放一次再建 SSE：既拿到游标（通常是 0），也让
        // `streamEnabled` 放行。await 只多一次很轻的 REST 请求。
        try {
          await replaySession(res.sessionId);
        } catch {
          markReplayed(res.sessionId, 0);
        }
      }
      sentSessionId.value = res.sessionId;
    }

    pinnedToBottom.value = true;
    scrollToBottomSoon();
    if (res.queued) ui.toast(`已排队 · 前面还有 ${res.position ?? 0} 个`);
    // 群聊：主持人可能已经降级并写了系统提示（REST 才有），补拉一次让「为什么没人说话」可见
    if (channel.value?.type === "group") {
      window.setTimeout(() => void refreshMessages(), 1200);
      window.setTimeout(() => void refreshMessages(), 6000);
    }
    return true;
  } catch (err) {
    if (isMissingEndpoint(err)) {
      ui.toast("发送接口尚未接入（M4）· 消息未发送");
      // 把文本还回输入框，避免用户白打一遍
      composer.value?.fill(text);
    } else {
      // POST 非 2xx：服务端没有这条消息，用户消息只能本地标失败。
      // 红条 + 重发由 rows 里的 fail 行渲染（见 FailedRow）。
      const reason = sendFailureText(err);
      failedSends.value = [
        ...failedSends.value,
        { id: `fail-${Date.now()}-${failedSends.value.length}`, text, reason, ts: Date.now() },
      ];
      ui.toast(`发送失败：${reason}`);
      pinnedToBottom.value = true;
      scrollToBottomSoon();
    }
    return false;
  } finally {
    sending.value = false;
  }
}

/** POST 失败的人话原因：优先服务端 `message`（如 worktree_not_ready 的具体原因）。 */
function sendFailureText(err: unknown): string {
  if (err instanceof ApiError) {
    const fromBody = err.bodyMessage;
    if (fromBody) return fromBody;
    switch (err.code) {
      case "runtime_unavailable":
        return "这个 Bot 绑定的运行时当前不可用（未安装或健康检查失败）。";
      case "no_bot_in_channel":
        return "这个会话里没有可回复的 Bot。";
      case "channel_not_found":
        return "会话不存在，可能已被删除。";
      case "text_required":
        return "消息内容不能为空。";
      default:
        return `发送失败（${err.code}）`;
    }
  }
  return err instanceof Error ? err.message : "发送失败";
}

/** 失败行上的「重发」：删掉失败记录，用同一段原文再走一次主发送路径。 */
async function resendFailed(id: string): Promise<void> {
  const row = failedSends.value.find((f) => f.id === id);
  if (!row) return;
  failedSends.value = failedSends.value.filter((f) => f.id !== id);
  await sendText(row.text);
}

async function onSend(text: string, mentionBotIds: string[] = []): Promise<void> {
  await sendText(text, mentionBotIds);
}

/** 这个 Turn 属于哪个 Session（群聊里 cancel 必须打到正确的 Session 上）。 */
function sessionOfTurn(turnId: string): string | null {
  // 事件自带的 sessionId 最可靠：群聊里发言人的 Session 可能还没进 sessions 列表
  const first = events.turnEvents(turnId)[0];
  if (first) return first.sessionId;
  const row = sessions.messages.find((m) => m.turnId === turnId);
  return row?.sessionId ?? activeSessionId.value;
}

async function stopTurnById(turnId: string): Promise<void> {
  // pending 的合成 key 不是真实 turnId：取消要用 POST 返回的锚点 turnId
  const pending = pendingTurn.value;
  const isPending = pending !== null && pending.key === turnId;
  const realTurnId = isPending ? pending.cancelTurnId : turnId;
  const sid = isPending ? pending.sessionId : sessionOfTurn(turnId);
  if (!sid) return;
  try {
    await api.cancelTurn(sid, realTurnId);
    ui.toast("已中断这一轮 · 已生成内容保留");
  } catch (err) {
    if (isMissingEndpoint(err)) ui.toast("中断接口尚未接入（M4）");
    else ui.toast("中断失败，请稍后再试");
  }
}

async function onStop(): Promise<void> {
  const turn = streamingTurn.value;
  if (!turn) return;
  await stopTurnById(turn.turnId);
}

function onStopTurn(turnId: string): void {
  void stopTurnById(turnId);
}

/**
 * 重发（P0-04）：**以上一条用户消息原文新建一轮**，原轮次不覆盖。
 *
 * 之前只把原文填进输入框（`composer.fill`），用户还要再按一次发送 ——
 * PRD 要求的是直接新建一轮。这里复用主发送路径，原 Turn 完全不动。
 */
async function onResend(_turnId?: string): Promise<void> {
  const lastUser = [...sessions.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    ui.toast("这个会话里还没有可重发的用户消息");
    return;
  }
  const ok = await sendText(lastUser.content);
  if (ok) ui.toast("已按上一条消息原文重发");
}

/** 空名单 / 主持人块里的「指定 Bot 回复」：打开 composer 的 @ 选择器。 */
function openBotPicker(): void {
  composer.value?.openBotPicker();
}

// ---------------------------------------------------------------------------
// 30s 无事件 → 「无响应」（P0-05）
// ---------------------------------------------------------------------------
/**
 * 计时基准是「最后一条真实事件」而不是心跳：服务端每 15s 发 `: ping`，
 * 但心跳只说明连接活着，不代表运行时在产出。有人产出就消失，Turn 收口时清计时器。
 */
const nowMs = ref(Date.now());
let stallTimer: number | null = null;

const hasStreamingTurn = computed(() =>
  turnViews.value.some((t) => t.status === "streaming" || t.status === "pending"),
);

function startStallClock(): void {
  if (stallTimer !== null) return;
  nowMs.value = Date.now();
  stallTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
}

function stopStallClock(): void {
  if (stallTimer === null) return;
  window.clearInterval(stallTimer);
  stallTimer = null;
}

watch(
  hasStreamingTurn,
  (active) => {
    if (active) startStallClock();
    else stopStallClock();
  },
  { immediate: true },
);

const STALL_MS = 30_000;

const stalledTurnIds = computed<Set<string>>(() => {
  const set = new Set<string>();
  const now = nowMs.value;
  for (const t of turnViews.value) {
    // pending 同样适用：POST 成功但 30s 内没有任何事件 → 「无响应」+ 停止
    if (t.status !== "streaming" && t.status !== "pending") continue;
    if (now - t.lastEventAt >= STALL_MS) set.add(t.turnId);
  }
  return set;
});

// ---------------------------------------------------------------------------
// 转为任务（F3：任意消息悬停 →「转为任务」）
// ---------------------------------------------------------------------------
const assignOpen = ref(false);
const assignBusy = ref(false);
const assignError = ref("");
const assignForm = ref({
  title: "",
  deliverable: "一段可直接贴进周报的结论，附每条结论的出处。",
  botId: "",
});

/** 从消息文本预填标题（取首句，最多 28 字 —— 与原型一致）。 */
function openAssignFrom(text: string): void {
  const firstLine = text.split(/[。\n]/)[0]?.trim() ?? text.trim();
  const title = firstLine.length > 28 ? `${firstLine.slice(0, 28)}…` : firstLine;
  assignForm.value = {
    title: title || "整理这条消息里的结论",
    deliverable: "一段可直接贴进周报的结论，附每条结论的出处。",
    botId: primaryBot.value?.id ?? bots.bots[0]?.id ?? "",
  };
  assignError.value = "";
  assignOpen.value = true;
}

async function submitAssignment(): Promise<void> {
  if (assignBusy.value) return;
  const f = assignForm.value;
  if (f.title.trim().length === 0) {
    assignError.value = "标题不能为空。";
    return;
  }
  if (f.deliverable.trim().length === 0) {
    assignError.value = "交付物描述不能为空。";
    return;
  }
  if (!f.botId) {
    assignError.value = "先选一个 Bot。";
    return;
  }
  assignBusy.value = true;
  assignError.value = "";
  try {
    const res = await api.createAssignment({
      channelId: props.channelId,
      title: f.title.trim(),
      deliverable: f.deliverable.trim(),
      botId: f.botId,
    });
    assignOpen.value = false;
    ui.toast(`已排队 · ${bots.findBot(f.botId)?.name ?? "Bot"} · 0s`);
    void router.push(`/assignments/${res.assignment.id}`);
  } catch (err) {
    if (err instanceof ApiError && err.code === "queue_full") {
      const limit = (err.body as { queueLimit?: number } | undefined)?.queueLimit ?? 5;
      assignError.value = `这个 Bot 的任务队列已满（上限 ${limit}）。等前面的任务结束再提交。`;
      return;
    }
    assignError.value =
      err instanceof ApiError ? (err.messageText() ?? `提交失败（${err.code}）`) : "提交失败，请重试。";
  } finally {
    assignBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 权限决策
// ---------------------------------------------------------------------------
async function onDecide(
  requestId: string,
  decision: "approve" | "reject" | "remember" | "forever",
): Promise<void> {
  const map = {
    approve: "approve",
    reject: "reject",
    remember: "remember_session",
    forever: "remember_bot",
  } as const;
  try {
    await api.decidePermission(requestId, map[decision]);
    const text =
      decision === "approve"
        ? "已批准 · 你"
        : decision === "reject"
          ? "已拒绝 · 你"
          : decision === "remember"
            ? "已批准 · 记住本会话"
            : "已批准 · 记住本 Bot";
    permissions.markDecided(requestId, text);
    ui.toast(text);
  } catch (err) {
    if (isMissingEndpoint(err)) {
      // 端点未落地：本地转已决，至少不把输入框永远锁着
      permissions.markDecided(requestId, decision === "reject" ? "已拒绝 · 你" : "已批准 · 你");
      ui.toast("决策接口尚未接入（M6）· 已本地标记");
    } else {
      ui.toast("决策提交失败");
    }
  }
}

// 快捷键（UX §8）：只在有阻断卡时生效，卡片上有 kbd 标注
useHotkeys({
  a: () => {
    const first = blocking.value[0];
    if (!first) return false;
    void onDecide(first.requestId, "approve");
  },
  "shift+a": () => {
    const first = blocking.value[0];
    if (!first) return false;
    void onDecide(first.requestId, "remember");
  },
  "ctrl+shift+a": () => {
    const first = blocking.value[0];
    if (!first) return false;
    void onDecide(first.requestId, "forever");
  },
  r: () => {
    const first = blocking.value[0];
    if (!first) return false;
    void onDecide(first.requestId, "reject");
  },
  f6: () => {
    const card = streamEl.value?.querySelector<HTMLElement>(".perm");
    if (!card) return false;
    card.scrollIntoView({ block: "center" });
    card.focus();
  },
});

// ---------------------------------------------------------------------------
// 渠道头 / 右面板
// ---------------------------------------------------------------------------
const participants = computed(() => {
  const ch = channel.value;
  if (!ch) return [];
  return ch.participantBotIds
    .map((id) => bots.findBot(id))
    .filter((b): b is NonNullable<typeof b> => b !== undefined);
});

const hostBot = computed(() => {
  const id = channel.value?.hostBotId;
  return id ? (bots.findBot(id) ?? null) : null;
});

const isGroup = computed(() => channel.value?.type === "group");
const primaryBot = computed(() => participants.value[0] ?? null);

const runtimeName = computed(() => primaryBot.value?.runtime?.displayName ?? "未绑定运行时");

/** 能力提示条：非流式运行时（UX §4.4）。 */
const capabilityTip = computed(() => {
  const rt = primaryBot.value?.runtime;
  if (!rt?.capabilities) return "";
  if (rt.capabilities.streaming === false) {
    return `${rt.displayName} 一次返回完整结果，期间不会显示中间过程（预计 30–60s）。`;
  }
  return "";
});

/** 右面板：Session 状态（由最近的 divider 推断）。 */
const sessionState = computed(() => {
  const last = dividers.value[dividers.value.length - 1];
  if (!last) return "已续接上下文";
  return /新 Session|重建/.test(last.text) ? "新 Session · 已重建" : "已续接上下文";
});

const memChars = 0;
const memCap = 6000;

const exampleQuestions = [
  "这版发布计划有什么风险？",
  "把结论整理成一段可以直接贴进周报的话",
  "这三家里谁的免费额度收紧得最狠？",
];

function fillPrompt(q: string): void {
  composer.value?.fill(q);
}

const asideOpenClass = computed(() => ({
  "is-open": ui.asideOpen,
}));

const chatCollapsedClass = computed(() => ({ "is-aside-collapsed": ui.asideCollapsed }));

function onToggleAside(): void {
  ui.toggleAside();
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
onMounted(async () => {
  ui.setCrumb([{ text: "会话", to: "/chats" }]);
  await loadChannel();
  // 渠道名补到面包屑
  if (channel.value) {
    ui.setCrumb([{ text: "会话", to: "/chats" }, { text: channel.value.name }]);
  }
  document.body.classList.add("is-chat");
  window.addEventListener("resize", markStuck, { passive: true });
});

onBeforeUnmount(() => {
  loadAbort?.abort();
  document.body.classList.remove("is-chat");
  window.removeEventListener("resize", markStuck);
  stopStallClock();
  closeExtraStreams();
  pendingTurn.value = null;
  sessions.reset();
  events.reset();
  permissions.reset();
});

// 渠道切换（同组件复用时）
watch(
  () => props.channelId,
  async (next, prev) => {
    if (next === prev) return;
    await loadChannel();
    if (channel.value) {
      ui.setCrumb([{ text: "会话", to: "/chats" }, { text: channel.value.name }]);
    }
  },
);

// 会话头变化后刷新吸顶判定
watch([status, connection], () => nextTick(markStuck));

// 这些绑定只在模板里用（SFC 模板引用不让 TS 认为已使用），保留显式 void 以免误删。
void sse;
void botVars;
void AppIcon;
void BotAvatar;
void allPermissions;
</script>

<template>
  <!-- 渠道不存在：明确「没有这个会话」，不复用空态引导（它说的不是同一件事） -->
  <div v-if="channelMissing" style="padding: var(--space-5) var(--space-7)">
    <EmptyState title="没有这个会话" description="它可能已被删除，或者链接里的渠道 id 不对。">
      <template #icon>
        <AppIcon name="chats" :size="24" />
      </template>
      <template #actions>
        <RouterLink class="btn btn--secondary" to="/bots">返回 Bot 列表</RouterLink>
      </template>
    </EmptyState>
  </div>

  <div v-else class="chat" :class="chatCollapsedClass">
    <div class="chat-main">
      <!-- 会话头：群聊 = 参与者头像行 + 主持人；单聊 = Bot 名 + 运行时 + 执行位置 -->
      <div class="chat-head">
        <span v-if="isGroup" class="av-stack">
          <BotAvatar
            v-for="p in participants.slice(0, 4)"
            :key="p.id"
            :name="p.name"
            :color-index="p.colorIndex"
            :avatar="p.avatar"
            :size="32"
            :state="p.state"
          />
        </span>
        <BotAvatar
          v-else-if="primaryBot"
          :name="primaryBot.name"
          :color-index="primaryBot.colorIndex"
          :avatar="primaryBot.avatar"
          :size="40"
          :state="primaryBot.state"
        />

        <div style="min-width: 0">
          <div class="chat-title">{{ channel?.name || "会话" }}</div>
          <div class="chat-meta">
            <template v-if="isGroup">
              <span>
                主持人：<b style="color: var(--color-text-secondary)">{{ hostBot?.name ?? "未指定" }}</b>
              </span>
              <button class="btn btn--sm btn--ghost" style="height: 22px; padding: 0 6px">更换</button>
              <span class="u-faint">|</span>
              <span>{{ participants.length }} 个参与者</span>
            </template>
            <template v-else-if="primaryBot">
              <span class="rt-chip">
                {{ primaryBot.runtime?.displayName ?? "未绑定" }}<template v-if="primaryBot.runtime"> · {{ primaryBot.runtime.protocol }}</template>
              </span>
              <span class="u-mono" style="color: var(--color-text-muted)">
                {{ primaryBot.executionLocation }} {{ primaryBot.effectivePath ?? "—" }}
              </span>
            </template>
          </div>
        </div>

        <div class="spacer" />
        <button
          class="btn btn--sm btn--ghost"
          aria-controls="aside"
          :aria-expanded="ui.asideCollapsed ? 'false' : 'true'"
          @click="onToggleAside"
        >
          {{ ui.asideCollapsed ? "展开上下文" : "上下文" }}
        </button>
      </div>

      <!-- 能力提示条（非流式运行时） -->
      <div v-if="capabilityTip" class="banner banner--info" style="margin: 8px var(--space-7) 0">
        {{ capabilityTip }}
      </div>

      <!-- 断线横幅（UX §4.4 错误态：不整页报错，只提示重连） -->
      <div
        v-if="connection === 'reconnecting'"
        class="banner"
        style="margin: 8px var(--space-7) 0"
      >
        <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
        <span>和本地服务的连接断开了，正在重连。已收到的内容不会丢。</span>
        <span class="spacer" />
        <button class="btn btn--sm" @click="sse.restart()">手动重连</button>
      </div>

      <!-- 会话整体错误（REST 失败且不是端点缺失） -->
      <div v-if="status === 'error'" class="banner" style="margin: 8px var(--space-7) 0">
        <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
        <span>读取会话失败{{ errorText ? `：${errorText}` : "。" }}</span>
        <span class="spacer" />
        <button class="btn btn--sm" @click="loadChannel()">重试</button>
      </div>

      <!-- 消息流 -->
      <div ref="streamEl" class="stream" @scroll.passive="onScroll">
        <div class="stream-inner">
          <!-- 加载态：顶部骨架，已加载部分可滚 -->
          <template v-if="status === 'loading' || status === 'idle'">
            <div style="display: grid; gap: 14px; padding-top: 16px">
              <div v-for="w in ['70%', '88%', '52%', '76%']" :key="w" class="sk" :style="{ height: '16px', width: w }" />
            </div>
          </template>

          <!-- 空态：Bot 人格 + 3 条示例提问 -->
          <template v-else-if="rows.length === 0">
            <EmptyState
              :title="primaryBot?.name || channel?.name || '开始对话'"
              :description="primaryBot?.persona ? `${primaryBot.persona}${isGroup ? '主持人会决定这一轮谁来回答。' : ''}` : '发第一条消息开始。'"
              style="margin-top: 8px"
            >
              <template #icon>
                <AppIcon name="chats" :size="24" />
              </template>
              <template #actions>
                <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 460px">
                  <button
                    v-for="q in exampleQuestions"
                    :key="q"
                    class="btn btn--secondary"
                    style="justify-content: flex-start; text-align: left"
                    @click="fillPrompt(q)"
                  >{{ q }}</button>
                </div>
              </template>
            </EmptyState>
          </template>

          <!-- 正常态 -->
          <template v-else>
            <!-- 虚拟化：长会话只渲染可视区 -->
            <div
              v-if="virtualEnabled"
              :style="{ height: `${virtual.totalSize.value}px`, position: 'relative', width: '100%' }"
            >
              <div
                v-for="entry in visibleRows"
                :key="entry.row.key"
                :ref="(el) => entry.start !== undefined && virtual.virtualizer.value.measureElement(el as Element)"
                :data-index="entry.index"
                :style="{
                  position: 'absolute',
                  /* 用 top 而不是 transform: translateY() 定位行。
                     transform 会给后代创建包含块，把 `.turn-head` 的
                     `position: sticky` 关在这一行里 —— 实测滚动到底时
                     最后一条 Turn 的头会跑到正文下方 174px（头部与气泡倒序）。
                     top 定位没有这个副作用，代价是少一点合成层优化。 */
                  top: `${entry.start ?? 0}px`,
                  left: 0,
                  width: '100%',
                }"
              >
                <!-- 发送失败（POST 非 2xx）：用户气泡 + 红条 + 重发 -->
                <div v-if="failedRowOf(entry.row)" class="msg msg--user">
                  <div class="msg-col">
                    <div class="bubble bubble--user">{{ failedRowOf(entry.row)?.failText }}</div>
                    <div class="err-block" role="alert">
                      <div class="err-msg">发送失败：{{ failedRowOf(entry.row)?.failReason }}</div>
                      <div class="err-actions">
                        <button class="btn btn--sm" @click="resendFailed(entry.row.key)">重发</button>
                      </div>
                    </div>
                  </div>
                  <span class="av av--32 av--user" aria-hidden="true">你</span>
                </div>
                <StreamRowItem
                  v-else
                  :row="asStreamRow(entry.row)"
                  :bots="bots.bots"
                  :permissions="allPermissions"
                  :collapsed="entry.row.turn ? isCollapsed(entry.row.turn) : false"
                  :host-decision="entry.row.turn ? (hostDecisions.get(entry.row.turn.turnId) ?? null) : null"
                  :host-raw="entry.row.turn ? hostRawTurnIds.has(entry.row.turn.turnId) : false"
                  :stalled="entry.row.turn ? stalledTurnIds.has(entry.row.turn.turnId) : false"
                  :max-speakers="MAX_SPEAKERS"
                  @toggle="toggleTurn"
                  @decide="onDecide"
                  @go-boundary="(id) => router.push(`/bots/${id}`)"
                  @resend="onResend"
                  @to-assignment="openAssignFrom"
                  @takeover="onTakeover"
                  @stop-turn="onStopTurn"
                  @pick-bot="openBotPicker"
                />
              </div>
            </div>

            <!-- 短会话：直接全渲染（避免测量抖动） -->
            <template v-else>
              <template v-for="entry in visibleRows" :key="entry.row.key">
                <!-- 发送失败（POST 非 2xx）：用户气泡 + 红条 + 重发 -->
                <div v-if="failedRowOf(entry.row)" class="msg msg--user">
                  <div class="msg-col">
                    <div class="bubble bubble--user">{{ failedRowOf(entry.row)?.failText }}</div>
                    <div class="err-block" role="alert">
                      <div class="err-msg">发送失败：{{ failedRowOf(entry.row)?.failReason }}</div>
                      <div class="err-actions">
                        <button class="btn btn--sm" @click="resendFailed(entry.row.key)">重发</button>
                      </div>
                    </div>
                  </div>
                  <span class="av av--32 av--user" aria-hidden="true">你</span>
                </div>
                <StreamRowItem
                  v-else
                  :row="asStreamRow(entry.row)"
                  :bots="bots.bots"
                  :permissions="allPermissions"
                  :collapsed="entry.row.turn ? isCollapsed(entry.row.turn) : false"
                  :host-decision="entry.row.turn ? (hostDecisions.get(entry.row.turn.turnId) ?? null) : null"
                  :host-raw="entry.row.turn ? hostRawTurnIds.has(entry.row.turn.turnId) : false"
                  :stalled="entry.row.turn ? stalledTurnIds.has(entry.row.turn.turnId) : false"
                  :max-speakers="MAX_SPEAKERS"
                  @toggle="toggleTurn"
                  @decide="onDecide"
                  @go-boundary="(id) => router.push(`/bots/${id}`)"
                  @resend="onResend"
                  @to-assignment="openAssignFrom"
                  @takeover="onTakeover"
                  @stop-turn="onStopTurn"
                  @pick-bot="openBotPicker"
                />
              </template>
            </template>

            <!-- 阻断型权限卡：流尾吸附在输入框上方（原型 .turn--perm-block）。
                 一次只吸附最老的一张，其余排队等它被处置 —— 同时钉多张会盖住整屏。 -->
            <PermissionBlock
              v-if="blockingPermission"
              :perm="blockingPermission"
              :bot="bots.findBot(blockingPermission.botId) ?? null"
              :runtime-name="bots.findBot(blockingPermission.botId)?.runtime?.displayName ?? '未绑定'"
              @decide="onDecide"
              @go-boundary="(id) => router.push(`/bots/${id}`)"
            />
          </template>
        </div>
      </div>

      <Composer
        ref="composer"
        :placeholder="placeholder"
        :streaming="streamingTurn !== null"
        :locked="composerLocked"
        :disabled="composerDisabled"
        :bots="participants"
        :mention-enabled="isGroup"
        :meta-left="isGroup ? '主持人会先决定谁来说' : `运行时 ${runtimeName}`"
        :meta-right="`≈ ${num(memChars)} / ${num(memCap)} 字符注入`"
        @send="onSend"
        @stop="onStop"
      />
    </div>

    <!-- 右面板遮罩（<1280 抽屉） -->
    <div class="aside-scrim" :class="asideOpenClass" aria-hidden="true" @click="ui.closeAside()" />

    <!-- 右面板 -->
    <aside class="aside" id="aside" :class="asideOpenClass" aria-label="上下文面板">
      <div class="aside-drawer-head">
        <span class="u-label">上下文</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="关闭上下文面板" @click="ui.closeAside()">
          <AppIcon name="close" :size="14" />
        </button>
      </div>

      <div class="aside-sec">
        <h4>参与者与运行时</h4>
        <div
          v-for="p in participants"
          :key="p.id"
          class="person"
          :style="botVars(p)"
        >
          <BotAvatar :name="p.name" :color-index="p.colorIndex" :avatar="p.avatar" :size="24" :state="p.state" />
          <span class="person-name">
            {{ p.name }}<template v-if="isGroup && p.id === hostBot?.id"> <span class="u-label">主持</span></template>
          </span>
          <span class="rt-chip">{{ p.runtime?.displayName ?? "未绑定" }}</span>
        </div>
        <p v-if="participants.length === 0" style="font-size: 11px; color: var(--color-text-muted)">
          还没有参与者（渠道端点接入后显示）
        </p>
      </div>

      <div class="aside-sec">
        <h4>当前 Session</h4>
        <div class="kv"><span class="k">状态</span><span class="v">{{ sessionState }}</span></div>
        <div class="kv">
          <span class="k">开始</span>
          <span class="v">{{ currentSession ? clockTime(currentSession.startedAt) : "—" }}</span>
        </div>
        <div class="kv">
          <span class="k">执行位置</span>
          <span class="v">{{ primaryBot?.executionLocation ?? "—" }} {{ primaryBot?.effectivePath ?? "" }}</span>
        </div>
      </div>

      <div class="aside-sec">
        <h4>记忆</h4>
        <div class="kv"><span class="k">注入</span><span class="v">{{ num(memChars) }} 字符 / {{ num(memCap) }}</span></div>
        <div class="kv"><span class="k">截断</span><span class="v">—</span></div>
      </div>

      <div class="aside-sec">
        <h4>边界</h4>
        <div class="kv"><span class="k">目录</span><span class="v">只读 · 写需批准</span></div>
        <div class="kv"><span class="k">Shell</span><span class="v">不允许</span></div>
        <div class="kv"><span class="k">联网</span><span class="v">允许</span></div>
      </div>

      <div class="aside-sec">
        <h4>最近任务</h4>
        <p style="font-size: 11px; color: var(--color-text-muted)">这个会话还没有任务</p>
      </div>

      <p v-if="endpointMissing" class="hint" style="margin-top: 16px">
        渠道与会话端点将在 M4/M5 接入；当前页面已连上事件流，等待真实数据。
      </p>
    </aside>

    <!-- 转为任务（F3-1：任意消息悬停 →「转为任务」） -->
    <AppModal v-model:open="assignOpen" title="转为任务">
      <div class="field">
        <label class="u-label" for="ca-title">标题</label>
        <input id="ca-title" v-model="assignForm.title" class="input" />
      </div>
      <div class="field">
        <label class="u-label" for="ca-deliverable">交付物</label>
        <textarea id="ca-deliverable" v-model="assignForm.deliverable" class="textarea" rows="2" />
      </div>
      <div class="field">
        <label class="u-label" for="ca-bot">指派 Bot</label>
        <select id="ca-bot" v-model="assignForm.botId" class="select">
          <option v-for="b in (participants.length > 0 ? participants : bots.bots)" :key="b.id" :value="b.id">
            {{ b.name }}（{{ b.runtime?.displayName ?? "未绑定" }}）
          </option>
        </select>
      </div>
      <p class="hint">
        执行位置继承自 Bot{{ primaryBot?.effectivePath ? `（${primaryBot.executionLocation} ${primaryBot.effectivePath}）` : "" }}。
        执行不占用输入框，你可以继续聊天。
      </p>
      <div v-if="assignError" class="field-err" role="alert">{{ assignError }}</div>
      <template #footer>
        <button class="btn btn--secondary" @click="assignOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="assignBusy" @click="submitAssignment">
          {{ assignBusy ? "提交中…" : "提交" }}
        </button>
      </template>
    </AppModal>
  </div>
</template>
