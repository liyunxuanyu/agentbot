<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { UsageRange, UsageResponseDto, UsageRowDto } from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useRuntimesStore } from "../stores/runtimes";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { num } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import EmptyState from "../components/common/EmptyState.vue";

/**
 * /usage —— 用量（UX §4.1 / UI §8.3，P0-12）。
 *
 * 硬规则（PRD Q3 已决 A）：**只信运行时上报**。未上报的行显示 `—`，不估算、不填 0 ——
 * 0 会被读成「这轮没花 token」，而实际是「它没告诉我们」。
 *
 * 四态：
 *   加载 = 表格骨架
 *   错误 = 「查询失败」+ 重试，**筛选条件保留**
 *   空   = 「还没有可统计的调用」+ 一句说明
 *   正常 = 行 + 合计行 + 占比条
 *
 * 数据形状：后端按 `botId × runtimeId × mode` 聚合，一行一个组合。
 * 同一 Bot 在同一运行时上既有交互又有 headless 调用时会出现两行 —— 这是对的，
 * 因为倍率不同（headless 通常 ×3），合成一行就没法解释成本。
 */
const ui = useUiStore();
const bots = useBotsStore();
const runtimes = useRuntimesStore();

const RANGES: { key: UsageRange; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "7d", label: "7 天" },
  { key: "30d", label: "30 天" },
  { key: "all", label: "全部" },
];

const range = ref<UsageRange>("7d");
const botFilter = ref("all");
const runtimeFilter = ref("all");

const data = ref<UsageResponseDto | null>(null);
const status = ref<"idle" | "loading" | "ready" | "empty" | "error">("idle");
const errorText = ref("");

async function load(): Promise<void> {
  status.value = "loading";
  errorText.value = "";
  try {
    const res = await api.usage({
      range: range.value,
      ...(botFilter.value === "all" ? {} : { botId: botFilter.value }),
      ...(runtimeFilter.value === "all" ? {} : { runtimeId: runtimeFilter.value }),
    });
    data.value = res;
    status.value = res.rows.length === 0 ? "empty" : "ready";
  } catch (err) {
    if (isMissingEndpoint(err)) {
      data.value = null;
      status.value = "empty";
      return;
    }
    errorText.value = err instanceof Error ? err.message : "查询失败";
    status.value = "error";
  }
}

function setRange(r: UsageRange): void {
  range.value = r;
  void load();
}

function setBot(id: string): void {
  botFilter.value = id;
  void load();
}

function setRuntime(id: string): void {
  runtimeFilter.value = id;
  void load();
}

