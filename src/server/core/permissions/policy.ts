import type { DB } from "../db/db.js";
import { config } from "../../config.js";
import type { PermissionAction, BoundaryVerdict } from "../../../shared/events.js";

/**
 * 三档超时策略（board `product-positioning/03-decisions.md` 决定 Q1 的硬要求）。
 *
 * | 场景 | 超时行为 |
 * |---|---|
 * | 交互会话（用户刚发消息） | `reject`：120s 后拒绝，标「超时自动拒绝」 |
 * | Assignment / 定时任务 | `hold`：不拒绝不继续，挂起最长 24h；用户回来仍可决策；超 24h 转拒绝 |
 * | 用户显式开启「写操作自动批准」 | `preauth`：边界内写操作自动批准只写审计，边界外仍走 hold/reject |
 *
 * **场景自动判定，不需要用户配置**：按触发来源（`TurnSource`）判断。
 * 这是 board 明确写下的产品决定 —— 加一个「超时策略」下拉框会让用户为
 * 一个他们无法预判后果的选项负责。
 *
 * 本文件是纯函数 + 一个扫描器：
 *   - 纯函数：决定策略、算截止时间。可被单测穷举。
 *   - 扫描器：`sweepExpired()` 由定时器（5min）与启动序调用，负责
 *     「超时转拒绝」与「进程已退出转失效」。
 */

/** 权限请求的来源场景（由触发方注入，见 §M7/M11/M12 接缝）。 */
export type TurnSource = "interactive" | "assignment" | "schedule";

export type TimeoutPolicy = "reject" | "hold" | "preauth";

export type PermissionStatus =
  | "pending"
  | "decided"
  | "denied_timeout"
  | "denied_hard_timeout"
  | "denied_boundary"
  /** 被会话权限模式拒绝（计划模式下挂起的写类请求）。 */
  | "denied_mode"
  | "invalidated";

export interface PolicyInput {
  source: TurnSource;
  action: PermissionAction;
  boundaryVerdict: BoundaryVerdict;
  /** Bot 的「写操作自动批准」开关（P0-09 二次确认后的值）。 */
  autoApproveWrite: boolean;
}

/**
 * 决定这张卡走哪一档。
 *
 * 注意 preauth 只在「边界内的写操作」成立：边界外的写仍按来源走 hold/reject
 * （board 原文「边界外仍走 hold/reject」）。读操作不需要批准，不产生卡片。
 */
export function decideTimeoutPolicy(input: PolicyInput): TimeoutPolicy {
  if (
    input.autoApproveWrite &&
    input.action === "write" &&
    input.boundaryVerdict === "allowed"
  ) {
    return "preauth";
  }
  // Assignment 与定时任务：用户明确离开了屏幕
  if (input.source === "assignment" || input.source === "schedule") return "hold";
  return "reject";
}

export interface Deadlines {
  /** 倒计时终点；null = 无倒计时（hold 与 preauth）。 */
  expiresAt: number | null;
  /** 挂起起始时间；null = 不是挂起型。 */
  heldSince: number | null;
}

/** 按策略算时间字段（写库时用）。`overrides` 只给测试用，生产不传。 */
export function deadlinesOf(
  policy: TimeoutPolicy,
  now: number,
  overrides: { rejectMs?: number; holdMaxMs?: number } = {},
): Deadlines {
  switch (policy) {
    case "reject":
      return {
        expiresAt: now + (overrides.rejectMs ?? config.timeouts.permissionRejectMs),
        heldSince: null,
      };
    case "hold":
      // 挂起型也记一个 24h 上限：超时才转拒绝（前端不显示倒计时，只用它做兜底）
      return {
        expiresAt: now + (overrides.holdMaxMs ?? config.timeouts.permissionHoldMaxMs),
        heldSince: now,
      };
    case "preauth":
      return { expiresAt: null, heldSince: null };
  }
}

// ---------------------------------------------------------------------------
// 扫描器：超时与失效
// ---------------------------------------------------------------------------

