import type { DB } from "../db/db.js";

/**
 * memory_entries 仓储 —— 纯 SQL，同步 API。
 *
 * 两个约定（schema 定稿、本轮不允许加列，所以用现有列承载语义）：
 *
 *   ① `kind='summary'` 即「自动摘要」条目（`manual` 是用户手写）。
 *      前端 DTO 把 kind 映射成 `source: 'auto' | 'manual'`，不需要额外的 source 列。
 *
 *   ② **待摘要标记** = 一条 `injected=0`、id 以 `mem_pending_` 开头的 summary 行：
 *      - `source_session_id` 指向待摘要的 Session（这正是该列的本意）；
 *      - `content` 存最近一次失败原因（诊断用，永不注入，因为 injected=0）；
 *      - 成功生成摘要时在同一事务里删标记 + 插正式条目，不会留下半截状态。
 *      为什么不用 sessions.status：那一列由 Supervisor 独占，写一个自定义值
 *      会让前端的 Session 状态映射失效（P0-15 的六态是从它推出来的）。
 */

export type MemoryKind = "manual" | "summary";

/**
 * 记忆作用域（R3 / G1）。
 *
 *   bot     = 该 Bot 的全局记忆：任何会话都注入（历史数据回填值）
 *   channel = 群聊内共享：同一渠道里每个 Bot 的会话都能读到
 *   session = 仅来源会话：同一 Bot 在别的会话读不到（新摘要的默认作用域）
 */
export type MemoryScope = "bot" | "channel" | "session";

/** 待摘要标记的 id 前缀。 */
export const PENDING_PREFIX = "mem_pending_";

export function pendingIdOf(sessionId: string): string {
  return `${PENDING_PREFIX}${sessionId}`;
}

export function isPendingId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

export interface MemoryEntryRow {
  id: string;
  botId: string;
  content: string;
  sourceSessionId: string | null;
  scope: MemoryScope;
  channelId: string | null;
  kind: MemoryKind;
  injected: boolean;
  version: number;
  updatedAt: number;
  createdAt: number;
}

interface RawRow {
  id: string;
  bot_id: string;
  content: string;
  source_session_id: string | null;
  scope: string;
  channel_id: string | null;
  kind: string;
  injected: number;
  version: number;
  updated_at: number;
  created_at: number;
}

function toScope(raw: string): MemoryScope {
  return raw === "session" ? "session" : raw === "channel" ? "channel" : "bot";
}

function toRow(raw: RawRow): MemoryEntryRow {
  return {
    id: raw.id,
    botId: raw.bot_id,
    content: raw.content,
    sourceSessionId: raw.source_session_id,
    scope: toScope(raw.scope),
    channelId: raw.channel_id,
    kind: raw.kind === "summary" ? "summary" : "manual",
    injected: raw.injected === 1,
    version: raw.version,
    updatedAt: raw.updated_at,
    createdAt: raw.created_at,
  };
}

/**
 * 列表：注入开关状态无关，按更新时间倒序（与注入优先级一致）。
 *
 * 除本 Bot 自己的全部记忆外，**还要带上它所在群聊的 channel 记忆**（R3 方案 A）：
 * 这类条目可能由别的 Bot 写入（`bot_id` 是别人），但本 Bot 会注入、也应该能在
 * 记忆页看到并管理。不带上就会出现「注入里有、页面里没有」的鬼影。
 *
 * 只算本 Bot 实际参与的渠道（`participant_bot_ids` 含它），不是全库所有 channel 记忆。
 */
export function listByBot(db: DB, botId: string): MemoryEntryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_entries
        WHERE bot_id = ?
           OR (
             scope = 'channel'
             AND channel_id IS NOT NULL
             AND channel_id IN (
               SELECT c.id FROM channels c, json_each(c.participant_bot_ids) p
                WHERE p.value = ?
             )
           )
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(botId, botId) as RawRow[];
  return rows.map(toRow);
}

/** 注入范围：调用方给出当前会话/渠道，按作用域过滤（R3）。 */
export interface InjectionScope {
  /** 当前会话 id；不传表示只注入 bot 全局记忆。 */
  sessionId?: string | null;
  /** 当前渠道 id；群聊内共享记忆靠它命中。 */
  channelId?: string | null;
}

/**
 * 注入候选：`injected=1` 且不是待摘要标记，按 updated_at 倒序。
 *
 * 作用域规则（R3 方案 A —— 群聊记忆真共享）：
 *   - `bot`     → 永远注入（限本 Bot：记忆属于 Bot）；
 *   - `channel` → **只按 channel_id 过滤，不限 bot_id**：同一群聊里 Bot A 写的
 *                 群聊记忆，Bot B 下一轮也能读到（「一个群一个上下文」）；
 *                 别的群聊的 channel 记忆读不到（channel_id 不同）；
 *   - `session` → 仅当 `source_session_id` 与当前会话相同（仍限本 Bot）。
 *
 * 不传 `scope` 时只注入 `bot` 全局记忆 —— 这是历史行为（迁移后老数据全是 bot），
 * 也保证「拿不到会话上下文时宁少注入、不串记忆」。
 *
 * 实现上拆成两段 SQL 再合并：`OR` 在一个 WHERE 里会让 channel 分支的
 * 「不限 bot_id」把 bot/session 分支也放开，写成同一个条件很容易漏掉限定。
 */
