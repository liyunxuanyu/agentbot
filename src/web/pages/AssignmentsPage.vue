<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type { AssignmentDto, AssignmentStatus } from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { durText, shortNum } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import AppModal from "../components/common/AppModal.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import EmptyState from "../components/common/EmptyState.vue";

/**
 * /assignments —— 任务总览（UX §4.1）。
 *
 * 四态：
 *   加载 = 分组骨架
 *   错误 = 重试条（筛选条件保留）
 *   空   = 「任务从会话里的一条消息创建」+ 去会话
 *   正常 = 状态 chips（带计数）+ 表格
 *
 * 状态分组按 PRD 五态（排队 / 执行中 / 已完成 / 失败 / 超时）。
 * 「超时」与「失败」分开：前者有产出可看，后者多半要重跑 —— 混在一起用户分不清。
 */
const router = useRouter();
const bots = useBotsStore();
const channels = useChannelsStore();
const ui = useUiStore();

type FilterKey = "all" | AssignmentStatus;

const assignments = ref<AssignmentDto[]>([]);
const counts = ref<Record<string, number>>({});
const status = ref<"idle" | "loading" | "ready" | "empty" | "error">("idle");
const errorText = ref("");
const filter = ref<FilterKey>("all");

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "queued", label: "排队" },
  { key: "running", label: "执行中" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" },
  { key: "timeout", label: "超时" },
];

const STATUS_WORD: Record<AssignmentStatus, string> = {
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  timeout: "超时",
};

const STATUS_STATE: Record<AssignmentStatus, "waiting" | "working" | "done" | "blocked"> = {
  queued: "waiting",
  running: "working",
  done: "done",
  failed: "blocked",
  timeout: "blocked",
};

const filtered = computed(() =>
  filter.value === "all"
    ? assignments.value
    : assignments.value.filter((a) => a.status === filter.value),
);

function countOf(key: FilterKey): number {
  if (key === "all") return assignments.value.length;
  return counts.value[key] ?? 0;
}

async function load(): Promise<void> {
  status.value = "loading";
  errorText.value = "";
  try {
    const res = await api.assignments();
    assignments.value = res.assignments;
    counts.value = res.counts;
    status.value = res.assignments.length === 0 ? "empty" : "ready";
  } catch (err) {
    if (isMissingEndpoint(err)) {
      assignments.value = [];
      status.value = "empty";
      return;
    }
    errorText.value = err instanceof Error ? err.message : "读取任务失败";
    status.value = "error";
  }
}

function botOf(id: string) {
  return bots.findBot(id) ?? null;
}

function channelName(id: string | null): string {
  if (!id) return "—";
  return channels.find(id)?.name ?? "—";
}

function durOf(a: AssignmentDto): string {
  if (a.durationMs == null) return "—";
  return durText(a.durationMs);
}

/**
 * 列表里的用量。
 *
 * 任务的 DTO 没有 token 字段，但报告里本来就有「## 用量」段（`- 输入：1.2k token`）。
 * 再为列表加一个端点不值得；解析失败就显示 —，与「未上报」的展示一致，不编数字。
 */
function usageText(a: AssignmentDto): string {
  const u = usageOf(a);
  if (!u) return "—";
  return `${shortNum(u.in)} / ${shortNum(u.out)}`;
}

function usageOf(a: AssignmentDto): { in: number | null; out: number | null } | null {
  if (!a.report) return null;
  const inMatch = /- 输入：([\d.,]+k?|—) token/.exec(a.report);
  const outMatch = /- 输出：([\d.,]+k?|—) token/.exec(a.report);
  if (!inMatch && !outMatch) return null;
  return { in: parseToken(inMatch?.[1]), out: parseToken(outMatch?.[1]) };
}

