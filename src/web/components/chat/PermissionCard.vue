<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { BotDto } from "../../net/types";
import type { PermissionKind, PermissionView } from "../../stores/permissions";
import { botVars } from "../../lib/botVars";

/**
 * 权限卡片（原型 permCardHtml()，UX F4 + 6.2 分级）。
 *
 * 五态（不是四态——「已决」与「已失效」视觉不同）：
 *   block    阻断型：琥珀 4px 左轨、120s 倒计时、4 个决策按钮、输入框锁定
 *   hold     挂起型：蓝色左轨、无倒计时（显示「已挂起 1h 20m」）、输入框不锁
 *   boundary 边界拒绝：红色左轨、无决策按钮、只有「去调整边界」
 *   invalid  已失效：灰化、按钮全禁
 *   decided  已决：收成一行审计行，可展开看完整动作与决定
 *
 * 快捷键在卡片上以 kbd 文字标注（UX §8 要求「快捷键必须在卡片上以文字标注」），
 * 实际绑定在 ChatPage 的 useHotkeys 里，作用于第一张阻断卡。
 */
const props = defineProps<{
  perm: PermissionView;
  bot: BotDto | null;
  /** 来源描述（`Bot 名 · 运行时 · 第 N 轮`）。 */
  sourceLabel: string;
}>();

const emit = defineEmits<{
  decide: [requestId: string, decision: "approve" | "reject" | "remember" | "forever"];
  goBoundary: [botId: string];
}>();

const vars = computed(() => (props.bot ? botVars(props.bot) : {}));

const kind = computed<PermissionKind>(() => props.perm.kind);

const tag = computed(() => {
  switch (kind.value) {
    case "boundary":
      return "▲ 超出边界";
    case "invalid":
      return "▲ 已失效";
    case "hold":
      return "◷ 挂起中";
    default:
      return "▲ 等待批准";
  }
});

const actionLabel = computed(() => {
  const map = { write: "写文件 · Write", read: "读文件 · Read", exec: "执行命令 · Bash", network: "联网 · Fetch" };
  return map[props.perm.action];
});

/** 倒计时（只对 block 型）。每秒 tick 一次；归零后显示 0s 等后端转终态。 */
const now = ref(Date.now());
let timer: number | null = null;
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});

const secondsLeft = computed(() => {
  if (props.perm.expiresAt === null) return null;
  return Math.max(0, Math.ceil((props.perm.expiresAt - now.value) / 1000));
});

/** 剩余 20s 内标红并脉冲（原型 .perm-countdown.is-urgent）。 */
const urgent = computed(() => secondsLeft.value !== null && secondsLeft.value <= 20);

/** hold 型：已挂起多久。 */
const heldFor = computed(() => {
  if (props.perm.heldSince === null) return "";
  const ms = Math.max(0, now.value - props.perm.heldSince);
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
});

/** 已决审计行是否展开。 */
const auditOpen = ref(false);

const note = computed(() => {
  switch (kind.value) {
    case "boundary":
      return "这个动作没有转发给运行时。边界变更只影响之后的请求。";
    case "hold":
      return "该请求来自 Assignment 或定时任务，不会因超时被拒绝；会话输入框不锁定。";
    case "invalid":
      return "运行时已退出，无法回传决定。重新发送可发起新请求。";
    default:
      return "决定会写入权限审计，记录不可在界面内删除。";
  }
});

function decide(decision: "approve" | "reject" | "remember" | "forever"): void {
  emit("decide", props.perm.requestId, decision);
}
</script>

