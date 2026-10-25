import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { aggregate, deleteByBot, exportCsv, type UsageRange } from "../../core/usage/aggregate.js";

/**
 * 用量端点（M13，P0-12）。
 *
 *   `GET    /api/usage?range=today|7d|30d|all&botId=&runtimeId=`
 *   `GET    /api/usage/export.csv?range=&botId=&runtimeId=`   （P1-02）
 *   `DELETE /api/usage?botId=`                                （设置页「一并删除」）
 *
 * 三条约定：
 *   ① **无数据返回空数组**（`rows: []` + 零值 totals），前端渲染空态而不是空表格。
 *   ② **未上报不估算**：`reported=0` 的行 `inputTokens/outputTokens` 为 `null`，
 *      另有 `unreportedRequests` 单列；totals 里 token 只累计已上报部分。
 *   ③ **删除 Bot 后历史保留**：聚合走 LEFT JOIN，取不到名字就 `deleted: true`；
 *      只有显式 DELETE 才真正删。
 */

const RANGES: readonly UsageRange[] = ["today", "7d", "30d", "all"];

function parseRange(raw: unknown): UsageRange {
  return typeof raw === "string" && (RANGES as readonly string[]).includes(raw)
    ? (raw as UsageRange)
    : "all";
}

function parseId(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

interface UsageQuery {
  range?: string;
  botId?: string;
  runtimeId?: string;
}

export function registerUsageRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const multiplierOf = (runtimeId: string | null): number | null =>
    ctx.runtimeMultiplier?.(runtimeId) ?? null;

  app.get<{ Querystring: UsageQuery }>("/api/usage", async (req) => {
    const filter = {
      range: parseRange(req.query.range),
      ...(parseId(req.query.botId) === undefined ? {} : { botId: parseId(req.query.botId) }),
      ...(parseId(req.query.runtimeId) === undefined
        ? {}
        : { runtimeId: parseId(req.query.runtimeId) }),
    };
    return aggregate(ctx.db, filter, { multiplierOf });
  });

  app.get<{ Querystring: UsageQuery }>("/api/usage/export.csv", async (req, reply: FastifyReply) => {
    const filter = {
      range: parseRange(req.query.range),
      ...(parseId(req.query.botId) === undefined ? {} : { botId: parseId(req.query.botId) }),
      ...(parseId(req.query.runtimeId) === undefined
        ? {}
        : { runtimeId: parseId(req.query.runtimeId) }),
    };
    const csv = exportCsv(ctx.db, filter, { multiplierOf });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .code(200)
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="agentbot-usage-${stamp}.csv"`)
      .send(csv);
  });

  app.delete<{ Querystring: UsageQuery }>("/api/usage", async (req, reply: FastifyReply) => {
    const botId = parseId(req.query.botId);
    if (!botId) {
      // 全量删除走设置页的独立端点（需确认短语），这里不接受无参删除
      return json(reply, 400, { error: "bot_id_required" });
    }
    const deleted = deleteByBot(ctx.db, botId);
    return { ok: true, deleted };
  });
}
