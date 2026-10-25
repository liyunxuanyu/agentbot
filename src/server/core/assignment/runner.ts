import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type { DB } from "../db/db.js";
import type { TurnOrchestrator } from "../orchestrator/turn.js";
import { sessionCwdOf } from "../process/supervisor.js";
import { waitTurnDone } from "../group/host.js";
import { ensureWorktreeForBot, listChangedFiles, type ChangedFile, type GitRunner } from "./worktree.js";
import { collectReportInput, parseChangedFilesFromReport, renderReport } from "./report.js";

/**
 * Assignment 独立执行（M11 / P0-07）。
 *
 * 三个关键设计（都与「不干扰聊天」有关）：
 *
 *   ① **独立线程**：每个 Assignment 有自己的 `task` 渠道与 Session。聊天会话的
 *      会话锁（`session-lock`）与事件流完全不受影响 —— 这就是「执行中会话可继续聊天」
 *      的落地方式，不是靠 UI 让位。
 *   ② **聊天流只有状态卡片**：创建与终态各写一条 `role='system'` 消息到原会话。
 *      system 不是 Turn，前端不会把它渲染成 Bot 回复，但数据在 `messages` 表里，
 *      卡片 UI（M11 前端）直接读即可。
 *   ③ **报告回贴**：终态时把完整 Markdown 写回原会话，同时持久化在
 *      `assignments.report`（`GET /api/assignments/:id/report.md` 的原文来源）。
 *
 * 队列（PRD P0-07 边界处理）：
 *   - 同一 Bot 同时最多 2 个执行，第 3 个进队列（`queued`），显示「等待前序任务」；
 *   - 队列上限 5，超出在创建时拒绝（HTTP 409），不无限堆积；
 *   - `queue_pos` 落库，重启后按它恢复顺序。
 *
 * 权限：这一轮显式传 `source:'assignment'`，权限卡片自动走 `hold` 档
 * （board 03-decisions Q1），无人值守时不会因 120s 超时被打断。
 */

