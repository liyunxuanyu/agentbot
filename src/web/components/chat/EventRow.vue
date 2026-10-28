<script setup lang="ts">
import { computed, ref } from "vue";
import type { BotDto } from "../../net/types";
import type { DisplayEvent } from "../../lib/turnModel";
import { botVars } from "../../lib/botVars";
import EventBlock from "./EventBlock.vue";
import DiffBlock from "./DiffBlock.vue";
import { useFilesUiStore } from "../../stores/filesUi";

/**
 * 单条事件渲染器（原型 evHtml() 的 switch）。
 *
 * 职责：把一个 DisplayEvent 映射成原型里的 DOM 结构。9 类事件里：
 *   思考 / 工具调用 / 工具结果 / 计划 → 折叠块（32px 一行）
 *   用量 / 结束                       → 极轻单行
 *   错误                              → 常显人话块 + 技术原文折叠
 *   权限请求                          → 由 PermissionCard 渲染（TurnItem 分派）
 *   消息增量                          → 由 MessageBubble 渲染（TurnItem 分派）
 *
 * 工具结果挂在调用下：tool_call 的 result 非空时，在同一条 EventRow 里
 * 再渲染一个 .ev--result（缩进 12），与原型一致。
 */
const props = defineProps<{
  event: DisplayEvent;
  bot: BotDto | null;
  /** 事件在 Turn 内的稳定 key。 */
  uid: string;
}>();

const emit = defineEmits<{ resend: [] }>();

/** 「查看完整文件」直接写进 filesUi store：它挂在四层组件里，逐层 emit 容易漏。 */
const filesUi = useFilesUiStore();

const detailOpen = ref(false);

const vars = computed(() => (props.bot ? botVars(props.bot) : {}));

const thoughtSummary = computed(() => {
  const e = props.event;
  if (e.kind !== "thought") return "";
  const chars = e.text.length;
  const parts = [e.streaming ? "思考中" : "思考"];
  if (chars > 0) parts.push(`${chars} 字`);
  return parts.join(" · ");
});

const toolSummary = computed(() => {
  const e = props.event;
  if (e.kind !== "tool_call") return "";
  const target = extractTarget(e.input);
  return target ? `${e.name} ${target}` : e.name;
});

const planView = computed(() => {
  const e = props.event;
  if (e.kind !== "plan") return { text: "", pct: 0 };
  const total = e.entries.length;
  const done = e.entries.filter((x) => x.status === "done").length;
  return { text: `计划 ${total} 项 · ${done} 完成`, pct: total > 0 ? done / total : 0 };
});

/** 工具结果行文案：`成功 · 42 行输出` / `失败 · exit 1`。 */
const resultView = computed(() => {
  const e = props.event;
  if (e.kind !== "tool_call" || !e.result) return null;
  const r = e.result;
  const lines = r.output.length > 0 ? r.output.split("\n").length : 0;
  if (r.status === "ok") {
    return { ok: true, text: `成功${lines > 0 ? ` · ${lines} 行输出` : ""}${r.truncated ? "（已截断）" : ""}` };
  }
  return {
    ok: false,
    text: `失败${r.exitCode !== null ? ` · exit ${r.exitCode}` : ""}${lines > 0 ? ` · ${lines} 行输出` : ""}`,
  };
});

