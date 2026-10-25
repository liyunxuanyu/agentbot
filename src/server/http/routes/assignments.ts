import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config.js";
import type { ServerContext } from "../server.js";
import {
  ASSIGNMENT_STATUSES,
  getAssignmentRow,
  listAssignmentRows,
  toAssignmentDto,
  type AssignmentStatus,
} from "../../core/assignment/runner.js";

/**
 * Assignment 端点（M11 / P0-07）。
 *
 *   GET   /api/assignments?status=&botId=&channelId=  列表（按创建时间倒序）
 *   GET   /api/assignments/:id                        详情（含报告、事件数、改动文件）
 *   POST  /api/assignments                            创建并入队
 *   GET   /api/assignments/:id/report.md              Markdown 原文（text/markdown）
 *
 * 错误码约定与其余端点一致：已实现但查不到 → `404 {error:"assignment_not_found"}`，
 * 路由不存在 → 框架统一 `404 {error:"not_found"}`。前端靠这个区分「没这个任务」与「功能没做」。
 *
 * `POST` 的队列满返回 `409 {error:"queue_full", queueLimit, message}`：
 * 用 409 而不是 400 —— 请求本身合法，是当前状态不允许（与「输入非法」语义不同）。
 */

interface CreateBody {
  channelId?: unknown;
  sourceMessageId?: unknown;
  title?: unknown;
  deliverable?: unknown;
  botId?: unknown;
  executionLocation?: unknown;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

export function registerAssignmentRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { status?: string; botId?: string; channelId?: string } }>(
    "/api/assignments",
    async (req, reply: FastifyReply) => {
      const raw = req.query.status;
      let status: AssignmentStatus | undefined;
      if (typeof raw === "string" && raw.length > 0) {
        if (!(ASSIGNMENT_STATUSES as readonly string[]).includes(raw)) {
          return json(reply, 400, { error: "invalid_status", allowed: ASSIGNMENT_STATUSES });
        }
        status = raw as AssignmentStatus;
      }

      const rows = listAssignmentRows(ctx.db, {
        ...(status === undefined ? {} : { status }),
        ...(typeof req.query.botId === "string" ? { botId: req.query.botId } : {}),
        ...(typeof req.query.channelId === "string" ? { channelId: req.query.channelId } : {}),
      });

      return {
        assignments: rows.map((r) => toAssignmentDto(ctx.db, r)),
        // 分组计数：前端标签页上的数字（一次算完，避免前端再拉一遍）
        counts: countByStatus(ctx.db),
      };
    },
  );

  app.get<{ Params: { id: string } }>("/api/assignments/:id", async (req, reply: FastifyReply) => {
    const row = getAssignmentRow(ctx.db, req.params.id);
    if (!row) return json(reply, 404, { error: "assignment_not_found" });
    return { assignment: toAssignmentDto(ctx.db, row, { withFiles: true }) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/assignments/:id/report.md",
    async (req, reply: FastifyReply) => {
      const row = getAssignmentRow(ctx.db, req.params.id);
      if (!row) return json(reply, 404, { error: "assignment_not_found" });
      if (!row.report) {
        // 还没生成报告：不是 404（任务存在），是「现在没有」—— 409 更准确
        return json(reply, 409, {
          error: "report_not_ready",
          status: row.status,
          message: "任务尚未结束，报告还没生成",
        });
      }
      return reply
        .code(200)
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", `inline; filename="${row.id}.md"`)
        .send(row.report);
    },
  );

  app.post<{ Body: CreateBody }>("/api/assignments", async (req, reply: FastifyReply) => {
    const body = req.body ?? {};
    const channelId = typeof body.channelId === "string" ? body.channelId : "";
    const title = typeof body.title === "string" ? body.title : "";
    const deliverable = typeof body.deliverable === "string" ? body.deliverable : "";
    const botId = typeof body.botId === "string" ? body.botId : "";

    if (channelId.length === 0) return json(reply, 400, { error: "channel_id_required" });
    if (title.trim().length === 0) return json(reply, 400, { error: "title_required" });
    if (deliverable.trim().length === 0) return json(reply, 400, { error: "deliverable_required" });
    if (botId.length === 0) return json(reply, 400, { error: "bot_id_required" });

    // 执行位置：请求里可选覆盖（P0-13 的「继承」语义由前端默认填当前 Bot 的值）。
    // 这里只校验取值；实际目录由 Bot 配置 + worktree.ts 决定，不在创建时改写配置。
    if (
      body.executionLocation !== undefined &&
      body.executionLocation !== "local" &&
      body.executionLocation !== "worktree"
    ) {
      return json(reply, 400, { error: "invalid_execution_location" });
    }

    const result = ctx.assignments.create({
      channelId,
      ...(typeof body.sourceMessageId === "string" && body.sourceMessageId.length > 0
        ? { sourceMessageId: body.sourceMessageId }
        : {}),
      title,
      deliverable,
      botId,
    });

    if (!result.ok) {
      switch (result.code) {
        case "channel_not_found":
          return json(reply, 404, { error: "channel_not_found" });
        case "bot_not_found":
          return json(reply, 404, { error: "bot_not_found" });
        case "message_not_found":
          return json(reply, 404, { error: "source_message_not_found" });
        case "queue_full":
          return json(reply, 409, {
            error: "queue_full",
            queueLimit: config.limits.assignmentQueueLimit,
            message: result.message,
          });
        case "invalid_input":
          return json(reply, 400, { error: "invalid_input", message: result.message });
      }
    }

    return reply.code(201).send({ assignment: toAssignmentDto(ctx.db, result.assignment) });
  });
}

function countByStatus(db: ServerContext["db"]): Record<string, number> {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM assignments GROUP BY status")
    .all() as { status: string; n: number }[];
  const out: Record<string, number> = {};
  for (const status of ASSIGNMENT_STATUSES) out[status] = 0;
  for (const row of rows) out[row.status] = row.n;
  return out;
}
