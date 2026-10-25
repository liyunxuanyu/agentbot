<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { BotDto } from "../../net/types";
import type { TurnItem as TurnItemModel, TurnView } from "../../lib/turnModel";
import type { PermissionView } from "../../stores/permissions";
import { botVars } from "../../lib/botVars";
import BotAvatar from "../bot/BotAvatar.vue";
import BotStateChip from "../bot/BotStateChip.vue";
import TurnBodyItem from "./TurnBodyItem.vue";

/**
 * 一个 Turn（原型 turnHtml()，UI §7「Turn 头」+ §8.2「身份三重锚」）。
 *
 * 结构：
 *   .turn
 *     .turn-head（sticky，3px 身份左轨 + 24 头像 + 名字 + 运行时胶囊 + 模式 + 右侧状态）
 *     .turn-body（消息气泡 + 事件折叠块 + 权限卡）
 *
 * 三条关键行为：
 *   ① 身份三重锚：Turn 头吸顶（.is-stuck 时加 raise 阴影）、气泡 3px 左轨、
 *      头像右下状态角标 —— 滚到任何位置都能回答「这是谁」。
 *   ② 已折叠：完成的 Turn 默认收起（只留头部一行）；生成中/待批保持展开。
 *      折叠态**不渲染 body**（不是 display:none）：2000+ 事件的轮次若保留 DOM，
 *      折叠只是「看不见」而不是「不存在」，DOM 依旧有上千个节点（critic 实测 1103）。
 *   ③ 已中断：头部灰化、正文保留（用户可能还要读它），尾部一句说明。
 *
 * 性能（P0-05 边界「单轮事件 >2000 条」）：
 *   展开态的事件列表走 `@tanstack/vue-virtual`，只渲染可视区 ±50 条。
 *   Turn 体自己成为滚动容器（`.turn-body--virtual` 有 max-height），
 *   因为整页滚动下没法把虚拟列表的滚动锚点挂在 `.stream` 上（会和外层 Turn
 *   虚拟化互相测量）。折叠态只渲染摘要行，不做虚拟化。
 *
 * 权限卡的位置：阻断型插在流尾并 sticky 到输入框上方（由 ChatPage 用
 * `.turn--perm-block` 包一层实现），这里只负责把卡片画在该 Turn 的 body 里。
 */
const props = withDefaults(
  defineProps<{
    turn: TurnView;
    bot: BotDto | null;
    /** 是否已折叠（由父组件管理，实现「单展开」）。 */
    collapsed?: boolean;
    /** 待批权限（按 requestId 排序后传给本 Turn 的那几条）。 */
    permissions?: PermissionView[];
    /** 运行时名（Turn 头胶囊）。 */
    runtimeName: string;
    /** 模式文案：交互 / 非流式。 */
    mode: string;
    /**
     * 群聊主持人决策（F2-2）：有值时把气泡替换成「本轮发言人」系统块。
     *
     * 主持人那一轮的助手消息正文就是它返回的 JSON；直接当气泡渲染，用户会看到一坨
     * `{"speakers":[…]}`。这里按 UX 规格渲染成：每位发言人一行（名字 + 理由）+
     * 块尾 `本轮调用 N/3`。`rawMessageIds` 里的消息不再画成普通气泡。
     */
    hostDecision?: {
      speakers: { botId: string; reason: string }[];
      skipReason: string;
      rawMessageIds?: string[];
    } | null;
    /**
     * 主持人回复像 JSON 但解析不出 `speakers`（围栏/寒暄/坏 JSON）：
     * 不显示原始 JSON 气泡，折叠成一行说明。
     */
    hostRaw?: boolean;
    /** P0-05：连续 30s 无事件且未结束 → 头部 warning chip + 停止。 */
    stalled?: boolean;
    /** 单轮发言人上限（块尾 `N/3` 的分母）。 */
    maxSpeakers?: number;
    /** 全部 Bot（主持人块里要点名其他 Bot，需要名字与身份色）。 */
    bots?: BotDto[];
  }>(),
  {
    collapsed: false,
    permissions: () => [],
    hostDecision: null,
    hostRaw: false,
    stalled: false,
    maxSpeakers: 3,
    bots: () => [],
  },
);

