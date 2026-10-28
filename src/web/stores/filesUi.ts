import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 工作区文件面板的「外部打开请求」。
 *
 * 为什么单独一个极小的 store：diff 块在四层组件里（EventRow → TurnBodyItem →
 * TurnItem → StreamRowItem），把「点查看文件」的回调一路 emit 上去要改四个组件的
 * props/emits；而打开文件面板是一个纯 UI 意图，用 store 传一次更不容易漏。
 *
 * 真正的数据加载与展示在 `WorkspacePanel.vue`，这里只放一个路径。
 */
export const useFilesUiStore = defineStore("filesUi", () => {
  /** 非 null 表示「请打开文件面板并定位到这个路径」。 */
  const pendingPath = ref<string | null>(null);

  function requestOpen(path: string): void {
    pendingPath.value = path;
  }

  function consume(): string | null {
    const path = pendingPath.value;
    pendingPath.value = null;
    return path;
  }

  return { pendingPath, requestOpen, consume };
});
