import { randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";

/**
 * 用量记录（M13，P0-12）。
 *
 * 四条纪律：
 *   ① **只信上报**：`reported:false` 就落一条 `reported=0` 的记录，token 记 0，
 *      **绝不估算**（PRD 已决 Q3：估算值与用户在各 CLI 里看到的数字不一致，反而损伤信任）。
 *      聚合层把这类记录单列成「未上报」，token 显示为 `—` 而不是 `0`。
 *   ② **以增量为准**：运行时可能同时给「累计值」（本 Session 至今总量）与「增量」
 *      （本轮量）。两者都拿到时用增量落库；若差值 >10%，记 warning（数据源不一致，
 *      但按 PRD 仍以增量为准）。
 *   ③ **每轮一条**：一轮结束落一条记录，`created_at` 是本轮收口时间。
 *      5s 内可见由「收口即写库」自然满足，不需要额外的批量任务。
 *   ④ **倍率不落库**：schema 没有 multiplier 列（本轮禁止改 schema），倍率是
 *      runtime 声明里的展示属性（`modes.multiplierHint`），由聚合层按运行时现算。
 *
 * 累计值的基线放在内存 Map 里（sessionId → 上次累计值）：
 *   进程重启 / 会话重建后累计值从 0 重新开始，内存基线自然失效，
 *   下一次收到累计值时按「新基线」处理（见下方回退分支），不会重复计数。
 */

export type UsageMode = "interactive" | "headless";

/** 一条 usage 事件归一后的样本（来自 `shared/events.ts` 的 UsagePayload）。 */
export interface UsageSample {
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
  /** true 表示这两个数字是「本 Session 累计值」而不是「本轮增量」。 */
  cumulative?: boolean;
}

export interface UsageRecorderDeps {
  db: DB;
  log?: (msg: string) => void;
}

export interface RecordUsageInput {
  botId: string;
  runtimeId: string | null;
  sessionId: string | null;
  mode: UsageMode;
  /** 本轮收到的所有 usage 事件（顺序按到达顺序）。 */
  samples: UsageSample[];
  /** 本轮结局。失败/中断也落记录（运行时可能已消耗 token），只用于日志口径。 */
  outcome?: "done" | "interrupted" | "failed";
}

export interface RecordUsageResult {
  id: string;
  reported: boolean;
  inputTokens: number;
  outputTokens: number;
  /** 数据源不一致等告警（同时已写日志）。 */
  warnings: string[];
}

export interface UsageRecorder {
  record(input: RecordUsageInput): RecordUsageResult;
  /** 丢弃某 Session 的累计基线（会话结束 / 进程回收时调用，避免 Map 无界增长）。 */
  forgetSession(sessionId: string): void;
}

/** 累计值与增量的相对差阈值（PRD：>10% 记 warning）。 */
export const CUMULATIVE_MISMATCH_RATIO = 0.1;

interface Baseline {
  input: number;
  output: number;
}

function finiteOrZero(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function relativeDiff(actual: number, expected: number): number {
  const denom = Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) / denom;
}

export function createUsageRecorder(deps: UsageRecorderDeps): UsageRecorder {
  const log = deps.log ?? ((m: string) => console.warn(`[usage] ${m}`));
  const baselines = new Map<string, Baseline>();

  function resolveTotals(
    sessionId: string | null,
    samples: UsageSample[],
    warnings: string[],
  ): { input: number; output: number } | null {
    const reported = samples.filter((s) => s.reported === true);
    if (reported.length === 0) return null;

    const incremental = reported.filter((s) => s.cumulative !== true);
    const cumulative = reported.filter((s) => s.cumulative === true);

    let incrementalInput = 0;
    let incrementalOutput = 0;
    for (const s of incremental) {
      incrementalInput += finiteOrZero(s.inputTokens);
      incrementalOutput += finiteOrZero(s.outputTokens);
    }

    // 只有累计值：用「本次累计 − 上次累计」得到本轮增量
    let cumulativeDelta: { input: number; output: number } | null = null;
    if (cumulative.length > 0) {
      const last = cumulative[cumulative.length - 1];
      if (last) {
        const cur: Baseline = {
          input: finiteOrZero(last.inputTokens),
          output: finiteOrZero(last.outputTokens),
        };
        const base = sessionId ? baselines.get(sessionId) : undefined;
        if (!base) {
          cumulativeDelta = { input: cur.input, output: cur.output };
        } else if (cur.input < base.input || cur.output < base.output) {
          // 累计值回退：进程重启 / 会话重建，累计从 0 重新开始。
          // 保守取 0，不重复计数（宁可少算也不把同一批 token 记两遍）。
          warnings.push(
            `累计值回退（${base.input}/${base.output} → ${cur.input}/${cur.output}），按新基线处理`,
          );
          cumulativeDelta = { input: 0, output: 0 };
        } else {
          cumulativeDelta = {
            input: cur.input - base.input,
            output: cur.output - base.output,
          };
        }
        if (sessionId) baselines.set(sessionId, cur);
      }
    }

    if (incremental.length > 0) {
      // 同时给了累计值与增量：以增量为准，差值 >10% 记 warning
      if (cumulativeDelta) {
        const diffIn = relativeDiff(cumulativeDelta.input, incrementalInput);
        const diffOut = relativeDiff(cumulativeDelta.output, incrementalOutput);
        if (diffIn > CUMULATIVE_MISMATCH_RATIO || diffOut > CUMULATIVE_MISMATCH_RATIO) {
          warnings.push(
            `累计值与增量差值超 10%（累计增量 ${cumulativeDelta.input}/${cumulativeDelta.output}，` +
              `上报增量 ${incrementalInput}/${incrementalOutput}），以增量为准`,
          );
        }
      }
      return { input: incrementalInput, output: incrementalOutput };
    }

    return cumulativeDelta ?? { input: 0, output: 0 };
  }

  return {
    record(input) {
      const warnings: string[] = [];
      const totals = resolveTotals(input.sessionId, input.samples, warnings);

      for (const w of warnings) log(`${input.sessionId ?? "-"}/${input.botId}：${w}`);

      const reported = totals !== null;
      const inputTokens = totals?.input ?? 0;
      const outputTokens = totals?.output ?? 0;
      const id = `use_${randomUUID()}`;

      deps.db
        .prepare(
          `INSERT INTO usage_records
             (id, bot_id, runtime_id, session_id, mode, input_tokens, output_tokens, reported, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.botId,
          input.runtimeId,
          input.sessionId,
          input.mode === "headless" ? "headless" : "interactive",
          inputTokens,
          outputTokens,
          reported ? 1 : 0,
          Date.now(),
        );

      return { id, reported, inputTokens, outputTokens, warnings };
    },

    forgetSession(sessionId) {
      baselines.delete(sessionId);
    },
  };
}
