<script setup lang="ts">
/**
 * 空态（原型 .empty）。
 * 四态里的「空」与「筛选无结果」是两种文案，由调用方传入，不复用同一套话术。
 */
withDefaults(
  defineProps<{
    title: string;
    description?: string;
  }>(),
  { description: "" },
);
</script>

<template>
  <div class="empty enter">
    <div class="empty-icon">
      <slot name="icon">
        <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <rect x="3" y="6" width="14" height="11" rx="4" />
          <path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h3A1.5 1.5 0 0 1 13 4.5V6" />
        </svg>
      </slot>
    </div>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.actions" class="empty-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
