<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import { openStream, type SseConnection } from "../net/stream";
import type { AssignmentDto, AssignmentStatus, SseFrame } from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useRuntimesStore } from "../stores/runtimes";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { clockTimeSeconds, dateTimeText, durText, num } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import EmptyState from "../components/common/EmptyState.vue";

/**
 * /assignments/:id —— 任务详情（UX §4.1）。
 *
 * 结构：任务头 + 字段条 + 报告正文（左）+ 事件流时间线（右，窄屏折到底部）。
 *
 * 四态：
 *   空   = 排队中 → 「等待前序任务（队列 2/5）」+ 前序链接
 *   加载 = 「报告生成中 · 已完成 N 个事件」+ 骨架
 *   错误 = 失败原因一句 + 最后 50 条事件 + 重跑
 *   正常 = 执行摘要 / 改动文件 / 用量 + 已交付状态戳
 *
 * 报告与事件流的来源：
 *   - 报告正文是 `assignment.report`（Markdown 原文，后端生成）；
 *     这里按固定四节标题解析，而不是渲染整个 Markdown（不引 Markdown 库，
 *     也不让报告里的任意 HTML 进 DOM）。
 *   - 事件流用 `GET /api/stream?sessionId=` 的**回放**能力（首连游标 0）：
 *     任务的事件落在它自己的 Session 里，SSE 会把历史按 events.id 重放一遍。
 *     收满静默 800ms 后断开 —— 这是一次性读取，不是长连接。
 */
const props = defineProps<{ id: string }>();

const router = useRouter();
const bots = useBotsStore();
const channels = useChannelsStore();
const runtimes = useRuntimesStore();
const ui = useUiStore();

const assignment = ref<AssignmentDto | null>(null);
const status = ref<"idle" | "loading" | "ready" | "empty" | "error" | "missing">("idle");
const errorText = ref("");
const rerunning = ref(false);

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

const bot = computed(() => (assignment.value ? bots.findBot(assignment.value.botId) : null));
const botStyle = computed(() => (bot.value ? botVars(bot.value) : {}));
const runtimeName = computed(
  () =>
    assignment.value?.runtimeName ??
    (assignment.value?.botId ? (runtimes.find(bot.value?.runtime?.id ?? null)?.displayName ?? "—") : "—"),
);

const channelName = computed(() => {
  const id = assignment.value?.sourceChannelId;
  if (!id) return "—";
  return channels.find(id)?.name ?? "—";
});

/**
 * 报告四节解析（后端 `renderReport()` 的固定结构）。
 *
 * 为什么按行扫描而不是用正则切 `## 标题` 之间的块：报告正文是**运行时写的自然语言**
 * Markdown，里面可能有任意缩进与空行；`^## X$([\s\S]*?)(?=^## |\s*$)` 这种写法在
 * `m` 模式下会被行尾空白提前截断（实测只拿到第一行）。逐行扫描到下一个 `## ` 标题
 * 为止，行为可预测。
 */
interface ParsedReport {
  summary: string[];
  files: { path: string; status: string; added: string; deleted: string }[];
  usageLines: string[];
  tailEvents: string[];
  hasSections: boolean;
}

function splitSections(md: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && line.startsWith("## ")) {
      current = heading[1] ?? "";
      map.set(current, []);
      continue;
    }
    if (current) map.get(current)?.push(line);
  }
  return map;
}

