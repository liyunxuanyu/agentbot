<script setup lang="ts">
import { NAV_PATHS, SMALL_PATHS, MOON_PATH, type IconName } from "../../lib/icons";

/**
 * 图标组件 —— 路径数据在 lib/icons.ts（与原型 ICONS 逐字一致）。
 * 用 v-html 注入 path 串：这些串是本地常量，不含用户数据。
 */
withDefaults(
  defineProps<{
    name: IconName;
    size?: number;
  }>(),
  { size: 18 },
);
</script>

<template>
  <svg
    v-if="name === 'moon'"
    :width="size"
    :height="size"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    aria-hidden="true"
    v-html="MOON_PATH"
  />
  <svg
    v-else-if="name === 'stop'"
    :width="12"
    :height="12"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="2" y="2" width="8" height="8" rx="1.6" />
  </svg>
  <svg
    v-else-if="name === 'chev'"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
  <svg
    v-else-if="NAV_PATHS[name]"
    :width="size"
    :height="size"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    aria-hidden="true"
    v-html="NAV_PATHS[name]"
  />
  <svg
    v-else-if="SMALL_PATHS[name]"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${SMALL_PATHS[name]!.box} ${SMALL_PATHS[name]!.box}`"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="SMALL_PATHS[name]!.body"
  />
</template>
