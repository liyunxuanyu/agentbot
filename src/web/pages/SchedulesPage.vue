<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type { ScheduleDto, TriggerType } from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { agoText, dateTimeText, dayTimeText } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import AppModal from "../components/common/AppModal.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import EmptyState from "../components/common/EmptyState.vue";

/**
 * /schedules —— 定时任务（UX F6 / PRD P0-11）。
 *
 * 四态：
 *   加载 = 行骨架
 *   错误 = 顶部横幅「调度器异常，定时任务可能不会触发」+ 重试（列表仍显示）
 *   空   = 「还没有定时任务」+ 新建
 *   正常 = 列表
 *
 * 三种触发方式**真切换控件**（F6-1）：
 *   一次性延迟 → 数字 + 分钟
 *   周期       → 数字 + 分钟（最小 5，内联拒绝）
 *   每日       → `type="time"` 时刻选择器
 * 三种共用同一个「09:00」时间框是原型里修过的 bug：选「每 N 分钟」也没法表达 N。
 */
const ui = useUiStore();
const bots = useBotsStore();
const channels = useChannelsStore();

const schedules = ref<ScheduleDto[]>([]);
const schedulerRunning = ref(true);
const minInterval = ref(5);
const status = ref<"idle" | "loading" | "ready" | "empty" | "error">("idle");
const errorText = ref("");

const TRIGGER_OPTIONS: { key: TriggerType; label: string; hint: string }[] = [
  { key: "daily", label: "每日 HH:MM", hint: "每天这个时刻触发一次" },
  { key: "interval", label: "每 N 分钟", hint: `周期任务，最小间隔 ${minInterval.value} 分钟` },
  { key: "once", label: "延迟 N 分钟", hint: "只触发一次；保存后按延迟时间排队" },
];

async function load(): Promise<void> {
  status.value = "loading";
  errorText.value = "";
  try {
    const res = await api.schedules();
    schedules.value = res.schedules;
    schedulerRunning.value = res.schedulerRunning;
    minInterval.value = res.minIntervalMinutes;
    status.value = res.schedules.length === 0 ? "empty" : "ready";
  } catch (err) {
    if (isMissingEndpoint(err)) {
      schedules.value = [];
      status.value = "empty";
      return;
    }
    errorText.value = err instanceof Error ? err.message : "读取定时任务失败";
    status.value = "error";
  }
}

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------
const open = ref(false);
const saving = ref(false);
const formError = ref("");
const form = ref({
  name: "",
  botId: "",
  channelId: "",
  prompt: "",
  triggerType: "daily" as TriggerType,
  minutes: 30,
  atTime: "09:00",
});

const activeHint = computed(
  () => TRIGGER_OPTIONS.find((o) => o.key === form.value.triggerType)?.hint ?? "",
);

async function openNew(): Promise<void> {
  formError.value = "";
  if (bots.bots.length === 0) await bots.load();
  if (channels.channels.length === 0) await channels.load();
  const firstChannel = channels.visible[0];
  form.value = {
    name: "",
    botId: firstChannel?.participantBotIds[0] ?? bots.bots[0]?.id ?? "",
    channelId: firstChannel?.id ?? "",
    prompt: "",
    triggerType: "daily",
    minutes: 30,
    atTime: "09:00",
  };
  open.value = true;
}

/** 切触发方式时重置控件默认值（避免「每 N 分钟」还带着 09:00）。 */
function setTrigger(t: TriggerType): void {
  form.value.triggerType = t;
  formError.value = "";
  if (t === "interval" && form.value.minutes < minInterval.value) {
    form.value.minutes = 30;
  }
  if (t === "once" && form.value.minutes < 1) form.value.minutes = 10;
}

