<script setup lang="ts">
import { computed } from "vue";
import type { BotDto } from "../../net/types";
import type { TurnView } from "../../lib/turnModel";
import type { PermissionView } from "../../stores/permissions";
import { clockTime } from "../../lib/format";
import TurnItem from "./TurnItem.vue";
import SessionDivider from "./SessionDivider.vue";
import RoundFence from "./RoundFence.vue";
import ActivityRow from "./ActivityRow.vue";

/**
 * 会话流的一行（用户气泡 / Session 分隔条 / Turn / 轮次栅栏 / 活动行）。
 *
 * 单独抽出来是因为流有两种渲染路径（虚拟化 / 全量），行结构必须完全一致；
 * 复制两遍模板迟早会漂移。
 */
const props = defineProps<{
  row: {
    key: string;
    kind: "turn" | "divider" | "user" | "fence" | "act" | "sys";
    turn?: TurnView;
    dividerText?: string;
    userText?: string;
    /** 系统消息正文。 */
    sysText?: string;
    fence?: { participants: string[]; tokens: number };
    act?: { turnId: string; botId: string; what: string; dur: string; pct: number };
    ts: number;
  };
  bots: BotDto[];
  permissions: PermissionView[];
  collapsed: boolean;
  /**
   * 群聊主持人决策（从主持人那一轮的 JSON 正文解析）。
   * 有值时该 Turn 的气泡替换成「本轮发言人」系统块，不再显示原始 JSON。
   */
  hostDecision?: {
    speakers: { botId: string; reason: string }[];
    skipReason: string;
    rawMessageIds?: string[];
  } | null;
  /** 主持人回复像 JSON 但解析失败：折叠成一行，不显示原始 JSON。 */
  hostRaw?: boolean;
  /** P0-05：连续 30s 无事件且未结束。 */
  stalled?: boolean;
  /** 单轮发言人上限（`本轮调用 2/3` 的分母）。 */
  maxSpeakers?: number;
}>();

const emit = defineEmits<{
  toggle: [turnId: string];
  decide: [requestId: string, decision: "approve" | "reject" | "remember" | "forever"];
  goBoundary: [botId: string];
  resend: [turnId: string];
  toAssignment: [text: string];
  takeover: [turnId: string];
  stopTurn: [turnId: string];
  pickBot: [];
}>();

const bot = computed<BotDto | null>(() => {
  const id = props.row.turn?.botId ?? props.row.act?.botId;
  if (!id) return null;
  return props.bots.find((b) => b.id === id) ?? null;
});

const runtimeName = computed(() => bot.value?.runtime?.displayName ?? "未绑定");
const mode = computed(() =>
  bot.value?.runtime?.capabilities?.streaming === false ? "非流式" : "交互",
);

/** 栅栏里的参与者头像（顺序按 Turn 出现顺序）。 */
const fenceParticipants = computed<BotDto[]>(() =>
  (props.row.fence?.participants ?? [])
    .map((id) => props.bots.find((b) => b.id === id))
    .filter((b): b is BotDto => b !== undefined),
);

/**
 * 「本轮无 Bot 发言」系统提示：PRD P0-06 要求同时给出「指定 Bot 回复」按钮。
 *
 * 后端在主持人返回空名单时会写一条 system 消息（`messages.role='system'`），
 * 文案里包含「无 Bot 发言」。这条消息不走事件流，只能在这里补动作入口 ——
 * 否则用户看到结论却没有任何下一步可点（critic 实测）。
 */
const noSpeakerNotice = computed(() =>
  /无\s*Bot\s*发言/.test(props.row.sysText ?? ""),
);
</script>

<template>
  <!-- 用户消息 -->
  <div v-if="row.kind === 'user'" class="msg msg--user">
    <div class="msg-col">
      <div class="bubble bubble--user">{{ row.userText }}</div>
      <div class="msg-hover">
        <span class="msg-time">你 · {{ clockTime(row.ts) }}</span>
      </div>
    </div>
    <span class="av av--32 av--user" aria-hidden="true">你</span>
  </div>

  <!-- Session 分隔条（meta 驱动） -->
  <SessionDivider v-else-if="row.kind === 'divider'" :text="row.dividerText ?? ''" />

  <!-- 系统消息：主持人降级 / 定时任务触发 / 丢弃了不存在的 Bot。
       UX 原则 5「缺席要可解释」—— 这一行不渲染，用户就只看到一轮空回复。 -->
  <div v-else-if="row.kind === 'sys'" class="sys-block enter">
    <span class="sys-tag">系统</span>
    <div class="sys-body">
      <div style="font-size: var(--font-size-caption); color: var(--color-text)">{{ row.sysText }}</div>
      <div class="sys-foot">
        <span>{{ clockTime(row.ts) }}</span>
        <button
          v-if="noSpeakerNotice"
          class="btn btn--sm btn--primary"
          @click="emit('pickBot')"
        >指定 Bot 回复</button>
      </div>
    </div>
  </div>

  <!-- 轮次栅栏 -->
  <RoundFence
    v-else-if="row.kind === 'fence'"
    :participants="fenceParticipants"
    :tokens="row.fence?.tokens ?? 0"
  />

  <!-- 活动行：折叠掉的并行 Turn，点击接管 -->
  <ActivityRow
    v-else-if="row.kind === 'act' && row.act"
    :bot="bot"
    :what="row.act.what"
    :dur="row.act.dur"
    :pct="row.act.pct"
    @takeover="() => emit('takeover', row.act!.turnId)"
  />

  <!-- Turn -->
  <TurnItem
    v-else-if="row.turn"
    :turn="row.turn"
    :bot="bot"
    :collapsed="collapsed"
    :permissions="permissions"
    :runtime-name="runtimeName"
    :mode="mode"
    :host-decision="hostDecision ?? null"
    :host-raw="hostRaw ?? false"
    :stalled="stalled ?? false"
    :max-speakers="maxSpeakers ?? 3"
    :bots="bots"
    @toggle="(id) => emit('toggle', id)"
    @decide-permission="(id, d) => emit('decide', id, d)"
    @go-boundary="(id) => emit('goBoundary', id)"
    @resend="(id) => emit('resend', id)"
    @to-assignment="(t) => emit('toAssignment', t)"
    @stop-turn="(id) => emit('stopTurn', id)"
    @pick-bot="emit('pickBot')"
  />
</template>
