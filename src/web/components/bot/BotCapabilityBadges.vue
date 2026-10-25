<script setup lang="ts">
import type { CapabilitySet, CapabilityValue } from "../../net/types";

/**
 * 能力徽标（原型 capBadge()）。
 *
 * UI §9 原则 2「能力可见而非缺失」：三态都带文字，未知 ≠ 不支持。
 *   支持 → 绿底实色；不支持 → 灰底实色；未知 → 虚线边（与折叠块的未知事件同语言）。
 *
 * `capabilities` 由 M4 的探测填；现在 `/api/meta` 不给，所以父组件传 null 时
 * 这里什么都不渲染 —— 「未上报」不产生空块（P0-05 的规则同样适用于能力）。
 */
defineProps<{
  capabilities: CapabilitySet | null;
  /** 只显示这三项；默认 plan / permission / resume。 */
  keys?: readonly ("plan" | "permission" | "resume")[];
}>();

const DEFAULT_KEYS = ["plan", "permission", "resume"] as const;

function badge(v: CapabilityValue): { cls: string; text: string } {
  if (v === true) return { cls: "cap cap--yes", text: "✓ 支持" };
  if (v === false) return { cls: "cap cap--no", text: "— 不支持" };
  return { cls: "cap cap--unknown", text: "? 未知" };
}
</script>

<template>
  <span v-if="capabilities" class="cap-row">
    <span
      v-for="key in keys ?? DEFAULT_KEYS"
      :key="key"
      :class="badge(capabilities[key]).cls"
    >{{ badge(capabilities[key]).text }}</span>
  </span>
</template>
