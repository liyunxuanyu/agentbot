<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { BotDto, PermissionMode } from "../../net/types";
import AppIcon from "../common/AppIcon.vue";
import BotAvatar from "../bot/BotAvatar.vue";

/**
 * 输入区（原型 .composer / .comp-meta）。
 *
 * UX §6.1 的硬要求：
 *   - 生成中「停止」按钮替换「发送」，**位置固定不变**（避免误点）；
 *   - 权限卡阻断时锁定：胶囊变 --color-surface-2 底、占位变「等待你批准，无法继续发送」；
 *   - 多行输入最高 160px（原型 max-height: 160px），超出内部滚动；
 *   - 连接断开时禁用但**内容保留**（不清空草稿）。
 *
 * @ 指定 Bot（P0-06「用户 @ 某 Bot 时该 Bot 必被包含且优先」）：
 *   群聊里点左侧 @ 按钮弹出选择浮层（白卡 + overlay 阴影 + 头像 + 名字），
 *   选中项随消息以 `mentionBotIds` 提交；发送后清空选择。
 *
 * 快捷键：Enter 发送、Shift+Enter 换行、Esc 关闭选择器。
 *
 * 权限模式胶囊（R5 / §4.1）：输入区左侧、@ 按钮旁，常显当前档位。
 *   - 四档带说明的下拉；切换立即生效，不二次确认；
 *   - Shift+Tab 在四档间循环（与 ZCode 一致）；
 *   - 非内置引擎禁用并说明「该运行时由 CLI 自身管理权限」；
 *   - 群聊菜单第一项「应用到本群全部 Bot」。
 */
const props = withDefaults(
  defineProps<{
    /** 占位文案（含渠道名）。 */
    placeholder: string;
    /** 生成中：发送键变停止键。 */
    streaming?: boolean;
    /** 权限阻断：锁定输入。 */
    locked?: boolean;
    /** 连接断开：禁用但保留内容。 */
    disabled?: boolean;
    /** 底部右侧的注入量提示（`≈ 1,560 / 6,000 字符注入`）。 */
    metaRight?: string;
    /** 底部左侧的说明（群聊「主持人会先决定谁来说」）。 */
    metaLeft?: string;
    /** 可 @ 的 Bot（群聊参与者）。 */
    bots?: BotDto[];
    /** 是否允许 @ 指定（仅群聊；私聊 @ 不改变目标）。 */
    mentionEnabled?: boolean;
    /** 当前权限模式（会话属性；群聊里是当前展开 Bot 的会话）。 */
    permissionMode?: PermissionMode;
    /** 非内置引擎：胶囊禁用（该运行时由 CLI 自身管理权限）。 */
    permissionDisabled?: boolean;
    /** 禁用原因（tooltip）。 */
    permissionDisabledReason?: string;
    /** 群聊：菜单第一项「应用到本群全部 Bot」。 */
    permissionGroup?: boolean;
    /** 切换请求进行中（避免连点重复提交）。 */
    permissionBusy?: boolean;
  }>(),
  {
    streaming: false,
    locked: false,
    disabled: false,
    metaRight: "",
    metaLeft: "",
    bots: () => [],
    mentionEnabled: false,
    permissionMode: "confirm",
    permissionDisabled: false,
    permissionDisabledReason: "该运行时由 CLI 自身管理权限",
    permissionGroup: false,
    permissionBusy: false,
  },
);

const emit = defineEmits<{
  send: [text: string, mentionBotIds: string[]];
  stop: [];
  "change-permission-mode": [mode: PermissionMode];
  "apply-permission-mode-all": [mode: PermissionMode];
}>();

const text = ref("");
const textarea = ref<HTMLTextAreaElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);

const canSend = computed(
  () => !props.locked && !props.disabled && !props.streaming && text.value.trim().length > 0,
);

const effectivePlaceholder = computed(() =>
  props.locked ? "等待你批准，无法继续发送" : props.placeholder,
);

