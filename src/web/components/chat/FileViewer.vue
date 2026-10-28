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
  if (!props.path || !props.botId) return;
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
      <div v-else-if="error" class="field-err" role="alert">{{ error }}</div>
      <div v-else-if="content.length === 0" class="hint">（空文件）</div>
      <pre v-else class="file-viewer-body"><span v-for="(line, i) in lines" :key="i" class="file-line">{{ line }}
</span></pre>
    </div>
  </AppModal>
</template>
