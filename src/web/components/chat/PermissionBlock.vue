<script setup lang="ts">
import { computed } from "vue";
import type { BotDto } from "../../net/types";
import type { PermissionView } from "../../stores/permissions";
import { botVars } from "../../lib/botVars";
import BotAvatar from "../bot/BotAvatar.vue";
import BotStateChip from "../bot/BotStateChip.vue";
import PermissionCard from "./PermissionCard.vue";

/**
 * 阻断型权限卡的吸附容器（原型 `.turn.turn--perm-block`）。
 *
 * 为什么单独成块，而不是把 `turn--perm-block` 加到所属 Turn 上：
 *   `.turn--perm-block` 是 `position: sticky; bottom: 0`，粘住的是**整个元素**。
 *   原型里这个 Turn 的 body 只有卡片本身，所以「粘住 Turn」≈「粘住卡片」。
 *   真实数据里权限请求挂在内容 Turn 上（有气泡、事件、错误块），
 *   把整轮粘到底部会盖住前面几百像素的内容 —— 实测踩到过（截图里正文被压住）。
 *
 * 因此这里复刻原型的最小形态：只有「Turn 头 + 卡片」的一块，放在流尾，
 * 让 sticky 的语义回到它本来的意思 ——「此刻正在等你决定的事」。
 */
const props = defineProps<{
  perm: PermissionView;
  bot: BotDto | null;
  runtimeName: string;
}>();

const emit = defineEmits<{
  decide: [requestId: string, decision: "approve" | "reject" | "remember" | "forever"];
  goBoundary: [botId: string];
}>();

const vars = computed(() => (props.bot ? botVars(props.bot) : {}));
</script>

<template>
  <section
    class="turn turn--perm-block"
    :data-turn="perm.turnId"
    :data-bot="bot?.id"
    :style="vars"
  >
    <header class="turn-head" aria-hidden="true">
      <BotAvatar
        v-if="bot"
        :name="bot.name"
        :color-index="bot.colorIndex"
        :avatar="bot.avatar"
        :size="24"
      />
      <span class="turn-name">{{ bot?.name ?? "未知 Bot" }}</span>
      <span class="rt-chip">{{ runtimeName }}</span>
      <span class="turn-right">
        <BotStateChip state="blocked" label="等待批准" />
      </span>
    </header>
    <div class="turn-body">
      <PermissionCard
        :perm="perm"
        :bot="bot"
        :source-label="`${bot?.name ?? '未知 Bot'} · ${runtimeName}`"
        @decide="(id, d) => emit('decide', id, d)"
        @go-boundary="(id) => emit('goBoundary', id)"
      />
    </div>
  </section>
</template>
