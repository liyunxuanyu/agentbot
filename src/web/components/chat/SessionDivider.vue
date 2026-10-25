<script setup lang="ts">
/**
 * Session 分隔条（原型 .session-divider）。
 *
 * 由 `meta` 事件驱动（session_resumed / session_rebuilt / compaction），
 * 只在「上下文发生变化」时显形（UX §2.3 规则）——日常连续对话不显示。
 *
 * 注意：meta 不进渲染流（不占 Turn 内位置），但分隔条**要**占流里的一行，
 * 因为它的作用就是「在这里切一刀」。这是 P0-05「meta 不渲染」的唯一例外，
 * 也是 PM 在 board 上明确同意的用途（`05-pm-answer.md` 第 2 条）。
 */
defineProps<{ text: string }>();
</script>

<template>
  <div class="session-divider">
    <span>{{ text }}</span>
  </div>
</template>