async function save(): Promise<void> {
  if (saving.value) return;
  formError.value = "";
  if (form.value.name.trim().length === 0) {
    formError.value = "名称不能为空。";
    return;
  }
  if (form.value.botId.length === 0) {
    formError.value = "先选一个目标 Bot。";
    return;
  }
  if (form.value.channelId.length === 0) {
    formError.value = "先选一个目标会话。";
    return;
  }
  if (form.value.prompt.trim().length === 0) {
    formError.value = "任务内容不能为空。";
    return;
  }
  // 周期 <5 分钟：内联拒绝（PRD P0-11 边界）
  if (form.value.triggerType === "interval" && form.value.minutes < minInterval.value) {
    formError.value = `周期任务最小间隔是 ${minInterval.value} 分钟，不能更小。`;
    return;
  }
  if (form.value.triggerType === "once" && form.value.minutes < 1) {
    formError.value = "延迟至少 1 分钟。";
    return;
  }
  if (form.value.triggerType === "daily" && !/^\d{2}:\d{2}$/.test(form.value.atTime)) {
    formError.value = "请选择一个有效时刻（HH:MM）。";
    return;
  }

  saving.value = true;
  try {
    await api.createSchedule({
      name: form.value.name.trim(),
      botId: form.value.botId,
      channelId: form.value.channelId,
      prompt: form.value.prompt.trim(),
      triggerType: form.value.triggerType,
      ...(form.value.triggerType === "interval" ? { intervalMinutes: form.value.minutes } : {}),
      ...(form.value.triggerType === "once" ? { delayMinutes: form.value.minutes } : {}),
      ...(form.value.triggerType === "daily" ? { atTime: form.value.atTime } : {}),
    });
    open.value = false;
    await load();
    ui.toast("已保存");
  } catch (err) {
    if (err instanceof ApiError && err.code === "interval_too_small") {
      formError.value = err.messageText() ?? `周期任务最小间隔是 ${minInterval.value} 分钟。`;
      return;
    }
    formError.value =
      err instanceof ApiError ? (err.messageText() ?? `保存失败（${err.code}）`) : "保存失败，请重试。";
  } finally {
    saving.value = false;
  }
}

// ---------------------------------------------------------------------------
// 暂停 / 恢复 / 删除
// ---------------------------------------------------------------------------
const busyId = ref<string | null>(null);

async function toggle(s: ScheduleDto): Promise<void> {
  if (busyId.value) return;
  busyId.value = s.id;
  try {
    const res = await api.patchSchedule(s.id, { enabled: !s.enabled });
    if (res.schedule) {
      const idx = schedules.value.findIndex((x) => x.id === s.id);
      if (idx >= 0) schedules.value[idx] = res.schedule;
    }
    ui.toast(s.enabled ? "已暂停" : "已恢复");
  } catch {
    ui.toast("操作失败，请重试");
  } finally {
    busyId.value = null;
  }
}

async function remove(s: ScheduleDto): Promise<void> {
  if (busyId.value) return;
  busyId.value = s.id;
  try {
    await api.deleteSchedule(s.id);
    schedules.value = schedules.value.filter((x) => x.id !== s.id);
    if (schedules.value.length === 0) status.value = "empty";
    ui.toast("已删除");
  } catch {
    ui.toast("删除失败，请重试");
  } finally {
    busyId.value = null;
  }
}

function botOf(id: string) {
  return bots.findBot(id) ?? null;
}

function channelName(s: ScheduleDto): string {
  return s.channelName ?? channels.find(s.channelId)?.name ?? "—";
}

/** 上次结果 chip：成功/失败/未运行，以及「补跑」标记（P0-11 边界）。 */
function lastState(s: ScheduleDto): { state: "idle" | "done" | "blocked"; label: string } {
  if (!s.lastResult) return { state: "idle", label: "未运行" };
  const failed = /失败|错误|超时/.test(s.lastResult);
  return { state: failed ? "blocked" : "done", label: s.lastResult };
}

/** 下次触发的展示：今天/明天/日期 + 时刻。 */
function nextText(s: ScheduleDto): string {
  if (!s.enabled || s.nextRunAt == null) return "—";
  const d = new Date(s.nextRunAt);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  if (sameDay) return `今天 ${hhmm}`;
  if (isTomorrow) return `明天 ${hhmm}`;
  return dayTimeText(s.nextRunAt);
}

