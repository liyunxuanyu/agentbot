<script setup lang="ts">
import { ref, computed } from "vue";

/**
 * 事件折叠块（原型 .ev / .ev-row / .ev-body）。
 *
 * 这是「一次只展开一层」的执行点：折叠时行高 32px；展开时行升到 --color-surface
 * 并带 card 阴影，行与体合成一块卡片（原型 CSS 注释里有完整理由）。
 *
 * 变体（与原型选择器一一对应）：
 *   think   —— 2px 虚线灰左轨
 *   tool    —— 2px 实线 Bot 色左轨，运行中扫光
 *   result  —— 无底色、挂在上一条调用下缩进 12
 *   plan    —— 行首环形进度
 *   unknown —— 虚线边整块（未知事件）
 *   plain   —— 无左轨无底色（普通折叠行）
 *   link    —— 只渲染一个 ghost 按钮触发展开（错误块的「查看详情」）
 */
const props = withDefaults(
  defineProps<{
    uid: string;
    summary: string;
    variant?: "think" | "tool" | "result" | "plan" | "unknown" | "plain" | "link";
    /** 工具调用运行中：行上扫光。 */
    running?: boolean;
    /** 工具结果成败：行首 ✓ / ✕。 */
    ok?: boolean;
    /** 摘要用等宽（命令、路径）。 */
    mono?: boolean;
    /** 默认展开。 */
    defaultOpen?: boolean;
    /** 计划环形进度 0–1。 */
    pct?: number;
  }>(),
  {
    variant: "plain",
    running: false,
    ok: undefined,
    mono: false,
    defaultOpen: false,
    pct: 0,
  },
);

const open = ref(props.defaultOpen);

const CIRCUMFERENCE = 2 * Math.PI * 6;
const dashOffset = computed(
  () => (CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, props.pct)))).toFixed(1),
);

const wrapperClass = computed(() => {
  switch (props.variant) {
    case "think":
      return "ev ev--think";
    case "tool":
      return `ev ev--tool${props.running ? " is-running" : ""}`;
    case "result":
      return "ev ev--result";
    case "unknown":
      return "ev ev--unknown";
    default:
      return "ev";
  }
});

function toggle(): void {
  open.value = !open.value;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggle();
  }
}
</script>

<template>
  <div :class="wrapperClass">
    <!-- link 形态：错误块里的「查看详情」，是 ghost 按钮而不是折叠行 -->
    <button
      v-if="variant === 'link'"
      class="btn btn--sm btn--ghost"
      :aria-expanded="open"
      :aria-controls="`ev-body-${uid}`"
      @click="toggle"
    >{{ open ? "收起详情" : "查看详情" }}</button>

    <button
      v-else
      class="ev-row"
      :aria-expanded="open"
      :aria-controls="`ev-body-${uid}`"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span v-if="variant === 'think'" class="u-faint">⋯</span>
      <span v-else-if="variant === 'tool'" :style="{ color: 'var(--bc)' }">▸</span>
      <span
        v-else-if="variant === 'result'"
        :style="{ color: ok === false ? 'var(--color-danger)' : 'var(--color-success)' }"
      >{{ ok === false ? "✕" : "✓" }}</span>
      <span v-else-if="variant === 'unknown'" class="ev-unknown-mark">?</span>
      <svg
        v-else-if="variant === 'plan'"
        class="plan-ring"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle class="bg" cx="8" cy="8" r="6" />
        <circle
          class="fg"
          cx="8"
          cy="8"
          r="6"
          :stroke-dasharray="CIRCUMFERENCE.toFixed(1)"
          :stroke-dashoffset="dashOffset"
        />
      </svg>

      <span :class="{ 'u-mono': mono }" :style="mono ? { fontSize: '11.5px' } : undefined">
        {{ summary }}
      </span>
      <span class="chev">›</span>
    </button>

    <div class="ev-body" :class="{ 'is-open': open }" :id="`ev-body-${uid}`">
      <slot />
    </div>
  </div>
</template>