/** 自适应高度：与原型一致，上限 160px。 */
function autoGrow(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

watch(text, () => nextTick(autoGrow));

// ---------------------------------------------------------------------------
// 权限模式胶囊（R5）
// ---------------------------------------------------------------------------
interface ModeOption {
  key: PermissionMode;
  label: string;
  short: string;
  desc: string;
  /** CSS 变量名（点色）。 */
  dot: string;
}

/** 顺序即 Shift+Tab 的循环顺序：只读 → 确认 → 自动 → 完全访问。 */
const MODES: readonly ModeOption[] = [
  {
    key: "plan",
    label: "计划模式",
    short: "计划",
    desc: "只读：不改文件、不跑命令，先出方案",
    dot: "--color-info",
  },
  {
    key: "confirm",
    label: "变更前确认（默认）",
    short: "确认",
    desc: "写文件、跑命令前都问你",
    dot: "--color-primary",
  },
  {
    key: "auto",
    label: "自动模式",
    short: "自动",
    desc: "边界内的写操作自动批准；越界直接拒绝并说明原因",
    dot: "--color-warning",
  },
  {
    key: "full",
    label: "完全访问",
    short: "完全",
    desc: "不再询问，所有动作直接执行并记审计",
    dot: "--color-danger",
  },
];

const modeMenuOpen = ref(false);

const currentMode = computed<ModeOption>(
  () => MODES.find((m) => m.key === props.permissionMode) ?? MODES[1]!,
);

const modeTitle = computed(() =>
  props.permissionDisabled
    ? props.permissionDisabledReason
    : `权限模式：${currentMode.value.label} · Shift+Tab 切换`,
);

function toggleModeMenu(): void {
  if (props.permissionDisabled || props.permissionBusy) return;
  modeMenuOpen.value = !modeMenuOpen.value;
}

function chooseMode(mode: PermissionMode): void {
  modeMenuOpen.value = false;
  if (mode === props.permissionMode) return;
  emit("change-permission-mode", mode);
}

function applyModeToAll(): void {
  modeMenuOpen.value = false;
  emit("apply-permission-mode-all", props.permissionMode);
}

/** Shift+Tab 循环四档（与 ZCode 一致）；禁用时不劫持键盘。 */
function cycleMode(backward: boolean): void {
  if (props.permissionDisabled || props.permissionBusy) return;
  const index = MODES.findIndex((m) => m.key === props.permissionMode);
  const next = MODES[(index + (backward ? -1 : 1) + MODES.length) % MODES.length]!;
  emit("change-permission-mode", next.key);
}

function onRootKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    pickerOpen.value = false;
    modeMenuOpen.value = false;
    return;
  }
  if (e.key === "Tab" && e.shiftKey) {
    // 只在权限控件可用时接管；否则保留浏览器默认的反向焦点切换
    if (props.permissionDisabled) return;
    e.preventDefault();
    cycleMode(true);
  }
}

// ---------------------------------------------------------------------------
// @ 选择器
// ---------------------------------------------------------------------------
const pickerOpen = ref(false);
const selected = ref<string[]>([]);

/** 切换会话（Composer 实例复用）时清掉上一个群的选择，避免选到已不在群里的 Bot。 */
watch(
  () => props.mentionEnabled,
  (enabled) => {
    if (enabled) return;
    pickerOpen.value = false;
    selected.value = [];
  },
);

watch(
  () => props.bots.map((b) => b.id).join(","),
  () => {
    const known = new Set(props.bots.map((b) => b.id));
    selected.value = selected.value.filter((id) => known.has(id));
    if (!props.mentionEnabled) pickerOpen.value = false;
  },
);

function togglePicker(): void {
  if (!props.mentionEnabled) return;
  pickerOpen.value = !pickerOpen.value;
}

function openBotPicker(): void {
  if (!props.mentionEnabled) return;
  pickerOpen.value = true;
}

function toggleMention(botId: string): void {
  selected.value = selected.value.includes(botId)
    ? selected.value.filter((id) => id !== botId)
    : [...selected.value, botId];
}

function isSelected(botId: string): boolean {
  return selected.value.includes(botId);
}

