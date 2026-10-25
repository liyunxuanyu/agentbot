import type { DB } from "../db/db.js";

/**
 * 用量聚合（M13，P0-12）。
 *
 * 输出形状对齐原型 `USAGE` 数组与 UI 文档 §8.3 的表格列：
 *   Bot 头像/名称 + 运行时 chip + 请求数 / 输入 token / 输出 token / 占比条。
 *
 * 四条规则：
 *   ① **按 Bot × 运行时 × 模式聚合**：同一 Bot 在交互与 headless 下的倍率不同，
 *      合成一行会让「倍率提示」失去意义（原型也是分开两行）。
 *   ② **未上报单列**：`reported=0` 的记录 token 显示 `null`（前端渲染 `—`），
 *      并单独给出 `unreportedRequests`；不把 0 混进合计（PRD 边界）。
 *   ③ **删除 Bot 后历史保留**：`usage_records` 不对 bots 级联，用左连接取名字；
 *      取不到就标 `deleted: true`，名称回落为「已删除 Bot」。
 *   ④ **无数据返回空数组**（不是空表格）：调用方据此渲染空态。
 *
 * 时间范围以**本地时区自然日**为界（用户看的是「今天」，不是「过去 24 小时」）。
 */

export type UsageRange = "today" | "7d" | "30d" | "all";

export interface UsageFilter {
  range?: UsageRange;
  botId?: string;
  runtimeId?: string;
  /** 注入「现在」便于测试。 */
  now?: number;
}

export interface UsageAggregateRow {
  botId: string;
  /** Bot 已删除时为 null（历史用量保留，标「已删除 Bot」）。 */
  botName: string | null;
  deleted: boolean;
  /** 身份色序号 1–8；Bot 已删除时为 null，前端用中性色。 */
  colorIndex: number | null;
  runtimeId: string | null;
  runtimeName: string | null;
  mode: "interactive" | "headless";
  /** 倍率提示：来自运行时声明的 `modes.multiplierHint`，缺省 1。 */
  multiplier: number;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 未上报的请求数（token 不计入 input/output）。 */
  unreportedRequests: number;
  /** 占本筛选结果「总 token（输入+输出）」的百分比，0–100，保留 1 位。 */
  share: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  unreportedRequests: number;
}

export interface UsageAggregateResult {
  range: UsageRange;
  /** 时间窗口（epoch ms）；`all` 时为 null。 */
  from: number | null;
  to: number;
  rows: UsageAggregateRow[];
  totals: UsageTotals;
}

/** 范围 → 起始时间（本地自然日）。`all` 返回 null。 */
export function rangeStart(range: UsageRange, now: number = Date.now()): number | null {
  if (range === "all") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = range === "today" ? 0 : range === "7d" ? 6 : 29;
  // 「7 天」= 含今天在内的 7 个自然日（今天 + 前 6 天）
  start.setDate(start.getDate() - days);
  return start.getTime();
}

interface RawAggRow {
  bot_id: string;
  runtime_id: string | null;
  mode: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  reported_requests: number;
  bot_name: string | null;
}

interface RuntimeInfo {
  name: string;
}

/** 运行时显示名。倍率不在库里（schema 无此列），由调用方注入。 */
function runtimeNames(db: DB): Map<string, RuntimeInfo> {
  const rows = db
    .prepare("SELECT id, display_name FROM runtime_definitions")
    .all() as { id: string; display_name: string }[];
  return new Map(rows.map((r) => [r.id, { name: r.display_name }]));
}

export interface AggregateOptions {
  /**
   * 运行时倍率提示（headless 单位 token 配额约为交互的 N 倍）。
   *
   * 为什么不在 core 里读声明：倍率是 adapter 声明的展示属性，而 core 不得
   * 依赖 adapters（分离铁律）。装配层把 `declaration.modes.multiplierHint`
   * 包成这个函数注入进来；缺省按 1（= 无额外倍率，而不是「未知」）。
   */
  multiplierOf?: (runtimeId: string | null) => number | null;
}

/**
 * 身份色：与 `http/dto.ts` 的 listBots 同一口径（按 created_at 升序轮转 1–8），
 * 这样用量页与 Bot 卡片的颜色一致。
 */
function colorIndexOf(db: DB): Map<string, number> {
  const rows = db
    .prepare("SELECT id FROM bots WHERE status = 'active' ORDER BY created_at ASC")
    .all() as { id: string }[];
  const map = new Map<string, number>();
  rows.forEach((r, i) => map.set(r.id, (i % 8) + 1));
  return map;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, unreportedRequests: 0 };
}