const emit = defineEmits<{
  toggle: [turnId: string];
  decidePermission: [requestId: string, decision: "approve" | "reject" | "remember" | "forever"];
  goBoundary: [botId: string];
  resend: [turnId: string];
  toAssignment: [text: string];
  stopTurn: [turnId: string];
  pickBot: [];
}>();

const vars = computed(() => (props.bot ? botVars(props.bot) : {}));

/**
 * 发言人名字与身份色。
 *
 * 主持人块里要显示「谁会被叫到」，这些 Bot 可能不是本 Turn 的 bot（主持人 ≠ 发言人），
 * 所以不能复用 `props.bot`。`allBots` 由父组件通过 `bots` 传入 —— 这里用
 * `inject` 会引入隐式依赖，改为从 props 拿（StreamRowItem 已有 bots 数组）。
 */
const allBots = computed<BotDto[]>(() => props.bots ?? []);

function botOf(id: string): BotDto | null {
  return allBots.value.find((b) => b.id === id) ?? null;
}

function botVarsOf(id: string) {
  const b = botOf(id);
  return b ? botVars(b) : {};
}

/** Turn 头右侧：状态 chip + 摘要/时长。 */
const headRight = computed(() => {
  const t = props.turn;
  switch (t.status) {
    case "interrupted":
      return { state: "idle" as const, label: "已中断", extra: "内容保留" };
    case "done":
      return { state: "done" as const, label: "完成", extra: t.summary };
    case "failed":
      return { state: "blocked" as const, label: "失败", extra: elapsed(t) };
    case "waiting":
      return { state: "waiting" as const, label: "排队中", extra: "" };
    case "pending":
      // pending 与 streaming 同样显示「生成中」：用户需要的是「它在处理」，
      // 而不是「连接还没建立」这种实现细节。
      return { state: "working" as const, label: "生成中", extra: elapsed(t) };
    default:
      return { state: "working" as const, label: "生成中", extra: elapsed(t) };
  }
});

/**
 * 秒表。
 *
 * 为什么需要本地时钟：`elapsed()` 原来读 `Date.now()`，但 computed 只在 props
 * 变化时重算。流式 Turn 每帧都有新事件，看起来在走；pending Turn 一条事件都没有，
 * 秒数会永远停在 0 —— 正是「发送后 15–30s 零反馈」的一半原因。
 * 这里只在 pending / streaming 时起 1s 定时器，收口即停，不做全局轮询。
 */
const nowMs = ref(Date.now());
let clockTimer: number | null = null;

function startClock(): void {
  if (clockTimer !== null) return;
  nowMs.value = Date.now();
  clockTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
}

function stopClock(): void {
  if (clockTimer === null) return;
  window.clearInterval(clockTimer);
  clockTimer = null;
}

watch(
  () => props.turn.status,
  (status) => {
    if (status === "pending" || status === "streaming") startClock();
    else stopClock();
  },
  { immediate: true },
);

onBeforeUnmount(stopClock);