interface PendingRow {
  id: string;
  session_id: string;
  bot_id: string;
  turn_id: string;
  action: string;
  target: string;
  timeout_policy: string;
  held_since: number | null;
  expires_at: number | null;
  created_at: number;
}

export interface SweepDeps {
  db: DB;
  /** 会话进程是否还活着；不存在（或未实现）时按「进程已退出」处理。 */
  isSessionAlive(sessionId: string): boolean;
  /** 状态落库后的通知（写审计事件 + 广播）。 */
  onSettled(row: PendingRow, status: PermissionStatus, reason: string): void;
  now?: number;
}

export interface SweepResult {
  /** reject 策略超时 → denied_timeout。 */
  timedOut: number;
  /** hold 策略超 24h → denied_hard_timeout。 */
  hardTimedOut: number;
  /** 进程已退出 → invalidated。 */
  invalidated: number;
  /** 挂起数超限，最老的转 invalidated。 */
  evicted: number;
}

/**
 * 一次扫描。调用时机：
 *   ① 启动序（服务重启后清理过期挂起，P0-08 边界处理）
 *   ② 每 5 分钟（`config` 没有单独的扫描间隔，用 5min 常量；
 *      超时精度要求是「秒级感知」，而 reject 的 120s 由内存定时器精确触发，
 *      扫描器只兜底 hold 的 24h 与崩溃/重启场景）
 */
export function sweepExpired(deps: SweepDeps): SweepResult {
  const now = deps.now ?? Date.now();
  const result: SweepResult = { timedOut: 0, hardTimedOut: 0, invalidated: 0, evicted: 0 };

  const rows = deps.db
    .prepare(
      `SELECT id, session_id, bot_id, turn_id, action, target, timeout_policy,
              held_since, expires_at, created_at
         FROM permission_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    )
    .all() as PendingRow[];

  const settle = deps.db.prepare(
    `UPDATE permission_requests
        SET status = ?, decision = ?, decided_by = 'system', decided_at = ?
      WHERE id = ? AND status = 'pending'`,
  );

  const heldPending: PendingRow[] = [];

  for (const row of rows) {
    // ① 先看时间上限：到点就按「超时」结案。
    //    顺序不能反 —— 服务重启时进程必然已不在，若先判「进程已退出」，
    //    所有挂起超过 24h 的卡片都会被标成「已失效」，
    //    而 board 明确要求「服务重启时对超过 24h 的挂起卡片直接转拒绝」。
    if (row.expires_at !== null && row.expires_at <= now) {
      const isHold = row.timeout_policy === "hold";
      const status: PermissionStatus = isHold ? "denied_hard_timeout" : "denied_timeout";
      const info = settle.run(status, "reject", now, row.id);
      if (info.changes > 0) {
        if (isHold) result.hardTimedOut += 1;
        else result.timedOut += 1;
        deps.onSettled(row, status, isHold ? "挂起超时" : "超时自动拒绝");
      }
      continue;
    }

    // ② 进程已退出：卡片直接失效，不占满 24h（P0-08 边界处理）
    if (!deps.isSessionAlive(row.session_id)) {
      const info = settle.run("invalidated", "invalidated", now, row.id);
      if (info.changes > 0) {
        result.invalidated += 1;
        deps.onSettled(row, "invalidated", "运行时进程已退出");
      }
      continue;
    }

    if (row.timeout_policy === "hold") heldPending.push(row);
  }

  // ③ 同时挂起数超限：最老的转「已失效」，防僵尸进程拖垮本机（架构 §5）
  const limit = config.limits.maxHeldPermissions;
  if (heldPending.length > limit) {
    const evict = heldPending.slice(0, heldPending.length - limit);
    for (const row of evict) {
      const info = settle.run("invalidated", "invalidated", now, row.id);
      if (info.changes > 0) {
        result.evicted += 1;
        deps.onSettled(row, "invalidated", `同时挂起超过 ${limit} 个，最老的已失效`);
      }
    }
  }

  return result;
}

/** 扫描间隔：5 分钟（只兜底长时超时与崩溃，短超时由内存定时器负责）。 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
