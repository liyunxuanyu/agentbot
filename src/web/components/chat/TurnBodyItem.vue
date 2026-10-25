<script setup lang="ts">
import type { BotDto } from "../../net/types";
import type { TurnItem as TurnItemModel, TurnView } from "../../lib/turnModel";
import type { PermissionView } from "../../stores/permissions";
import { clockTime } from "../../lib/format";
import MessageBubble from "./MessageBubble.vue";
import PermissionCard from "./PermissionCard.vue";
import EventRow from "./EventRow.vue";

/**
 * Turn 体内的一行（消息气泡 / 权限卡 / 事件块）。
 *
 * 为什么单独拆出来：Turn 体有两条渲染路径 —— 普通轮次直接 v-for，单轮
 * >2000 事件时走 `@tanstack/vue-virtual`（只渲染可视区 ±50）。两条路径的行结构
 * 必须逐字段一致，复制一遍模板迟早会漂移（虚拟化路径漏掉「重发」就是一类）。
 *
 * 它只负责「把 TurnItem 映射成 DOM」，排序、折叠、宿主判定都在 TurnItem 里。
 */
const props = defineProps<{
  item: TurnItemModel;
  turn: TurnView;
  bot: BotDto | null;
  permissions: PermissionView[];
  runtimeName: string;
  mode: string;
  /** 连续消息：上一条也是消息（气泡组规则）。 */
  cont: boolean;
  /** 后面还有消息：尾部留缺口。 */
  hasNext: boolean;
}>();

const emit = defineEmits<{
  decidePermission: [requestId: string, decision: "approve" | "reject" | "remember" | "forever"];
  goBoundary: [botId: string];
  resend: [turnId: string];
  toAssignment: [text: string];
}>();

/** 权限请求按 requestId 从 store 取权威状态；store 没有则按事件 payload 兜底。 */
function permOf(requestId: string): PermissionView | null {
  return props.permissions.find((p) => p.requestId === requestId) ?? null;
}
</script>

<template>
  <!-- 助手消息气泡（空回复时内部降级为「未返回内容」+ 重发） -->
  <MessageBubble
    v-if="item.kind === 'message'"
    :text="item.text"
    :bot="bot"
    :cont="cont"
    :has-next="hasNext"
    :streaming="item.streaming"
    :time-label="clockTime(item.ts)"
    show-tools
    @resend="emit('resend', turn.turnId)"
    @to-assignment="(t) => emit('toAssignment', t)"
  />

  <!-- 权限请求：阻断型由 ChatPage 在流尾统一渲染成吸附块；这里只渲染不吸附的
       挂起 / 边界 / 已决，避免同一张卡片出现两次。 -->
  <PermissionCard
    v-else-if="item.kind === 'permission' && permOf(item.requestId) && permOf(item.requestId)!.kind !== 'block'"
    :perm="permOf(item.requestId)!"
    :bot="bot"
    :source-label="`${bot?.name ?? '未知 Bot'} · ${runtimeName} · ${mode}`"
    @decide="(id, d) => emit('decidePermission', id, d)"
    @go-boundary="(id) => emit('goBoundary', id)"
  />

  <!-- 其余 8 类事件 -->
  <EventRow
    v-else-if="item.kind !== 'permission'"
    :event="item"
    :bot="bot"
    :uid="`${turn.turnId}-${item.seq}`"
    @resend="emit('resend', turn.turnId)"
  />
</template>
