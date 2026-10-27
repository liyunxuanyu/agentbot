import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { closeAllStreams } from "../sse.js";
import { listBots, toRuntimeDto } from "../dto.js";
import { listRuntimes } from "../../adapters/probe.js";

/**
 * 全量删除（P0-12 边界 / PRD §6「全量数据（设置页，需输入确认短语）」）。
 *
 *   `POST /api/admin/purge`  body `{ confirm: "删除全部数据" }`
 *   → `{ ok: true, deleted: {…每表行数}, closedStreams }`
 *
 * 三条纪律：
 *   ① **必须带确认短语**，短语不符回 `400 {error:"confirm_required"}`。
 *      前端还会做一次输入校验，但服务端不能只信前端 —— 这个端点不可逆。
 *   ② **只删用户数据**：`runtime_definitions`（探测缓存）与 `schema_meta` 保留。
 *      删掉运行时缓存会让用户重置完必须重启服务才能再建 Bot，那不是「清数据」。
 *   ③ **先断 SSE 再删表**：活跃连接持有 sessionId 游标，表删完后再断会触发
 *      一连串「会话不存在」的错误帧。断开后前端会显示「连接已断开」。
 *
 * 删表顺序按外键依赖从叶到根；`permission_grants` / `usage_records` 没有外键，
 * 单独删（它们是「历史」，Bot 删了也要一起清掉，否则用量页会留下孤儿行）。
 */

/** 前端输入框要求用户逐字输入的短语（与设置页 UI 文案一致）。 */
export const PURGE_CONFIRM_PHRASE = "删除全部数据";

/** 按依赖顺序排列；先叶后根，避免外键约束报错。 */
const TABLES = [
  "events",
  "messages",
  "permission_requests",
  "permission_grants",
  "sessions",
  "assignments",
  "memory_entries",
  "schedules",
  "usage_records",
  "runtime_bindings",
  "channels",
  "bots",
] as const;

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

interface TidyPreview {
  /** 会被删除的渠道（dm/group 且无在用参与者）。 */
  channels: { id: string; type: string; name: string; participantCount: number }[];
  /** 连带删除的会话数。 */
  sessions: number;
  /** 连带删除的消息数。 */
  messages: number;
  /** 连带删除的事件数。 */
  events: number;
  /** 所属 Bot 已不存在的记忆条目数。 */
  memories: number;
  /** 所属 Bot 已不存在的用量记录数（只统计，保留作历史）。 */
  orphanUsage: number;
}

/** 统计「归档/删除 Bot 之后留下的孤儿数据」，不写库。 */
function previewTidy(db: ServerContext["db"]): TidyPreview {
  const activeIds = new Set(
    (db.prepare("SELECT id FROM bots WHERE status = 'active'").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const rows = db
    .prepare("SELECT id, type, name, participant_bot_ids FROM channels WHERE type IN ('dm','group')")
    .all() as { id: string; type: string; name: string; participant_bot_ids: string }[];

  const channels: TidyPreview["channels"] = [];
  let sessions = 0;
  let messages = 0;
  let events = 0;
  for (const row of rows) {
    let ids: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.participant_bot_ids);
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      ids = [];
    }
    // 没有参与者数据也视为孤儿：它无法再被打开或发送
    if (ids.some((id) => activeIds.has(id))) continue;
    channels.push({ id: row.id, type: row.type, name: row.name, participantCount: ids.length });
    sessions += (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE channel_id = ?").get(row.id) as { n: number }
    ).n;
    messages += (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(row.id) as { n: number }
    ).n;
    events += (
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id IN (SELECT id FROM sessions WHERE channel_id = ?)")
        .get(row.id) as { n: number }
    ).n;
  }

  const memories = (
    db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE bot_id NOT IN (SELECT id FROM bots)").get() as {
      n: number;
    }
  ).n;
  const orphanUsage = (
    db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE bot_id NOT IN (SELECT id FROM bots)").get() as {
      n: number;
    }
  ).n;

  return { channels, sessions, messages, events, memories, orphanUsage };
}