onMounted(async () => {
  ui.setCrumb([{ text: "定时" }]);
  if (bots.bots.length === 0) void bots.load();
  if (channels.channels.length === 0) void channels.load();
  await load();
});

void dateTimeText;
void agoText;
void botVars;
</script>

<template>
  <div>
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">定时任务</h1>
        <p class="page-desc">
          到点以目标 Bot 的身份在指定会话执行，结果作为系统块追加到会话里。
        </p>
      </div>
      <div class="spacer" />
      <button class="btn btn--primary" @click="openNew">
        <AppIcon name="plus" :size="14" />新建
      </button>
    </div>

    <!-- 错误态：调度器异常横幅（列表仍显示，保留重试） -->
    <div v-if="status === 'error'" class="banner">
      <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
      <span>读取定时任务失败{{ errorText ? `：${errorText}` : "。" }}</span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="load">重试</button>
    </div>
    <div v-else-if="status !== 'loading' && status !== 'idle' && !schedulerRunning" class="banner banner--warn">
      <span class="state-dot" :style="{ '--s': 'var(--state-waiting)' }" />
      <span>调度器异常，定时任务可能不会触发。</span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="load">重试</button>
    </div>

    <!-- 加载态 -->
    <div v-if="status === 'loading' || status === 'idle'" class="rows">
      <div v-for="i in 3" :key="i" class="row-item" aria-hidden="true">
        <span class="sk sk-line" style="width: 50%; display: block" />
      </div>
    </div>

    <!-- 空态 -->
    <EmptyState
      v-else-if="status === 'empty'"
      title="还没有定时任务"
      description="比如「每周一 09:00 让研究助手抓一次竞品更新」，结果会回到你指定的会话。"
    >
      <template #icon><AppIcon name="clock" :size="24" /></template>
      <template #actions>
        <button class="btn btn--primary" @click="openNew">新建定时任务</button>
      </template>
    </EmptyState>

    <!-- 正常态 -->
    <div v-else class="card" style="padding: 8px">
      <div class="grid-row is-head sched-head">
        <span>名称</span><span>目标 Bot</span><span>目标会话</span><span>触发规则</span>
        <span>下次触发</span><span>上次结果</span><span />
      </div>
      <div
        v-for="(s, i) in schedules"
        :key="s.id"
        class="grid-row sched-row enter"
        :class="{ 'is-dim': !s.enabled }"
        :style="{ '--i': Math.min(i + 2, 5) }"
      >
        <div class="sched-name" style="min-width: 0">
          <div style="font-weight: var(--weight-semibold); font-size: var(--font-size-caption)">{{ s.name }}</div>
          <div v-if="s.autoPaused" style="font-size: 11px; color: var(--color-warning-ink); margin-top: 2px">
            连续失败 {{ s.failCount }} 次，已自动暂停
          </div>
          <div v-else-if="!s.enabled" style="font-size: 11px; color: var(--color-text-muted); margin-top: 2px">
            已暂停
          </div>
        </div>
        <span
          class="sched-bot"
          style="display: flex; align-items: center; gap: 8px"
          :style="botOf(s.botId) ? botVars(botOf(s.botId)!) : {}"
        >
          <BotAvatar
            v-if="botOf(s.botId)"
            :name="botOf(s.botId)!.name"
            :color-index="botOf(s.botId)!.colorIndex"
            :avatar="botOf(s.botId)!.avatar"
            :size="24"
          />
          <span style="font-size: var(--font-size-caption); color: var(--bc-ink, var(--color-text))">
            {{ s.botName ?? botOf(s.botId)?.name ?? "（已删除的 Bot）" }}
          </span>
        </span>
        <span class="sched-channel u-muted" style="font-size: var(--font-size-caption)">{{ channelName(s) }}</span>
        <span class="sched-rule u-mono u-muted">{{ s.trigger }}</span>
        <span class="sched-next u-mono" style="color: var(--color-text-secondary)">{{ nextText(s) }}</span>
        <span class="sched-last">
          <BotStateChip :state="lastState(s).state" :label="lastState(s).label" />
        </span>
        <span class="sched-action" style="text-align: right; display: flex; gap: 4px; justify-content: flex-end">
          <button class="btn btn--sm btn--ghost" :disabled="busyId === s.id" @click="toggle(s)">
            {{ s.enabled ? "暂停" : "恢复" }}
          </button>
          <button class="btn btn--sm btn--ghost" :disabled="busyId === s.id" @click="remove(s)">删除</button>
        </span>
      </div>
    </div>

    <p v-if="status === 'ready'" class="hint">
      一次性任务执行后置「已完成」并保留记录；服务未运行错过的触发会在启动后补跑一次。
      周期任务连续失败 3 次自动暂停。
    </p>

    <!-- 新建弹层 -->
    <AppModal v-model:open="open" title="新建定时任务">
      <div class="field">
        <label class="u-label" for="sc-name">名称</label>
        <input id="sc-name" v-model="form.name" class="input" placeholder="例如：竞品周报" />
      </div>
      <div class="field">
        <label class="u-label" for="sc-bot">目标 Bot</label>
        <select id="sc-bot" v-model="form.botId" class="select">
          <option v-if="bots.bots.length === 0" value="">还没有 Bot</option>
          <option v-for="b in bots.bots" :key="b.id" :value="b.id">
            {{ b.name }}（{{ b.runtime?.displayName ?? "未绑定" }}）
          </option>
        </select>
      </div>
      <div class="field">
        <label class="u-label" for="sc-channel">目标会话</label>
        <select id="sc-channel" v-model="form.channelId" class="select">
          <option v-if="channels.visible.length === 0" value="">还没有会话，先去开一个私聊</option>
          <option v-for="c in channels.visible" :key="c.id" :value="c.id">{{ c.name || "私聊" }}</option>
        </select>
        <div class="hint">到点后，结果作为系统块追加到这个会话里。</div>
      </div>
      <div class="field">
        <label class="u-label" for="sc-body">任务内容</label>
        <textarea id="sc-body" v-model="form.prompt" class="textarea" rows="2" placeholder="抓一次三家竞品的更新，按「变化 / 影响 / 建议」三段输出。" />
      </div>

      <div class="field">
        <label class="u-label">触发方式</label>
        <div class="radio-row" role="radiogroup" aria-label="触发方式">
          <label v-for="opt in TRIGGER_OPTIONS" :key="opt.key" class="radio">
            <input
              type="radio"
              name="sc-trig"
              :value="opt.key"
              :checked="form.triggerType === opt.key"
              @change="setTrigger(opt.key)"
            />
            {{ opt.label }}
          </label>
        </div>

        <!-- 真切换控件：daily 用时刻选择器，interval/once 用分钟数 -->
        <div style="margin-top: 12px">
          <input
            v-if="form.triggerType === 'daily'"
            v-model="form.atTime"
            class="input"
            type="time"
            style="max-width: 160px"
            aria-label="触发时刻"
            @input="formError = ''"
          />
          <div v-else style="display: flex; align-items: center; gap: 8px; max-width: 220px">
            <input
              v-model.number="form.minutes"
              class="input"
              type="number"
              :min="form.triggerType === 'interval' ? minInterval : 1"
              max="1440"
              inputmode="numeric"
              :aria-label="form.triggerType === 'interval' ? '间隔分钟数' : '延迟分钟数'"
              @input="formError = ''"
            />
            <span class="u-muted" style="font-size: var(--font-size-caption); white-space: nowrap">分钟</span>
          </div>
        </div>
        <div class="hint">{{ activeHint }}</div>
        <div v-if="formError" class="field-err" role="alert">{{ formError }}</div>
      </div>

      <template #footer>
        <button class="btn btn--secondary" @click="open = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="saving" @click="save">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </template>
    </AppModal>
  </div>
</template>