function elapsed(t: TurnView): string {
  const end = t.endedAt ?? nowMs.value;
  const ms = Math.max(0, end - t.startedAt);
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** pending Turn 的已等待秒数（每秒随本地时钟重算）。 */
const pendingSeconds = computed(() =>
  Math.max(0, Math.floor((nowMs.value - props.turn.startedAt) / 1000)),
);

/** pending Turn 绑定运行时是否流式；非流式不能画假光标，只能说明「等完整结果」。 */
const pendingStreaming = computed(() => props.turn.pending?.streamingRuntime !== false);

const pendingLine = computed(() =>
  pendingStreaming.value
    ? "正在连接运行时…"
    : `等待运行时返回完整结果 · 已 ${pendingSeconds.value}s`,
);

/**
 * 不渲染成普通气泡的消息：主持人决策的原始 JSON。
 *
 * 只按 messageId 精确排除，而不是「有 hostDecision 就整轮不画消息」——
 * 同一 Turn 里若还有别的助手消息（例如主持人先说了句人话再给 JSON），
 * 那句话仍要保留。
 */
const hiddenMessageIds = computed<Set<string>>(() => {
  const set = new Set<string>(props.hostDecision?.rawMessageIds ?? []);
  if (props.hostRaw) {
    for (const item of props.turn.items) {
      if (item.kind === "message") set.add(item.messageId);
    }
  }
  return set;
});

const visibleItems = computed<TurnItemModel[]>(() =>
  props.turn.items.filter(
    (item) => !(item.kind === "message" && hiddenMessageIds.value.has(item.messageId)),
  ),
);

function itemKey(item: TurnItemModel | undefined, index: number): string {
  if (!item) return `i-${index}`;
  return item.kind === "message" ? `m-${item.messageId}` : `${item.kind}-${item.seq}-${index}`;
}

/** 连续消息判定：相邻两条都是 message 且同属本 Turn 的助手消息。 */
function isCont(index: number): boolean {
  if (index === 0) return false;
  return visibleItems.value[index - 1]?.kind === "message";
}

function hasNextMessage(index: number): boolean {
  return visibleItems.value[index + 1]?.kind === "message";
}

/**
 * 行包装类：把 `.msg + .msg` 的间距规则搬到包装层。
 *
 * 拆出 TurnBodyItem 后每条 item 外面多了一层 `.turn-body__row`，
 * `.msg + .msg` 不再是兄弟选择器。这里补上等价类：
 *   组间 12px = 容器 gap 8 + 4（与原型一致）；连续消息 -4 → 读作一段话。
 */
function rowClass(index: number): Record<string, boolean> {
  const item = visibleItems.value[index];
  if (!item || item.kind !== "message") return {};
  return { "turn-body__row--msg": true, "turn-body__row--cont": isCont(index) };
}

// ---------------------------------------------------------------------------
// 单轮 >2000 事件的虚拟滚动
// ---------------------------------------------------------------------------
/** 展开态的 Turn 体（虚拟滚动容器）。 */
const bodyEl = ref<HTMLElement | null>(null);
/** 用户是否贴着 Turn 体底部（生成中追加时自动跟随）。 */
const bodyPinned = ref(true);

/**
 * 阈值 200 行（不是 2000 事件）：事件在 turnModel 里已合并（tool_result 挂到
 * tool_call 下），2205 条事件 → ~1100 行。按「行」判断才能覆盖真实 DOM 规模；
 * 低于 200 行直接全渲染，避免短轮次出现测量抖动。
 */
const virtualEnabled = computed(() => !props.collapsed && visibleItems.value.length > 200);

const virtualizer = useVirtualizer(
  computed(() => ({
    count: visibleItems.value.length,
    getScrollElement: () => bodyEl.value,
    estimateSize: (index: number) => (visibleItems.value[index]?.kind === "message" ? 96 : 34),
    getItemKey: (index: number) => itemKey(visibleItems.value[index], index),
    overscan: 50,
    enabled: virtualEnabled.value,
  })),
);

interface BodyEntry {
  item: TurnItemModel;
  index: number;
  key: string;
  /** 虚拟化时的绝对定位偏移；短轮次为 undefined。 */
  start?: number;
}

const bodyEntries = computed<BodyEntry[]>(() => {
  if (!virtualEnabled.value) {
    return visibleItems.value.map((item, index) => ({ item, index, key: itemKey(item, index) }));
  }
  const out: BodyEntry[] = [];
  for (const vi of virtualizer.value.getVirtualItems()) {
    const item = visibleItems.value[vi.index];
    if (item) out.push({ item, index: vi.index, key: String(vi.key), start: vi.start });
  }
  return out;
});

const totalSize = computed(() => virtualizer.value.getTotalSize());

function measureVirtualItem(el: unknown): void {
  if (el instanceof Element) virtualizer.value.measureElement(el);
}

function onBodyScroll(): void {
  const el = bodyEl.value;
  if (!el) return;
  bodyPinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// ---------------------------------------------------------------------------
// 消息身份（头像 + 名字）作为折叠入口
// ---------------------------------------------------------------------------
/**
 * Turn 头已经有一份「研 研究助手」，Turn 体内每条消息又重复一次头像与名字。
 * 用户会自然去点它 —— 之前那里是纯展示，点了没有任何反应。
 *
 * 为什么用事件委托而不是包一层可点区域：`.msg` 的 DOM 由 MessageBubble 渲染，
 * 本轮改动不允许碰那个文件。在行包装层判断「点击落点是不是头像/名字」，
 * 既能覆盖两条渲染路径（普通 / 虚拟化），又完全不影响气泡本身的文字选择。
 */
function identityTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest(".msg--bot .av, .msg--bot .msg-name");
}

function onRowClick(e: MouseEvent): void {
  if (!identityTarget(e.target)) return;
  emit("toggle", props.turn.turnId);
}

function onRowKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (!identityTarget(e.target)) return;
  e.preventDefault();
  emit("toggle", props.turn.turnId);
}

