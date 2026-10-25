<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { BotDto } from "../../net/types";
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
  }>(),
  {
    streaming: false,
    locked: false,
    disabled: false,
    metaRight: "",
    metaLeft: "",
    bots: () => [],
    mentionEnabled: false,
  },
);

const emit = defineEmits<{
  send: [text: string, mentionBotIds: string[]];
  stop: [];
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
  if (!pickerOpen.value) return;
  const root = rootEl.value;
  if (root && !root.contains(e.target as Node)) pickerOpen.value = false;
}

onMounted(() => document.addEventListener("pointerdown", onDocPointerDown, true));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointerDown, true));

function submit(): void {
  if (!canSend.value) return;
  const value = text.value.trim();
  if (value.length === 0) return;
  const mentions = [...selected.value];
  text.value = "";
  selected.value = [];
  pickerOpen.value = false;
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
  <div ref="rootEl" class="composer-wrap" @keydown.esc="pickerOpen = false">
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
