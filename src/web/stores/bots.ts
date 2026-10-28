import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { BotDto, BotState, RuntimeSummary } from "../net/types";
import { sendBlockedReason } from "../lib/runtime";

/**
 * Bot 列表与运行时。
 *
 * 四态由 `status` 表达：`loading | error | empty | ready`。
 * `/api/bots` 还没实现（M3 阶段）时按 404 处理 → 空态，而不是把用户丢进错误页：
 * 空态文案说的是「创建你的第一个 Bot」，这对「端点未落地」也是诚实的。
 */

export type LoadStatus = "idle" | "loading" | "ready" | "empty" | "error";

/** Bot 六态 → 中文（原型 STATE_WORD）。 */
export const STATE_WORD: Record<BotState, string> = {
  idle: "空闲",
  thinking: "思考中",
  working: "工作中",
  waiting: "等待中",
  blocked: "受阻",
  done: "完成",
};

export const useBotsStore = defineStore("bots", () => {
  const bots = ref<BotDto[]>([]);
  const runtimes = ref<RuntimeSummary[]>([]);
  const status = ref<LoadStatus>("idle");
  const errorText = ref("");

  /** 页头汇总用的四个数（原型 readbar）。 */
  const workingCount = computed(
    () => bots.value.filter((b) => b.state === "working" || b.state === "thinking").length,
  );
  const pendingCount = computed(() =>
    bots.value.reduce((sum, b) => sum + b.pendingPermissions, 0),
  );
  const readyRuntimeCount = computed(
    () => runtimes.value.filter((r) => r.healthStatus === "ready").length,
  );

  const byId = computed(() => {
    const map = new Map<string, BotDto>();
    for (const b of bots.value) map.set(b.id, b);
    return map;
  });

  function runtimeOf(bot: BotDto | null | undefined): RuntimeSummary | null {
    return bot?.runtime ?? null;
  }

  function findBot(id: string): BotDto | undefined {
    return byId.value.get(id);
  }

  /**
   * 拉 Bot 列表。
   *
   * 运行时来源有两处：`/api/meta` 的 runtimes（M1 已有，探测结果）与
   * `/api/bots` 内联的 runtime。前者是「机器上有什么」，后者是「Bot 绑了谁」，
   * 页头的「N 种运行时」按前者算（与原型一致：统计的是已就绪的运行时种类）。
   */
  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";

    // 元信息先拉：即便 bots 端点还没落地，也要能显示运行时种类
    try {
      const meta = await api.meta(signal);
      runtimes.value = meta.runtimes;
    } catch (err) {
      if (isMissingEndpoint(err)) {
        runtimes.value = [];
      } else {
        status.value = "error";
        errorText.value = err instanceof Error ? err.message : "读取服务信息失败";
        return;
      }
    }

    try {
      const res = await api.bots(signal);
      bots.value = res.bots;
      status.value = res.bots.length === 0 ? "empty" : "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        // 端点尚未实现：真实的空工作区，不是故障
        bots.value = [];
        status.value = "empty";
        return;
      }
      bots.value = [];
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取 Bot 失败";
    }
  }

  /**
   * 待批权限数：**以服务端为准**，不在前端做加减法。
   *
   * 旧实现只在 `permission_request` 到达时 `+1`，批准/拒绝/超时后从不减 ——
   * 真机实测：批准之后顶栏仍显示「待批 2」，直到整页刷新才归零。
   * 待批数是「此刻还有几件事等你决定」，它必须反映权威状态，而不是事件计数：
   * 事件会重放、轮询与 SSE 会重叠、超时由服务端定时器收口。
   *
   * 因此这里只做一件事：拉一次 `/api/bots`，只合并 `pendingPermissions`
   * （不动 status / errorText —— 这不是一次「加载页面」，失败也不该把列表打成错误态）。
   * 并发调用合并成一次（一轮里可能连着来好几条 permission_request）。
   */
  let pendingRefresh: Promise<void> | null = null;
  function refreshPending(): Promise<void> {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
      try {
        const res = await api.bots();
        const byId = new Map(res.bots.map((b) => [b.id, b.pendingPermissions]));
        for (const bot of bots.value) {
          const next = byId.get(bot.id);
          if (next !== undefined) bot.pendingPermissions = next;
        }
      } catch {
        // 拉不到就沿用旧值：下一次权限事件或页面刷新会校正
      } finally {
        pendingRefresh = null;
      }
    })();
    return pendingRefresh;
  }

  /**
   * 单个 Bot 的待批数变化（SSE 的 permission_request 驱动）。
   *
   * @deprecated 前端加减法不可靠（批准后减不回来）。新代码用 `refreshPending()`；
   * 保留它是为了不破坏外部调用与测试，行为保持不变。
   */
  function bumpPending(botId: string, delta: number): void {
    const bot = bots.value.find((b) => b.id === botId);
    if (!bot) return;
    bot.pendingPermissions = Math.max(0, bot.pendingPermissions + delta);
  }

  /**
   * 发送被阻止的原因（P0-02 / P0-13）。
   *
   * 会话页的 Composer 用 `canSend` / `sendBlockReason` 决定禁用与提示文案：
   * 运行时不可用时显示 `运行时不可用：<probeDetail 原文>`，worktree 创建失败时
   * 提示去 Bot 详情重试。返回 null 表示可以发送。
   */
  function sendBlockReason(botId: string): string | null {
    return sendBlockedReason(findBot(botId));
  }

  function canSend(botId: string): boolean {
    return sendBlockReason(botId) === null;
  }

  /** 删除/归档后立即从列表移除（不等待下一次 `load()`）。 */
  function remove(botId: string): void {
    bots.value = bots.value.filter((b) => b.id !== botId);
    if (bots.value.length === 0) status.value = "empty";
  }

  return {
    bots,
    runtimes,
    status,
    errorText,
    workingCount,
    pendingCount,
    readyRuntimeCount,
    byId,
    runtimeOf,
    findBot,
    load,
    bumpPending,
    refreshPending,
    sendBlockReason,
    canSend,
    remove,
  };
});