/**
 * 给头像/名字补 title、tabindex 与 hover class。
 *
 * 这些属性只能落在 MessageBubble 渲染出来的节点上，而本轮不允许改那个组件；
 * 用 DOM 标注是唯一不越界的做法。Vue 重新 patch 子组件时可能覆盖 class，
 * 所以 `onUpdated` 会再补一次（幂等，代价是每个 Turn 体一次 querySelectorAll，
 * 虚拟化后 DOM 规模有上限）。
 */
function applyIdentityAffordance(): void {
  const root = bodyEl.value;
  if (!root) return;
  const label = props.collapsed ? "展开这一轮" : "折叠这一轮";
  const expanded = String(!props.collapsed);
  for (const msg of root.querySelectorAll<HTMLElement>(".msg--bot")) {
    const avatar = msg.querySelector<HTMLElement>(".av");
    const name = msg.querySelector<HTMLElement>(".msg-name");
    for (const el of [avatar, name]) {
      if (!el) continue;
      el.classList.add("msg-identity--clickable");
      el.setAttribute("title", label);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-expanded", expanded);
      if (el === avatar) {
        // 头像本身是装饰节点（aria-hidden），一旦可聚焦就必须给出可读名称。
        el.removeAttribute("aria-hidden");
        el.setAttribute("aria-label", label);
      }
    }
  }
}

onMounted(() => void nextTick(applyIdentityAffordance));
onUpdated(applyIdentityAffordance);
watch(
  () => [props.collapsed, visibleItems.value.length],
  () => void nextTick(applyIdentityAffordance),
);

// 展开 / 切换虚拟化后重新测量（滚动容器是后挂载的，virtualizer 需要一次 kick）
watch(
  () => [props.collapsed, virtualEnabled.value],
  () => {
    if (!virtualEnabled.value) return;
    void nextTick(() => virtualizer.value.measure());
  },
  { immediate: true },
);

