import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { SetupStateResponse, SetupStepKey } from "../net/types";

/**
 * 初始化引导的状态（N1）。
 *
 * 服务端 `GET /api/setup/state` 是唯一口径（首启跳转与侧栏提示都读它），
 * 本 store 只做缓存与派生。四态与其它 store 一致，但**加载失败不阻断应用**：
 * 拿不到状态时按「不需要引导」处理 —— 宁可少提示一次，也不要把用户堵在向导页。
 */
export type SetupStatus = "idle" | "loading" | "ready" | "error";

export const useSetupStore = defineStore("setup", () => {
  const state = ref<SetupStateResponse | null>(null);
  const status = ref<SetupStatus>("idle");
  const errorText = ref("");
  /** 已经主动「稍后再说」过：本次会话不再自动跳转（刷新后重新判断）。 */
  const dismissed = ref(false);

  const needsSetup = computed(() => state.value?.needsSetup === true && !dismissed.value);
  const completed = computed(() => state.value?.completed ?? 0);
  const total = computed(() => state.value?.total ?? 5);
  const steps = computed(() => state.value?.steps ?? []);

  function stepOf(key: SetupStepKey): { done: boolean; detail: string } {
    const step = state.value?.steps.find((s) => s.key === key);
    return { done: step?.done === true, detail: step?.detail ?? "" };
  }

  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";
    try {
      state.value = await api.setupState(signal);
      status.value = "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        // 旧服务没有这个端点：不引导，避免把用户锁在一个空向导里
        state.value = null;
        status.value = "ready";
        return;
      }
      state.value = null;
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取初始化状态失败";
    }
  }

  /** 用户点「稍后再说」：本次会话不再自动跳转，侧栏提示仍保留。 */
  function dismiss(): void {
    dismissed.value = true;
  }

  /** 某个步骤完成 / 配置变化后刷新；失败静默（不打断当前操作）。 */
  async function refresh(): Promise<void> {
    try {
      state.value = await api.setupState();
      status.value = "ready";
    } catch {
      // 保持上一次的状态
    }
  }

  return {
    state,
    status,
    errorText,
    dismissed,
    needsSetup,
    completed,
    total,
    steps,
    stepOf,
    load,
    dismiss,
    refresh,
  };
});
