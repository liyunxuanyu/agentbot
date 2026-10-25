<script setup lang="ts">
import { computed } from "vue";
import type { BotDto } from "../../net/types";
import { botVars } from "../../lib/botVars";

/**
 * 轮次栅栏（原型 .fence）。
 *
 * UX §5.1 第 4 条：每轮结束插极轻分隔行 `— 本轮结束 · ●●● · 4,120 token —`，
 * 三个点就是参与者身份色，历史永远按轮可读。
 */
const props = defineProps<{
  participants: BotDto[];
  tokens: number;
}>();

const dots = computed(() =>
  props.participants.map((b) => ({ id: b.id, vars: botVars(b) })),
);
</script>

<template>
  <div class="fence">
    <span class="dots">
      <i v-for="d in dots" :key="d.id" :style="d.vars" />
    </span>
    <span>本轮结束 · {{ participants.length }} 个 Bot · {{ tokens.toLocaleString("en-US") }} token</span>
  </div>
</template>