// 新事件追加：只有用户原本就贴底时才跟随，避免打断向上翻阅
watch(
  () => visibleItems.value.length,
  () => {
    if (!virtualEnabled.value || !bodyPinned.value) return;
    void nextTick(() => {
      const el = bodyEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

function onHeadKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    emit("toggle", props.turn.turnId);
  }
}

const stateLabel = computed(() => headRight.value.label);
const hostRawLine = computed(() =>
  props.turn.status === "streaming" ? "主持人正在决定发言人…" : "主持人已完成决策 · 原始 JSON 已折叠",
);

/**
 * 折叠态摘要行（P0-05 性能边界的另一半）：只渲染这一行，不渲染事件列表。
 *
 * 为什么保留 `.turn-body` 而不是把整块摘掉：折叠不是「这几类事件没发生」，
 * 用户展开前就应该知道这一轮里有什么（思考 / 工具 / 计划 / 用量各几条）。
 * 同时 DOM 只有 1 个子节点，2000+ 事件折叠时也不会撑爆。
 */
const collapsedSummary = computed(() => {
  let messages = 0;
  let thoughts = 0;
  let tools = 0;
  let plans = 0;
  let permissions = 0;
  let usages = 0;
  let unknown = 0;
  for (const item of visibleItems.value) {
    switch (item.kind) {
      case "message":
        messages += 1;
        break;
      case "thought":
        thoughts += 1;
        break;
      case "tool_call":
        tools += 1;
        break;
      case "plan":
        plans += 1;
        break;
      case "permission":
        permissions += 1;
        break;
      case "usage":
        usages += 1;
        break;
      case "unknown":
        unknown += 1;
        break;
      default:
        break;
    }
  }
  const parts: string[] = [];
  if (messages > 0) parts.push(`${messages} 条消息`);
  if (thoughts > 0) parts.push(`思考 ${thoughts}`);
  if (tools > 0) parts.push(`工具 ${tools}`);
  if (plans > 0) parts.push(`计划 ${plans}`);
  if (permissions > 0) parts.push(`权限 ${permissions}`);
  if (usages > 0) parts.push(`用量 ${usages}`);
  if (unknown > 0) parts.push(`未知 ${unknown}`);
  // 摘要行先给「它说了什么」，再给计数。
  // 只有计数（「1 条消息 · 用量 1」）等于什么也没说 —— 收起的历史轮次
  // 必须能一眼扫出结论，否则用户只能逐条点开（试用反馈：回答默认折叠后看不见）。
  const preview = (() => {
    for (let i = visibleItems.value.length - 1; i >= 0; i -= 1) {
      const it = visibleItems.value[i];
      if (it?.kind !== "message") continue;
      const text = (it.text ?? "").replace(/\s+/g, " ").trim();
      if (text.length > 0) return text.length > 28 ? `${text.slice(0, 28)}…` : text;
    }
    return "";
  })();
  const counts = parts.length > 0 ? parts.join(" · ") : "已完成";
  return preview.length > 0 ? `${preview} · ${counts}` : counts;
});
</script>

<template>
  <section
    class="turn"
    :class="{
      'is-collapsed': collapsed,
      'is-interrupted': turn.status === 'interrupted',
    }"
    :data-turn="turn.turnId"
    :data-bot="bot?.id"
    :style="vars"
  >
    <header
      class="turn-head"
      tabindex="0"
      role="button"
      :aria-expanded="!collapsed"
      @click="emit('toggle', turn.turnId)"
      @keydown="onHeadKeydown"
    >
      <BotAvatar
        v-if="bot"
        :name="bot.name"
        :color-index="bot.colorIndex"
        :avatar="bot.avatar"
        :size="24"
      />
      <span class="turn-name">{{ bot?.name ?? "未知 Bot" }}</span>
      <span class="rt-chip">{{ runtimeName }}</span>
      <span class="rt-chip turn-mode">{{ mode }}</span>
      <span class="turn-right">
        <!-- P0-05：30s 无事件且未结束 -->
        <span v-if="stalled" class="stall-chip">无响应</span>
        <button
          v-if="stalled"
          class="btn btn--sm btn--ghost turn-stop"
          @click.stop="emit('stopTurn', turn.turnId)"
        >停止</button>
        <BotStateChip :state="headRight.state" :label="stateLabel" />
        <span v-if="headRight.extra" class="turn-sum">{{ headRight.extra }}</span>
        <span class="turn-chev">{{ collapsed ? "›" : "⌄" }}</span>
      </span>
    </header>

    <!-- 折叠态：只渲染摘要行，不渲染事件列表（也不做虚拟化） -->
    <div v-if="collapsed" class="turn-body turn-body--summary">
      <!-- 整行可点：用户点的是「展开查看」四个字，不是 Turn 头。
           与 .turn-head 共用同一个 toggle 事件与键盘行为。 -->
      <div
        class="turn-summary-line turn-summary-line--clickable"
        role="button"
        tabindex="0"
        :aria-expanded="!collapsed"
        :title="collapsed ? '展开这一轮' : '折叠这一轮'"
        @click="emit('toggle', turn.turnId)"
        @keydown="onHeadKeydown"
      >
        <span class="turn-summary-text">{{ collapsedSummary }}</span>
        <span class="spacer" />
        <span class="u-muted">展开查看</span>
      </div>
    </div>

    <!-- 展开态：2000+ 行时 Turn 体自己滚动并虚拟化 -->
    <div
      v-else
      ref="bodyEl"
      class="turn-body turn-body--identity-toggle"
      :class="{ 'turn-body--virtual': virtualEnabled }"
      @scroll.passive="onBodyScroll"
    >
      <!-- pending（P0-04）：POST 已返回、首个 SSE 事件还没到。
           非流式运行时一轮 15–30s，这期间没有任何事件可渲染 ——
           不给一条明确的「在等」文案，用户会以为没发出去。 -->
      <div
        v-if="turn.status === 'pending'"
        class="turn-body__items turn-pending"
        role="status"
        aria-live="polite"
      >
        <div class="wait-line">{{ pendingLine }}</div>
        <div v-if="!pendingStreaming" class="hint" style="margin-top: 0">
          该运行时一次性返回完整结果，期间不会显示中间过程；通常 15–30 秒。
        </div>
      </div>
      <!-- 主持人决策块（F2-2）：替换掉主持人那一轮的 JSON 气泡 -->
      <div v-if="hostDecision" class="sys-block" :style="vars">
        <span class="sys-tag">本轮发言人</span>
        <div class="sys-body">
          <div style="font-size: var(--font-size-caption); color: var(--color-text)">
            {{ hostDecision.speakers.length > 0 ? "主持人决定由下列 Bot 回答" : "本轮无 Bot 发言" }}
          </div>
          <ul v-if="hostDecision.speakers.length > 0" class="sys-list">
            <li
              v-for="s in hostDecision.speakers"
              :key="s.botId"
              :style="botVarsOf(s.botId)"
            >
              <BotAvatar
                v-if="botOf(s.botId)"
                :name="botOf(s.botId)!.name"
                :color-index="botOf(s.botId)!.colorIndex"
                :avatar="botOf(s.botId)!.avatar"
                :size="20"
              />
              <b>{{ botOf(s.botId)?.name ?? "未知 Bot" }}</b>
              <span v-if="s.reason" class="u-muted">— {{ s.reason }}</span>
            </li>
          </ul>
          <div class="sys-foot">
            <span v-if="hostDecision.skipReason">原因：{{ hostDecision.skipReason }}</span>
            <button
              v-if="hostDecision.speakers.length === 0"
              class="btn btn--sm btn--primary"
              @click="emit('pickBot')"
            >指定 Bot 回复</button>
            <span class="spacer" />
            <span>本轮调用 {{ hostDecision.speakers.length }}/{{ maxSpeakers }}</span>
          </div>
        </div>
      </div>

      <!-- 主持人回复是 JSON 但解析失败：一行说明，绝不把原始 JSON 当气泡 -->
      <div v-if="hostRaw && !hostDecision" class="host-raw-line">
        <span class="state-dot" :style="{ '--s': 'var(--color-text-muted)' }" />
        <span>{{ hostRawLine }}</span>
      </div>

      <div
        class="turn-body__items"
        :class="{ 'turn-body__items--virtual': virtualEnabled }"
        :style="virtualEnabled ? { height: `${totalSize}px` } : undefined"
      >
        <div
          v-for="entry in bodyEntries"
          :key="entry.key"
          class="turn-body__row"
          :class="[rowClass(entry.index), { 'turn-body__row--virtual': entry.start !== undefined }]"
          :data-index="entry.index"
          :ref="entry.start !== undefined ? measureVirtualItem : undefined"
          :style="entry.start !== undefined ? { transform: `translateY(${entry.start}px)` } : undefined"
          @click="onRowClick"
          @keydown="onRowKeydown"
        >
          <TurnBodyItem
            :item="entry.item"
            :turn="turn"
            :bot="bot"
            :permissions="permissions"
            :runtime-name="runtimeName"
            :mode="mode"
            :cont="isCont(entry.index)"
            :has-next="hasNextMessage(entry.index)"
            @decide-permission="(id, d) => emit('decidePermission', id, d)"
            @go-boundary="(id) => emit('goBoundary', id)"
            @resend="(id) => emit('resend', id)"
            @to-assignment="(t) => emit('toAssignment', t)"
          />
        </div>
      </div>

      <!-- 已中断尾注 -->
      <div v-if="turn.status === 'interrupted'" class="interrupted-note">
        已中断 · 已向运行时发出 cancel，生成的内容保留在原处。
      </div>
    </div>
  </section>
</template>