/** 从 tool_call 的 input 里挖可读目标（原型展示 `Read src/auth.ts`）。 */
function extractTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return "";
  const rec = input as Record<string, unknown>;
  for (const key of ["path", "file", "file_path", "command", "cmd", "url", "query"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
</script>

<template>
  <div :style="vars">
    <!-- 思考：虚线灰左轨 -->
    <EventBlock
      v-if="event.kind === 'thought'"
      :uid="uid"
      variant="think"
      :summary="thoughtSummary"
    >
      <pre>{{ event.text || "（无内容）" }}</pre>
    </EventBlock>

    <!-- 工具调用 + 挂在其下的结果 -->
    <template v-else-if="event.kind === 'tool_call'">
      <EventBlock
        :uid="uid"
        variant="tool"
        :running="event.status === 'running' && !event.result"
        :summary="toolSummary"
        mono
      >
        <pre>{{ prettyJson(event.input ?? {}) }}</pre>
      </EventBlock>
      <!-- 写类工具：改动 diff 直接挂在结果行下面（移动端也能看清改了什么） -->
      <DiffBlock
        v-if="event.result?.fileChange"
        :change="event.result.fileChange"
        @view="(p) => filesUi.requestOpen(p)"
      />
      <EventBlock
        v-if="resultView"
        :uid="`${uid}-r`"
        variant="result"
        :ok="resultView.ok"
        :summary="resultView.text"
      >
        <pre>{{ event.result!.output || "（无输出）" }}</pre>
      </EventBlock>
    </template>

    <!-- 计划：环形进度 -->
    <EventBlock
      v-else-if="event.kind === 'plan'"
      :uid="uid"
      variant="plan"
      :summary="planView.text"
      :pct="planView.pct"
    >
      <ul class="ev-plan-list">
        <li v-for="(entry, i) in event.entries" :key="i">
          <span
            class="plan-dot"
            :class="{ 'is-done': entry.status === 'done', 'is-doing': entry.status === 'in_progress' }"
          />
          {{ entry.content }}
        </li>
      </ul>
    </EventBlock>

    <!-- 用量：极轻单行 -->
    <div v-else-if="event.kind === 'usage'" class="ev">
      <div class="usage-line">
        <span>∑</span>
        <span v-if="event.reported">
          {{ event.inputTokens.toLocaleString("en-US") }} in /
          {{ event.outputTokens.toLocaleString("en-US") }} out
        </span>
        <span v-else>用量未上报</span>
      </div>
    </div>

    <!-- 结束：状态戳 -->
    <div v-else-if="event.kind === 'done'" class="ev">
      <div class="end-stamp">
        <span
          class="state-dot"
          :style="{
            '--s':
              event.stopReason === 'error' || event.stopReason === 'cancelled'
                ? 'var(--state-blocked)'
                : 'var(--state-done)',
          }"
        />
        {{ event.stopReason === "cancelled"
          ? "已中断"
          : event.stopReason === "max_tokens"
            ? "达到长度上限"
            : event.stopReason === "error"
              ? "失败"
              : "完成" }}
        · {{ (event.durationMs / 1000).toFixed(1) }}s
      </div>
    </div>

    <!-- 错误：人话块 + 技术原文折叠（UX §6.3） -->
    <div v-else-if="event.kind === 'error'" class="ev">
      <div class="err-block">
        <div class="err-msg">{{ event.message }}</div>
        <div class="err-actions">
          <button class="btn btn--sm btn--primary" @click="emit('resend')">重发</button>
          <button
            class="btn btn--sm btn--ghost"
            :aria-expanded="detailOpen"
            :aria-controls="`ev-body-${uid}-d`"
            @click="detailOpen = !detailOpen"
          >{{ detailOpen ? "收起详情" : "查看详情" }}</button>
        </div>
        <div class="ev-body" :class="{ 'is-open': detailOpen }" :id="`ev-body-${uid}-d`">
          <pre>{{ event.detail ?? `code: ${event.code}` }}</pre>
        </div>
      </div>
    </div>

    <!-- 未知事件：虚线块 + 原始 JSON（P0-05 降级，不丢弃） -->
    <EventBlock
      v-else-if="event.kind === 'unknown'"
      :uid="uid"
      variant="unknown"
      :summary="`未知事件 · ${event.typeName} · 缺 ${event.missing.join(' / ')} · 已保留原始 JSON`"
    >
      <pre>{{ prettyJson(event.raw) }}</pre>
    </EventBlock>
  </div>
</template>