export function aggregate(
  db: DB,
  filter: UsageFilter = {},
  options: AggregateOptions = {},
): UsageAggregateResult {
  const range: UsageRange = filter.range ?? "all";
  const now = filter.now ?? Date.now();
  const from = rangeStart(range, now);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (from !== null) {
    where.push("u.created_at >= ?");
    params.push(from);
  }
  if (filter.botId) {
    where.push("u.bot_id = ?");
    params.push(filter.botId);
  }
  if (filter.runtimeId) {
    where.push("u.runtime_id = ?");
    params.push(filter.runtimeId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // 左连接 bots：Bot 删除后历史仍要能聚合出来（标「已删除 Bot」）
  const rows = db
    .prepare(
      `SELECT u.bot_id,
              u.runtime_id,
              u.mode,
              COUNT(*) AS requests,
              SUM(CASE WHEN u.reported = 1 THEN u.input_tokens  ELSE 0 END) AS input_tokens,
              SUM(CASE WHEN u.reported = 1 THEN u.output_tokens ELSE 0 END) AS output_tokens,
              SUM(CASE WHEN u.reported = 1 THEN 1 ELSE 0 END) AS reported_requests,
              b.name AS bot_name
         FROM usage_records u
         LEFT JOIN bots b ON b.id = u.bot_id
         ${whereSql}
        GROUP BY u.bot_id, u.runtime_id, u.mode
        ORDER BY input_tokens DESC, requests DESC`,
    )
    .all(...params) as RawAggRow[];

  if (rows.length === 0) {
    return { range, from, to: now, rows: [], totals: emptyTotals() };
  }

  const runtimes = runtimeNames(db);
  const colors = colorIndexOf(db);

  let totalTokens = 0;
  for (const row of rows) {
    if (row.reported_requests > 0) {
      totalTokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    }
  }

  const totals = emptyTotals();
  const out: UsageAggregateRow[] = rows.map((row) => {
    const reported = row.reported_requests > 0;
    const input = reported ? (row.input_tokens ?? 0) : 0;
    const output = reported ? (row.output_tokens ?? 0) : 0;
    const unreported = row.requests - row.reported_requests;
    const info = row.runtime_id ? runtimes.get(row.runtime_id) : undefined;
    const tokens = input + output;

    totals.requests += row.requests;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.unreportedRequests += unreported;

    return {
      botId: row.bot_id,
      botName: row.bot_name ?? null,
      deleted: row.bot_name === null,
      colorIndex: colors.get(row.bot_id) ?? null,
      runtimeId: row.runtime_id,
      runtimeName: info?.name ?? null,
      mode: row.mode === "headless" ? "headless" : "interactive",
      multiplier: options.multiplierOf?.(row.runtime_id) ?? 1,
      requests: row.requests,
      // 未上报用 null（前端显示 —），不估算、不混进合计
      inputTokens: reported ? input : null,
      outputTokens: reported ? output : null,
      unreportedRequests: unreported,
      share: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1000) / 10 : 0,
    };
  });

  return { range, from, to: now, rows: out, totals };
}

/**
 * CSV 导出（P1-02）：字段与页面列一致。
 *
 * 导出的是**聚合后的行**（与页面看到的一致），不是原始记录 —— PRD 要求
 * 「导出字段与页面列一致」。行数上限由时间范围与 Bot 数量决定，不做分页；
 * 原始记录导出留给 P2（10 万行级需要流式写文件）。
 */
export function exportCsv(
  db: DB,
  filter: UsageFilter = {},
  options: AggregateOptions = {},
): string {
  const agg = aggregate(db, filter, options);
  const header = [
    "bot_id",
    "bot_name",
    "deleted_bot",
    "runtime_id",
    "runtime_name",
    "mode",
    "multiplier",
    "requests",
    "input_tokens",
    "output_tokens",
    "unreported_requests",
    "share_percent",
  ];
  const escape = (v: string | number | null): string => {
    if (v === null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const row of agg.rows) {
    lines.push(
      [
        row.botId,
        row.botName ?? "已删除 Bot",
        row.deleted ? "true" : "false",
        row.runtimeId,
        row.runtimeName,
        row.mode,
        row.multiplier,
        row.requests,
        row.inputTokens,
        row.outputTokens,
        row.unreportedRequests,
        row.share,
      ]
        .map(escape)
        .join(","),
    );
  }
  // 合计行：与页面底部合计一致；未上报单列不混入 token
  lines.push(
    [
      "",
      "合计",
      "",
      "",
      "",
      "",
      "",
      agg.totals.requests,
      agg.totals.inputTokens,
      agg.totals.outputTokens,
      agg.totals.unreportedRequests,
      "",
    ]
      .map(escape)
      .join(","),
  );
  // BOM：Excel 打开 UTF-8 CSV 不乱码
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** 设置页「一并删除」：按 Bot 清空历史用量。返回删除行数。 */
export function deleteByBot(db: DB, botId: string): number {
  const info = db.prepare("DELETE FROM usage_records WHERE bot_id = ?").run(botId);
  return info.changes;
}
