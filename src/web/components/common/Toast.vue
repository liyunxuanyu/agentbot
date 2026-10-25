<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useUiStore } from "../../stores/ui";

/**
 * Toast 容器（原型 .toast-wrap / .toast）。
 * 挂在 App 根部，通过 ui store 的 toast() 触发。
 */
const ui = useUiStore();
const { toasts } = storeToRefs(ui);
</script>

<template>
  <div class="toast-wrap" aria-live="polite" aria-atomic="true">
    <div v-for="t in toasts" :key="t.id" class="toast">{{ t.text }}</div>
  </div>
</template>
