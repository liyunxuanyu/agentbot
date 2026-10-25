import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type { DB } from "../db/db.js";
import type { TurnOrchestrator } from "../orchestrator/turn.js";
import { waitTurnDone } from "../group/host.js";
import { postSystemNotice } from "../group/notices.js";
import {
  computeNextRun,
  describeTrigger,
  TRIGGER_TYPES,
  validateTrigger,
  type TriggerSpec,
  type TriggerType,
} from "./triggers.js";

/**
 * 定时任务调度器（M12 / P0-11）。
 *
 * 六条纪律，每条对应 PRD 的一句边界处理：
 *
 *   ① **不常驻轮询**：只在「最早的下一次触发」上挂一个 `setTimeout`，触发后重排。
 *      每秒扫库会让本地服务一直醒着（board 已决：一次性延迟 + 周期触发，不做常驻轮询）。
 *   ② **启动时重建**：重启后内存定时器全丢，`start()` 按 `next_run_at` 重排；
 *      已过期的视为「服务未运行错过触发」→ **补跑 1 次**并标「补跑」。
 *   ③ **补跑不重复**：执行**之前**先把 `next_run_at` 推到下一次（或置 NULL），
 *      持久标记就是 `next_run_at` 本身 —— 重启后不会第二次补跑。
 *   ④ **连续失败 3 次自动暂停**：`fail_count` 落库；达阈值把 `enabled` 置 0，
 *      原因写进 `last_result`（前端行变灰 + 显示原因 + 「恢复」）。
 *   ⑤ **一次性任务执行后完成**：`next_run_at` 置 NULL、`enabled` 置 0，记录保留。
 *   ⑥ **权限走 hold**：`source:'schedule'` 让 `permissions/policy` 自动选 hold 档，
 *      无人值守时不会因 120s 超时被打断（board 03-decisions Q1）。
 *
 * 结果回贴沿用 M11 的做法：**不造假 Turn**，触发与结果各写一条 `role='system'`
 * 消息到原会话；Bot 的真实回复是它自己的 Turn（assistant 消息由编排层产生）。
 *
 * 为什么状态没有独立列：`schedules` 表由 M2 定稿，本轮不改 schema。
 * 状态全部由 `enabled` / `next_run_at` / `last_result` / `fail_count` 组合推导
 * （见 `scheduleStatusOf`），足够表达 active / paused / completed。
 */

export interface ScheduleRow {
  id: string;
  name: string;
  bot_id: string;
  channel_id: string;
  prompt: string;
  trigger_type: string;
  interval_minutes: number | null;
  delay_minutes: number | null;
  at_time: string | null;
  next_run_at: number | null;
  last_result: string | null;
  last_run_at: number | null;
  fail_count: number;
  enabled: number;
  created_at: number;
}

export type ScheduleStatus = "active" | "paused" | "completed" | "bot_archived";

export interface ScheduleDto {
  id: string;
  name: string;
  botId: string;
  botName: string | null;
  channelId: string;
  channelName: string | null;
  prompt: string;
  triggerType: TriggerType;
  /** 人类可读的触发规则（「每 30 分钟」）。 */
  trigger: string;
  delayMinutes: number | null;
  intervalMinutes: number | null;
  atTime: string | null;
  nextRunAt: number | null;
  lastResult: string | null;
  lastRunAt: number | null;
  failCount: number;
  enabled: boolean;
  status: ScheduleStatus;
  /** 是否因连续失败被自动暂停（前端显示「已自动暂停」+ 原因）。 */
  autoPaused: boolean;
  createdAt: number;
}

export type CreateScheduleResult =
  | { ok: true; schedule: ScheduleRow }
  | { ok: false; code: string; message: string; field?: string };