export const ASSIGNMENT_STATUSES = ["queued", "running", "done", "failed", "timeout"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface AssignmentRow {
  id: string;
  title: string;
  deliverable: string;
  bot_id: string;
  source_channel_id: string | null;
  session_id: string | null;
  worktree_path: string | null;
  status: AssignmentStatus;
  queue_pos: number;
  report: string | null;
  fail_reason: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

interface RawRow {
  id: string;
  title: string;
  deliverable: string;
  bot_id: string;
  source_channel_id: string | null;
  session_id: string | null;
  worktree_path: string | null;
  status: string;
  queue_pos: number;
  report: string | null;
  fail_reason: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export interface CreateAssignmentInput {
  channelId: string;
  sourceMessageId?: string;
  title: string;
  deliverable: string;
  botId: string;
}

export type CreateAssignmentResult =
  | { ok: true; assignment: AssignmentRow }
  | {
      ok: false;
      code: "bot_not_found" | "channel_not_found" | "message_not_found" | "queue_full" | "invalid_input";
      message: string;
    };

export interface AssignmentRunnerDeps {
  db: DB;
  orchestrator: TurnOrchestrator;
  /** 运行时不可用时立刻标失败并给原因，而不是让它挂到超时。 */
  isRuntimeAvailable(botId: string): boolean;
  /** 30 分钟无结束事件 → 超时（PRD 硬要求）；测试注入更短的值。 */
  timeoutMs?: number;
  concurrent?: number;
  queueLimit?: number;
  /** 注入便于测试 git 分支（非 git 仓库 / 创建失败）。 */
  gitRun?: GitRunner;
  log?: (msg: string) => void;
}

export interface AssignmentRunner {
  create(input: CreateAssignmentInput): CreateAssignmentResult;
  /** 启动一次调度（内部自动调用；测试可显式 await 它等「已开跑」）。 */
  pump(botId: string): Promise<void>;
  /** 启动序：把重启前残留的 running 标失败，并按序恢复排队。 */
  recover(): void;
  /** 关服：不再启动新任务。 */
  stop(): void;
}

// ---------------------------------------------------------------------------
// 行转换
// ---------------------------------------------------------------------------

function toRow(raw: RawRow): AssignmentRow {
  const status: AssignmentStatus = (ASSIGNMENT_STATUSES as readonly string[]).includes(raw.status)
    ? (raw.status as AssignmentStatus)
    : "queued";
  return {
    id: raw.id,
    title: raw.title,
    deliverable: raw.deliverable,
    bot_id: raw.bot_id,
    source_channel_id: raw.source_channel_id,
    session_id: raw.session_id,
    worktree_path: raw.worktree_path,
    status,
    queue_pos: raw.queue_pos,
    report: raw.report,
    fail_reason: raw.fail_reason,
    started_at: raw.started_at,
    ended_at: raw.ended_at,
    created_at: raw.created_at,
  };
}

export function getAssignmentRow(db: DB, id: string): AssignmentRow | null {
  const raw = db.prepare("SELECT * FROM assignments WHERE id = ?").get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

export function listAssignmentRows(
  db: DB,
  filter: { status?: AssignmentStatus; botId?: string; channelId?: string } = {},
): AssignmentRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.botId) {
    where.push("bot_id = ?");
    params.push(filter.botId);
  }
  if (filter.channelId) {
    where.push("source_channel_id = ?");
    params.push(filter.channelId);
  }
  const sql = `SELECT * FROM assignments ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY created_at DESC`;
  return (db.prepare(sql).all(...params) as RawRow[]).map(toRow);
}

/**
 * 排队位次（1 起）；非 queued 返回 null。
 *
 * 按 `queue_pos` 排而不是 `created_at`：同一毫秒创建的两条也要有确定顺序，
 * 重启恢复也依赖这一列（架构 §5「queue_pos 持久化，重启后按序恢复」）。
 */
export function queueRankOf(db: DB, row: AssignmentRow): number | null {
  if (row.status !== "queued") return null;
  const ahead = db
    .prepare(
      `SELECT COUNT(*) AS n FROM assignments
        WHERE bot_id = ? AND status = 'queued'
          AND (queue_pos < ? OR (queue_pos = ? AND created_at < ?))`,
    )
    .get(row.bot_id, row.queue_pos, row.queue_pos, row.created_at) as { n: number };
  return ahead.n + 1;
}

// ---------------------------------------------------------------------------
// 回贴与状态卡片
// ---------------------------------------------------------------------------

/**
 * 回贴目标 Session。
 *
 * 优先来源消息所在的 Session（报告紧挨着用户派活那条消息），
 * 其次该 Bot 在该渠道最近的 Session。
 *
 * **绝不新建 Session**：`ChatPage` 把「渠道最新 Session」当当前会话，
 * 凭空插一个空 Session 会让用户正在看的聊天流切走 —— 看起来像消息全丢了。
 * 找不到就不回贴，报告仍然保存在 assignments 里（如实记 warning）。
 */
function postSessionOf(db: DB, row: AssignmentRow, sourceSessionId: string | null): string | null {
  if (sourceSessionId) {
    const hit = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sourceSessionId) as
      | { id: string }
      | undefined;
    if (hit) return hit.id;
  }
  if (!row.source_channel_id) return null;
  const own = db
    .prepare(
      `SELECT id FROM sessions WHERE channel_id = ? AND bot_id = ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(row.source_channel_id, row.bot_id) as { id: string } | undefined;
  if (own) return own.id;
  const any = db
    .prepare("SELECT id FROM sessions WHERE channel_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(row.source_channel_id) as { id: string } | undefined;
  return any?.id ?? null;
}

/**
 * 写一条状态卡片（`role='system'`）。
 *
 * 为什么用 system 而不是 assistant：assistant 会进 Turn 视图（`turnOrder` 由消息驱动），
 * 一个没有事件的 Turn 在 `buildTurnView` 里会被判成 `streaming` —— 用户会看到
 * 一个永远转圈的气泡。system 消息完整落库、不进渲染流，正是「状态卡片」的语义。
 */
function postCard(
  db: DB,
  row: AssignmentRow,
  content: string,
  sourceSessionId: string | null,
  log: (msg: string) => void,
): void {
  if (!row.source_channel_id) return;
  const sessionId = postSessionOf(db, row, sourceSessionId);
  if (!sessionId) {
    log(`任务 ${row.id} 找不到可回贴的 Session，状态卡片未写入`);
    return;
  }
  try {
    db.prepare(
      `INSERT INTO messages
         (id, session_id, channel_id, turn_id, role, content, content_version, status,
          tokens_in, tokens_out, created_at)
       VALUES (?, ?, ?, ?, 'system', ?, 0, 'done', NULL, NULL, ?)`,
    ).run(`msg_${randomUUID()}`, sessionId, row.source_channel_id, `asg_${row.id}`, content, Date.now());
  } catch (err) {
    log(`状态卡片写入失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// 独立线程
// ---------------------------------------------------------------------------

/** 每个 Assignment 一个 task 渠道 —— 这就是「独立线程」。 */
function ensureTaskChannel(db: DB, row: AssignmentRow): string {
  const id = `ch_asg_${row.id}`;
  const existing = db.prepare("SELECT id FROM channels WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (existing) return id;
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'task', ?, ?, ?, ?)`,
  ).run(id, row.title.slice(0, 60), JSON.stringify([row.bot_id]), row.bot_id, Date.now());
  return id;
}

/** 交给运行时的任务 prompt：明确「这是任务不是聊天」，并要求末尾给总结。 */
export function buildAssignmentPrompt(title: string, deliverable: string): string {
  return [
    `你在执行一个已委派的任务，不是聊天。任务标题：${title}`,
    "",
    "交付物要求：",
    deliverable,
    "",
    "完成后直接给出结果，最后用 3 行以内说明：做了什么、改了哪些文件、还有什么没做。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createAssignmentRunner(deps: AssignmentRunnerDeps): AssignmentRunner {
  const db = deps.db;
  const log = deps.log ?? ((msg: string) => console.warn(`[assignment] ${msg}`));
  const timeoutMs = deps.timeoutMs ?? config.limits.assignmentTimeoutMs;
  /**
   * 同一 Bot 的执行并发。
   *
   * **取 1，以 PRD 验收口径为准**：P0-07 边界处理写「同一 Bot 同时 2 个 Assignment：
   * 第二个排队显示『等待前序任务』」—— 即第二个必须排队。架构 §5 写的是「同 Bot 最多
   * 2 个执行中」（config.limits.assignmentConcurrent = 2），两者冲突；验收看 PRD，
   * 所以这里默认 1，并保留参数供将来调整（冲突已写进交付说明的「待确认」）。
   */
  const concurrent = Math.max(1, deps.concurrent ?? 1);
  const queueLimit = Math.max(1, deps.queueLimit ?? config.limits.assignmentQueueLimit);
  const gitRun = deps.gitRun;
  /** 每个 Bot 一条调度链：并发创建时不会把同一个 queued 行取两次。 */
  const pumps = new Map<string, Promise<void>>();
  let stopped = false;

  function countByStatus(botId: string, status: AssignmentStatus): number {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM assignments WHERE bot_id = ? AND status = ?")
      .get(botId, status) as { n: number };
    return row.n;
  }

  function update(
    id: string,
    status: AssignmentStatus,
    patch: {
      sessionId?: string | null;
      worktreePath?: string | null;
      startedAt?: number;
      endedAt?: number;
      failReason?: string | null;
      report?: string | null;
    } = {},
  ): void {
    const sets: string[] = ["status = ?"];
    const params: (string | number | null)[] = [status];
    if (patch.sessionId !== undefined) {
      sets.push("session_id = ?");
      params.push(patch.sessionId);
    }
    if (patch.worktreePath !== undefined) {
      sets.push("worktree_path = ?");
      params.push(patch.worktreePath);
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = ?");
      params.push(patch.startedAt);
    }
    if (patch.endedAt !== undefined) {
      sets.push("ended_at = ?");
      params.push(patch.endedAt);
    }
    if (patch.failReason !== undefined) {
      sets.push("fail_reason = ?");
      params.push(patch.failReason);
    }
    if (patch.report !== undefined) {
      sets.push("report = ?");
      params.push(patch.report);
    }
    params.push(id);
    db.prepare(`UPDATE assignments SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** 收口：算改动文件 → 生成报告 → 落库 → 回贴原会话。 */
  function finalize(
    row: AssignmentRow,
    status: Exclude<AssignmentStatus, "queued" | "running">,
    opts: { cwd: string; failReason: string | null; sourceSessionId: string | null },
  ): void {
    update(row.id, status, { endedAt: Date.now(), failReason: opts.failReason });

    // 报告在状态落库之后生成：renderReport 依据 status 决定是否附事件尾巴
    const changed = listChangedFiles(opts.cwd, gitRun);
    const input = collectReportInput(db, row.id, changed);
    const markdown = input ? renderReport(input) : `# ${row.title}\n\n状态：${status}\n`;
    db.prepare("UPDATE assignments SET report = ? WHERE id = ?").run(markdown, row.id);

    const fresh = getAssignmentRow(db, row.id) ?? row;
    const label = status === "done" ? "任务完成" : status === "timeout" ? "任务超时" : "任务失败";
    postCard(db, fresh, `【${label}】${row.title}\n\n${markdown}`, opts.sourceSessionId, log);
    log(`任务 ${row.id} → ${status}${opts.failReason ? `（${opts.failReason}）` : ""}`);
  }

  /** 执行一个任务。调用方保证同一 Bot 的并发数已受控。 */
  async function execute(row: AssignmentRow, sourceSessionId: string | null): Promise<void> {
    update(row.id, "running", { startedAt: Date.now() });

    // ① 执行位置：worktree 未就绪 → 直接失败并给原因（P0-13「发送时阻止并给重试」）
    const wt = ensureWorktreeForBot(db, row.bot_id, gitRun === undefined ? {} : { run: gitRun });
    if (!wt.ok) {
      finalize(row, "failed", {
        cwd: sessionCwdOf(db, row.bot_id),
        failReason: `worktree 未就绪：${wt.message ?? wt.code ?? "未知原因"}`,
        sourceSessionId,
      });
      return;
    }
    update(row.id, "running", { worktreePath: wt.path });

    if (!deps.isRuntimeAvailable(row.bot_id)) {
      finalize(row, "failed", {
        cwd: wt.path ?? sessionCwdOf(db, row.bot_id),
        failReason: "该 Bot 绑定的运行时当前不可用",
        sourceSessionId,
      });
      return;
    }

    // ② 独立线程 + 独立 Session；权限走 hold（source: 'assignment'）
    const channelId = ensureTaskChannel(db, row);
    let info: Awaited<ReturnType<TurnOrchestrator["start"]>>;
    try {
      info = await deps.orchestrator.start({
        channelId,
        botId: row.bot_id,
        text: buildAssignmentPrompt(row.title, row.deliverable),
        userMessageText: row.deliverable,
        source: "assignment",
      });
    } catch (err) {
      finalize(row, "failed", {
        cwd: wt.path ?? sessionCwdOf(db, row.bot_id),
        failReason: `启动失败：${err instanceof Error ? err.message : String(err)}`,
        sourceSessionId,
      });
      return;
    }
    update(row.id, "running", { sessionId: info.sessionId });

    // ③ 等结束事件；30 分钟没有 → 标超时并保留已有产出
    const waited = await waitTurnDone(db, info.turnId, timeoutMs);
    const cwd = wt.path ?? sessionCwdOf(db, row.bot_id);

    if (waited.status === "timeout") {
      // 先请求中断再收口：已生成的正文留在 messages.content 里，报告会读到
      await deps.orchestrator.cancel(info.sessionId, info.turnId).catch(() => undefined);
      finalize(row, "timeout", {
        cwd,
        failReason: `${Math.round(timeoutMs / 60000)} 分钟无结束事件，已标记超时（已有产出保留）`,
        sourceSessionId,
      });
      return;
    }
    if (waited.status === "failed" || waited.status === "interrupted") {
      finalize(row, "failed", {
        cwd,
        failReason: waited.status === "failed" ? "运行时报告失败（见报告末尾的事件）" : "执行被中断",
        sourceSessionId,
      });
      return;
    }
    finalize(row, "done", { cwd, failReason: null, sourceSessionId });
  }

  /** 调度一轮：在并发上限内把排队任务放出去。 */
  async function pumpOnce(botId: string): Promise<void> {
    for (;;) {
      if (stopped) return;
      if (countByStatus(botId, "running") >= concurrent) return;

      const next = db
        .prepare(
          `SELECT * FROM assignments
            WHERE bot_id = ? AND status = 'queued'
            ORDER BY queue_pos ASC, created_at ASC LIMIT 1`,
        )
        .get(botId) as RawRow | undefined;
      if (!next) return;

      const row = toRow(next);
      // 先抢状态再执行：并发 pump 只有一个能把 queued 改成 running
      const claimed = db
        .prepare(
          "UPDATE assignments SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(Date.now(), row.id);
      if (claimed.changes === 0) continue;

      const sourceSessionId = row.source_channel_id ? postSessionOf(db, row, null) : null;

      // 不 await：同一轮里按上限并行启动（上限 2），完成后各自再触发一轮
      void execute(row, sourceSessionId)
        .catch((err: unknown) => {
          log(`任务 ${row.id} 执行异常：${err instanceof Error ? err.message : String(err)}`);
          try {
            finalize(row, "failed", {
              cwd: sessionCwdOf(db, row.bot_id),
              failReason: `执行异常：${err instanceof Error ? err.message : String(err)}`,
              sourceSessionId,
            });
          } catch {
            // 库已关闭（关服路径）：状态没写成也不影响退出
          }
        })
        .finally(() => {
          void pump(botId).catch(() => undefined);
        });
    }
  }

  async function pump(botId: string): Promise<void> {
    const prev = pumps.get(botId) ?? Promise.resolve();
    const task = prev.then(() => pumpOnce(botId)).catch((err: unknown) => {
      log(`调度失败：${err instanceof Error ? err.message : String(err)}`);
    });
    pumps.set(botId, task);
    return task;
  }

  function create(input: CreateAssignmentInput): CreateAssignmentResult {
    const title = input.title.trim();
    const deliverable = input.deliverable.trim();
    if (title.length === 0 || title.length > 200) {
      return { ok: false, code: "invalid_input", message: "标题需为 1–200 字符" };
    }
    if (deliverable.length === 0) {
      return { ok: false, code: "invalid_input", message: "交付物描述不能为空" };
    }

    const channel = db.prepare("SELECT id FROM channels WHERE id = ?").get(input.channelId) as
      | { id: string }
      | undefined;
    if (!channel) return { ok: false, code: "channel_not_found", message: "会话不存在" };

    const bot = db.prepare("SELECT id FROM bots WHERE id = ?").get(input.botId) as
      | { id: string }
      | undefined;
    if (!bot) return { ok: false, code: "bot_not_found", message: "Bot 不存在" };

    // 来源消息必须属于该渠道：否则报告会贴到用户没在看的地方
    let sourceSessionId: string | null = null;
    if (input.sourceMessageId) {
      const msg = db
        .prepare("SELECT channel_id, session_id FROM messages WHERE id = ?")
        .get(input.sourceMessageId) as { channel_id: string; session_id: string } | undefined;
      if (!msg) return { ok: false, code: "message_not_found", message: "来源消息不存在" };
      if (msg.channel_id !== input.channelId) {
        return { ok: false, code: "invalid_input", message: "来源消息不属于该会话" };
      }
      sourceSessionId = msg.session_id;
    }

    // 队列上限：只算排队中的（执行中的不占队列名额）
    const queued = countByStatus(input.botId, "queued");
    if (queued >= queueLimit) {
      return {
        ok: false,
        code: "queue_full",
        message: `该 Bot 的队列已满（上限 ${queueLimit} 个），等前面的任务完成后再试`,
      };
    }

    const id = `asg_${randomUUID()}`;
    const now = Date.now();
    const maxPos = db
      .prepare("SELECT COALESCE(MAX(queue_pos), 0) AS mx FROM assignments WHERE bot_id = ?")
      .get(input.botId) as { mx: number };

    db.prepare(
      `INSERT INTO assignments
         (id, title, deliverable, bot_id, source_channel_id, session_id, worktree_path,
          status, queue_pos, report, fail_reason, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(id, title, deliverable, input.botId, input.channelId, maxPos.mx + 1, now);

    const row = getAssignmentRow(db, id);
    if (!row) return { ok: false, code: "invalid_input", message: "创建后读不回" };

    // 状态卡片：创建时贴一条，用户立刻看到任务被接住（UX F3 第 1 步）
    const rank = queueRankOf(db, row);
    postCard(
      db,
      row,
      `已排队 · ${row.title}${rank !== null && rank > 1 ? ` · 等待前序任务（队列 ${rank}/${queueLimit}）` : ""}`,
      sourceSessionId,
      log,
    );

    void pump(input.botId).catch(() => undefined);
    return { ok: true, assignment: row };
  }

  function recover(): void {
    // 服务重启：进程已不在，running 不可能还在跑 —— 如实标失败，不假装在跑
    const stale = db.prepare("SELECT * FROM assignments WHERE status = 'running'").all() as RawRow[];
    for (const raw of stale) {
      const row = toRow(raw);
      finalize(row, "failed", {
        cwd: row.worktree_path ?? sessionCwdOf(db, row.bot_id),
        failReason: "服务重启，执行中断",
        sourceSessionId: null,
      });
    }
    if (stale.length > 0) log(`启动恢复：${stale.length} 个执行中的任务标为失败`);

    // 排队按 queue_pos 恢复（重启前已入队的不丢）
    const bots = db
      .prepare("SELECT DISTINCT bot_id FROM assignments WHERE status = 'queued'")
      .all() as { bot_id: string }[];
    for (const b of bots) void pump(b.bot_id).catch(() => undefined);
  }

  return {
    create,
    pump,
    recover,
    stop() {
      stopped = true;
    },
  };
}

// ---------------------------------------------------------------------------
// DTO（REST 与前端契约）
// ---------------------------------------------------------------------------

export interface AssignmentDto {
  id: string;
  title: string;
  deliverable: string;
  botId: string;
  botName: string;
  runtimeName: string | null;
  sourceChannelId: string | null;
  sessionId: string | null;
  status: AssignmentStatus;
  /** 排队位次（1 起）；非排队为 null。前端显示「等待前序任务（队列 2/5）」。 */
  queuePosition: number | null;
  queueLimit: number;
  report: string | null;
  failReason: string | null;
  executionLocation: "local" | "worktree";
  worktreePath: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  /** 已耗时；排队中为 null。 */
  durationMs: number | null;
  /** 该任务独立线程里的事件数（卡片显示「N 条事件」）。 */
  eventCount: number;
  /** 改动文件：仅详情返回（列表不跑 git）。 */
  changedFiles: ChangedFile[] | null;
}

interface BotInfoRow {
  name: string;
  execution_location: string;
  worktree_path: string | null;
  display_name: string | null;
}

export function toAssignmentDto(
  db: DB,
  row: AssignmentRow,
  opts: { withFiles?: boolean } = {},
): AssignmentDto {
  const bot = db
    .prepare(
      `SELECT b.name, b.execution_location, b.worktree_path, r.display_name
         FROM bots b LEFT JOIN runtime_definitions r ON r.id = b.default_runtime_id
        WHERE b.id = ?`,
    )
    .get(row.bot_id) as BotInfoRow | undefined;

  let eventCount = 0;
  if (row.session_id) {
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
      .get(row.session_id) as { n: number };
    eventCount = n.n;
  }

  const startedAt = row.started_at;
  const endedAt = row.ended_at;

  return {
    id: row.id,
    title: row.title,
    deliverable: row.deliverable,
    botId: row.bot_id,
    botName: bot?.name ?? "（已删除的 Bot）",
    runtimeName: bot?.display_name ?? null,
    sourceChannelId: row.source_channel_id,
    sessionId: row.session_id,
    status: row.status,
    queuePosition: queueRankOf(db, row),
    queueLimit: config.limits.assignmentQueueLimit,
    report: row.report,
    failReason: row.fail_reason,
    executionLocation: bot?.execution_location === "worktree" ? "worktree" : "local",
    worktreePath: row.worktree_path ?? bot?.worktree_path ?? null,
    startedAt,
    endedAt,
    createdAt: row.created_at,
    durationMs: startedAt === null ? null : Math.max(0, (endedAt ?? Date.now()) - startedAt),
    eventCount,
    // 改动文件从已存报告解析：与报告完全一致，重启后也不漂移（不重跑 git）
    changedFiles:
      opts.withFiles === true && row.report ? parseChangedFilesFromReport(row.report) : null,
  };
}

/** 终态判定（前端标签分组用）。 */
export function isTerminalStatus(status: AssignmentStatus): boolean {
  return status === "done" || status === "failed" || status === "timeout";
}