function parseReport(md: string | null): ParsedReport {
  const empty: ParsedReport = { summary: [], files: [], usageLines: [], tailEvents: [], hasSections: false };
  if (!md) return empty;

  const sections = splitSections(md);
  const summaryRaw = sections.get("执行摘要") ?? [];
  const filesRaw = sections.get("改动文件") ?? [];
  const usageRaw = sections.get("用量") ?? [];
  const tailRaw = sections.get("最后 50 条事件") ?? [];

  /**
   * 执行摘要：保留正文段落，去掉「交付物：」「失败原因：」两行元信息。
   *
   * 有序列表（`1. xxx`）与无序列表（`- xxx`）都去掉前缀 —— 前端用 `<ol>` 渲染，
   * 保留 `1.` 会出现「1. 1. xxx」。段落里的 `做了什么：` 这类行原样保留（它们是正文）。
   */
  const summary = summaryRaw
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith("交付物：") && !l.startsWith("失败原因："))
    .map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, ""));

  const files: ParsedReport["files"] = [];
  for (const line of filesRaw) {
    const trimmed = line.trim();
    // 跳过分隔行与表头
    if (!trimmed.startsWith("|") || /^\|[\s:|-]+\|$/.test(trimmed)) continue;
    if (/^\|\s*文件\s*\|/.test(trimmed)) continue;
    const m = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(trimmed);
    if (!m) continue;
    files.push({
      path: m[1] ?? "",
      status: (m[2] ?? "").trim() || "M",
      added: (m[3] ?? "").trim(),
      deleted: (m[4] ?? "").trim(),
    });
  }

  const usageLines = usageRaw
    .map((l) => l.trim().replace(/^(\d+[.)]|[-*])\s+/, ""))
    .filter((l) => l.length > 0);

  const tailEvents = tailRaw
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== "```");

  return {
    summary,
    files,
    usageLines,
    tailEvents,
    hasSections: summaryRaw.length > 0 || filesRaw.length > 0 || usageRaw.length > 0,
  };
}

const report = computed(() => parseReport(assignment.value?.report ?? null));

/** 失败原因：优先 `failReason`，其次报告里的「失败原因：」行。 */
const failReason = computed(() => {
  if (assignment.value?.failReason) return assignment.value.failReason;
  const m = /失败原因：(.+)/.exec(assignment.value?.report ?? "");
  return m?.[1]?.trim() ?? "";
});

// ---------------------------------------------------------------------------
// 事件流（SSE 回放，一次性读取）
// ---------------------------------------------------------------------------
interface TimelineEvent {
  id: number;
  type: string;
  label: string;
  detail: string;
  tone: "muted" | "primary" | "success" | "danger";
}

const timeline = ref<TimelineEvent[]>([]);
const timelineLoading = ref(false);
const timelineError = ref("");
let conn: SseConnection | null = null;
let idleTimer: number | null = null;

const TYPE_SYMBOL: Record<string, string> = {
  message_delta: "·",
  thought: "⋯",
  tool_call: "▸",
  tool_result: "◂",
  plan: "≡",
  permission_request: "▲",
  usage: "∑",
  done: "■",
  error: "✕",
  meta: "·",
};

const TYPE_WORD: Record<string, string> = {
  message_delta: "正文",
  thought: "思考",
  tool_call: "工具调用",
  tool_result: "工具结果",
  plan: "计划",
  permission_request: "权限请求",
  usage: "用量",
  done: "结束",
  error: "错误",
  meta: "内部状态",
};

