/**
 * 展示层格式化 —— 与原型 index.html 的同名工具函数一一对应。
 * 数字一律 en-US 千分位（原型用 toLocaleString("en-US")），保证两套实现读数一致。
 */

/** 完整千分位；null/undefined 显示破折号（未上报不是 0）。 */
export function num(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

/** 1.2k / 388 这类短数字，用于窄列（任务列表的用量）。 */
export function shortNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** HH:MM。 */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 秒 / 分 / 小时三档相对时间（任务卡「最后活动」用，不引日期库）。 */
export function agoText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  return `${Math.floor(m / 60)}h 前`;
}

/** 毫秒 → `12.4s` / `6m 12s`。 */
export function durText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** 会话内耗时显示：生成中按秒滚动，结束显示最终时长。 */
export function elapsedText(fromTs: number, toTs: number = Date.now()): string {
  return durText(Math.max(0, toTs - fromTs));
}

/** `YYYY-MM-DD HH:MM`（表格与详情页的时间列）。 */
export function dateTimeText(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 相对日 + 时刻：`今天 14:12` / `昨天 16:20` / `10-22 09:04`。
 *
 * 列表里「今天/昨天」比完整日期好扫读；超过两天就换成月-日，避免出现
 * 「3 天前 14:12」这种既不是相对时间也不是绝对时间的混合写法。
 */
export function dayTimeText(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}

/** 绝对时刻（`HH:MM:SS`），失败报告的事件时间戳用。 */
export function clockTimeSeconds(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
