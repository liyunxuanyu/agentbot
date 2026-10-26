import { randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";
import { config } from "../../config.js";
import * as memoryRepo from "../repo/memory.js";

/**
 * 自动摘要（M7，P0-10）。
 *
 * 触发条件（二选一）：
 *   - Session 消息数达 40（`config.limits.summaryMessageThreshold`）；
 *   - 用户点「立即摘要」（HTTP 路由直接调 `summarizeNow`）。
 *
 * 产出：一条 `kind='summary'` 的记忆条目，**≤500 字符**，`injected=1`，可编辑
 * （前端按 `source='auto'` 标「自动摘要」，编辑走普通 PATCH）。
 *
 * 关键边界：**摘要时运行时不可用 → 保留待摘要标记，下次会话开始前重试，不阻塞对话。**
 * 落地方式（详见 repo/memory.ts 的说明）：一条 `injected=0` 的 `mem_pending_<sessionId>`
 * 行。它不会被注入（injected=0 + id 前缀双保险），也不占 6000 预算。
 * 重试时机：`retryPending()` 由装配层在**每次新 Session 启动前**调用一次。
 *
 * 为什么摘要本身是「本地抽取式」而不是「调运行时生成」：
 *   本模块只依赖 DB，不持有驱动/进程句柄 —— 摘要必须能在对话之外（会话开始前）
 *   执行，一旦绑定运行时就会把「运行时不可用」变成必然失败。所以默认用确定性的
 *   抽取式摘要（用户意图 + 助手结论），保证：① 永远有结果且 ≤500 字符；
 *   ② 可测试；③ 不因运行时故障而静默丢失。运行时可不可用只影响**是否现在做**，
 *   不影响**能不能做** —— 不可用时留标记，下次会话开始前补做。
 */

/** 摘要条目的字符上限（P0-10：≤500 字符），取自 config 以便一处调整。 */
export const SUMMARY_CHAR_LIMIT = config.limits.summaryCharLimit;

/** 摘要生成器：拿到消息样本，返回 ≤500 字符文本。可注入以便测试与将来替换。 */
export type SummaryComposer = (input: {
  botName: string;
  messages: { role: string; content: string }[];
}) => string;

interface SummaryMessage {
  role: string;
  content: string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/**
 * 默认抽取式摘要：
 *   ① 用户问过什么（取前 3 条用户消息）
 *   ② 助手最后给出了什么结论（最后一条助手消息）
 *   ③ 硬性 ≤500 字符
 *
 * 顺序即优先级：预算不够时先砍第 ② 段，用户意图保留得更完整。
 */
export function composeExtractiveSummary(input: {
  botName: string;
  messages: { role: string; content: string }[];
}): string {
  const users = input.messages
    .filter((m) => m.role === "user")
    .map((m) => oneLine(m.content))
    .filter((t) => t.length > 0);
  const assistants = input.messages
    .filter((m) => m.role === "assistant")
    .map((m) => oneLine(m.content))
    .filter((t) => t.length > 0);

  const intents = users.slice(0, 3).map((t) => clip(t, 60));
  const intentLine =
    intents.length > 0 ? `用户关注：${intents.join("；")}。` : "用户关注：本会话未记录明确问题。";

  const conclusion = assistants.length > 0 ? assistants[assistants.length - 1] ?? "" : "";
  const conclusionLine =
    conclusion.length > 0 ? `最后结论：${clip(conclusion, 300)}` : "最后结论：会话尚无助手回复。";

  return clip(`${input.botName} 的会话摘要：${intentLine}${conclusionLine}`, SUMMARY_CHAR_LIMIT);
}

export interface SummarizerDeps {
  db: DB;
  /** 覆盖摘要生成器（测试 / 将来接运行时）。 */
  composer?: SummaryComposer;
  /** 覆盖阈值（默认 config.limits.summaryMessageThreshold = 40）。 */
  threshold?: number;
  /**
   * 运行时是否可用。**不可用时不做摘要，只留待摘要标记**（PRD 边界）。
   * 不传视为「总是可用」（单元测试与不关心运行时的场景）。
   */
  isRuntimeAvailable?: (botId: string) => boolean;
  log?: (msg: string) => void;
}

export interface SummaryOutcome {
  ok: boolean;
  /** 生成的记忆条目 id（ok=true 且真的写了才有）。 */
  entryId?: string;
  /** 本次是否跳过了生成（消息不足阈值 / 已摘要 / 无消息）。 */
  skipped?: boolean;
  /** 失败或跳过原因。ok=false 时待摘要标记已保留。 */
  reason?: string;
  /** 生成文本的字符数。 */
  chars?: number;
}

export interface Summarizer {
  /** Session 消息数达阈值时自动触发；不足阈值返回 skipped。 */
  maybeSummarize(sessionId: string): SummaryOutcome;
  /** 「立即摘要」：不看阈值。 */
  summarizeNow(sessionId: string): SummaryOutcome;
  /** 会话开始前重试所有待摘要标记；返回成功/失败计数。 */
  retryPending(botId?: string): { attempted: number; succeeded: number; failed: number };
  /** 该 Session 是否已有待摘要标记。 */
  hasPending(sessionId: string): boolean;
}

function sessionMessages(db: DB, sessionId: string): SummaryMessage[] {
  return db
    .prepare(
      `SELECT role, content FROM messages
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId) as SummaryMessage[];
}

function botOfSession(
  db: DB,
  sessionId: string,
): { botId: string; name: string; channelId: string | null; channelType: string | null } | null {
  const row = db
    .prepare(
      `SELECT b.id AS bot_id, b.name AS name, s.channel_id AS channel_id, c.type AS channel_type
         FROM sessions s
         JOIN bots b ON b.id = s.bot_id
         LEFT JOIN channels c ON c.id = s.channel_id
        WHERE s.id = ?`,
    )
    .get(sessionId) as
    | { bot_id: string; name: string; channel_id: string | null; channel_type: string | null }
    | undefined;
  return row
    ? {
        botId: row.bot_id,
        name: row.name,
        channelId: row.channel_id,
        channelType: row.channel_type,
      }
    : null;
}

export function createSummarizer(deps: SummarizerDeps): Summarizer {
  const threshold = deps.threshold ?? config.limits.summaryMessageThreshold;
  const composer = deps.composer ?? composeExtractiveSummary;
  const log = deps.log ?? ((m: string) => console.warn(`[memory] ${m}`));

  function keepPending(botId: string, sessionId: string, reason: string): void {
    try {
      memoryRepo.upsertPending(deps.db, { botId, sessionId, reason });
    } catch (err) {
      // 库已关（关服/测试收尾）：标记写不进去，但不影响调用方
      log(`待摘要标记写入失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 真正生成摘要。
   *
   * 失败路径**必须**落待摘要标记：否则一次故障就让这段对话永远失去被摘要的机会
   * （下次没人再触发）。成功路径在同一事务里清标记。
   */
  function summarizeSession(sessionId: string): SummaryOutcome {
    const owner = botOfSession(deps.db, sessionId);
    if (!owner) return { ok: false, reason: "session_not_found" };

    const messages = sessionMessages(deps.db, sessionId).filter((m) => m.content.trim().length > 0);
    if (messages.length === 0) return { ok: true, skipped: true, reason: "no_messages" };

    // 已生成过：不重复追加（同一 Session 只留一条自动摘要）
    if (memoryRepo.hasSummaryForSession(deps.db, sessionId)) {
      memoryRepo.clearPending(deps.db, sessionId);
      return { ok: true, skipped: true, reason: "already_summarized" };
    }

    // 运行时不可用：留标记，下次会话开始前重试，**不阻塞对话**（PRD P0-10 边界）
    if (deps.isRuntimeAvailable && !deps.isRuntimeAvailable(owner.botId)) {
      keepPending(owner.botId, sessionId, "运行时不可用，等待下次会话开始前重试");
      return { ok: false, reason: "runtime_unavailable" };
    }

    let text: string;
    try {
      text = composer({
        botName: owner.name,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }).trim();
      if (text.length === 0) throw new Error("摘要内容为空");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      keepPending(owner.botId, sessionId, reason);
      log(`Session ${sessionId} 摘要失败，已保留待摘要标记：${reason}`);
      return { ok: false, reason };
    }

    // 二次兜底：composer 是可注入的，不能假定它守约
    const clipped = clip(text, SUMMARY_CHAR_LIMIT);
    const id = `mem_${randomUUID()}`;

    // 作用域（R3）：群聊里摘要进 channel 作用域（同群每个 Bot 都能读），
    // 私聊进 session 作用域（同一 Bot 的其它会话读不到）。
    const groupChannel = owner.channelType === "group" ? owner.channelId : null;
    const scope: "channel" | "session" = groupChannel ? "channel" : "session";

    const write = deps.db.transaction(() => {
      memoryRepo.create(deps.db, {
        id,
        botId: owner.botId,
        content: clipped,
        kind: "summary",
        sourceSessionId: sessionId,
        scope,
        channelId: groupChannel,
        injected: true,
      });
      memoryRepo.clearPending(deps.db, sessionId);
    });

    try {
      write();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      keepPending(owner.botId, sessionId, reason);
      log(`Session ${sessionId} 摘要写库失败：${reason}`);
      return { ok: false, reason };
    }

    return { ok: true, entryId: id, chars: clipped.length };
  }

  return {
    maybeSummarize(sessionId) {
      const row = deps.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
        .get(sessionId) as { n: number } | undefined;
      const count = row?.n ?? 0;
      if (count < threshold) {
        return { ok: true, skipped: true, reason: `below_threshold(${count}<${threshold})` };
      }
      return summarizeSession(sessionId);
    },

    summarizeNow(sessionId) {
      return summarizeSession(sessionId);
    },

    retryPending(botId) {
      const pending = memoryRepo.listPending(deps.db, botId);
      let succeeded = 0;
      let failed = 0;
      for (const mark of pending) {
        const sessionId = mark.sourceSessionId;
        if (!sessionId) {
          memoryRepo.remove(deps.db, mark.id);
          continue;
        }
        const outcome = summarizeSession(sessionId);
        if (outcome.ok) succeeded += 1;
        else failed += 1;
      }
      return { attempted: pending.length, succeeded, failed };
    },

    hasPending(sessionId) {
      return memoryRepo.getById(deps.db, memoryRepo.pendingIdOf(sessionId)) !== null;
    },
  };
}