function labelOf(frame: SseFrame): { label: string; detail: string; tone: TimelineEvent["tone"] } {
  const p = (typeof frame.payload === "object" && frame.payload !== null
    ? frame.payload
    : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
  switch (frame.type) {
    case "message_delta": {
      const text = str("text").replace(/\s+/g, " ").slice(0, 90);
      return { label: `正文 ${str("phase")}`, detail: text, tone: "muted" };
    }
    case "thought":
      return { label: "思考", detail: str("text").replace(/\s+/g, " ").slice(0, 90), tone: "muted" };
    case "tool_call":
      return {
        label: `工具调用 ${str("name") || "—"}`,
        detail: JSON.stringify(p["input"] ?? "").slice(0, 90),
        tone: "primary",
      };
    case "tool_result": {
      const ok = str("status") === "ok";
      return {
        label: `工具结果 · ${ok ? "成功" : "失败"}`,
        detail: str("output").replace(/\s+/g, " ").slice(0, 90),
        tone: ok ? "success" : "danger",
      };
    }
    case "plan": {
      const entries = Array.isArray(p["entries"]) ? (p["entries"] as unknown[]) : [];
      return { label: `计划 ${entries.length} 项`, detail: "", tone: "muted" };
    }
    case "permission_request":
      return {
        label: `权限 · ${str("action")}`,
        detail: str("target"),
        tone: "danger",
      };
    case "usage":
      return {
        label: `用量 ${num(typeof p["inputTokens"] === "number" ? p["inputTokens"] : null)} in / ${num(typeof p["outputTokens"] === "number" ? p["outputTokens"] : null)} out`,
        detail: p["reported"] === false ? "运行时未上报" : "",
        tone: "muted",
      };
    case "done":
      return {
        label: `结束 · ${str("stopReason") || "end"}`,
        detail: typeof p["durationMs"] === "number" ? durText(p["durationMs"]) : "",
        tone: "success",
      };
    case "error":
      return { label: "错误", detail: str("message"), tone: "danger" };
    default:
      return { label: TYPE_WORD[frame.type] ?? frame.type, detail: "", tone: "muted" };
  }
}

function stopTimeline(): void {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  conn?.close();
  conn = null;
}

function resetIdleTimer(): void {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  // 静默 800ms 视为回放结束（SSE 没有「历史读完」的语义）
  idleTimer = window.setTimeout(() => {
    stopTimeline();
    timelineLoading.value = false;
  }, 800);
}

function loadTimeline(sessionId: string): void {
  stopTimeline();
  timeline.value = [];
  timelineError.value = "";
  timelineLoading.value = true;
  try {
    conn = openStream({
      sessionId,
      lastEventId: 0,
      onFrame: (frame) => {
        const { label, detail, tone } = labelOf(frame);
        timeline.value = [...timeline.value, { id: frame.id, type: frame.type, label, detail, tone }];
        resetIdleTimer();
      },
      onError: (fatal) => {
        if (fatal) {
          timelineLoading.value = false;
          timelineError.value = "无法读取事件流（会话可能已清理）";
          stopTimeline();
        }
      },
    });
    resetIdleTimer();
  } catch {
    timelineLoading.value = false;
    timelineError.value = "无法读取事件流";
  }
}

const timelineSymbol = (t: string): string => TYPE_SYMBOL[t] ?? "·";

const timelineColor = (tone: TimelineEvent["tone"]): string => {
  if (tone === "danger") return "var(--color-danger)";
  if (tone === "primary") return "var(--color-primary)";
  if (tone === "success") return "var(--color-success)";
  return "var(--color-text-muted)";
};

// ---------------------------------------------------------------------------
// 加载 / 重跑
// ---------------------------------------------------------------------------
let pollTimer: number | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 执行中的任务必须轮询。
 *
 * 任务在**独立 Session** 里跑，用户停在这个详情页时没有 SSE 连接（时间线是一次性
 * 回放），所以状态只能靠轮询推进。不轮询的话页面会永远停在「执行中 · 0 个事件」，
 * 用户以为卡死（实测踩到）。2s 一次、到终态即停 —— 任务页面天然是短驻留页面。
 */
function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    const a = assignment.value;
    if (!a) return;
    if (a.status !== "queued" && a.status !== "running") {
      stopPolling();
      return;
    }
    try {
      const res = await api.assignment(props.id);
      assignment.value = res.assignment;
      status.value = res.assignment.status === "queued" ? "empty" : "ready";
      if (res.assignment.sessionId && timeline.value.length === 0) {
        loadTimeline(res.assignment.sessionId);
      }
      if (res.assignment.status !== "queued" && res.assignment.status !== "running") {
        stopPolling();
        if (res.assignment.sessionId) loadTimeline(res.assignment.sessionId);
      }
    } catch {
      // 轮询失败不打断页面：下一拍再试
    }
  }, 2000);
}

async function load(): Promise<void> {
  status.value = "loading";
  errorText.value = "";
  stopPolling();
  try {
    const res = await api.assignment(props.id);
    assignment.value = res.assignment;
    status.value = res.assignment.status === "queued" ? "empty" : "ready";
    if (res.assignment.sessionId) loadTimeline(res.assignment.sessionId);
    if (res.assignment.status === "queued" || res.assignment.status === "running") {
      startPolling();
    }
  } catch (err) {
    if (isMissingEndpoint(err)) {
      status.value = "missing";
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      status.value = "missing";
      return;
    }
    errorText.value = err instanceof Error ? err.message : "读取任务失败";
    status.value = "error";
  }
}