/** 占比条的最大值：输入 + 输出 token 的总和（未上报行不参与）。 */
const maxTotal = computed(() => {
  const rows = data.value?.rows ?? [];
  let max = 0;
  for (const r of rows) {
    const total = (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    if (total > max) max = total;
  }
  return max;
});

function pctOf(row: UsageRowDto): number {
  const total = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  if (total === 0 || maxTotal.value === 0) return 0;
  return Math.max(3, Math.round((total / maxTotal.value) * 100));
}

/** 行名：Bot 已删除时用占位名 + chip，不留空。 */
function rowName(row: UsageRowDto): string {
  return row.botName ?? "已删除 Bot";
}

function rowColorIndex(row: UsageRowDto): number {
  return row.colorIndex ?? 8;
}

function rowStyle(row: UsageRowDto) {
  return botVars({ colorIndex: rowColorIndex(row) });
}

/** 一行是否「完全未上报」（token 全 null 且请求数 > 0）。 */
function isUnreported(row: UsageRowDto): boolean {
  return row.inputTokens === null && row.outputTokens === null;
}

/** 模式标签：headless 带倍率提示（UI §8.3）。 */
function modeText(row: UsageRowDto): string {
  if (isUnreported(row)) return "未上报";
  if (row.mode === "headless") return `headless ×${row.multiplier}`;
  return `交互 ×${row.multiplier}`;
}

/** 缓存命中率：未上报（null）显示 —，不按 0 处理。 */
function cacheRateText(rate: number | null): string {
  if (rate === null) return "—";
  return `${rate.toFixed(1).replace(/\.0$/, "")}%`;
}

/** 悬停给出口径：命中 token / 输入 token。 */
function cacheTitle(row: UsageRowDto): string {
  if (row.cacheHitRate === null) return "该行没有缓存上报";
  return `命中 ${num(row.cachedInputTokens)} / 输入 ${num(row.cacheInputTokens)} token（只算缓存已上报的请求）`;
}

const totals = computed(() => data.value?.totals ?? null);

/** 导出 CSV：直接跳转（带 token 的 URL），由浏览器下载。 */
function exportCsv(): void {
  window.location.href = api.usageCsvUrl({
    range: range.value,
    ...(botFilter.value === "all" ? {} : { botId: botFilter.value }),
    ...(runtimeFilter.value === "all" ? {} : { runtimeId: runtimeFilter.value }),
  });
  ui.toast("开始下载 CSV");
}

onMounted(async () => {
  ui.setCrumb([{ text: "用量" }]);
  if (bots.bots.length === 0) void bots.load();
  if (runtimes.runtimes.length === 0) void runtimes.load();
  await load();
});
</script>

<template>
  <div>
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">用量</h1>
        <p class="page-desc">
          按 Bot × 运行时聚合。数值全部来自运行时上报；没上报的显示 —，不估算。
        </p>
      </div>
      <div class="spacer" />
      <button class="btn btn--secondary" @click="exportCsv">导出 CSV</button>
    </div>

    <!-- 筛选条（错误态也保留，重试时条件不丢） -->
    <div class="filters enter" :style="{ '--i': 1 }">
      <div class="filter-group">
        <span class="u-label">范围</span>
        <button
          v-for="r in RANGES"
          :key="r.key"
          class="chip"
          :class="{ 'is-on': range === r.key }"
          @click="setRange(r.key)"
        >{{ r.label }}</button>
      </div>
      <div class="filter-group">
        <span class="u-label">Bot</span>
        <button class="chip" :class="{ 'is-on': botFilter === 'all' }" @click="setBot('all')">全部</button>
        <button
          v-for="b in bots.bots.slice(0, 6)"
          :key="b.id"
          class="chip"
          :class="{ 'is-on': botFilter === b.id }"
          @click="setBot(b.id)"
        >{{ b.name }}</button>
      </div>
      <div class="filter-group">
        <span class="u-label">运行时</span>
        <button class="chip" :class="{ 'is-on': runtimeFilter === 'all' }" @click="setRuntime('all')">全部</button>
        <button
          v-for="r in runtimes.runtimes"
          :key="r.id"
          class="chip"
          :class="{ 'is-on': runtimeFilter === r.id }"
          @click="setRuntime(r.id)"
        >{{ r.displayName }}</button>
      </div>
    </div>

    <!-- 加载态 -->
    <div v-if="status === 'loading' || status === 'idle'" class="rows">
      <div v-for="i in 6" :key="i" class="row-item" aria-hidden="true">
        <span class="sk sk-line" style="width: 80%; display: block" />
      </div>
    </div>

    <!-- 错误态 -->
    <div v-else-if="status === 'error'" class="banner">
      <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
      <span>查询失败{{ errorText ? `：${errorText}` : "。" }}筛选条件已保留。</span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="load">重试</button>
    </div>

    <!-- 空态 -->
    <EmptyState
      v-else-if="status === 'empty'"
      title="还没有可统计的调用"
      description="每轮对话结束后 5 秒内，用量会出现在这里。运行时不上报的，会单列成「未上报」。"
    >
      <template #icon><AppIcon name="chart" :size="24" /></template>
      <template #actions>
        <RouterLink class="btn btn--secondary" to="/chats">去发一条消息</RouterLink>
      </template>
    </EmptyState>

    <!-- 正常态 -->
    <template v-else-if="data">
      <div class="card" style="padding: 8px">
        <div class="grid-row is-head usage-head">
          <span>Bot</span><span>运行时</span>
          <span class="usage-nums">
            <span>请求数</span><span>输入 token</span><span>输出 token</span><span>缓存命中率</span>
          </span>
          <span>占比 / 模式</span>
        </div>
        <div
          v-for="(row, i) in data.rows"
          :key="`${row.botId}-${row.runtimeId ?? 'none'}-${row.mode}`"
          class="grid-row usage-row enter"
          :class="{ 'is-dim': row.deleted }"
          :style="{ '--i': Math.min(i + 2, 5) }"
        >
          <span class="usage-bot" style="display: flex; align-items: center; gap: 10px; min-width: 0">
            <BotAvatar
              :name="rowName(row)"
              :color-index="rowColorIndex(row)"
              :size="28"
            />
            <span style="min-width: 0" :style="rowStyle(row)">
              <span style="font-size: var(--font-size-caption); font-weight: var(--weight-semibold); color: var(--bc-ink)">
                {{ rowName(row) }}
              </span>
              <span v-if="row.deleted" class="cap cap--no" style="margin-left: 6px">已删除 Bot</span>
            </span>
          </span>
          <span class="rt-chip usage-rt" style="justify-self: start">{{ row.runtimeName ?? "—" }}</span>
          <span class="usage-nums">
            <span class="cell-num" data-label="请求数">{{ row.requests }}</span>
            <span class="cell-num" data-label="输入 token">{{ num(row.inputTokens) }}</span>
            <span class="cell-num" data-label="输出 token">{{ num(row.outputTokens) }}</span>
            <span class="cell-num" data-label="缓存命中率" :title="cacheTitle(row)">
              {{ cacheRateText(row.cacheHitRate) }}
              <span v-if="row.cacheHitRate !== null" class="cell-sub" style="display: block">
                {{ num(row.cachedInputTokens) }} / {{ num(row.cacheInputTokens) }}
              </span>
            </span>
          </span>
          <span class="usage-bar-cell" :style="rowStyle(row)">
            <span class="bar-track"><span class="bar-fill" :style="{ width: `${pctOf(row)}%` }" /></span>
            <span class="u-mono" style="color: var(--color-text-muted); font-size: 11px">{{ modeText(row) }}</span>
          </span>
        </div>

        <!-- 合计行 -->
        <div
          v-if="totals"
          class="grid-row is-head usage-total"
          style="border-top: 1px solid var(--color-border); background: var(--color-surface-2); border-radius: 0 0 10px 10px; color: var(--color-text-secondary); min-height: 48px"
        >
          <span style="font-weight: var(--weight-bold); color: var(--color-text)">合计</span><span />
          <span class="usage-nums">
            <span class="cell-num" data-label="请求数" style="font-weight: var(--weight-bold); color: var(--color-text)">{{ totals.requests }}</span>
            <span class="cell-num" data-label="输入 token" style="font-weight: var(--weight-bold); color: var(--color-text)">{{ num(totals.inputTokens) }}</span>
            <span class="cell-num" data-label="输出 token" style="font-weight: var(--weight-bold); color: var(--color-text)">{{ num(totals.outputTokens) }}</span>
            <span class="cell-num" data-label="缓存命中率" style="font-weight: var(--weight-bold); color: var(--color-text)">
              {{ cacheRateText(totals.cacheHitRate) }}
              <span v-if="totals.cacheHitRate !== null" class="cell-sub" style="display: block">
                {{ num(totals.cachedInputTokens) }} / {{ num(totals.cacheInputTokens) }}
              </span>
            </span>
          </span>
          <span />
        </div>
      </div>

      <p class="hint">
        headless 模式按运行时声明的倍率标注；未上报 token 的运行时（例如 CLI 通道）聚合时不估算，
        单列显示 —。合计行的 token 只累计已上报部分。
        缓存命中率 = 缓存读取 token / 输入 token；供应商没有上报缓存字段时显示 —。
        <template v-if="totals && totals.unreportedRequests > 0">
          当前有 {{ totals.unreportedRequests }} 次请求未上报。
        </template>
      </p>
    </template>
  </div>
</template>