/** 点击外部关闭：只在打开时挂监听，避免每次点击都走一遍 contains。 */
function onDocPointerDown(e: PointerEvent): void {
  if (!pickerOpen.value && !modeMenuOpen.value) return;
  const root = rootEl.value;
  if (root && !root.contains(e.target as Node)) {
    pickerOpen.value = false;
    modeMenuOpen.value = false;
  }
}

onMounted(() => document.addEventListener("pointerdown", onDocPointerDown, true));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointerDown, true));

/**
 * 把输入区实际高度写成 CSS 变量 `--composer-h`（挂在 documentElement 上）。
 *
 * 为什么：窄屏的阻断型权限卡是 `position: fixed` 贴在视口底部的。旧实现写死
 * `bottom: 58px`（只让开底部导航），390×844 实测卡片直接盖住整个输入区 ——
 * 连权限胶囊都点不到，用户没法把会话切到「完全访问」（真机反馈的形态）。
 * 输入区高度随多行输入、提示条变化，写死任何一个值都会在某种情况下错位，
 * 所以用 ResizeObserver 量真实高度。
 */
let composerObserver: ResizeObserver | null = null;

function publishComposerHeight(): void {
  const el = rootEl.value;
  if (!el) return;
  const h = Math.round(el.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty("--composer-h", `${h}px`);
}

onMounted(() => {
  publishComposerHeight();
  const el = rootEl.value;
  if (el && typeof ResizeObserver !== "undefined") {
    composerObserver = new ResizeObserver(() => publishComposerHeight());
    composerObserver.observe(el);
  }
  window.addEventListener("resize", publishComposerHeight);
});

onBeforeUnmount(() => {
  composerObserver?.disconnect();
  composerObserver = null;
  window.removeEventListener("resize", publishComposerHeight);
  document.documentElement.style.removeProperty("--composer-h");
});

function submit(): void {
  if (!canSend.value) return;
  const value = text.value.trim();
  if (value.length === 0) return;
  const mentions = [...selected.value];
  text.value = "";
  selected.value = [];
  pickerOpen.value = false;
  modeMenuOpen.value = false;
  nextTick(autoGrow);
  emit("send", value, mentions);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (props.streaming) return;
    submit();
  }
}

function onMainClick(): void {
  if (props.streaming) emit("stop");
  else submit();
}

/** 外部（空态里的示例提问）填词。 */
function fill(value: string): void {
  text.value = value;
  nextTick(() => {
    autoGrow();
    textarea.value?.focus();
  });
}

defineExpose({ fill, focus: () => textarea.value?.focus(), openBotPicker });
</script>