/** 重跑：后端没有专用端点，按 PRD 语义「新建一个同样的任务」 */
async function rerun(): Promise<void> {
  const a = assignment.value;
  if (!a || rerunning.value) return;
  rerunning.value = true;
  try {
    const res = await api.createAssignment({
      channelId: a.sourceChannelId ?? "",
      title: a.title,
      deliverable: a.deliverable,
      botId: a.botId,
    });
    ui.toast("已重跑 · 新任务已入队");
    void router.push(`/assignments/${res.assignment.id}`);
  } catch (err) {
    if (err instanceof ApiError && err.code === "queue_full") {
      ui.toast("队列已满，等前面的任务结束再重跑");
    } else {
      ui.toast(err instanceof ApiError ? (err.messageText() ?? "重跑失败") : "重跑失败");
    }
  } finally {
    rerunning.value = false;
  }
}

onMounted(async () => {
  ui.setCrumb([{ text: "任务", to: "/assignments" }]);
  if (bots.bots.length === 0) void bots.load();
  if (channels.channels.length === 0) void channels.load();
  if (runtimes.runtimes.length === 0) void runtimes.load();
  await load();
  if (assignment.value) {
    ui.setCrumb([{ text: "任务", to: "/assignments" }, { text: assignment.value.title.slice(0, 20) }]);
  }
});

onBeforeUnmount(() => {
  stopTimeline();
  stopPolling();
});
</script>