export interface SchedulerDeps {
  db: DB;
  orchestrator: TurnOrchestrator;
  /** 运行时不可用时立刻判失败（不白等 24h）。 */
  isRuntimeAvailable(botId: string): boolean;
  /**
   * 单次执行的等待上限。默认取 hold 的 24h：定时任务的权限走 hold，
   * 提前超时会把「等用户回来批准」变成失败，与 board 决定冲突。
   */
  turnTimeoutMs?: number;
  /** 周期最小间隔（分钟）；默认 config.limits.minScheduleIntervalMinutes。 */
  minIntervalMinutes?: number;
  /** 连续失败几次自动暂停；默认 config.limits.scheduleFailurePauseThreshold。 */
  failurePauseThreshold?: number;
  /** 注入便于测试。 */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Scheduler {
  /** 启动：补跑过期任务 + 重排。 */
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** 配置变化（新建 / 恢复 / 改名）后重排。 */
  reschedule(): void;
  /**
   * 立即处理所有到期任务，返回「本次启动了几条」。
   *
   * `catchup=true` 时把结果标成「补跑」（启动补跑用）。执行本身在后台串行队列里跑，
   * 不阻塞调用方 —— 一条任务可能挂起 24h（权限 hold），不能把定时器卡死。
   * 要等执行结束用 `drain()`。
   */
  runDue(opts?: { catchup?: boolean }): Promise<number>;
  /** 等当前执行队列清空（测试与关服用）。 */
  drain(): Promise<void>;
  /** 立刻执行一条（手动触发 / 测试）；等待执行完成。 */
  trigger(id: string): Promise<void>;
}

function toTriggerSpec(row: ScheduleRow): TriggerSpec {
  return {
    triggerType: (TRIGGER_TYPES as readonly string[]).includes(row.trigger_type)
      ? (row.trigger_type as TriggerType)
      : "once",
    delayMinutes: row.delay_minutes,
    intervalMinutes: row.interval_minutes,
    atTime: row.at_time,
  };
}

export function getScheduleRow(db: DB, id: string): ScheduleRow | null {
  const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  return row ?? null;
}

export function listScheduleRows(db: DB): ScheduleRow[] {
  return db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all() as ScheduleRow[];
}

/** 状态推导（无 status 列，全部由现有列组合而来，见文件头纪律 ④⑤）。 */
export function scheduleStatusOf(
  row: ScheduleRow,
  botStatus: string | null,
  failureThreshold: number = config.limits.scheduleFailurePauseThreshold,
): ScheduleStatus {
  if (botStatus === "archived") return "bot_archived";
  // 一次性任务：next_run_at 被置 NULL 即「已认领/已执行完」。
  // 有结果 → completed；还没有结果 → 正在跑（显示 active，不能显示「已暂停」）。
  if (row.trigger_type === "once" && row.next_run_at === null) {
    return row.last_result !== null ? "completed" : "active";
  }
  return row.enabled === 1 ? "active" : "paused";
}

export function toScheduleDto(db: DB, row: ScheduleRow): ScheduleDto {
  const bot = db
    .prepare("SELECT name, status FROM bots WHERE id = ?")
    .get(row.bot_id) as { name: string; status: string } | undefined;
  const channel = db
    .prepare("SELECT name FROM channels WHERE id = ?")
    .get(row.channel_id) as { name: string } | undefined;
  const spec = toTriggerSpec(row);
  const threshold = config.limits.scheduleFailurePauseThreshold;

  return {
    id: row.id,
    name: row.name,
    botId: row.bot_id,
    botName: bot?.name ?? null,
    channelId: row.channel_id,
    channelName: channel?.name ?? null,
    prompt: row.prompt,
    triggerType: spec.triggerType,
    trigger: describeTrigger(spec),
    delayMinutes: row.delay_minutes,
    intervalMinutes: row.interval_minutes,
    atTime: row.at_time,
    nextRunAt: row.next_run_at,
    lastResult: row.last_result,
    lastRunAt: row.last_run_at,
    failCount: row.fail_count,
    enabled: row.enabled === 1,
    status: scheduleStatusOf(row, bot?.status ?? null),
    autoPaused: row.enabled === 0 && row.fail_count >= threshold,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  name: string;
  botId: string;
  channelId: string;
  prompt: string;
  triggerType: TriggerType;
  delayMinutes?: number | null;
  intervalMinutes?: number | null;
  atTime?: string | null;
}

/**
 * 创建并落库。校验顺序：名称/内容 → Bot/会话 → 触发参数。
 *
 * 创建时就把 `next_run_at` 算好落库：调度器重启后靠它恢复，
 * 内存里不留「待触发」状态（纪律 ②）。
 */
export function createSchedule(
  db: DB,
  input: CreateScheduleInput,
  opts: { minIntervalMinutes: number; now?: number },
): CreateScheduleResult {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 60) {
    return { ok: false, code: "invalid_input", field: "name", message: "名称需为 1–60 字符" };
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return { ok: false, code: "invalid_input", field: "prompt", message: "任务内容不能为空" };
  }

  const bot = db.prepare("SELECT id, status FROM bots WHERE id = ?").get(input.botId) as
    | { id: string; status: string }
    | undefined;
  if (!bot) return { ok: false, code: "bot_not_found", field: "botId", message: "目标 Bot 不存在" };
  if (bot.status !== "active") {
    return {
      ok: false,
      code: "bot_archived",
      field: "botId",
      message: "目标 Bot 已归档，不能创建定时任务",
    };
  }

  const channel = db
    .prepare("SELECT id, type, participant_bot_ids FROM channels WHERE id = ?")
    .get(input.channelId) as
    | { id: string; type: string; participant_bot_ids: string }
    | undefined;
  if (!channel) {
    return { ok: false, code: "channel_not_found", field: "channelId", message: "目标会话不存在" };
  }
  // 目标 Bot 必须在这个会话里：否则执行结果贴进一个它不参与的会话
  let participants: string[] = [];
  try {
    const parsed: unknown = JSON.parse(channel.participant_bot_ids);
    participants = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    participants = [];
  }
  if (!participants.includes(input.botId)) {
    return {
      ok: false,
      code: "bot_not_in_channel",
      field: "channelId",
      message: "目标 Bot 不在该会话里，执行结果无处回贴",
    };
  }

  const spec: TriggerSpec = {
    triggerType: input.triggerType,
    delayMinutes: input.delayMinutes ?? null,
    intervalMinutes: input.intervalMinutes ?? null,
    atTime: input.atTime ?? null,
  };
  const validation = validateTrigger(spec, { minIntervalMinutes: opts.minIntervalMinutes });
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code ?? "invalid_trigger",
      field: "trigger",
      message: validation.message ?? "触发参数不合法",
    };
  }

  const now = opts.now ?? Date.now();
  const nextRunAt = computeNextRun(spec, now);
  const id = `sch_${randomUUID()}`;

  db.prepare(
    `INSERT INTO schedules
       (id, name, bot_id, channel_id, prompt, trigger_type, interval_minutes, delay_minutes,
        at_time, next_run_at, last_result, last_run_at, fail_count, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, ?)`,
  ).run(
    id,
    name,
    input.botId,
    input.channelId,
    prompt,
    spec.triggerType,
    spec.intervalMinutes ?? null,
    spec.delayMinutes ?? null,
    spec.atTime ?? null,
    nextRunAt,
    now,
  );

  const row = getScheduleRow(db, id);
  if (!row) return { ok: false, code: "internal_error", message: "创建后读不回" };
  return { ok: true, schedule: row };
}

