<script setup lang="ts">
import { computed, ref } from "vue";
import type { FileChangeView } from "../../lib/turnModel";

/**
 * 写类工具结果的 diff 块（2026-10-28 移动端反馈：界面上看不到改了什么）。
 *
 * 为什么自己渲染而不是丢一个 `<pre>` 让用户读 unified diff：
 * 手机屏幕窄，纯文本 diff 的 +/- 前缀很难扫；这里按行着色、默认折叠上下文，
 * 并把「查看完整文件」做成显式按钮（走 `/api/files`，不是从事件里猜内容）。
 *
 * 数据来自 `tool_result.fileChange`（内置引擎的 write_file / edit_file 附带），
 * 所以刷新后仍在、其它标签页也能看到，不依赖前端内存。
 */
const props = defineProps<{
  change: FileChangeView;
}>();

const emit = defineEmits<{ view: [path: string] }>();

/** 是否展开全部上下文；默认只显示变更行前后各 2 行。 */
const showAll = ref(false);

interface Row {
  kind: " " | "+" | "-";
  text: string;
  /** 上下文行在折叠时是否省略。 */
  hidden: boolean;
}

const rows = computed<Row[]>(() => {
  const lines = props.change.diff.split("\n").filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  if (showAll.value || lines.length <= 200) {
    return lines.map((line) => ({
      kind: line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ",
      text: line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line,
      hidden: false,
    }));
  }
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (line.startsWith("+") || line.startsWith("-")) {
      for (let d = -2; d <= 2; d += 1) keep.add(i + d);
    }
  });
  return lines.map((line, i) => ({
    kind: line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ",
    text: line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line,
    hidden: !keep.has(i),
  }));
});

const hiddenCount = computed(() => rows.value.filter((r) => r.hidden).length);
</script>

<template>
  <div class="file-diff">
    <div class="file-diff-head">
      <span class="file-diff-path u-mono">{{ change.path }}</span>
      <span class="file-diff-stat">
        <span class="add">+{{ change.added }}</span>
        <span class="del">−{{ change.removed }}</span>
        <span v-if="change.truncated" class="u-faint">（已截断）</span>
      </span>
      <span class="spacer" />
      <button class="btn btn--sm btn--ghost" @click="emit('view', change.path)">查看完整文件</button>
      <button
        v-if="hiddenCount > 0"
        class="btn btn--sm btn--ghost"
        @click="showAll = !showAll"
      >{{ showAll ? "收起上下文" : `展开全部（省略 ${hiddenCount} 行）` }}</button>
    </div>
    <pre class="file-diff-body"><template v-for="(row, i) in rows" :key="i"><span
      v-if="!row.hidden"
      class="diff-line"
      :class="row.kind === '+' ? 'is-add' : row.kind === '-' ? 'is-del' : 'is-ctx'"
    >{{ row.kind }}{{ row.text }}
</span><span v-else class="diff-skip">⋯
</span></template></pre>
  </div>
</template>
