import { randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";
import { config } from "../../config.js";
import type { PermissionAction } from "../../../shared/events.js";
import { resolveRealish } from "./boundary.js";

/**
 * 授权记忆（`permission_grants`，P0-08「记住（本会话）/ 记住（本 Bot 永久）」）。
 *
 * `action_key` 是「动作 + 目标」的稳定指纹：
 *   - `write:<绝对路径>`、`exec:<命令原文>`、`network:<主机>`、`read:<绝对路径>`
 *   不含 turnId / requestId —— 那两个每次都变，记住了也命中不了。
 *
 * scope：
 *   - `session`：只对本 Session 有效，`session_id` 非空
 *   - `bot`：对本 Bot 的所有 Session 有效，`session_id` 为 NULL
 *     （UI 文案叫「本 Bot 永久」，但实现上带 TTL：`config.timeouts.grantTtlMs`，
 *      默认 12h。理由是「永久」的授权一旦记错就没有回收路径，
 *      而 PRD 只要求「不再重复弹卡」，12h 足够覆盖一次连续工作。）
 *
 * 60s 复用窗口（P0-08 边界处理）：同动作在窗口内重复且已有记住 → 直接命中，
 * 不需要新写一条。这里用 `created_at` 判断，不额外建表。
 */

export type GrantScope = "session" | "bot";

export interface GrantRow {
  id: string;
  botId: string;
  sessionId: string | null;
  actionKey: string;
  scope: GrantScope;
  expiresAt: number | null;
  createdAt: number;
}

interface RawGrant {
  id: string;
  bot_id: string;
  session_id: string | null;
  action_key: string;
  scope: string;
  expires_at: number | null;
  created_at: number;
}

function toRow(raw: RawGrant): GrantRow {
  return {
    id: raw.id,
    botId: raw.bot_id,
    sessionId: raw.session_id,
    actionKey: raw.action_key,
    scope: raw.scope === "bot" ? "bot" : "session",
    expiresAt: raw.expires_at,
    createdAt: raw.created_at,
  };
}

/**
 * 动作指纹。
 *
 * 路径统一小写（Windows）并去掉尾部分隔符 —— 与 boundary 的 canonical 规则一致，
 * 否则同一文件两种写法会各自命中一次，等于把「记住」变成「每次都要批准」。
 */
export function actionKeyOf(action: PermissionAction, target: string): string {
  const normalized = normalizeTarget(action, target);
  return `${action}:${normalized}`;
}

function normalizeTarget(action: PermissionAction, target: string): string {
  if (action === "exec") return target.trim();
  if (action === "network") return target.trim().toLowerCase();
  let p = target.trim();
  // 与 boundary 用同一套归一化：realpath + 去尾分隔符 + 小写。
  // 少了 realpath 这一步，Windows 上「长名/短名（liyunx~1）」会被算成两个动作，
  // 「记住」就永远命中不了 —— 这是实测踩到的。
  if (p.length > 0) p = resolveRealish(p);
  if (p.startsWith("\\\\?\\")) p = p.slice(4);
  if (p.length > 1) p = p.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export interface GrantLookupInput {
  botId: string;
  sessionId: string;
  actionKey: string;
  /** 当前时间，便于测试注入。 */
  now?: number;
}

/**
 * 查命中的授权：session 域优先于 bot 域（更具体的那条先算数）。
 *
 * 过期的行顺手删掉 —— 这是唯一会清理的地方，不额外跑维护任务。
 */
export function findGrant(db: DB, input: GrantLookupInput): GrantRow | null {
  const now = input.now ?? Date.now();
  const rows = db
    .prepare(
      `SELECT * FROM permission_grants
        WHERE bot_id = ? AND action_key = ?
          AND (scope = 'bot' OR (scope = 'session' AND session_id = ?))
        ORDER BY CASE scope WHEN 'session' THEN 0 ELSE 1 END, created_at DESC`,
    )
    .all(input.botId, input.actionKey, input.sessionId) as RawGrant[];

  let expiredIds: string[] = [];
  let hit: GrantRow | null = null;
  for (const raw of rows) {
    if (raw.expires_at !== null && raw.expires_at <= now) {
      expiredIds.push(raw.id);
      continue;
    }
    if (!hit) hit = toRow(raw);
  }
  if (expiredIds.length > 0) {
    const placeholders = expiredIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM permission_grants WHERE id IN (${placeholders})`).run(...expiredIds);
  }
  return hit;
}

export interface CreateGrantInput {
  botId: string;
  sessionId: string;
  actionKey: string;
  scope: GrantScope;
  now?: number;
}

/** 写一条授权。同 scope 同 action 的旧记录先删（避免越积越多）。 */
export function createGrant(db: DB, input: CreateGrantInput): GrantRow {
  const now = input.now ?? Date.now();
  const expiresAt = now + config.timeouts.grantTtlMs;
  const id = `grant_${randomUUID()}`;
  const sessionId = input.scope === "session" ? input.sessionId : null;

  const write = db.transaction(() => {
    if (input.scope === "session") {
      db.prepare(
        `DELETE FROM permission_grants
          WHERE bot_id = ? AND action_key = ? AND scope = 'session' AND session_id = ?`,
      ).run(input.botId, input.actionKey, input.sessionId);
    } else {
      db.prepare(
        `DELETE FROM permission_grants
          WHERE bot_id = ? AND action_key = ? AND scope = 'bot'`,
      ).run(input.botId, input.actionKey);
    }
    db.prepare(
      `INSERT INTO permission_grants (id, bot_id, session_id, action_key, scope, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.botId, sessionId, input.actionKey, input.scope, expiresAt, now);
  });
  write();

  return {
    id,
    botId: input.botId,
    sessionId,
    actionKey: input.actionKey,
    scope: input.scope,
    expiresAt,
    createdAt: now,
  };
}

/** 清掉某 Bot 的全部授权（Bot 边界收紧时调用，避免旧授权越权）。 */
export function clearGrantsForBot(db: DB, botId: string): number {
  return db.prepare("DELETE FROM permission_grants WHERE bot_id = ?").run(botId).changes;
}

/** 清掉某 Session 的 session 域授权（会话结束时）。 */
export function clearSessionGrants(db: DB, sessionId: string): number {
  return db
    .prepare("DELETE FROM permission_grants WHERE scope = 'session' AND session_id = ?")
    .run(sessionId).changes;
}

/** 列表（Bot 详情页「预授权列表」与审计回看用）。 */
export function listGrants(db: DB, botId: string, now = Date.now()): GrantRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM permission_grants
        WHERE bot_id = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC`,
    )
    .all(botId, now) as RawGrant[];
  return rows.map(toRow);
}