// ---------------------------------------------------------------------------
// 调度器
// ---------------------------------------------------------------------------

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const db = deps.db;
  const log = deps.log ?? ((msg: string) => console.warn(`[scheduler] ${msg}`));
  const now = deps.now ?? (() => Date.now());
  const turnTimeoutMs = deps.turnTimeoutMs ?? config.timeouts.permissionHoldMaxMs;
  const minIntervalMinutes = deps.minIntervalMinutes ?? config.limits.minScheduleIntervalMinutes;
  const failurePauseThreshold =
    deps.failurePauseThreshold ?? config.limits.scheduleFailurePauseThreshold;

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  /** 正在执行的 id：同一任务不会被定时器与手动触发同时跑两遍。 */
  const executing = new Set<string>();
  /** 关服标记：不再启动新执行（已在跑的不杀，它自己会收口）。 */
  let stopped = false;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 取下一条要触发的（enabled=1 且 next_run_at 非空）。 */
  function nextDueAt(): number | null {
    const row = db
      .prepare(
        `SELECT MIN(next_run_at) AS ts FROM schedules
          WHERE enabled = 1 AND next_run_at IS NOT NULL`,
      )
      .get() as { ts: number | null } | undefined;
    return row?.ts ?? null;
  }

  /** 重排：只挂一个 setTimeout 指向最早的任务（纪律 ①）。 */
  function arm(): void {
    clearTimer();
    if (!running || stopped) return;
    const due = nextDueAt();
    if (due === null) return;
    // 已过期（补跑前）按 0 延迟立即跑
    const delay = Math.max(0, due - now());
    // setTimeout 上限约 24.8 天：更远的一次性任务分多段等待
    const capped = Math.min(delay, 2_147_483_647);
    timer = setTimeout(() => {
      timer = null;
      void runDueWith(false)
        .catch((err: unknown) => {
          log(`到期处理失败：${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          arm();
        });
    }, capped);
    timer.unref?.();
  }

  /**
   * 推进 `next_run_at` 并算出执行后应有的状态。
   *
   * 必须在执行**之前**调用：这样即使执行中进程崩了，重启也不会再补跑一次
   * （纪律 ③：补跑只 1 次）。
   *
   * 一次性任务的 `enabled` **此刻不动**：它表示「用户启用」，不是「还能触发」。
   * 若在这里置 0，执行中的几十秒里列表会显示「已暂停」—— 用户会以为任务被拦下了。
   * 真正的「完成」由执行结果写（`succeed` / `fail` 置 enabled=0）。
   * 也不会重复触发：`runDue` 的条件是 `next_run_at IS NOT NULL`，已置空即出局。
   */
  function claim(row: ScheduleRow): { nextRunAt: number | null; enabled: number } {
    const spec = toTriggerSpec(row);
    if (spec.triggerType === "once") {
      return { nextRunAt: null, enabled: row.enabled };
    }
    return { nextRunAt: computeNextRun(spec, now()), enabled: 1 };
  }

  interface ResultPatch {
    lastResult: string;
    lastRunAt: number;
    failCount: number;
    enabled?: number;
    /** undefined = 不改 next_run_at；null = 置空。 */
    nextRunAt?: number | null;
  }

  /** 只推进「认领」字段：不碰 last_result / last_run_at（它们由执行结果写）。 */
  function applyClaim(id: string, claimed: { nextRunAt: number | null; enabled: number }): void {
    try {
      db.prepare("UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ?").run(
        claimed.nextRunAt,
        claimed.enabled,
        id,
      );
    } catch (err) {
      log(`认领写入失败（${id}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function markResult(id: string, patch: ResultPatch): void {
    try {
      if (patch.nextRunAt === undefined) {
        db.prepare(
          `UPDATE schedules
              SET last_result = ?, last_run_at = ?, fail_count = ?,
                  enabled = COALESCE(?, enabled)
            WHERE id = ?`,
        ).run(
          patch.lastResult,
          patch.lastRunAt,
          patch.failCount,
          patch.enabled ?? null,
          id,
        );
        return;
      }
      db.prepare(
        `UPDATE schedules
            SET last_result = ?, last_run_at = ?, fail_count = ?,
                enabled = COALESCE(?, enabled), next_run_at = ?
          WHERE id = ?`,
      ).run(
        patch.lastResult,
        patch.lastRunAt,
        patch.failCount,
        patch.enabled ?? null,
        patch.nextRunAt,
        id,
      );
    } catch (err) {
      log(`结果写入失败（${id}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 回贴目标：该 Bot 在该渠道的最新 Session（没有就只打日志，见 notices）。 */
  function currentSessionOf(row: ScheduleRow): string | null {
    const own = db
      .prepare(
        `SELECT id FROM sessions WHERE channel_id = ? AND bot_id = ?
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(row.channel_id, row.bot_id) as { id: string } | undefined;
    if (own) return own.id;
    const any = db
      .prepare("SELECT id FROM sessions WHERE channel_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(row.channel_id) as { id: string } | undefined;
    return any?.id ?? null;
  }

  /**
   * 触发提示要落在**这条任务即将使用的 Session** 上。
   *
   * 首次触发时该 Bot 在这个渠道里可能一个 Session 都没有（用户只建了定时任务）。
   * 不补建的话「定时任务触发」这条系统块会被 `postSystemNotice` 丢掉 —— 用户
   * 只看到一条 Bot 回复，不知道它是谁触发的。补建一行 `status='created'` 的空
   * Session 即可：编排层的 `findSessionId` 会复用它，不会多开进程。
   * （与 `http/routes/messages.ts` 的 `ensureAnchorSession` 同一策略。）
   */
  function ensureAnchorSession(row: ScheduleRow): string | null {
    const existing = currentSessionOf(row);
    if (existing) return existing;
    const id = `sess_${randomUUID()}`;
    try {
      db.prepare(
        `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
         VALUES (?, ?, ?, NULL, 'fresh', 'created', ?)`,
      ).run(id, row.bot_id, row.channel_id, now());
      return id;
    } catch (err) {
      log(`锚点 Session 创建失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  function systemNotice(row: ScheduleRow, content: string): void {
    postSystemNotice(db, {
      channelId: row.channel_id,
      sessionId: ensureAnchorSession(row),
      turnId: `sch_${row.id}`,
      content,
    });
  }

  function botNameOf(botId: string): string {
    const row = db.prepare("SELECT name FROM bots WHERE id = ?").get(botId) as
      | { name: string }
      | undefined;
    return row?.name ?? "（已删除的 Bot）";
  }

  /**
   * 记一次成功。**不动 `next_run_at`**：它在执行前已被 claim 推进过
   * （执行中再算一次会让周期按「完成时刻」累积漂移）。
   *
   * 一次性任务在这里置 `enabled=0`：它已经跑完，默认不再点亮。
   * 用户若在列表里显式「恢复」，PATCH 会重算 `next_run_at` 并重新武装它 ——
   * 那是一次明确的「再跑一次」操作，不是意外重跑。
   *
   * `catchup` 会写进 `last_result` 的前缀（「补跑 · 成功 · 3s」）：这是
   * 「补跑」的**持久标记** —— 重启后仍能从列表里看出这次是补跑，
   * 同时 `next_run_at` 已推进，保证不会再补第二次。
   */
  function succeed(row: ScheduleRow, text: string, at: number, catchup: boolean): void {
    markResult(row.id, {
      lastResult: `${catchup ? "补跑 · " : ""}${text}`,
      lastRunAt: at,
      failCount: 0,
      ...(row.trigger_type === "once" ? { enabled: 0 } : {}),
    });
  }

  /**
   * 记一次失败。周期任务连续失败达到阈值 → 自动暂停并写明原因（纪律 ④）。
   * 一次性任务失败也是「结束」（enabled 置 0），但不会算作「自动暂停」。
   */
  function fail(row: ScheduleRow, text: string, at: number, catchup: boolean): void {
    const fresh = getScheduleRow(db, row.id);
    if (!fresh) return;
    const failCount = fresh.fail_count + 1;
    const prefix = catchup ? "补跑 · " : "";

    if (fresh.trigger_type !== "once" && failCount >= failurePauseThreshold) {
      markResult(row.id, {
        lastResult: `${prefix}${text} · 连续失败 ${failCount} 次，已自动暂停`,
        lastRunAt: at,
        failCount,
        enabled: 0,
      });
      log(`任务 ${row.id}「${row.name}」连续失败 ${failCount} 次，已自动暂停`);
      return;
    }

    markResult(row.id, {
      lastResult: `${prefix}${text}`,
      lastRunAt: at,
      failCount,
      ...(fresh.trigger_type === "once" ? { enabled: 0 } : {}),
    });
  }

  /**
   * 执行一条定时任务。
   *
   * `catchup=true` 表示这次是「服务未运行错过触发」的补跑：系统块里会标「补跑」。
   *
   * 调用方负责 `executing` 集合的进出（它同时承担「已认领」与「执行中」两个语义，
   * 防止定时器与手动触发把同一条跑两遍）。
   */
  async function execute(row: ScheduleRow, catchup: boolean): Promise<"done" | "failed"> {
    const botName = botNameOf(row.bot_id);
    const label = `定时任务「${row.name}」${catchup ? "补跑" : "触发"}`;
    const startedAt = now();
    systemNotice(row, `${label} · ${botName}`);

    try {
      if (!deps.isRuntimeAvailable(row.bot_id)) {
        const reason = "运行时不可用，未执行";
        systemNotice(row, `${label} 失败：${reason}`);
        fail(row, reason, startedAt, catchup);
        return "failed";
      }

      const info = await deps.orchestrator.start({
        channelId: row.channel_id,
        botId: row.bot_id,
        text: row.prompt,
        // 用户消息就是任务内容：会话流里能看出「这条是定时任务发的」
        userMessageText: row.prompt,
        source: "schedule",
      });

      const waited = await waitTurnDone(db, info.turnId, turnTimeoutMs);

      if (waited.status === "done") {
        const took = Math.max(1, Math.round((now() - startedAt) / 1000));
        const preview = waited.content.trim().slice(0, 120);
        systemNotice(
          row,
          `${label} 完成 · 用时 ${took}s${preview.length > 0 ? `\n${preview}` : ""}`,
        );
        succeed(row, `成功 · ${took}s`, startedAt, catchup);
        return "done";
      }

      if (waited.status === "timeout") {
        // 与 Assignment 同语义：先请求中断再收口，已有产出保留在 messages.content
        await deps.orchestrator.cancel(info.sessionId, info.turnId).catch(() => undefined);
        const reason = `${Math.round(turnTimeoutMs / 60000)} 分钟无结束事件，已标记超时`;
        systemNotice(row, `${label} 失败：${reason}`);
        fail(row, `超时 · ${reason}`, startedAt, catchup);
        return "failed";
      }

      const reason = waited.status === "interrupted" ? "执行被中断" : "运行时报告失败";
      systemNotice(row, `${label} 失败：${reason}`);
      fail(row, `失败 · ${reason}`, startedAt, catchup);
      return "failed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      systemNotice(row, `${label} 失败：${message}`);
      fail(row, `失败 · ${message}`, startedAt, catchup);
      return "failed";
    } finally {
      executing.delete(row.id);
    }
  }

  /**
   * 执行队列（严格串行）。
   *
   * 为什么必须串行：定时任务与聊天共用同一个运行时进程池，同时开多个会让
   * 本地机器瞬间吃满（架构 §5 并发与隔离）。串行也让「连续失败 3 次」的计数
   * 不会因为并发写而丢更新。
   *
   * 队列用 promise 链而不是数组：任务可能挂起 24h（权限 hold），链式写法
   * 不需要额外的状态机，`drain()` 就是等这条链。
   */
  let chain: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<unknown>): void {
    chain = chain.then(
      () => task().then(() => undefined),
      () => task().then(() => undefined),
    );
    chain = chain.catch((err: unknown) => {
      log(`执行异常：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * 处理所有到期任务。
   *
   * `catchup` 由调用方决定：`start()` 时一律 true；定时器触发一律 false。
   * 每条先 claim（推进 next_run_at）再执行 —— 见 claim 的注释。
   */
  async function runDueWith(catchup: boolean): Promise<number> {
    if (stopped) return 0;
    const at = now();
    const due = db
      .prepare(
        `SELECT * FROM schedules
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
      )
      .all(at) as ScheduleRow[];
    if (due.length === 0) return 0;

    let started = 0;
    for (const row of due) {
      if (executing.has(row.id)) continue;

      // Bot 已归档：不执行，也不反复刷失败计数（如实写一条结果即可）
      const bot = db.prepare("SELECT status FROM bots WHERE id = ?").get(row.bot_id) as
        | { status: string }
        | undefined;
      if (bot?.status !== "active") {
        markResult(row.id, {
          lastResult: "未执行 · 目标 Bot 已归档",
          lastRunAt: at,
          failCount: row.fail_count,
          enabled: 0,
          nextRunAt: null,
        });
        continue;
      }

      // 先推进时间（纪律 ③）：崩在这里也不会重复补跑
      applyClaim(row.id, claim(row));
      executing.add(row.id);

      started += 1;
      enqueue(() => execute(row, catchup));
    }
    return started;
  }

  return {
    get running() {
      return running;
    },

    start() {
      if (running) return;
      running = true;
      stopped = false;

      // 启动补跑：此时 next_run_at 已过期 = 服务没在跑时错过的触发（纪律 ②③）
      const missed = db
        .prepare(
          `SELECT COUNT(*) AS n FROM schedules
            WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
        )
        .get(now()) as { n: number };
      if (missed.n > 0) log(`启动补跑：${missed.n} 条错过的定时任务（各补跑 1 次）`);

      void runDueWith(true)
        .catch((err: unknown) => {
          log(`启动补跑失败：${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          arm();
        });
    },

    stop() {
      stopped = true;
      running = false;
      clearTimer();
    },

    reschedule() {
      arm();
    },

    runDue(opts = {}) {
      return runDueWith(opts.catchup === true);
    },

    async drain() {
      await chain.catch(() => undefined);
    },

    async trigger(id) {
      const row = getScheduleRow(db, id);
      if (!row) return;
      if (executing.has(row.id)) return;
      applyClaim(row.id, claim(row));
      executing.add(row.id);
      await execute(row, false);
    },
  };
}

// 触发规则的类型与纯函数统一从 triggers.ts 导入；本文件只导出调度器与行转换。
export type { TriggerSpec, TriggerType };
