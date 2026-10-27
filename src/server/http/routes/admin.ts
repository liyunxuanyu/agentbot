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

/** 可勾选的整理项。 */
export const TIDY_TARGETS = ["channels", "orphanSessions", "memories", "orphanUsage"] as const;
export type TidyTarget = (typeof TIDY_TARGETS)[number];

/** 不勾选时的安全默认：不动用量历史。 */
const DEFAULT_TARGETS: TidyTarget[] = ["channels", "orphanSessions", "memories"];

interface TidyPreview {
  /** 会被删除的渠道（dm/group 且无在用参与者）。 */
  channels: { id: string; type: string; name: string; participantCount: number }[];
  /** 渠道还在、但所属 Bot 已不存在的会话。 */
  orphanSessions: { id: string; channelId: string; channelName: string; botId: string }[];
  /** 连带删除的会话数（含渠道连带 + 孤儿会话）。 */
  sessions: number;
  /** 连带删除的消息数。 */
  messages: number;
  /** 连带删除的事件数。 */
  events: number;
  /** 所属 Bot 已不存在的记忆条目数。 */
  memories: number;
  /** 所属 Bot 已不存在的用量记录数。 */
  orphanUsage: number;
}

/** 统计「归档/删除 Bot 之后留下的孤儿数据」，不写库。 */
function previewTidy(db: ServerContext["db"]): TidyPreview {
  const activeIds = new Set(
    (db.prepare("SELECT id FROM bots WHERE status = 'active'").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const knownBotIds = new Set(
    (db.prepare("SELECT id FROM bots").all() as { id: string }[]).map((r) => r.id),
  );

  const rows = db
    .prepare("SELECT id, type, name, participant_bot_ids FROM channels WHERE type IN ('dm','group')")
    .all() as { id: string; type: string; name: string; participant_bot_ids: string }[];

  const channels: TidyPreview["channels"] = [];
  const channelIds = new Set<string>();
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
    channelIds.add(row.id);
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

  // 渠道还在、但会话的 Bot 已经不存在（Bot 被彻底删除，渠道留着）
  const orphanRows = db
    .prepare(
      `SELECT s.id AS id, s.channel_id AS channelId, s.bot_id AS botId, c.name AS channelName
         FROM sessions s LEFT JOIN channels c ON c.id = s.channel_id`,
    )
    .all() as { id: string; channelId: string; botId: string; channelName: string | null }[];
  const orphanSessions: TidyPreview["orphanSessions"] = [];
  for (const row of orphanRows) {
    if (knownBotIds.has(row.botId)) continue;
    if (channelIds.has(row.channelId)) continue; // 已计入渠道连带删除
    orphanSessions.push({
      id: row.id,
      channelId: row.channelId,
      channelName: row.channelName ?? row.channelId,
      botId: row.botId,
    });
  }
  for (const s of orphanSessions) {
    messages += (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(s.id) as { n: number }
    ).n;
    events += (
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(s.id) as { n: number }
    ).n;
  }
  sessions += orphanSessions.length;

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

  return { channels, orphanSessions, sessions, messages, events, memories, orphanUsage };
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
   * `POST /api/admin/tidy` —— 执行整理，body `{ confirm: true, targets: [...] }`。
   *
   * 整理什么：Bot 已归档/已删除后留下的孤儿数据。它们不会自己消失，会一直占着
   * 会话列表、用量页与磁盘。四类：
   *   ① `channels`  —— dm / group 渠道里没有任何在用参与者（连带 sessions/messages/events）；
   *   ② `memories`  —— 记忆条目所属 Bot 已不存在；
   *   ③ `orphanUsage` —— 用量记录所属 Bot 已不存在（默认保留作历史账目，勾选才删）；
   *   ④ `orphanSessions` —— 会话所属 Bot 已不存在（渠道还在但 Bot 没了）。
   *
   * `targets` 省略 = 只做安全默认（channels + memories + orphanSessions），
   * 明确列出才删 `orphanUsage`。
   */
  app.get("/api/admin/tidy", async () => {
    return { preview: previewTidy(ctx.db), targets: TIDY_TARGETS };
  });

  app.post<{ Body: { confirm?: unknown; targets?: unknown } }>("/api/admin/tidy", async (req, reply) => {
    if (req.body?.confirm !== true) {
      return json(reply, 400, {
        error: "confirm_required",
        message: "需要先预览，再带 confirm: true 执行整理",
      });
    }
    const requested = Array.isArray(req.body.targets)
      ? req.body.targets.filter((t): t is TidyTarget =>
          typeof t === "string" && (TIDY_TARGETS as readonly string[]).includes(t),
        )
      : DEFAULT_TARGETS;
    if (requested.length === 0) {
      return json(reply, 400, {
        error: "no_target",
        message: "至少要选一类要整理的数据",
      });
    }
    const targets = new Set(requested);

    const preview = previewTidy(ctx.db);
    const deleted: Record<string, number> = {
      channels: 0,
      sessions: 0,
      messages: 0,
      events: 0,
      memories: 0,
      orphanUsage: 0,
    };

    const tidy = ctx.db.transaction(() => {
      if (targets.has("channels")) {
        for (const ch of preview.channels) {
          deleted["events"] =
            (deleted["events"] ?? 0) +
            ctx.db
              .prepare("DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE channel_id = ?)")
              .run(ch.id).changes;
          deleted["messages"] =
            (deleted["messages"] ?? 0) +
            ctx.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(ch.id).changes;
          deleted["sessions"] =
            (deleted["sessions"] ?? 0) +
            ctx.db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(ch.id).changes;
          deleted["channels"] = (deleted["channels"] ?? 0) + ctx.db
            .prepare("DELETE FROM channels WHERE id = ?")
            .run(ch.id).changes;
        }
      }
      if (targets.has("orphanSessions")) {
        for (const s of preview.orphanSessions) {
          deleted["events"] =
            (deleted["events"] ?? 0) +
            ctx.db.prepare("DELETE FROM events WHERE session_id = ?").run(s.id).changes;
          deleted["messages"] =
            (deleted["messages"] ?? 0) +
            ctx.db.prepare("DELETE FROM messages WHERE session_id = ?").run(s.id).changes;
          deleted["sessions"] = (deleted["sessions"] ?? 0) + ctx.db
            .prepare("DELETE FROM sessions WHERE id = ?")
            .run(s.id).changes;
        }
      }
      if (targets.has("memories") && preview.memories > 0) {
        deleted["memories"] = ctx.db
          .prepare("DELETE FROM memory_entries WHERE bot_id NOT IN (SELECT id FROM bots)")
          .run().changes;
      }
      if (targets.has("orphanUsage") && preview.orphanUsage > 0) {
        deleted["orphanUsage"] = ctx.db
          .prepare("DELETE FROM usage_records WHERE bot_id NOT IN (SELECT id FROM bots)")
          .run().changes;
      }
    });
    tidy();

    console.log(
      `[agentbot] 数据整理完成（${[...targets].join(",")}）：` +
        `渠道=${deleted["channels"]} 会话=${deleted["sessions"]} 消息=${deleted["messages"]} ` +
        `事件=${deleted["events"]} 记忆=${deleted["memories"]} 用量=${deleted["orphanUsage"]}`,
    );
    return { ok: true, targets: [...targets], preview, deleted };
  });
}
