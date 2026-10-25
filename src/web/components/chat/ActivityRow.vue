<script setup lang="ts">
import { computed } from "vue";
import type { BotDto } from "../../net/types";
import { botVars } from "../../lib/botVars";
import BotAvatar from "../bot/BotAvatar.vue";

/**
 * 活动行（原型 .act-row，UI §8.2「单展开」的第二半）。
 *
 * 群聊多 Bot 同时跑时，只允许一个 Turn 展开流式，其余折叠成 40px 一行：
 * 20 头像 + `正在运行 <命令> · 12s` + 2px Bot 色进度条，点击接管。
 *
 * 这是 UX 原则 5「缺席要可解释」的落点：用户必须能看出「谁在干活但还没说话」，
 * 而不是以为它没被叫到。
 *
 * `bot` 允许为 null（Bot 列表还没拉到 / Bot 已被删除）：此时用兜底身份色 +
 * 「未知 Bot」占位。**绝不因为拿不到 Bot 就整行消失** —— 那等于告诉用户
 * 「没有 Bot 在跑」，是一条错误信息。
 */
const props = withDefaults(
  defineProps<{
    bot: BotDto | null;
    /** 当前动作（命令、工具名 + 目标）。 */
    what: string;
    /** 已进行时长文案。 */
    dur: string;
    /** 进度百分比 0–100；不传用 40（原型默认）。 */
    pct?: number;
  }>(),
  { pct: 40 },
);

const emit = defineEmits<{ takeover: [] }>();

/** 兜底身份色：未分配一律 --bot-8（松绿，UI §2.4 明确「未分配兜底」）。 */
const vars = computed(() => botVars({ colorIndex: props.bot?.colorIndex ?? 8 }));
const name = computed(() => props.bot?.name ?? "未知 Bot");
</script>

<template>
  <button
    class="act-row"
    :style="vars"
    :aria-label="`${name} 正在运行，点击接管这一轮`"
    @click="emit('takeover')"
  >
    <BotAvatar
      :name="name"
      :color-index="bot?.colorIndex ?? 8"
      :avatar="bot?.avatar ?? null"
      :size="20"
    />
    <span class="act-name">{{ name }}</span>
    <span class="act-what">正在运行 <code>{{ what }}</code> · <span class="act-dur">{{ dur }}</span></span>
    <span class="act-take">点击接管</span>
    <span class="act-bar"><i :style="{ width: `${pct}%` }" /></span>
  </button>
</template>