export function registerAdminRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /**
   * `GET /api/admin/bots` —— 管理员 Bot 列表（R6）。
   *
   * 管理员只是 `role='admin'` 的普通 Bot，可以有多个；前端在 Bot 列表与管理页
   * 用这个端点标出「可创建 Bot」的身份，不另开一套模型。
   */
  app.get("/api/admin/bots", async () => {
    const runtimeMap = new Map(listRuntimes(ctx.db).map((r) => [r.id, toRuntimeDto(r)]));
    const bots = listBots(ctx.db, runtimeMap);
    return {
      bots: bots.filter((b) => b.role === "admin"),
      totalBots: bots.length,
    };
  });

  app.post<{ Body: { confirm?: unknown } }>("/api/admin/purge", async (req, reply: FastifyReply) => {
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm.trim() : "";
    if (confirm !== PURGE_CONFIRM_PHRASE) {
      return json(reply, 400, {
        error: "confirm_required",
        message: `请输入「${PURGE_CONFIRM_PHRASE}」以确认`,
      });
    }

    // 先断连接：删表过程中不该再有事件往外推
    const closedStreams = closeAllStreams("purge");

    const deleted: Record<string, number> = {};
    const purge = ctx.db.transaction(() => {
      for (const table of TABLES) {
        const info = ctx.db.prepare(`DELETE FROM ${table}`).run();
        deleted[table] = info.changes;
      }
    });
    purge();

    // 删完让调度器重排（它的内存队列里可能还挂着已删任务的定时器）
    ctx.scheduler?.reschedule();
    console.log(
      `[agentbot] 全量删除完成：${Object.entries(deleted)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );

    return { ok: true, deleted, closedStreams };
  });

  /**
   * `GET /api/admin/tidy` —— 数据整理预览（只统计，不删）。
   * `POST /api/admin/tidy` —— 执行整理，body `{ confirm: true }`。
   *
   * 整理什么：Bot 已归档/已删除后留下的孤儿数据。它们不会自己消失，会一直占着
   * 会话列表、用量页与磁盘。四类：
   *   ① dm / group 渠道里没有任何在用参与者 → 连带 sessions/messages/events 一起删；
   *   ② 参与者只剩归档 Bot 的会话（同上，按渠道处理已覆盖）；
   *   ③ 记忆条目所属 Bot 已不存在 → 删；
   *   ④ 用量记录所属 Bot 已不存在 → 保留（历史账目），只统计不删。
   *
   * 先给预览再执行：这个动作不可逆，用户必须先看到「会删多少」。
   */
  app.get("/api/admin/tidy", async () => {
    return { preview: previewTidy(ctx.db) };
  });

  app.post<{ Body: { confirm?: unknown } }>("/api/admin/tidy", async (req, reply) => {
    if (req.body?.confirm !== true) {
      return json(reply, 400, {
        error: "confirm_required",
        message: "需要先预览，再带 confirm: true 执行整理",
      });
    }
    const preview = previewTidy(ctx.db);
    if (preview.channels.length === 0 && preview.memories === 0) {
      return { ok: true, preview, deleted: { channels: 0, sessions: 0, messages: 0, events: 0, memories: 0 } };
    }

    const deleted = { channels: 0, sessions: 0, messages: 0, events: 0, memories: 0 };
    const tidy = ctx.db.transaction(() => {
      for (const ch of preview.channels) {
        // 先删事件与消息，再删会话，最后删渠道（外键从叶到根）
        deleted.events += ctx.db
          .prepare("DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE channel_id = ?)")
          .run(ch.id).changes;
        deleted.messages += ctx.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(ch.id).changes;
        deleted.sessions += ctx.db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(ch.id).changes;
        deleted.channels += ctx.db.prepare("DELETE FROM channels WHERE id = ?").run(ch.id).changes;
      }
      if (preview.memories > 0) {
        deleted.memories = ctx.db
          .prepare("DELETE FROM memory_entries WHERE bot_id NOT IN (SELECT id FROM bots)")
          .run().changes;
      }
    });
    tidy();

    console.log(
      `[agentbot] 数据整理完成：渠道=${deleted.channels} 会话=${deleted.sessions} ` +
        `消息=${deleted.messages} 事件=${deleted.events} 记忆=${deleted.memories}`,
    );
    return { ok: true, preview, deleted };
  });
}
