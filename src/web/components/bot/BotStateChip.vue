<script setup lang="ts">
import { computed } from "vue";
import type { BotState } from "../../net/types";
import { STATE_WORD } from "../../lib/botVars";

/**
 * 六态 chip（原型 stateChip()）。
 *
 * UI §2.5 铁律：状态永远「颜色 + 图标 + 文字」三者同时出现，不允许只靠颜色。
 * 六态各自动效在 base.css 里按 `.state--<state>` 分支实现，这里只给对类名与图标。
 */
const props = withDefaults(
  defineProps<{
    state: BotState;
    /** 覆盖文案（Turn 头用「生成中」「已中断」等轮次词）。 */
    label?: string | null;
    /** 完成态 3s 后回落 idle 色（§2.5 done 的动效）。 */
    decay?: boolean;
    /** 只要圆点，不要图标（活动行 / 紧凑处）。 */
    dotOnly?: boolean;
  }>(),
  { label: null, decay: false, dotOnly: false },
);

const text = computed(() => props.label ?? STATE_WORD[props.state]);
const decayClass = computed(() => (props.decay && props.state === "done" ? "is-decay" : ""));
</script>

<template>
  <span class="state" :class="[`state--${state}`, decayClass]">
    <span class="state-dot" :style="{ '--s': `var(--state-${state})` }" />
    <template v-if="!dotOnly">
      <span class="si-wrap">
        <svg
          v-if="state === 'thinking'"
          class="si"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="13" cy="8" r="1.3" fill="currentColor" stroke="none" />
        </svg>
        <svg
          v-else-if="state === 'working'"
          class="si"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" />
        </svg>
        <svg
          v-else-if="state === 'waiting'"
          class="si"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M3 3h10M3 13h10" />
          <path d="M4.5 3c0 3 3.5 3.6 3.5 5s-3.5 2-3.5 5M11.5 3c0 3-3.5 3.6-3.5 5s3.5 2 3.5 5" />
        </svg>
        <svg
          v-else-if="state === 'blocked'"
          class="si"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.8v4M8 11.2v.1" />
        </svg>
        <svg
          v-else-if="state === 'done'"
          class="si"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path class="tick" d="M5.2 8.2 7.1 10l3.7-3.8" />
        </svg>
        <svg
          v-else
          class="si"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.6" />
        </svg>
      </span>
    </template>
    <span>{{ text }}</span>
  </span>
</template>
