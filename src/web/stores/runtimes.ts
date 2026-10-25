import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { CreateRuntimeRequest, RuntimeDetailDto } from "../net/types";
import {
  runtimeReason,
  runtimeStatusWord,
  runtimeUnavailable,
  type RuntimeLike,
} from "../lib/runtime";

/**
 * 运行时列表（`GET /api/runtimes`）—— 设置页与首启向导共用。
 *
 * 与 `bots` store 的分工：`bots.runtimes` 来自 `/api/meta`，只有 id/名称/协议/健康态，
 * 用于 Bot 列表的筛选与汇总条。本 store 拿**完整行**：`availability`（区分「没装」与
 * 「装了但初始化失败」）、`executable`、`requiresWorktree`、能力三态、事件掩码。
 *
 * 四态与其它 store 一致：`loading | ready | empty | error`。
 * 空 = 这台机器上一个 agent 都没装（给安装指引，不是故障）；
 * 端点缺失（404 not_found）= 也走空态，因为「没有运行时」是诚实的结果。
 */
export type RuntimesStatus = "idle" | "loading" | "ready" | "empty" | "error";

export const useRuntimesStore = defineStore("runtimes", () => {
  const runtimes = ref<RuntimeDetailDto[]>([]);
  const status = ref<RuntimesStatus>("idle");
  const errorText = ref("");
  const loadedAt = ref<number | null>(null);
  /** 正在重探的运行时 id（行级 loading）。 */
  const probingIds = ref<string[]>([]);
  /** 全局「重新探测」的进度（done/total）。 */
  const probeProgress = ref({ done: 0, total: 0 });

  const readyCount = computed(() => runtimes.value.filter((r) => r.availability === "ready").length);

  /** 可绑定的运行时：ready 与 unprobed 都算（unprobed 只是没探测过，不是不可用）。 */
  const bindable = computed(() =>
    runtimes.value.filter((r) => r.availability === "ready" || r.availability === "unprobed"),
  );

  function find(id: string | null | undefined): RuntimeDetailDto | null {
    if (!id) return null;
    return runtimes.value.find((r) => r.id === id) ?? null;
  }

  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";
    try {
      const res = await api.runtimes(signal);
      runtimes.value = res.runtimes;
      status.value = res.runtimes.length === 0 ? "empty" : "ready";
      loadedAt.value = Date.now();
    } catch (err) {
      if (isMissingEndpoint(err)) {
        runtimes.value = [];
        status.value = "empty";
        loadedAt.value = Date.now();
        return;
      }
      runtimes.value = [];
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取运行时失败";
    }
  }

  /** 原地替换一行（探测/添加只影响这一行，不让整表闪）。 */
  function upsert(row: RuntimeDetailDto): void {
    const idx = runtimes.value.findIndex((r) => r.id === row.id);
    if (idx >= 0) {
      runtimes.value = runtimes.value.map((r, i) => (i === idx ? row : r));
    } else {
      runtimes.value = [...runtimes.value, row];
    }
    if (status.value === "empty") status.value = "ready";
    loadedAt.value = Date.now();
  }

  function isProbing(id: string): boolean {
    return probingIds.value.includes(id);
  }

  /**
   * 单运行时重探（P0-01「检测超时」+ 重试按钮）。
   *
   * 只调 `/api/runtimes/:id/probe`：其余行状态与 `lastProbeAt` 都不动。
   * 失败时抛出，由页面决定 toast 文案（不静默吞掉）。
   */
  async function probeOne(id: string): Promise<RuntimeDetailDto> {
    if (isProbing(id)) {
      const current = find(id);
      if (current) return current;
    }
    probingIds.value = [...probingIds.value, id];
    try {
      const res = await api.probeRuntime(id);
      upsert(res.runtime);
      return res.runtime;
    } finally {
      probingIds.value = probingIds.value.filter((x) => x !== id);
    }
  }

  /**
   * 全局「重新探测」：逐个调单行 probe（顺序执行，避免同时 spawn 多个进程）。
   *
   * 单项失败不中断其余项 —— PRD「单项失败不影响其他项」。
   */
  async function probeAll(): Promise<{ probed: number; failed: number }> {
    const ids = runtimes.value.map((r) => r.id);
    let probed = 0;
    let failed = 0;
    probeProgress.value = { done: 0, total: ids.length };
    for (const id of ids) {
      try {
        await probeOne(id);
        probed += 1;
      } catch {
        failed += 1;
      }
      probeProgress.value = { done: probed + failed, total: ids.length };
    }
    return { probed, failed };
  }

  /** 手动添加自定义运行时；409 由调用方处理（跳转高亮已有条目）。 */
  async function addCustom(body: CreateRuntimeRequest): Promise<RuntimeDetailDto | null> {
    const res = await api.createRuntime(body);
    if (res.runtime) upsert(res.runtime);
    return res.runtime;
  }

  /** 展示层原因（优先 probeDetail）——页面与下拉共用同一口径。 */
  function reasonOf(rt: RuntimeLike | null | undefined): string {
    return runtimeReason(rt);
  }

  function statusWordOf(rt: RuntimeLike | null | undefined): string {
    return runtimeStatusWord(rt);
  }

  function isUnavailable(rt: RuntimeLike | null | undefined): boolean {
    return runtimeUnavailable(rt);
  }

  return {
    runtimes,
    status,
    errorText,
    loadedAt,
    probingIds,
    probeProgress,
    readyCount,
    bindable,
    find,
    load,
    isProbing,
    probeOne,
    probeAll,
    addCustom,
    reasonOf,
    statusWordOf,
    isUnavailable,
  };
});
