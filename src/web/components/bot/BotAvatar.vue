<script setup lang="ts">
import { computed } from "vue";
import type { BotState } from "../../net/types";
import { botVars, initialOf } from "../../lib/botVars";

/**
 * Bot 头像（原型 .av / .av-wrap / .av-badge）。
 *
 * 形态：8px 方牌（vivid 的像素风语言，UI §4.1），身份色实底 + 白/深墨首字。
 * 状态角标 10px，`box-shadow: 0 0 0 2px var(--color-surface)` 由 base.css 给，
 * 所以暗色下描边自动跟随表面色，不会出现白圈。
 */
const props = withDefaults(
  defineProps<{
    name: string;
    colorIndex: number;
    avatar?: string | null;
    size?: 20 | 24 | 28 | 32 | 40 | 48;
    /** 有值时渲染右下状态角标。 */
    state?: BotState | null;
    /** 用户头像：圆形 + 主色底（原型 .av--user）。 */
    user?: boolean;
  }>(),
  { avatar: null, size: 32, state: null, user: false },
);

const initial = computed(() => (props.user ? "你" : initialOf(props.name, props.avatar)));
const style = computed(() => (props.user ? {} : botVars({ colorIndex: props.colorIndex })));
</script>

<template>
  <span v-if="state && !user" class="av-wrap">
    <span class="av" :class="`av--${size}`" :style="style" aria-hidden="true">{{ initial }}</span>
    <span class="av-badge" :style="{ '--s': `var(--state-${state})` }" />
  </span>
  <span
    v-else
    class="av"
    :class="[`av--${size}`, { 'av--user': user }]"
    :style="style"
    aria-hidden="true"
  >{{ initial }}</span>
</template>
