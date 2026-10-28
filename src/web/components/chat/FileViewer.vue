<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ApiError, api } from "../../net/client";
import AppModal from "../common/AppModal.vue";

/**
 * 文件内容查看器（会话页的「查看完整文件」）。
 *
 * 数据源是 `GET /api/files`：服务端按 Bot/Session 解析工作区并用 `resolveInside`
 * 限制路径，前端只传相对路径。diff 块点进来时路径来自 tool_result 的 fileChange，
 * 所以刷新后仍然可用（事件已落库）。
 */
const props = defineProps<{
  botId: string | null;
  sessionId: string | null;
  path: string | null;
}>();

const open = defineModel<boolean>("open", { required: true });

const content = ref("");
const size = ref(0);
const loading = ref(false);
const error = ref("");
const copied = ref(false);

const lines = computed(() => (content.value.length === 0 ? [] : content.value.split("\n")));

async function load(): Promise<void> {
  // botId 还没就绪（Bot 列表异步加载）：**不能**静默 return。
  // 打开时 botId 为 null 的话，旧实现既不加载也不提示，用户看到的是一张
  // 空白弹层，只能关掉重开（与文件面板同一类问题）。这里给一句可读的提示；
  // 下方 watch 会在 botId 到位后自动补拉。
  if (!props.path) return;
  if (!props.botId) {
    content.value = "";
    size.value = 0;
    error.value = "正在解析这个文件所属的 Bot，请稍候…";
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = "";
  copied.value = false;
  try {
    const res = await api.file({
      botId: props.botId,
      sessionId: props.sessionId,
      path: props.path,
    });
    content.value = res.content;
    size.value = res.size;
  } catch (err) {
    content.value = "";
    size.value = 0;
    error.value =
      err instanceof ApiError
        ? (err.bodyMessage ?? err.code)
        : err instanceof Error
          ? err.message
          : "读取文件失败";
  } finally {
    loading.value = false;
  }
}

watch(
  () => [open.value, props.path, props.botId, props.sessionId],
  () => {
    if (open.value) void load();
  },
);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(content.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1500);
  } catch {
    // 无剪贴板权限时静默失败（用户仍可手动选中）
  }
}
</script>

<template>
  <AppModal v-model:open="open" :title="path ?? '文件内容'" width="920px">
    <div class="file-viewer">
      <div class="file-viewer-head">
        <span class="u-mono file-viewer-path" :title="path ?? ''">{{ path }}</span>
        <span class="spacer" />
        <span v-if="size > 0" class="u-faint">{{ size }} 字节</span>
        <button class="btn btn--sm btn--ghost" :disabled="content.length === 0" @click="copy">
          {{ copied ? "已复制" : "复制内容" }}
        </button>
        <button class="btn btn--sm btn--ghost" :disabled="loading" @click="load">刷新</button>
      </div>
      <div v-if="loading" class="hint">读取中…</div>
      <!-- 「正在解析 Bot」不是错误：用提示样式，不要红色告警 -->
      <div v-else-if="error && error.startsWith('正在解析')" class="hint">{{ error }}</div>
      <div v-else-if="error" class="field-err" role="alert">{{ error }}</div>
      <div v-else-if="content.length === 0" class="hint">（空文件）</div>
      <pre v-else class="file-viewer-body"><span v-for="(line, i) in lines" :key="i" class="file-line">{{ line }}
</span></pre>
    </div>
  </AppModal>
</template>
