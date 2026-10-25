import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { ProviderDto, ProviderInput } from "../net/types";

/**
 * 模型供应商（内置引擎 N1/N6）。
 *
 * 四态与其它 store 一致：loading | ready | empty | error。
 * 空 = 一个供应商都没配（内置引擎置灰，给「去添加」引导），不是故障。
 */
export type ProvidersStatus = "idle" | "loading" | "ready" | "empty" | "error";

export const useProvidersStore = defineStore("providers", () => {
  const providers = ref<ProviderDto[]>([]);
  const defaultId = ref<string | null>(null);
  const status = ref<ProvidersStatus>("idle");
  const errorText = ref("");

  const readyCount = computed(() => providers.value.length);
  const defaultProvider = computed(
    () => providers.value.find((p) => p.id === defaultId.value) ?? providers.value[0] ?? null,
  );

  function find(id: string | null | undefined): ProviderDto | null {
    if (!id) return null;
    return providers.value.find((p) => p.id === id) ?? null;
  }

  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";
    try {
      const res = await api.providers(signal);
      providers.value = res.providers;
      defaultId.value = res.defaultId;
      status.value = res.providers.length === 0 ? "empty" : "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        providers.value = [];
        defaultId.value = null;
        status.value = "empty";
        return;
      }
      providers.value = [];
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取模型供应商失败";
    }
  }

  async function create(input: ProviderInput & { apiKey: string }): Promise<ProviderDto> {
    const res = await api.createProvider(input);
    providers.value = [...providers.value, res.provider];
    if (res.provider.isDefault || defaultId.value === null) defaultId.value = res.provider.id;
    status.value = "ready";
    return res.provider;
  }

  async function update(id: string, input: Partial<ProviderInput>): Promise<ProviderDto> {
    const res = await api.updateProvider(id, input);
    providers.value = providers.value.map((p) => (p.id === id ? res.provider : p));
    return res.provider;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteProvider(id);
    providers.value = providers.value.filter((p) => p.id !== id);
    if (defaultId.value === id) defaultId.value = providers.value[0]?.id ?? null;
    if (providers.value.length === 0) status.value = "empty";
  }

  async function setDefault(id: string): Promise<void> {
    await api.setDefaultProvider(id);
    defaultId.value = id;
    providers.value = providers.value.map((p) => ({ ...p, isDefault: p.id === id }));
  }

  return {
    providers,
    defaultId,
    status,
    errorText,
    readyCount,
    defaultProvider,
    find,
    load,
    create,
    update,
    remove,
    setDefault,
  };
});
