import type { DB } from "../db/db.js";

/**
 * messages 仓储 —— 纯 SQL，同步 API。
 *
 * `messages.content` 是助手正文的唯一权威副本（P0-04/P0-15）：
 * 事件流只做增量通知，断线重连后前端用这里的 content 整体覆盖本地文本，
 * 因此任何地方都不得用事件累积去重建正文。
 */

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "streaming" | "done" | "interrupted" | "failed";

export interface MessageRow {
  id: string;
  sessionId: string;
  channelId: string;
  turnId: string;
  role: MessageRole;
  content: string;
  contentVersion: number;
  status: MessageStatus;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: number;
}

interface RawRow {
  id: string;
  session_id: string;
  channel_id: string;
  turn_id: string;
  role: string;
  content: string;
  content_version: number;
  status: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: number;
}

function toRow(raw: RawRow): MessageRow {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    channelId: raw.channel_id,
    turnId: raw.turn_id,
    role: raw.role as MessageRole,
    content: raw.content,
    contentVersion: raw.content_version,
    status: raw.status as MessageStatus,
    tokensIn: raw.tokens_in,
    tokensOut: raw.tokens_out,
    createdAt: raw.created_at,
  };
}

export interface CreateMessageInput {
  id: string;
  sessionId: string;
  channelId: string;
  turnId: string;
  role: MessageRole;
  content?: string;
  status?: MessageStatus;
  tokensIn?: number | null;
  tokensOut?: number | null;
  createdAt?: number;
}

export function create(db: DB, input: CreateMessageInput): MessageRow {
  const createdAt = input.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO messages
       (id, session_id, channel_id, turn_id, role, content, content_version, status,
        tokens_in, tokens_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.channelId,
    input.turnId,
    input.role,
    input.content ?? "",
    input.status ?? "streaming",
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    createdAt,
  );

  const row = getById(db, input.id);
  if (!row) throw new Error(`消息写入后读不回：${input.id}`);
  return row;
}

export function getById(db: DB, id: string): MessageRow | null {
  const raw = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

export type AppendResult =
  | { ok: true; contentVersion: number; content: string }
  | { ok: false; currentVersion: number };

export interface AppendContentInput {
  id: string;
  delta: string;
  /**
   * 乐观并发：调用方读到的版本号。不传则无条件追加。
   * 单写者（会话锁）下不会冲突，这里保留 compare-and-set 是为了
   * 将来多进程或前端回写时能立刻发现踩踏，而不是静默覆盖。
   */
  expectedVersion?: number;
}

/** 追加正文并 `content_version++`；返回写入后的版本供调用方缓存。 */
export function appendContent(db: DB, input: AppendContentInput): AppendResult {
  const stmt =
    input.expectedVersion === undefined
      ? db.prepare(
          `UPDATE messages
              SET content = content || ?, content_version = content_version + 1
            WHERE id = ?`,
        )
      : db.prepare(
          `UPDATE messages
              SET content = content || ?, content_version = content_version + 1
            WHERE id = ? AND content_version = ?`,
        );

  const params =
    input.expectedVersion === undefined
      ? [input.delta, input.id]
      : [input.delta, input.id, input.expectedVersion];

  const info = stmt.run(...params);
  const raw = db
    .prepare("SELECT content, content_version FROM messages WHERE id = ?")
    .get(input.id) as { content: string; content_version: number } | undefined;

  if (!raw) throw new Error(`追加正文失败，消息不存在：${input.id}`);

  if (info.changes === 0) {
    return { ok: false, currentVersion: raw.content_version };
  }
  return { ok: true, contentVersion: raw.content_version, content: raw.content };
}

export interface FinalizeInput {
  id: string;
  status: Exclude<MessageStatus, "streaming">;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** 收口消息；只改状态与用量，正文保持追加结果不动。 */
export function finalize(db: DB, input: FinalizeInput): boolean {
  const info = db
    .prepare(
      `UPDATE messages
          SET status = ?,
              tokens_in  = COALESCE(?, tokens_in),
              tokens_out = COALESCE(?, tokens_out)
        WHERE id = ?`,
    )
    .run(input.status, input.tokensIn ?? null, input.tokensOut ?? null, input.id);
  return info.changes > 0;
}

/**
 * 按频道分页取历史，最新在前。
 * `before` 是上一页最后一条的 createdAt（毫秒），首页不传。
 *
 * 排序键：`created_at DESC, rowid DESC`。
 *
 * 为什么不用 `id` 兜底：`id` 是随机 UUID，同一毫秒内写入的 user 与 assistant
 * 两行按 UUID 排序结果是随机的 —— 实测会出现「回答排到提问前面」，直接违反
 * P0-15「重启后会话顺序一致」。`rowid` 是 SQLite 的隐式单调列，等于插入顺序，
 * 且不需要改 schema（禁止改 schema.sql）。
 */
export function listByChannel(
  db: DB,
  channelId: string,
  limit = 50,
  before?: number,
): MessageRow[] {
  const rows = (
    before === undefined
      ? db
          .prepare(
            `SELECT * FROM messages
              WHERE channel_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT ?`,
          )
          .all(channelId, limit)
      : db
          .prepare(
            `SELECT * FROM messages
              WHERE channel_id = ? AND created_at < ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT ?`,
          )
          .all(channelId, before, limit)
  ) as RawRow[];
  return rows.map(toRow);
}