<template>
  <div v-if="status === 'missing'" style="padding: var(--space-4) 0">
    <EmptyState title="没有这个任务" description="它可能已被删除，或者链接里的 id 不对。">
      <template #icon><AppIcon name="tasks" :size="24" /></template>
      <template #actions>
        <RouterLink class="btn btn--secondary" to="/assignments">返回任务列表</RouterLink>
      </template>
    </EmptyState>
  </div>

  <div v-else-if="status === 'error'" class="banner">
    <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
    <span>读取任务失败：{{ errorText }}</span>
    <span class="spacer" />
    <button class="btn btn--sm" @click="load">重试</button>
  </div>

  <div v-else>
    <!-- 任务头 -->
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">{{ assignment?.title ?? "读取中…" }}</h1>
        <div class="detail-meta" :style="botStyle">
          <span class="u-mono" style="color: var(--color-text-muted)">№ {{ assignment?.id.slice(-8) ?? "—" }}</span>
          <BotStateChip
            v-if="assignment"
            :state="STATUS_STATE[assignment.status]"
            :label="STATUS_WORD[assignment.status]"
          />
          <span v-if="bot" style="display: flex; align-items: center; gap: 6px">
            <BotAvatar :name="bot.name" :color-index="bot.colorIndex" :avatar="bot.avatar" :size="20" />
            <span style="font-size: var(--font-size-caption); color: var(--bc-ink)">{{ bot.name }}</span>
          </span>
          <span v-else-if="assignment" style="font-size: var(--font-size-caption)">{{ assignment.botName }}</span>
          <span class="rt-chip">{{ runtimeName }}</span>
        </div>
      </div>
      <div class="page-actions">
        <button
          v-if="assignment && (assignment.status === 'failed' || assignment.status === 'timeout')"
          class="btn btn--primary"
          :disabled="rerunning"
          @click="rerun"
        >{{ rerunning ? "提交中…" : "重跑" }}</button>
        <RouterLink class="btn btn--secondary" to="/assignments">全部任务</RouterLink>
      </div>
    </div>

    <div v-if="status === 'loading'" style="display: grid; gap: 16px; max-width: 720px">
      <div v-for="w in ['70%', '88%', '52%']" :key="w" class="sk" :style="{ height: '24px', width: w }" />
    </div>

    <template v-else-if="assignment">
      <!-- 字段条 -->
      <div class="card card-pad enter" :style="{ '--i': 1, marginBottom: '24px' }">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px">
          <div>
            <div class="u-label" style="margin-bottom: 4px">来源会话</div>
            <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary)">
              {{ channelName }}
            </div>
          </div>
          <div>
            <div class="u-label" style="margin-bottom: 4px">执行位置</div>
            <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary)">
              {{ assignment.executionLocation }}
              <span class="u-mono">{{ assignment.worktreePath ?? bot?.effectivePath ?? "" }}</span>
            </div>
          </div>
          <div>
            <div class="u-label" style="margin-bottom: 4px">开始</div>
            <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary)">
              {{ assignment.startedAt ? dateTimeText(assignment.startedAt) : "—" }}
            </div>
          </div>
          <div>
            <div class="u-label" style="margin-bottom: 4px">耗时</div>
            <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary)">
              {{ assignment.durationMs == null ? "—" : durText(assignment.durationMs) }}
            </div>
          </div>
          <div>
            <div class="u-label" style="margin-bottom: 4px">事件数</div>
            <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary)">
              {{ assignment.eventCount }}
            </div>
          </div>
        </div>
      </div>

      <div class="assign-detail" style="display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start">
        <div>
          <!-- 排队中（空态） -->
          <div v-if="assignment.status === 'queued'" class="card card-pad">
            <div class="empty" style="box-shadow: none; padding: 24px 0">
              <div class="empty-icon"><AppIcon name="clock" :size="24" /></div>
              <h3>
                {{ assignment.queuePosition
                  ? `等待前序任务（第 ${assignment.queuePosition} 位）`
                  : "已排队" }}
              </h3>
              <p>
                同一个 Bot 同时只执行 1 个任务，队列上限 {{ assignment.queueLimit }}。
                前序任务结束后会自动开始，不需要你操作。
              </p>
              <div class="empty-actions">
                <RouterLink class="btn btn--sm btn--secondary" to="/assignments">看全部任务</RouterLink>
              </div>
            </div>
          </div>

          <!-- 执行中（加载态：报告生成中） -->
          <div v-else-if="assignment.status === 'running'" class="card card-pad">
            <div class="u-label" style="margin-bottom: 12px">
              报告生成中 · 已完成 {{ assignment.eventCount }} 个事件
            </div>
            <div v-for="w in ['86%', '72%', '90%', '54%']" :key="w" class="sk" :style="{ height: '12px', width: w, marginBottom: '12px' }" />
            <p class="hint">执行不占用会话输入框；完成后报告会回贴原会话。</p>
          </div>

          <!-- 失败 / 超时（错误态） -->
          <div v-else-if="assignment.status === 'failed' || assignment.status === 'timeout'" class="card card-pad">
            <div class="err-block" style="margin-bottom: 24px">
              <div class="err-msg">
                {{ failReason || (assignment.status === "timeout"
                  ? "超过 30 分钟没有结束，已标记超时。已有产出保留。"
                  : "运行时退出，这一轮没有完成。已有产出保留。") }}
              </div>
              <div class="err-actions">
                <button class="btn btn--sm btn--primary" :disabled="rerunning" @click="rerun">重跑</button>
                <a
                  class="btn btn--sm btn--secondary"
                  :href="`/api/assignments/${assignment.id}/report.md`"
                  target="_blank"
                  rel="noopener"
                >导出报告 Markdown</a>
              </div>
            </div>

            <div class="u-label" style="margin-bottom: 8px">最后 50 条事件</div>
            <pre
              v-if="report.tailEvents.length > 0"
              class="u-mono"
              style="margin: 0; padding: 12px; background: var(--color-surface-2); border-radius: 8px; color: var(--color-text-secondary); white-space: pre-wrap"
            >{{ report.tailEvents.join("\n") }}</pre>
            <p v-else class="hint">报告里没有事件尾部（可能失败发生在事件产生之前）。</p>

            <div v-if="report.summary.length > 0" style="margin-top: 20px">
              <div class="u-label" style="margin-bottom: 8px">已有产出</div>
              <ol style="font-size: var(--font-size-body-sm); color: var(--color-text-secondary); line-height: 1.8; padding-left: 1.2em">
                <li v-for="(s, i) in report.summary" :key="i" style="margin-bottom: 6px">{{ s }}</li>
              </ol>
            </div>
          </div>

          <!-- 已完成（正常态） -->
          <div v-else class="card card-pad">
            <div class="u-label" style="margin-bottom: 10px">执行摘要</div>
            <ol
              v-if="report.summary.length > 0"
              style="font-size: var(--font-size-body-sm); color: var(--color-text-secondary); line-height: 1.8; padding-left: 1.2em"
            >
              <li v-for="(s, i) in report.summary" :key="i" style="margin-bottom: 8px">{{ s }}</li>
            </ol>
            <p v-else style="font-size: var(--font-size-caption); color: var(--color-text-muted)">
              报告里没有执行摘要。完整内容见
              <a :href="`/api/assignments/${assignment.id}/report.md`" target="_blank" rel="noopener">Markdown 原文</a>。
            </p>

            <div class="u-label" style="margin: 24px 0 10px">改动文件</div>
            <template v-if="report.files.length > 0">
              <div
                v-for="f in report.files"
                :key="f.path"
                style="display: flex; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--color-border)"
              >
                <span class="u-mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis">{{ f.path }}</span>
                <span class="u-mono" style="color: var(--color-success-ink)">{{ f.added }}</span>
                <span class="u-mono" style="color: var(--color-danger-ink)">{{ f.deleted }}</span>
              </div>
            </template>
            <p v-else style="font-size: var(--font-size-caption); color: var(--color-text-muted)">
              尚未产生文件改动。
            </p>

            <div class="u-label" style="margin: 24px 0 8px">用量</div>
            <div class="usage-line">
              {{ report.usageLines.length > 0 ? report.usageLines.join(" · ") : "— 运行时未上报" }}
            </div>

            <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--color-border); display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
              <span style="font-size: var(--font-size-caption); color: var(--color-text-muted)">
                交付物：{{ assignment.deliverable }}
              </span>
              <span class="spacer" />
              <span class="state state--done">
                <span class="state-dot" :style="{ '--s': 'var(--state-done)' }" />
                已交付 · {{ assignment.endedAt ? dateTimeText(assignment.endedAt) : "—" }}
              </span>
            </div>
          </div>
        </div>

        <!-- 事件流时间线 -->
        <aside class="card card-pad" style="position: sticky; top: 72px; max-height: calc(100vh - 120px); overflow: auto">
          <div class="u-label" style="margin-bottom: 12px">
            事件流
            <span v-if="timelineLoading" class="u-muted" style="font-weight: 400">· 读取中…</span>
          </div>
          <div v-if="timelineError" class="hint" style="color: var(--color-danger-ink)">{{ timelineError }}</div>
          <template v-else-if="timeline.length > 0">
            <div
              v-for="(e, i) in timeline"
              :key="e.id"
              style="display: flex; gap: 8px; font-size: 11px; padding: 4px 0; color: var(--color-text-secondary)"
            >
              <span class="u-mono" :style="{ color: timelineColor(e.tone), width: '12px', textAlign: 'center' }">
                {{ timelineSymbol(e.type) }}
              </span>
              <span class="u-mono" style="color: var(--color-text-muted); width: 20px">{{ String(i + 1).padStart(2, "0") }}</span>
              <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {{ e.label }}<template v-if="e.detail"> · {{ e.detail }}</template>
              </span>
            </div>
          </template>
          <p v-else-if="!timelineLoading" style="font-size: 11px; color: var(--color-text-muted)">
            还没有事件{{ assignment.sessionId ? "" : "（任务还没开始执行）" }}。
          </p>
          <p v-if="assignment.sessionId" class="hint" style="margin-top: 12px">
            时间线来自该任务 Session 的事件回放；首行是 Session 的第一条事件。
          </p>
        </aside>
      </div>
    </template>
  </div>
</template>