<template>
  <div class="ev" :style="vars">
    <!-- 已决：收成一行审计 -->
    <template v-if="kind === 'decided'">
      <button
        class="audit-row"
        :aria-expanded="auditOpen"
        :aria-controls="`audit-${perm.requestId}`"
        @click="auditOpen = !auditOpen"
      >
        <span :class="perm.decisionText && perm.decisionText.includes('拒绝') ? 'no' : 'ok'">
          {{ perm.decisionText && perm.decisionText.includes("拒绝") ? "✕" : "✓" }}
        </span>
        <span>{{ perm.decisionText ?? "已处置" }}</span>
        <span class="u-mono" style="font-size: 11px; color: var(--color-text-muted)">{{ actionLabel }}</span>
        <span class="audit-no">№ {{ perm.requestId }}</span>
      </button>
      <div class="ev-body" :class="{ 'is-open': auditOpen }" :id="`audit-${perm.requestId}`">
        <pre>{{ `${actionLabel}\n${perm.target}\n${perm.decisionText ?? ""}\n记录已写入设置 › 权限审计` }}</pre>
      </div>
    </template>

    <!-- 待处置 -->
    <div
      v-else
      class="perm"
      :class="`perm--${kind}`"
      :data-perm="perm.requestId"
      :data-kind="kind"
      tabindex="-1"
    >
      <div class="perm-head">
        <span class="perm-tag">{{ tag }}</span>
        <span class="perm-no">№ {{ perm.requestId }}</span>
      </div>

      <div class="perm-fields">
        <div class="perm-field">
          <span class="k">动作</span><span class="v">{{ actionLabel }}</span>
        </div>
        <div class="perm-field">
          <span class="k">目标</span><span class="v"><code>{{ perm.target }}</code></span>
        </div>
        <div class="perm-field">
          <span class="k">来源</span><span class="v">{{ sourceLabel }}</span>
        </div>

        <template v-if="kind === 'hold'">
          <div class="perm-field">
            <span class="k">状态</span>
            <span class="v" style="color: var(--color-info-ink)">等待你回来 · 已挂起 {{ heldFor }}</span>
          </div>
          <div class="perm-field">
            <span class="k">上限</span><span class="v">最长保留 24h，期间运行时不退出</span>
          </div>
        </template>
        <template v-else-if="kind === 'boundary'">
          <div class="perm-field">
            <span class="k">判定</span>
            <span class="v" style="color: var(--color-danger-ink)">超出 Bot 边界 · 已自动拒绝</span>
          </div>
        </template>
        <template v-else-if="kind === 'invalid'">
          <div class="perm-field">
            <span class="k">状态</span><span class="v">请求已失效 · 运行时进程已退出</span>
          </div>
        </template>
        <template v-else>
          <div class="perm-field">
            <span class="k">剩余</span>
            <span class="v">
              <span class="perm-countdown" :class="{ 'is-urgent': urgent }">{{ secondsLeft ?? 120 }}s</span>
              后自动拒绝
            </span>
          </div>
        </template>
      </div>

      <!-- 按钮区 -->
      <div v-if="kind === 'boundary'" class="perm-actions">
        <button class="btn btn--sm btn--secondary" @click="emit('goBoundary', bot?.id ?? '')">
          去调整边界
        </button>
      </div>

      <div v-else-if="kind === 'invalid'" class="perm-actions">
        <span class="perm-btn"><button class="btn btn--sm" disabled>批准一次</button><kbd>A</kbd></span>
        <span class="perm-btn"><button class="btn btn--sm" disabled>拒绝</button><kbd>R</kbd></span>
      </div>

      <div v-else class="perm-actions">
        <span class="perm-btn">
          <button class="btn btn--sm btn--primary" @click="decide('approve')">批准一次</button><kbd>A</kbd>
        </span>
        <span class="perm-btn">
          <button class="btn btn--sm btn--secondary" @click="decide('reject')">拒绝</button><kbd>R</kbd>
        </span>
        <span class="perm-btn">
          <button class="btn btn--sm btn--ghost" @click="decide('remember')">记住（本会话）</button><kbd>⇧A</kbd>
        </span>
        <span class="perm-btn">
          <button class="btn btn--sm btn--ghost" @click="decide('forever')">记住（本 Bot 永久）</button><kbd>⌃⇧A</kbd>
        </span>
      </div>

      <div class="perm-note">{{ note }}</div>
    </div>
  </div>
</template>
