import { randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";

/**
 * 写一条系统消息到会话流（群聊的降级提示、Assignment 的状态卡片与报告回贴）。
 *
 * 为什么是 `role='system'` 而不是 assistant：
 *   - 它不是任何 Bot 的一轮 Turn，前端不会把它渲染成「某个 Bot 的回复」；
 *   - 但它必须进 `messages` 表 —— 断线重连后用户仍要看到「本轮无 Bot 发言」、
 *     「已排队」、「任务完成」这些事实（P0-15：messages 是唯一真相）。
 *
 * 写入失败只记 warning：系统提示是辅助信息，不能因为它写不进去就让主流程失败。
 */
export interface SystemNoticeInput {
  channelId: string;
  /** 目标 Session（群聊提示落在主持人/发言人的会话里；没有就只存库外的日志）。 */
  sessionId: string | null;
  /** 归属的伪 turnId：让前端能把同一张卡片的多条提示归到一组。 */
  turnId: string;
  content: string;
}

export function postSystemNotice(db: DB, input: SystemNoticeInput): string | null {
  if (!input.sessionId) {
    console.warn(`[notice] 会话 ${input.channelId} 没有可用 Session，系统提示未落库：${input.content.slice(0, 80)}`);
    return null;
  }
  const id = `msg_${randomUUID()}`;
  try {
    db.prepare(
      `INSERT INTO messages
         (id, session_id, channel_id, turn_id, role, content, content_version, status,
          tokens_in, tokens_out, created_at)
       VALUES (?, ?, ?, ?, 'system', ?, 0, 'done', NULL, NULL, ?)`,
    ).run(id, input.sessionId, input.channelId, input.turnId, input.content, Date.now());
    return id;
  } catch (err) {
    console.warn(
      `[notice] 系统消息写入失败：${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** 该渠道的「当前 Session」：优先指定 Bot 的会话，否则该渠道最新的一条。 */
export function currentSessionOf(db: DB, channelId: string, botId?: string): string | null {
  if (botId) {
    const own = db
      .prepare(
        `SELECT id FROM sessions WHERE channel_id = ? AND bot_id = ?
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(channelId, botId) as { id: string } | undefined;
    if (own) return own.id;
  }
  const any = db
    .prepare("SELECT id FROM sessions WHERE channel_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(channelId) as { id: string } | undefined;
  return any?.id ?? null;
}