<template>
  <div ref="rootEl" class="composer-wrap" @keydown="onRootKeydown">
    <div class="composer" :class="{ 'is-locked': locked }">
      <!-- @ 指定 Bot（仅群聊）：选中项随消息提交，发送后清空 -->
      <button
        class="comp-icon"
        :class="{ 'is-on': pickerOpen || selected.length > 0, 'is-disabled': !mentionEnabled }"
        aria-label="指定 Bot"
        :title="mentionEnabled ? '指定 Bot（@ 必被包含且优先）' : '群聊里可以指定 Bot'"
        :aria-expanded="pickerOpen"
        :disabled="!mentionEnabled"
        @click="togglePicker"
      >
        <AppIcon name="at" :size="16" />
        <span v-if="selected.length > 0" class="comp-icon-badge">{{ selected.length }}</span>
      </button>

      <div v-if="pickerOpen" class="mention-pop" role="dialog" aria-label="指定 Bot">
        <div class="mention-pop-head">
          <span>选择要 @ 的 Bot</span>
          <span class="spacer" />
          <span class="u-faint">必被包含且优先</span>
        </div>
        <button
          v-for="b in bots"
          :key="b.id"
          class="mention-item"
          :class="{ 'is-on': isSelected(b.id) }"
          :aria-pressed="isSelected(b.id)"
          @click="toggleMention(b.id)"
        >
          <BotAvatar :name="b.name" :color-index="b.colorIndex" :avatar="b.avatar" :size="24" />
          <span class="mention-name">{{ b.name }}</span>
          <span class="mention-check">{{ isSelected(b.id) ? "✓" : "" }}</span>
        </button>
        <div v-if="bots.length === 0" class="mention-empty">这个会话还没有可指定的 Bot</div>
        <div class="mention-foot">
          <span class="u-muted">
            {{ selected.length > 0 ? `已选 ${selected.length} 个` : "不选则由主持人决定" }}
          </span>
          <span class="spacer" />
          <button class="btn btn--sm btn--ghost" @click="pickerOpen = false">完成</button>
        </div>
      </div>

      <!-- 权限模式胶囊（R5）：常显当前档位；点击弹出四档说明；Shift+Tab 循环。
           禁用态用外层 title：disabled 的 <button> 在多数浏览器不触发鼠标事件，
           直接挂 title 用户看不到「该运行时由 CLI 自身管理权限」的原因。 -->
      <span
        class="perm-capsule-wrap"
        :title="permissionDisabled ? permissionDisabledReason : undefined"
      >
        <button
          class="perm-capsule"
          :class="{
            'is-full': permissionMode === 'full',
            'is-disabled': permissionDisabled,
            'is-open': modeMenuOpen,
          }"
          :style="{ '--dot': `var(${currentMode.dot})` }"
          :title="permissionDisabled ? undefined : modeTitle"
          :aria-label="`权限模式：${currentMode.label}`"
          :aria-expanded="modeMenuOpen"
          :aria-haspopup="'menu'"
          :disabled="permissionDisabled"
          @click="toggleModeMenu"
        >
          <span class="perm-dot" aria-hidden="true" />
          <span class="perm-label perm-label--long">{{ currentMode.label }}</span>
          <span class="perm-label perm-label--short">{{ currentMode.short }}</span>
          <AppIcon name="chev" :size="12" class="perm-chev" />
        </button>
      </span>

      <div v-if="modeMenuOpen" class="perm-menu" role="menu" aria-label="选择权限模式">
        <button
          v-if="permissionGroup"
          class="perm-menu-all"
          role="menuitem"
          @click="applyModeToAll"
        >
          <span class="perm-all-ico" aria-hidden="true">◎</span>
          <span class="perm-item-body">
            <span class="perm-item-name">应用到本群全部 Bot</span>
            <span class="perm-item-desc">把「{{ currentMode.label }}」同步给群里每个 Bot 的会话</span>
          </span>
        </button>
        <button
          v-for="m in MODES"
          :key="m.key"
          class="perm-item"
          :class="{ 'is-on': m.key === permissionMode }"
          role="menuitemradio"
          :aria-checked="m.key === permissionMode"
          @click="chooseMode(m.key)"
        >
          <span class="perm-item-dot" :style="{ '--dot': `var(${m.dot})` }" aria-hidden="true" />
          <span class="perm-item-body">
            <span class="perm-item-name">{{ m.label }}</span>
            <span class="perm-item-desc">{{ m.desc }}</span>
          </span>
          <span class="perm-item-check" aria-hidden="true">{{ m.key === permissionMode ? "✓" : "" }}</span>
        </button>
      </div>

      <textarea
        ref="textarea"
        rows="1"
        :value="text"
        :placeholder="effectivePlaceholder"
        :disabled="disabled"
        @input="text = ($event.target as HTMLTextAreaElement).value; autoGrow()"
        @keydown="onKeydown"
      />
      <button
        class="comp-send"
        :class="{ 'is-stop': streaming }"
        :aria-label="streaming ? '停止' : '发送'"
        :disabled="!streaming && !canSend"
        @click="onMainClick"
      >
        <AppIcon v-if="streaming" name="stop" :size="12" />
        <AppIcon v-else name="send" :size="16" />
      </button>
    </div>
    <div class="comp-meta">
      <span>Enter 发送 · Shift+Enter 换行</span>
      <span>·</span>
      <span v-if="metaLeft">{{ metaLeft }}</span>
      <span class="spacer" />
      <span v-if="metaRight" class="u-mono">{{ metaRight }}</span>
    </div>
  </div>
</template>
