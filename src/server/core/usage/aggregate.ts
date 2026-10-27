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
  /** 缓存命中（读）token；该行没有任何缓存上报时为 null。 */
  cachedInputTokens: number | null;
  /** 缓存写入 token；该行没有任何缓存上报时为 null。 */
  cacheWriteTokens: number | null;
  /**
   * 命中率分母：**缓存字段已上报**那部分请求的输入 token。
   *
   * 与 `inputTokens` 的差别只在混合行：同一行里既有上报缓存的请求，
   * 也有没上报的请求时，拿总输入当分母会让副行的「命中 / 输入」与命中率对不上。
   * 该行没有任何缓存上报时为 null。
   */
  cacheInputTokens: number | null;
  /**
   * 缓存命中率（0–100，1 位小数）= 缓存读 / (输入 + 缓存读)。
   *
   * 两端口径已归一：OpenAI 的 `prompt_tokens` 含缓存命中，provider 层已把
   * 命中部分从输入里扣掉；Anthropic 的 `input_tokens` 本来就不含缓存。
   * 没有缓存上报（升级前的历史记录）时为 null，前端显示「未上报」而不是 0。
   */
  cacheHitRate: number | null;
  /** 未上报的请求数（token 不计入 input/output）。 */
  unreportedRequests: number;
  /** 占本筛选结果「总 token（输入+输出）」的百分比，0–100，保留 1 位。 */
  share: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** 合计命中率的分母：只有缓存字段已上报的请求才计入（R8）。 */
  cacheInputTokens: number;
  /** 合计命中率；没有任何缓存上报时为 null。 */
  cacheHitRate: number | null;
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
  cached_input_tokens: number;
  cache_write_tokens: number;
  /** 缓存字段真的上报了的请求的输入 token（命中率分母，R8）。 */
  cache_input_tokens: number;
  /**
   * 带缓存口径的上报请求数（R8）。
   *
   * 用 `cache_reported` 而不是 `model IS NOT NULL` 推断：供应商回了 token
   * 但没给缓存字段时，这行是「有用量、无命中率」，必须显示 — 而不是 0%。
   */
  cache_reported_requests: number;
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
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheInputTokens: 0,
    cacheHitRate: null,
    unreportedRequests: 0,
  };
}

/** 命中率：缓存读 / (输入 + 缓存读)；分母为 0 或没有缓存上报时返回 null。 */
function hitRateOf(cached: number, input: number, cacheReported: boolean): number | null {
  if (!cacheReported) return null;
  const total = input + cached;
  if (total <= 0) return null;
  return Math.round((cached / total) * 1000) / 10;
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
              SUM(CASE WHEN u.reported = 1 THEN u.cached_input_tokens ELSE 0 END) AS cached_input_tokens,
              SUM(CASE WHEN u.reported = 1 THEN u.cache_write_tokens ELSE 0 END) AS cache_write_tokens,
              -- 命中率分母只算「缓存字段真的上报了」的请求（R8）：
              -- 未上报缓存的行 input 有数但缓存未知，混进分母会稀释成伪 0。
              SUM(CASE WHEN u.reported = 1 AND u.cache_reported = 1 THEN u.input_tokens ELSE 0 END) AS cache_input_tokens,
              SUM(CASE WHEN u.reported = 1 AND u.cache_reported = 1 THEN 1 ELSE 0 END) AS cache_reported_requests,
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
  let totalsCacheReported = false;
  // 合计命中率的分母：逐行累加「缓存已上报」部分的输入（R8）。
  let totalsCacheInput = 0;
  const out: UsageAggregateRow[] = rows.map((row) => {
    const reported = row.reported_requests > 0;
    const input = reported ? (row.input_tokens ?? 0) : 0;
    const output = reported ? (row.output_tokens ?? 0) : 0;
    const cacheReported = row.cache_reported_requests > 0;
    const cachedInput = cacheReported ? (row.cached_input_tokens ?? 0) : 0;
    const cacheWrite = cacheReported ? (row.cache_write_tokens ?? 0) : 0;
    const cacheInput = cacheReported ? (row.cache_input_tokens ?? 0) : 0;
    const unreported = row.requests - row.reported_requests;
    const info = row.runtime_id ? runtimes.get(row.runtime_id) : undefined;
    const tokens = input + output;

    totals.requests += row.requests;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cachedInputTokens += cachedInput;
    totals.cacheWriteTokens += cacheWrite;
    totals.unreportedRequests += unreported;
    if (cacheReported) {
      totalsCacheReported = true;
      totalsCacheInput += cacheInput;
    }

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
      cachedInputTokens: cacheReported ? cachedInput : null,
      cacheWriteTokens: cacheReported ? cacheWrite : null,
      cacheInputTokens: cacheReported ? cacheInput : null,
      cacheHitRate: hitRateOf(cachedInput, cacheInput, cacheReported),
      unreportedRequests: unreported,
      share: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1000) / 10 : 0,
    };
  });

  totals.cacheInputTokens = totalsCacheInput;
  totals.cacheHitRate = hitRateOf(
    totals.cachedInputTokens,
    totalsCacheInput,
    totalsCacheReported,
  );

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
    "cached_input_tokens",
    "cache_write_tokens",
    "cache_hit_rate_percent",
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
        row.cachedInputTokens,
        row.cacheWriteTokens,
        row.cacheHitRate,
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
      agg.totals.cachedInputTokens,
      agg.totals.cacheWriteTokens,
      agg.totals.cacheHitRate,
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