export function listInjected(
  db: DB,
  botId: string,
  scope: InjectionScope = {},
): MemoryEntryRow[] {
  const sessionId = scope.sessionId ?? null;
  const channelId = scope.channelId ?? null;

  // ① 本 Bot 的 bot 全局记忆与（属于它的）session 记忆
  const ownRows = db
    .prepare(
      `SELECT * FROM memory_entries
        WHERE bot_id = ? AND injected = 1 AND id NOT LIKE ?
          AND (
            scope = 'bot'
            OR (scope = 'session' AND source_session_id IS NOT NULL AND source_session_id = ?)
          )
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(botId, `${PENDING_PREFIX}%`, sessionId) as RawRow[];

  // ② 当前渠道的群聊记忆：不限 bot_id（跨 Bot 共享），但必须属于同一 channel
  const channelRows =
    channelId === null
      ? []
      : (db
          .prepare(
            `SELECT * FROM memory_entries
              WHERE scope = 'channel' AND channel_id = ? AND injected = 1 AND id NOT LIKE ?
              ORDER BY updated_at DESC, created_at DESC`,
          )
          .all(channelId, `${PENDING_PREFIX}%`) as RawRow[]);

  return [...ownRows, ...channelRows]
    .map(toRow)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function getById(db: DB, id: string): MemoryEntryRow | null {
  const raw = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

export interface CreateMemoryInput {
  id: string;
  botId: string;
  content: string;
  kind?: MemoryKind;
  sourceSessionId?: string | null;
  /** 作用域；缺省 `bot`（手写全局记忆）。自动摘要由调用方显式指定。 */
  scope?: MemoryScope;
  channelId?: string | null;
  injected?: boolean;
  version?: number;
  updatedAt?: number;
  createdAt?: number;
}

export function create(db: DB, input: CreateMemoryInput): MemoryEntryRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_entries
       (id, bot_id, content, source_session_id, scope, channel_id, kind, injected, version,
        updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.botId,
    input.content,
    input.sourceSessionId ?? null,
    input.scope ?? "bot",
    input.channelId ?? null,
    input.kind ?? "manual",
    input.injected === false ? 0 : 1,
    input.version ?? 1,
    input.updatedAt ?? now,
    input.createdAt ?? now,
  );
  const row = getById(db, input.id);
  if (!row) throw new Error(`记忆写入后读不回：${input.id}`);
  return row;
}

export interface UpdateMemoryInput {
  content?: string;
  injected?: boolean;
}

/** 改内容或注入开关；`updated_at` 同步推进（它同时决定注入排序）。 */
export function update(db: DB, id: string, patch: UpdateMemoryInput): MemoryEntryRow | null {
  const current = getById(db, id);
  if (!current) return null;

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number)[] = [Date.now()];
  if (patch.content !== undefined) {
    sets.push("content = ?", "version = version + 1");
    params.push(patch.content);
  }
  if (patch.injected !== undefined) {
    sets.push("injected = ?");
    params.push(patch.injected ? 1 : 0);
  }
  params.push(id);
  db.prepare(`UPDATE memory_entries SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getById(db, id);
}

export function remove(db: DB, id: string): boolean {
  const info = db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
  return info.changes > 0;
}

/** 该 Session 是否已经生成过正式摘要（待摘要标记不算）。 */
export function hasSummaryForSession(db: DB, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM memory_entries
        WHERE source_session_id = ? AND kind = 'summary' AND id NOT LIKE ?
        LIMIT 1`,
    )
    .get(sessionId, `${PENDING_PREFIX}%`);
  return row !== undefined;
}

/** 待摘要标记：按 botId 过滤（不传则全部）。 */
export function listPending(db: DB, botId?: string): MemoryEntryRow[] {
  const rows = (
    botId === undefined
      ? db
          .prepare(
            `SELECT * FROM memory_entries
              WHERE id LIKE ? ORDER BY updated_at ASC`,
          )
          .all(`${PENDING_PREFIX}%`)
      : db
          .prepare(
            `SELECT * FROM memory_entries
              WHERE id LIKE ? AND bot_id = ? ORDER BY updated_at ASC`,
          )
          .all(`${PENDING_PREFIX}%`, botId)
  ) as RawRow[];
  return rows.map(toRow);
}

/** 落一个待摘要标记（幂等：同一 Session 只留一条）。 */
export function upsertPending(
  db: DB,
  input: { botId: string; sessionId: string; reason: string },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_entries
       (id, bot_id, content, source_session_id, kind, injected, version, updated_at, created_at)
     VALUES (?, ?, ?, ?, 'summary', 0, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`,
  ).run(pendingIdOf(input.sessionId), input.botId, input.reason, input.sessionId, now, now);
}

export function clearPending(db: DB, sessionId: string): void {
  db.prepare("DELETE FROM memory_entries WHERE id = ?").run(pendingIdOf(sessionId));
}