function parseToken(raw: string | undefined): number | null {
  if (!raw || raw === "—") return null;
  if (raw.endsWith("k")) {
    const n = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 从会话派活（PRD P0-07 的创建入口在会话里；这里给一个等价表单，免去跳来跳去）
// ---------------------------------------------------------------------------
const assignOpen = ref(false);
const creating = ref(false);
const formError = ref("");
const form = ref({
  channelId: "",
  title: "",
  deliverable: "一段可直接贴进周报的结论，附每条结论的出处。",
  botId: "",
});

async function openAssign(): Promise<void> {
  formError.value = "";
  if (channels.channels.length === 0) await channels.load();
  const firstChannel = channels.visible[0];
  form.value = {
    channelId: firstChannel?.id ?? "",
    title: "",
    deliverable: "一段可直接贴进周报的结论，附每条结论的出处。",
    botId: firstChannel?.participantBotIds[0] ?? bots.bots[0]?.id ?? "",
  };
  assignOpen.value = true;
}

/** 选中渠道后，默认指派该渠道里的第一个 Bot（私聊就是它本身）。 */
function syncBotToChannel(): void {
  const ch = channels.find(form.value.channelId);
  const first = ch?.participantBotIds[0];
  if (first && bots.findBot(first)) form.value.botId = first;
}

async function createAssignment(): Promise<void> {
  if (creating.value) return;
  formError.value = "";
  if (form.value.channelId.length === 0) {
    formError.value = "先选一个来源会话。";
    return;
  }
  if (form.value.title.trim().length === 0) {
    formError.value = "标题不能为空。";
    return;
  }
  if (form.value.deliverable.trim().length === 0) {
    formError.value = "交付物描述不能为空。";
    return;
  }
  if (form.value.botId.length === 0) {
    formError.value = "先选一个 Bot。";
    return;
  }
  creating.value = true;
  try {
    const res = await api.createAssignment({
      channelId: form.value.channelId,
      title: form.value.title.trim(),
      deliverable: form.value.deliverable.trim(),
      botId: form.value.botId,
    });
    assignOpen.value = false;
    await load();
    void router.push(`/assignments/${res.assignment.id}`);
  } catch (err) {
    if (err instanceof ApiError && err.code === "queue_full") {
      const limit = (err.body as { queueLimit?: number } | undefined)?.queueLimit ?? 5;
      formError.value = `这个 Bot 的任务队列已满（上限 ${limit}）。等前面的任务结束再提交。`;
      return;
    }
    formError.value =
      err instanceof ApiError ? (err.messageText() ?? `提交失败（${err.code}）`) : "提交失败，请重试。";
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  ui.setCrumb([{ text: "任务" }]);
  if (bots.bots.length === 0) void bots.load();
  if (channels.channels.length === 0) void channels.load();
  await load();
});
</script>

<template>
  <div>
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">任务</h1>
        <p class="page-desc">
          任务从会话里的一条消息创建，独立执行，完成后把报告回贴原会话。执行期间不占用输入框。
        </p>
      </div>
      <div class="spacer" />
      <button class="btn btn--secondary" @click="openAssign">从会话派活</button>
    </div>

    <!-- 加载态：分组骨架 -->
    <template v-if="status === 'loading' || status === 'idle'">
      <div class="filters">
        <span class="sk" style="height: 30px; width: 260px; border-radius: 10px" />
      </div>
      <div class="rows">
        <div v-for="i in 4" :key="i" class="row-item" aria-hidden="true">
          <span class="sk sk-line" style="width: 60%; display: block" />
        </div>
      </div>
    </template>

    <!-- 错误态 -->
    <div v-else-if="status === 'error'" class="banner">
      <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
      <span>读取任务失败{{ errorText ? `：${errorText}` : "。" }}筛选条件已保留。</span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="load">重试</button>
    </div>

    <!-- 空态 -->
    <EmptyState
      v-else-if="status === 'empty'"
      title="还没有任务"
      description="任务不是在这里新建的：在会话里把一条消息「转为任务」，它就会带着上下文独立执行，完成后把报告贴回原会话。"
    >
      <template #icon><AppIcon name="tasks" :size="24" /></template>
      <template #actions>
        <RouterLink class="btn btn--primary" to="/chats">去会话</RouterLink>
        <button class="btn btn--secondary" @click="openAssign">从会话派活</button>
      </template>
    </EmptyState>

    <!-- 正常态 -->
    <template v-else>
      <div class="filters enter" :style="{ '--i': 1 }">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          class="chip"
          :class="{ 'is-on': filter === f.key }"
          @click="filter = f.key"
        >{{ f.label }}<span class="n">{{ countOf(f.key) }}</span></button>
      </div>

      <div v-if="filtered.length === 0" class="empty">
        <div class="empty-icon"><AppIcon name="tasks" :size="24" /></div>
        <h3>这个分组里没有任务</h3>
        <p>换一个状态看看。</p>
        <div class="empty-actions">
          <button class="btn btn--secondary" @click="filter = 'all'">看全部</button>
        </div>
      </div>

      <div v-else class="card" style="padding: 8px">
        <div class="grid-row is-head assign-head">
          <span>标题</span><span>指派 Bot</span><span>来源会话</span><span>状态</span>
          <span style="text-align: right">耗时</span>
          <span style="text-align: right">用量</span>
        </div>
        <div
          v-for="(a, i) in filtered"
          :key="a.id"
          class="grid-row assign-row enter"
          :class="{ 'is-dim': a.status === 'failed' || a.status === 'timeout' }"
          :style="{ '--i': Math.min(i + 2, 5) }"
          @click="router.push(`/assignments/${a.id}`)"
        >
          <span
            class="assign-title"
            style="font-weight: var(--weight-semibold); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
          >{{ a.title }}</span>
          <span
            class="assign-bot"
            style="display: flex; align-items: center; gap: 8px; min-width: 0"
            :style="botOf(a.botId) ? botVars(botOf(a.botId)!) : {}"
          >
            <BotAvatar
              v-if="botOf(a.botId)"
              :name="botOf(a.botId)!.name"
              :color-index="botOf(a.botId)!.colorIndex"
              :avatar="botOf(a.botId)!.avatar"
              :size="24"
            />
            <span style="font-size: var(--font-size-caption); color: var(--bc-ink, var(--color-text))">
              {{ a.botName }}
            </span>
          </span>
          <span class="assign-channel u-muted" style="font-size: var(--font-size-caption)">
            {{ channelName(a.sourceChannelId) }}
          </span>
          <span class="assign-status">
            <BotStateChip :state="STATUS_STATE[a.status]" :label="STATUS_WORD[a.status]" />
          </span>
          <span class="cell-num u-muted assign-dur">{{ durOf(a) }}</span>
          <span class="cell-num u-muted assign-usage">{{ usageText(a) }}</span>
        </div>
      </div>

      <p class="hint">
        同一 Bot 同时执行 1 个任务，其余排队（队列上限 {{ assignments[0]?.queueLimit ?? 5 }}）。
        30 分钟无结束会标超时并保留已有产出。
      </p>
    </template>

    <!-- 从会话派活 -->
    <AppModal v-model:open="assignOpen" title="从会话派活">
      <div class="field">
        <label class="u-label" for="as-channel">来源会话</label>
        <select id="as-channel" v-model="form.channelId" class="select" @change="syncBotToChannel">
          <option v-if="channels.visible.length === 0" value="">还没有会话，先去开一个私聊</option>
          <option v-for="c in channels.visible" :key="c.id" :value="c.id">{{ c.name || "私聊" }}</option>
        </select>
        <div class="hint">任务完成后，报告会回贴到这个会话。</div>
      </div>
      <div class="field">
        <label class="u-label" for="as-title">标题</label>
        <input id="as-title" v-model="form.title" class="input" placeholder="例如：整理这版发布计划的风险" />
      </div>
      <div class="field">
        <label class="u-label" for="as-deliverable">交付物</label>
        <textarea id="as-deliverable" v-model="form.deliverable" class="textarea" rows="2" />
      </div>
      <div class="field">
        <label class="u-label" for="as-bot">指派 Bot</label>
        <select id="as-bot" v-model="form.botId" class="select">
          <option v-for="b in bots.bots" :key="b.id" :value="b.id">
            {{ b.name }}（{{ b.runtime?.displayName ?? "未绑定" }}）
          </option>
        </select>
      </div>
      <p class="hint">执行位置继承自 Bot；执行不占用输入框，你可以继续聊天。</p>
      <div v-if="formError" class="field-err" role="alert">{{ formError }}</div>
      <template #footer>
        <button class="btn btn--secondary" @click="assignOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="creating" @click="createAssignment">
          {{ creating ? "提交中…" : "提交" }}
        </button>
      </template>
    </AppModal>
  </div>
</template>
