import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import type { PermissionRow } from "../../core/permissions/resolver.js";

/**
 * 权限端点（前端已按此契约写好，见 `src/web/stores/permissions.ts`）。
 *
 *   `GET  /api/permissions?sessionId=`        → `{ permissions: PermissionDto[] }`
 *   `POST /api/permissions/:id/decision`      → 204
 *
 * 为什么卡片不能只靠事件流：事件的 `permission_request` payload 定稿为 4 个字段
 * （requestId / action / target / boundaryVerdict），没有 `timeoutPolicy`、
 * 没有 `expiresAt`、没有 `status`。前端 120s 倒计时与挂起态全靠这个端点。
 *
 * 决策 body：`{decision:"approve"|"reject"|"remember_session"|"remember_bot"}`
 * —— 与 `src/web/net/client.ts` 的 `decidePermission()` 一致。
 */

/** 与 `src/web/net/types.ts` 的 PermissionDto 同形（camelCase）。 */
export interface PermissionDto {
  id: string;
  sessionId: string;
  botId: string;
  turnId: string;
  action: string;
  target: string;
  boundaryVerdict: "allowed" | "denied" | "pending";
  timeoutPolicy: "reject" | "hold" | "preauth";
  status: string;
  heldSince: number | null;
  expiresAt: number | null;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

export function toPermissionDto(row: PermissionRow): PermissionDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    botId: row.botId,
    turnId: row.turnId,
    action: row.action,
    target: row.target,
    boundaryVerdict: row.boundaryVerdict,
    timeoutPolicy: row.timeoutPolicy,
    status: row.status,
    heldSince: row.heldSince,
    expiresAt: row.expiresAt,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

const DECISIONS = new Set(["approve", "reject", "remember_session", "remember_bot"]);

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

export function registerPermissionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { sessionId?: string } }>(
    "/api/permissions",
    async (req, reply: FastifyReply) => {
      const sessionId = req.query.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return json(reply, 400, { error: "session_id_required" });
      }
      const exists = ctx.db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(sessionId);
      if (!exists) return json(reply, 404, { error: "session_not_found" });

      const rows = ctx.permissions.listBySession(sessionId);
      return { permissions: rows.map(toPermissionDto) };
    },
  );

  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>(
    "/api/permissions/:id/decision",
    async (req, reply: FastifyReply) => {
      const requestId = req.params.id;
      const raw = req.body?.decision;
      if (typeof raw !== "string" || !DECISIONS.has(raw)) {
        return json(reply, 400, { error: "decision_invalid" });
      }

      const result = await ctx.permissions.decide(
        requestId,
        raw as "approve" | "reject" | "remember_session" | "remember_bot",
      );

      if (!result.ok) {
        if (result.code === "not_found") return json(reply, 404, { error: "permission_not_found" });
        // 已决/已失效：幂等语义下不算失败，但也不能谎称「刚批准了」
        return json(reply, 409, { error: "permission_not_pending", status: result.status ?? null });
      }
      return reply.code(204).send();
    },
  );
}
