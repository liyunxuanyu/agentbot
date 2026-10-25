<script setup lang="ts">
import { computed } from "vue";
import type { BotDto } from "../../net/types";
import { botVars } from "../../lib/botVars";
import BotAvatar from "../bot/BotAvatar.vue";

/**
 * 消息气泡（原型 msgHtml() / userMsgHtml()）。
 *
 * UI §4.2 连续消息规则（三条一起作用才读得成「一段话」）：
 *   ① 组首无缺口、组中双缺口（TL+BL）、组末缺口朝上（TL）；
 *   ② 连续消息 gap 从 12px 降到 4px（由 .msg--cont 的负 margin 实现）；
 *   ③ 组首之后不重复头像与名字，左缩进 44px（= 32 头像 + 12 间距）。
 *
 * 时间只在悬停时出现（第三条）——所以常态下气泡旁没有任何元信息。
 */
const props = withDefaults(
  defineProps<{
    text: string;
    bot: BotDto | null;
    /** true = 用户消息（右对齐，主色实心）。 */
    user?: boolean;
    /** 连续消息中的非首条：无头像无名字。 */
    cont?: boolean;
    /** 后面还有同组消息 → 尾部留缺口。 */
    hasNext?: boolean;
    /** 流式中：末尾挂光标。 */
    streaming?: boolean;
    /** 悬停时间戳文案。 */
    timeLabel?: string | null;
    /** 显示「转为任务」等悬停操作。 */
    showTools?: boolean;
  }>(),
  {
    user: false,
    cont: false,
    hasNext: false,
    streaming: false,
    timeLabel: null,
    showTools: false,
  },
);

const emit = defineEmits<{ toAssignment: [text: string]; resend: [] }>();

const vars = computed(() => (props.bot ? botVars(props.bot) : {}));

/** 圆角：组中 = mid，组末 = last（原型 bubbleRadius）。 */
const radiusClass = computed(() => {
  if (!props.cont) return "";
  return props.hasNext ? "bubble--mid" : "bubble--last";
});

/**
 * 空回复（P0-04 边界）：消息行存在、状态已收口、content 长度为 0。
 *
 * 不能画一个空气泡（用户会以为渲染坏了），也不能什么都不画（用户会以为
 * 运行时没被调用）。按原型 muted 语言降级成一行「未返回内容」+ 重发入口。
 * 流式中（text 仍可能为空）保持气泡 + 光标，不提前下结论。
 */
const emptyReply = computed(() => !props.user && !props.streaming && props.text.length === 0);
</script>

<template>
  <!-- 用户消息 -->
  <div v-if="user" class="msg msg--user">
    <div class="msg-col">
      <div class="bubble bubble--user">{{ text }}</div>
      <div class="msg-hover">
        <div v-if="showTools" class="msg-tools">
          <button class="msg-tool" @click="emit('toAssignment', text.slice(0, 40))">转为任务</button>
        </div>
        <span v-if="timeLabel" class="msg-time">你 · {{ timeLabel }}</span>
      </div>
    </div>
    <span class="av av--32 av--user" aria-hidden="true">你</span>
  </div>

  <!-- Bot 消息 -->
  <div
    v-else
    class="msg msg--bot"
    :class="{ 'msg--cont': cont }"
    :style="vars"
  >
    <BotAvatar
      v-if="!cont && bot"
      :name="bot.name"
      :color-index="bot.colorIndex"
      :avatar="bot.avatar"
      :size="32"
    />
    <div class="msg-col">
      <div v-if="!cont && bot" class="msg-name">{{ bot.name }}</div>

      <!-- 空回复降级：muted 一行 + 重发（不再渲染空气泡） -->
      <div v-if="emptyReply" class="empty-reply" role="status">
        <span class="empty-reply-mark" aria-hidden="true">—</span>
        <span class="empty-reply-text">未返回内容</span>
        <button class="btn btn--sm btn--ghost" @click="emit('resend')">重发</button>
      </div>

      <div v-else class="bubble bubble--bot" :class="radiusClass">
        {{ text }}<span v-if="streaming" class="cursor-stream" />
      </div>
      <div class="msg-hover">
        <div v-if="showTools" class="msg-tools">
          <button class="msg-tool" @click="emit('toAssignment', text.slice(0, 40))">转为任务</button>
          <button class="msg-tool">设为定时</button>
        </div>
        <span v-if="timeLabel && bot" class="msg-time">{{ bot.name }} · {{ timeLabel }}</span>
      </div>
    </div>
  </div>
</template>
