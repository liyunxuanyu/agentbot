import type { DB } from "../db/db.js";
import type { EventRow, StoredEventType, StoredPayload } from "../events/model.js";

/**
 * events 仓储 —— 纯 SQL，同步 API。
 *
 * 双游标（架构 §4）：
 *   - `id`  全局 AUTOINCREMENT，SSE 重连游标，跨会话单调；
 *   - `seq` 会话内计数，UI 排序用，由写事务里的 `sessions.seq_counter` 递增分配，
 *           不用 `MAX(seq)+1`（并发下会撞唯一索引）。
 */

interface RawRow {
  id: number;
  session_id: string;
  message_id: string | null;
  turn_id: string;
  type: string;
  seq: number;
  payload: string;
  raw: string | null;
  created_at: number;
}

function toRow(raw: RawRow): EventRow {
  let payload: StoredPayload;
  try {
    payload = JSON.parse(raw.payload) as StoredPayload;
  } catch {
    // 落库时是我们自己序列化的，理论上不会坏；真坏了也不能让整页读失败
    payload = { entries: [], replace: true } as unknown as StoredPayload;
  }
  let rawValue: unknown | null = null;
  if (raw.raw !== null) {
    try {
      rawValue = JSON.parse(raw.raw);
    } catch {
      // 原始 JSON 可能本身就是不可解析的字符串，原样返回
      rawValue = raw.raw;
    }
  }
  return {
    id: raw.id,
    sessionId: raw.session_id,
    messageId: raw.message_id,
    turnId: raw.turn_id,
    type: raw.type as StoredEventType,
    seq: raw.seq,
    payload,
    raw: rawValue,
    createdAt: raw.created_at,
  };
}

export interface InsertEventInput {
  sessionId: string;
  messageId: string | null;
  turnId: string;
  type: StoredEventType;
  payload: StoredPayload;
  raw?: unknown;
  createdAt?: number;
}

/**
 * 写一条事件并分配会话内 seq。
 *
 * 事务内先 `seq_counter + 1` 再读回，保证同一会话的事件严格单写者递增；
 * 会话不存在时直接抛错（事件不能挂在虚构会话上）。
 */
export function insert(db: DB, input: InsertEventInput): EventRow {
  const write = db.transaction((): EventRow => {
    const bump = db
      .prepare("UPDATE sessions SET seq_counter = seq_counter + 1 WHERE id = ?")
      .run(input.sessionId);
    if (bump.changes === 0) {
      throw new Error(`事件写入失败，会话不存在：${input.sessionId}`);
    }

    const counter = db
      .prepare("SELECT seq_counter FROM sessions WHERE id = ?")
      .get(input.sessionId) as { seq_counter: number };

    // raw 列统一存 JSON 文本：字符串会被加引号，读回时仍是同一个字符串，
    // 不会出现「存进去是字符串、读出来被当成 JSON 解析」的歧义
    const rawText = input.raw === undefined || input.raw === null ? null : JSON.stringify(input.raw);

    const info = db
      .prepare(
        `INSERT INTO events
           (session_id, message_id, turn_id, type, seq, payload, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.messageId,
        input.turnId,
        input.type,
        counter.seq_counter,
        JSON.stringify(input.payload),
        rawText,
        input.createdAt ?? Date.now(),
      );

    const stored = db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(info.lastInsertRowid as number) as RawRow;
    return toRow(stored);
  });

  return write();
}

/** 按会话内 seq 升序分页；`afterSeq` 用于 UI 向上翻页。 */
export function listBySession(
  db: DB,
  sessionId: string,
  afterSeq = 0,
  limit = 200,
): EventRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(sessionId, afterSeq, limit) as RawRow[];
  return rows.map(toRow);
}

/**
 * SSE 重放：取 `id > lastEventId` 的事件，按全局 id 升序。
 * 走 `idx_events_session_id(session_id, id)`。
 */
export function listAfterId(
  db: DB,
  sessionId: string,
  lastEventId: number,
  limit = 500,
): EventRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM events
        WHERE session_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(sessionId, lastEventId, limit) as RawRow[];
  return rows.map(toRow);
}

/** 保留期批删：按 type + created_at 索引一次删一批，调用方循环直到返回 0。 */
export function deleteOlderThan(db: DB, cutoffMs: number, limit = 5000): number {
  const info = db
    .prepare(
      `DELETE FROM events
        WHERE id IN (
          SELECT id FROM events WHERE created_at < ? ORDER BY created_at ASC LIMIT ?
        )`,
    )
    .run(cutoffMs, limit);
  return info.changes;
}
