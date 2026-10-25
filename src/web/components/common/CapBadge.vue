<script setup lang="ts">
import type { CapabilityValue } from "../../net/types";

/**
 * 单个能力徽标（原型 `capBadge()`）。
 *
 * 三态都带文字（UI §9 原则 2「能力可见而非缺失」）：
 *   支持 → 绿底实色；不支持 → 灰底实色；未知 → 虚线边（与未知事件同语言）。
 * 「未知」与「不支持」视觉不同 —— 这是本产品最容易做错的一处，不允许合并成灰色。
 */
withDefaults(defineProps<{ value: CapabilityValue; label?: string }>(), { label: "" });

function badgeOf(v: CapabilityValue): { cls: string; text: string } {
  if (v === true) return { cls: "cap cap--yes", text: "✓ 支持" };
  if (v === false) return { cls: "cap cap--no", text: "— 不支持" };
  return { cls: "cap cap--unknown", text: "? 未知" };
}
</script>

<template>
  <span :class="badgeOf(value).cls">{{ label ? `${label} ` : "" }}{{ badgeOf(value).text }}</span>
</template>
