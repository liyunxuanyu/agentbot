import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { PermissionDto } from "../net/types";

/**
 * 权限请求（P0-08 / UX F4 与 6.2 的分级）。
 *
 * 为什么需要独立的 store 而不是只靠事件流：
 *   事件流的 `permission_request` payload 只有 `{requestId, action, target, boundaryVerdict}`，
 *   **没有超时策略、没有截止时间、没有已决状态**。卡片要显示 120s 倒计时、
 *   要区分「阻断型」与「挂起型」、要在已决后收成一行审计，必须靠 `/api/permissions`
 *   的权威状态。所以：事件流负责「出现了」的信号，本 store 负责「到底是什么状态」。
 *
 * 端点未实现时（M3）：按 `reject` + 120s 兜底，让卡片仍然可渲染 ——
 * 这是唯一一种「宁可猜也不能不显示」的地方，因为不显示卡片会让输入框永远锁着。
 */

/** 兜底倒计时：UX 6.2 L1 阻断型 120s。 */
const FALLBACK_TIMEOUT_MS = 120_000;

export type PermissionKind = "block" | "hold" | "boundary" | "invalid" | "decided";

export interface PermissionView {
  requestId: string;
  sessionId: string;
  botId: string;
  turnId: string;
  action: "write" | "read" | "exec" | "network";
  target: string;
  kind: PermissionKind;
  /** 已决时的决定文案，如「已批准 · 你 · 14:32」。 */
  decisionText: string | null;
  /** 挂起起始时间（hold 型显示「已挂起 1h 20m」）。 */
  heldSince: number | null;
  /** 倒计时终点（block 型）；null 表示无倒计时（hold / invalid / boundary / decided）。 */
  expiresAt: number | null;
  createdAt: number;
}

function kindOf(row: PermissionDto): PermissionKind {
  if (row.status === "decided" || row.status.startsWith("denied")) return "decided";
  if (row.status === "invalidated") return "invalid";
  if (row.boundaryVerdict === "denied") return "boundary";
  if (row.timeoutPolicy === "hold") return "hold";
  return "block";
}

function decisionText(row: PermissionDto): string | null {
  if (row.status === "pending") return null;
  const who = row.decidedBy === "system" ? "系统" : "你";
  const at = row.decidedAt
    ? new Date(row.decidedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : "";
  switch (row.status) {
    case "decided":
      return row.decision === "reject"
        ? `已拒绝 · ${who}${at ? ` · ${at}` : ""}`
        : `已批准 · ${who}${at ? ` · ${at}` : ""}`;
    case "denied_timeout":
      return "超时自动拒绝";
    case "denied_hard_timeout":
      return "挂起超时 · 已自动拒绝";
    case "denied_boundary":
      return "超出 Bot 边界 · 已自动拒绝";
    case "invalidated":
      return "请求已失效";
    default:
      return row.decision ?? "已处置";
  }
}

export const usePermissionsStore = defineStore("permissions", () => {
  /** requestId → 视图。用普通 ref：权限卡数量是 0–5，深代理无压力。 */
  const items = ref<Record<string, PermissionView>>({});
  const loading = ref(false);

  const all = computed(() => Object.values(items.value));

  /** 待决策（阻断或挂起），按创建时间升序。 */
  const pending = computed(() =>
    all.value
      .filter((p) => p.kind === "block" || p.kind === "hold")
      .sort((a, b) => a.createdAt - b.createdAt),
  );

  const blocking = computed(() => pending.value.filter((p) => p.kind === "block"));

  /** 已决审计行，最近的在前。 */
  const decided = computed(() =>
    all.value
      .filter((p) => p.kind === "decided" || p.kind === "boundary" || p.kind === "invalid")
      .sort((a, b) => b.createdAt - a.createdAt),
  );

  const hasBlocking = computed(() => blocking.value.length > 0);

  /** 某 Turn 是否有阻断型待批（Turn 头 sticky 判定）。 */
  function blockingTurnIds(): Set<string> {
    return new Set(blocking.value.map((p) => p.turnId));
  }

  function upsert(row: PermissionDto): void {
    items.value = {
      ...items.value,
      [row.id]: {
        requestId: row.id,
        sessionId: row.sessionId,
        botId: row.botId,
        turnId: row.turnId,
        action: row.action,
        target: row.target,
        kind: kindOf(row),
        decisionText: decisionText(row),
        heldSince: row.heldSince,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      },
    };
  }

  /**
   * 事件流出现一条 permission_request 时先占位（避免「等了 1s 才看到卡片」）。
   * 真实状态由 `load()` 覆盖；端点不存在时这个占位就是最终形态。
   */
  function placeholder(input: {
    requestId: string;
    sessionId: string;
    botId: string;
    turnId: string;
    action: "write" | "read" | "exec" | "network";
    target: string;
    boundaryVerdict: "allowed" | "denied" | "pending";
    createdAt: number;
  }): void {
    if (items.value[input.requestId]) return;
    const kind: PermissionKind =
      input.boundaryVerdict === "denied" ? "boundary" : "block";
    items.value = {
      ...items.value,
      [input.requestId]: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        botId: input.botId,
        turnId: input.turnId,
        action: input.action,
        target: input.target,
        kind,
        decisionText: null,
        heldSince: null,
        // 兜底 120s：端点缺失时卡片至少有个倒计时，不会永远挂着
        expiresAt: kind === "block" ? input.createdAt + FALLBACK_TIMEOUT_MS : null,
        createdAt: input.createdAt,
      },
    };
  }

  async function load(sessionId: string, signal?: AbortSignal): Promise<void> {
    loading.value = true;
    try {
      const res = await api.permissions(sessionId, signal);
      const next: Record<string, PermissionView> = {};
      for (const row of res.permissions) {
        next[row.id] = {
          requestId: row.id,
          sessionId: row.sessionId,
          botId: row.botId,
          turnId: row.turnId,
          action: row.action,
          target: row.target,
          kind: kindOf(row),
          decisionText: decisionText(row),
          heldSince: row.heldSince,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
        };
      }
      items.value = next;
    } catch (err) {
      if (!isMissingEndpoint(err)) {
        // 权限端点故障不该阻断会话：保留现有卡片，只记一笔
        console.warn("[permissions] 读取失败，沿用事件流推断的状态");
      }
    } finally {
      loading.value = false;
    }
  }

  /** 本地标记已决（先乐观更新，服务端回包后由 load 校正）。 */
  function markDecided(requestId: string, text: string): void {
    const cur = items.value[requestId];
    if (!cur) return;
    items.value = {
      ...items.value,
      [requestId]: { ...cur, kind: "decided", decisionText: text, expiresAt: null },
    };
  }

  function markInvalid(requestId: string): void {
    const cur = items.value[requestId];
    if (!cur) return;
    items.value = {
      ...items.value,
      [requestId]: { ...cur, kind: "invalid", decisionText: "请求已失效", expiresAt: null },
    };
  }

  function reset(): void {
    items.value = {};
  }

  return {
    items,
    loading,
    all,
    pending,
    blocking,
    decided,
    hasBlocking,
    blockingTurnIds,
    upsert,
    placeholder,
    load,
    markDecided,
    markInvalid,
    reset,
  };
});
