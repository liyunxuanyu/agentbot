/**
 * 定时任务的触发时间计算（P0-11）。
 *
 * 三种触发方式：
 *   once      —— 延迟 N 分钟后执行一次（从创建时刻起算）
 *   interval  —— 每 N 分钟执行一次（N 有下限，见 config.limits.minScheduleIntervalMinutes）
 *   daily     —— 每日 HH:MM 执行一次（**本地时区**，用户说的 9 点就是他表上的 9 点）
 *
 * 本文件是纯函数，不读库、不挂定时器：
 *   - 校验在保存时用（拒绝非法输入）；
 *   - 下次触发时间在创建、每次执行后、服务启动补跑后都要算，集中一处避免漂移。
 *
 * 时间一律用 epoch ms（与 schema 的 INTEGER 列一致）。
 */

export type TriggerType = "once" | "interval" | "daily";

export const TRIGGER_TYPES: readonly TriggerType[] = ["once", "interval", "daily"];

/** 触发配置（与 `schedules` 表的列一一对应）。 */
export interface TriggerSpec {
  triggerType: TriggerType;
  /** once 用：延迟分钟数。 */
  delayMinutes?: number | null;
  /** interval 用：间隔分钟数。 */
  intervalMinutes?: number | null;
  /** daily 用：`HH:MM`（本地时区）。 */
  atTime?: string | null;
}

export interface TriggerValidation {
  ok: boolean;
  code?: string;
  message?: string;
}

/** 一次性延迟的上限：一年。防止手滑输入 999999 分钟把定时器推到不可控的地方。 */
export const MAX_DELAY_MINUTES = 365 * 24 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` → 当天的分钟数；格式不合法返回 null。 */
export function parseAtTime(atTime: string): { hour: number; minute: number } | null {
  const m = HHMM.exec(atTime.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * 保存时校验。
 *
 * 为什么最小间隔是 5 分钟：周期任务每次都会起一个运行时进程（0.5–2s 启动 +
 * 真实 token 消耗），1 分钟级的周期等于让机器一直满转，且用户几乎不可能
 * 认真看结果。5 分钟是 PRD 写死的下限，不是可配置项。
 */
export function validateTrigger(
  spec: TriggerSpec,
  opts: { minIntervalMinutes: number } = { minIntervalMinutes: 5 },
): TriggerValidation {
  switch (spec.triggerType) {
    case "once": {
      const d = spec.delayMinutes;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1) {
        return { ok: false, code: "invalid_delay", message: "延迟分钟数必须是 ≥1 的整数" };
      }
      if (d > MAX_DELAY_MINUTES) {
        return {
          ok: false,
          code: "delay_too_large",
          message: `延迟最多 ${MAX_DELAY_MINUTES} 分钟（一年）`,
        };
      }
      return { ok: true };
    }
    case "interval": {
      const n = spec.intervalMinutes;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
        return { ok: false, code: "invalid_interval", message: "间隔必须是正整数分钟" };
      }
      if (n < opts.minIntervalMinutes) {
        return {
          ok: false,
          code: "interval_too_small",
          message: `周期任务的最小间隔是 ${opts.minIntervalMinutes} 分钟，更小的间隔会持续占用运行时进程`,
        };
      }
      return { ok: true };
    }
    case "daily": {
      if (typeof spec.atTime !== "string" || parseAtTime(spec.atTime) === null) {
        return { ok: false, code: "invalid_at_time", message: "每日触发时间格式应为 HH:MM（00:00–23:59）" };
      }
      return { ok: true };
    }
    default:
      return { ok: false, code: "invalid_trigger_type", message: "触发方式只能是 once / interval / daily" };
  }
}

/** 下一次「每日 HH:MM」的本地时间戳；严格晚于 `from`。 */
export function nextDailyAt(atTime: string, from: number): number {
  const parsed = parseAtTime(atTime);
  if (!parsed) return from;
  const base = new Date(from);
  const candidate = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    parsed.hour,
    parsed.minute,
    0,
    0,
  );
  // 今天这个点已经过了（或正好是现在）→ 明天
  if (candidate.getTime() <= from) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

/**
 * 从 `from` 起算的下一次触发时间。
 *
 * - once：`from + delay`（创建时 from=now；执行后调用方传 null 表示不再触发）
 * - interval：`from + interval`
 * - daily：严格晚于 from 的下一个 HH:MM
 *
 * 返回 null 表示「不会再有下一次」（仅 once 且已执行）。
 */
export function computeNextRun(spec: TriggerSpec, from: number): number | null {
  switch (spec.triggerType) {
    case "once": {
      const d = spec.delayMinutes;
      if (typeof d !== "number" || d <= 0) return null;
      return from + d * 60_000;
    }
    case "interval": {
      const n = spec.intervalMinutes;
      if (typeof n !== "number" || n <= 0) return null;
      return from + n * 60_000;
    }
    case "daily":
      if (typeof spec.atTime !== "string") return null;
      return nextDailyAt(spec.atTime, from);
    default:
      return null;
  }
}

/** 人类可读的触发规则（列表「触发规则」列）。 */
export function describeTrigger(spec: TriggerSpec): string {
  switch (spec.triggerType) {
    case "once":
      return `延迟 ${spec.delayMinutes ?? "?"} 分钟（一次性）`;
    case "interval":
      return `每 ${spec.intervalMinutes ?? "?"} 分钟`;
    case "daily":
      return `每日 ${spec.atTime ?? "??:??"}`;
    default:
      return "未知触发方式";
  }
}
