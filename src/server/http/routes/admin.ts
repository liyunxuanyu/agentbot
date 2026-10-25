import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { closeAllStreams } from "../sse.js";

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

export function registerAdminRoutes(app: FastifyInstance, ctx: ServerContext): void {
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
}
