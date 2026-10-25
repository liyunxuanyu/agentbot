<script setup lang="ts">
import { computed } from "vue";
import type { BotDto } from "../../net/types";
import { botVars, initialOf } from "../../lib/botVars";
import BotStateChip from "./BotStateChip.vue";
import BotAvatar from "./BotAvatar.vue";

/**
 * Bot 卡片（原型 botCard()，UI §7 组件规格）。
 *
 * 320×200、r14、p20；顶部 3px 身份条是网格里唯一的强色块 ——
 * 所以身份色只出现在这条 3px 与头像底，绝不整卡铺底。
 *
 * 五行结构（UX §2.4，S3 硬指标，一个字段都不能删）：
 *   ① 头像 + 名称 + 六态
 *   ② 人格摘要（1 行截断）
 *   ③ 运行时 名称 · 协议 · 模式
 *   ④ 执行位置 类型 + 路径（中段省略）
 *   ⑤ Session 状态 + 相对时间 + 待批数
 */
const props = withDefaults(
  defineProps<{
    bot: BotDto;
    /** stagger 序号（原型 --i，超 5 项不再延迟）。 */
    index?: number;
  }>(),
  { index: 0 },
);

const emit = defineEmits<{
  open: [id: string];
  detail: [id: string];
  assign: [id: string];
}>();

const vars = computed(() => botVars(props.bot));
const initial = computed(() => initialOf(props.bot.name, props.bot.avatar));

/** 运行时不可用：未绑定或健康检查没过（P0-02「发送被阻止并给改绑入口」）。 */
const unavailable = computed(() => {
  const rt = props.bot.runtime;
  if (!rt) return true;
  return rt.healthStatus !== "ready" && rt.healthStatus !== "unprobed";
});

const STATE_WORD = {
  idle: "空闲",
  thinking: "思考中",
  working: "工作中",
  waiting: "等待中",
  blocked: "受阻",
  done: "完成",
} as const;

const sessionText = computed(() => {
  const b = props.bot;
  if (b.state === "blocked" && unavailable.value) return "不可用 · 运行时未就绪";
  if (b.state === "working" && b.stateSince) {
    const secs = Math.max(0, Math.round((Date.now() - b.stateSince) / 1000));
    return `生成中 · ${secs}s`;
  }
  if (b.state === "waiting") return "排队中";
  const ago = b.lastActiveAt ? relative(b.lastActiveAt) : "";
  return `${STATE_WORD[b.state]}${ago ? ` · ${ago}` : ""}`;
});

/** 路径中段省略：拆成「目录 + 尾段」，目录用 ellipsis 截断，尾段保持完整。 */
const pathParts = computed(() => {
  const p = props.bot.effectivePath ?? "—";
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return { mid: "", tail: p };
  return { mid: p.slice(0, idx + 1), tail: p.slice(idx + 1) };
});

function relative(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    emit("open", props.bot.id);
  }
}
</script>

<template>
  <article
    class="bot-card enter"
    :class="{ 'is-unavailable': unavailable }"
    :style="{ '--i': Math.min(index, 5), ...vars }"
    tabindex="0"
    role="link"
    :aria-label="`${bot.name}，打开详情`"
    @click="emit('open', bot.id)"
    @keydown="onKeydown"
  >
    <div class="bc-acts">
      <button class="btn btn--sm btn--ghost" @click.stop="emit('detail', bot.id)">详情</button>
      <button class="btn btn--sm btn--ghost" @click.stop="emit('assign', bot.id)">派任务</button>
    </div>

    <div class="bc-head">
      <BotAvatar
        :name="bot.name"
        :avatar="bot.avatar"
        :color-index="bot.colorIndex"
        :size="40"
        :state="bot.state"
      />
      <div class="bc-id">
        <div class="bc-name">{{ bot.name }}</div>
        <BotStateChip :state="bot.state" decay />
      </div>
    </div>

    <div class="bc-persona">{{ bot.persona }}</div>

    <div v-if="unavailable" class="bc-banner">
      {{ bot.runtime ? `${bot.runtime.displayName} 未就绪` : "未绑定运行时" }} · 发送会被阻止
    </div>

    <div class="bc-reads">
      <span class="k">运行时</span>
      <span class="v">
        <template v-if="bot.runtime">
          {{ bot.runtime.displayName }} · {{ bot.runtime.protocol }} · 交互
        </template>
        <template v-else>未绑定 · 去改绑</template>
      </span>
      <span class="k">执行位置</span>
      <span class="v">
        <span class="path">
          <span class="pre">{{ bot.executionLocation === "worktree" ? "worktree" : "local" }}</span>
          <span class="p-a">{{ pathParts.mid }}</span>
          <span class="p-b">{{ pathParts.tail }}</span>
        </span>
      </span>
      <span class="k">Session</span>
      <span class="v">
        {{ sessionText }}<template v-if="bot.pendingPermissions > 0"> · 待批 {{ bot.pendingPermissions }}</template>
      </span>
    </div>
  </article>
</template>
