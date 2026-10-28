<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ApiError, api } from "../../net/client";
import type { ChangedFileDto, FileContentDto, FileDiffDto, FileTreeEntryDto } from "../../net/types";
import AppIcon from "../common/AppIcon.vue";
import AppModal from "../common/AppModal.vue";

/**
 * 工作区文件面板（2026-10-28 移动端反馈：界面上无法查看文件内容 / diff）。
 *
 * 两个标签：
 *   改动 —— `git status` 的改动文件 + 单文件 unified diff（未跟踪文件按全文新增合成）
 *   文件 —— 工作区目录树 + 文本内容查看
 *
 * 为什么放在会话页而不是 Bot 详情：用户是在「这一轮改了什么」的上下文里点进来的，
 * 工作区也是按会话/渠道回退链解析的（内置引擎的 cwd 就是它）。
 *
 * 安全：所有路径都由服务端用 `resolveInside` 限制在工作区内，越界回 403；
 * 前端只负责把用户选中的相对路径发过去，绝不拼绝对路径。
 */
const props = defineProps<{
  botId: string | null;
  sessionId: string | null;
  /** 外部请求打开的路径（diff 块的「查看完整文件」）。 */
  initialPath?: string | null;
}>();

const open = defineModel<boolean>("open", { required: true });

type Tab = "changes" | "tree";
const tab = ref<Tab>("changes");

const workspace = ref("");
const changes = ref<ChangedFileDto[]>([]);
const gitAvailable = ref(true);
const changesMessage = ref("");
const tree = ref<FileTreeEntryDto[]>([]);
const treeTruncated = ref(false);

const selected = ref<string | null>(null);
const content = ref<FileContentDto | null>(null);
const diff = ref<FileDiffDto | null>(null);
const loading = ref(false);
const detailLoading = ref(false);
const error = ref("");
/** 上次成功加载对应的 `botId:sessionId`：props 迟到时用来判断要不要补拉。 */
const loadedFor = ref<string | null>(null);

const selectedChange = computed(() =>
  selected.value ? (changes.value.find((f) => f.path === selected.value) ?? null) : null,
);

/** diff 行拆分（服务端给的是 unified diff 原文）。 */
const diffLines = computed(() => {
  const text = diff.value?.diff ?? "";
  if (text.length === 0) return [];
  return text.split("\n").map((line) => ({
    kind: line.startsWith("+") && !line.startsWith("+++")
      ? "add"
      : line.startsWith("-") && !line.startsWith("---")
        ? "del"
        : line.startsWith("@@")
          ? "hunk"
          : "ctx",
    text: line,
  }));
});

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.bodyMessage ?? err.code;
  return err instanceof Error ? err.message : "加载失败";
}

async function loadList(): Promise<void> {
  // botId 还没就绪（Bot 列表尚未加载完）时**不能**静默返回：
  // 旧实现在这里 return，而加载只在「打开面板」那一刻触发一次 ——
  // 打开时 botId 为 null 就永久空白，用户只能关掉重开（真机偶发踩到，
  // 面板显示「工作区未解析 / 工作区没有未提交的改动」，实际后端有 2 个改动）。
  // 现在由下方 watch 在 botId 到位后补一次，这里只负责不发无效请求。
  if (!props.botId) {
    loadedFor.value = null;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const res = await api.fileChanges({ botId: props.botId, sessionId: props.sessionId });
    workspace.value = res.workspace;
    changes.value = res.files;
    gitAvailable.value = res.git;
    changesMessage.value = res.message ?? "";
    loadedFor.value = `${props.botId}:${props.sessionId ?? ""}`;
    if (tab.value === "tree") await loadTree();
  } catch (err) {
    error.value = messageOf(err);
  } finally {
    loading.value = false;
  }
}

async function loadTree(): Promise<void> {
  if (!props.botId) return;
  try {
    const res = await api.fileTree({ botId: props.botId, sessionId: props.sessionId });
    workspace.value = res.workspace;
    tree.value = res.entries;
    treeTruncated.value = res.truncated;
  } catch (err) {
    error.value = messageOf(err);
  }
}

async function selectFile(path: string): Promise<void> {
  if (!props.botId) return;
  selected.value = path;
  detailLoading.value = true;
  error.value = "";
  content.value = null;
  diff.value = null;
  try {
    // 两个请求并行：diff 可能不存在（未改动），内容也可能不可读（二进制）
    const [fileRes, diffRes] = await Promise.allSettled([
      api.file({ botId: props.botId, sessionId: props.sessionId, path }),
      api.fileDiff({ botId: props.botId, sessionId: props.sessionId, path }),
    ]);
    if (fileRes.status === "fulfilled") content.value = fileRes.value;
    if (diffRes.status === "fulfilled") diff.value = diffRes.value;
    if (fileRes.status === "rejected" && diffRes.status === "rejected") {
      error.value = messageOf(fileRes.reason);
    }
  } finally {
    detailLoading.value = false;
  }
}

function switchTab(next: Tab): void {
  tab.value = next;
  if (next === "tree" && tree.value.length === 0) void loadTree();
}

async function refresh(): Promise<void> {
  await loadList();
  if (selected.value) await selectFile(selected.value);
}

watch(
  () => open.value,
  async (isOpen) => {
    if (!isOpen) return;
    await loadList();
    if (props.initialPath) await selectFile(props.initialPath);
  },
);

/**
 * botId / sessionId 迟到（Bot 列表异步加载、发送后新建 Session）时补一次。
 *
 * 面板通常在会话页挂载时就存在，打开那一刻 props 可能还是 null；
 * 只依赖 open 的 watch 会让面板永久停在空白态（真机偶发）。
 */
watch(
  () => [props.botId, props.sessionId] as const,
  async () => {
    if (!open.value) return;
    const key = `${props.botId ?? ""}:${props.sessionId ?? ""}`;
    if (props.botId && loadedFor.value !== key) await loadList();
  },
);

watch(
  () => props.initialPath,
  (path) => {
    if (open.value && path) void selectFile(path);
  },
);

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}
</script>

<template>
  <AppModal v-model:open="open" title="工作区文件" width="980px">
    <div class="ws-panel">
      <div class="ws-tabs">
        <button class="ws-tab" :class="{ 'is-on': tab === 'changes' }" @click="switchTab('changes')">
          改动<template v-if="changes.length > 0"> · {{ changes.length }}</template>
        </button>
        <button class="ws-tab" :class="{ 'is-on': tab === 'tree' }" @click="switchTab('tree')">文件</button>
        <span class="spacer" />
        <span class="ws-ws u-mono" :title="workspace">{{ workspace || "工作区未解析" }}</span>
        <button class="btn btn--sm btn--ghost" :disabled="loading" @click="refresh">刷新</button>
      </div>

      <div v-if="error" class="field-err" role="alert">{{ error }}</div>

      <div class="ws-body">
        <div class="ws-list">
          <template v-if="tab === 'changes'">
            <div v-if="loading" class="hint">读取改动…</div>
            <div v-else-if="!gitAvailable" class="hint">{{ changesMessage || "工作区不是 git 仓库" }}</div>
            <div v-else-if="changes.length === 0" class="hint">工作区没有未提交的改动。</div>
            <button
              v-for="f in changes"
              :key="f.path"
              class="ws-file"
              :class="{ 'is-on': f.path === selected }"
              @click="selectFile(f.path)"
            >
              <span class="ws-status u-mono">{{ f.status }}</span>
              <span class="ws-path u-mono" :title="f.path">{{ f.path }}</span>
              <span class="ws-stat">
                <span v-if="f.insertions !== null" class="add">+{{ f.insertions }}</span>
                <span v-if="f.deletions !== null" class="del">−{{ f.deletions }}</span>
              </span>
            </button>
          </template>

          <template v-else>
            <div v-if="tree.length === 0" class="hint">目录为空，或还没有加载。</div>
            <button
              v-for="e in tree"
              :key="e.path"
              class="ws-file"
              :class="{ 'is-on': e.path === selected, 'is-dir': e.type === 'dir' }"
              :style="{ paddingLeft: `${8 + (e.path.split('/').length - 1) * 14}px` }"
              @click="e.type === 'file' ? selectFile(e.path) : undefined"
            >
              <span class="ws-status">{{ e.type === "dir" ? "▸" : "·" }}</span>
              <span class="ws-path u-mono" :title="e.path">{{ e.name }}</span>
              <span v-if="e.type === 'file'" class="ws-stat u-faint">{{ e.size }}B</span>
            </button>
            <div v-if="treeTruncated" class="hint">目录过大，只列了前 500 项。</div>
          </template>
        </div>

        <div class="ws-detail">
          <div v-if="!selected" class="hint">选一个文件查看内容或 diff。</div>
          <div v-else-if="detailLoading" class="hint">读取…</div>
          <template v-else>
            <div class="ws-detail-head">
              <span class="u-mono ws-path" :title="selected">{{ selected }}</span>
              <span class="spacer" />
              <span v-if="content" class="u-faint">{{ content.size }} 字节</span>
              <button v-if="content" class="btn btn--sm btn--ghost" @click="copy(content.content)">复制内容</button>
              <button v-if="diff?.diff" class="btn btn--sm btn--ghost" @click="copy(diff.diff)">复制 diff</button>
            </div>

            <div v-if="diff?.diff" class="ws-section">
              <div class="ws-section-title">
                diff
                <span class="ws-stat">
                  <span v-if="diff.insertions !== null" class="add">+{{ diff.insertions }}</span>
                  <span v-if="diff.deletions !== null" class="del">−{{ diff.deletions }}</span>
                </span>
              </div>
              <pre class="ws-diff"><span
                v-for="(line, i) in diffLines"
                :key="i"
                class="diff-line"
                :class="`is-${line.kind}`"
              >{{ line.text }}
</span></pre>
            </div>
            <div v-if="content" class="ws-section">
              <div class="ws-section-title">
                内容<template v-if="selectedChange"> · 当前工作区版本</template>
              </div>
              <pre class="ws-content">{{ content.content }}</pre>
            </div>
            <div v-if="!content && !diff?.diff" class="hint">
              这个文件没有可展示的文本内容（可能是二进制，或没有改动）。
            </div>
          </template>
        </div>
      </div>
    </div>
  </AppModal>
</template>
