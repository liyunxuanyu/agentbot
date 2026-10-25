import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config.js";
import type { ServerContext } from "../server.js";
import {
  createSchedule,
  getScheduleRow,
  listScheduleRows,
  toScheduleDto,
} from "../../core/scheduling/scheduler.js";
import {
  computeNextRun,
  TRIGGER_TYPES,
  type TriggerType,
} from "../../core/scheduling/triggers.js";

/**
 * 定时任务端点（M12 / P0-11）。
 *
 *   GET    /api/schedules        列表（含下次触发、上次结果、状态）
 *   POST   /api/schedules        创建（三种触发方式 + 5 分钟下限）
 *   PATCH  /api/schedules/:id    暂停 / 恢复 / 改名
 *   DELETE /api/schedules/:id    删除
 *
 * 错误码约定与其余端点一致：已实现但查不到 → `404 {error:"schedule_not_found"}`；
 * 输入非法 → `400 {error, message, field?}`（前端把 message 挂到对应输入框）。
 *
 * **保存时就把下次触发算好并落库**：调度器重启后靠 `next_run_at` 恢复，
 * 不在内存里留待触发状态（见 core/scheduling/scheduler.ts 纪律 ②）。
 *
 * `PATCH` 只允许改三件事：`enabled`（暂停/恢复）、`name`（改名）、`prompt`（改内容）。
 * 不支持改目标 Bot / 会话 / 触发规则 —— 那等于换一个任务，让用户删了重建更诚实
 * （PRD 只要求暂停/恢复/删除）。
 */

interface CreateBody {
  name?: unknown;
  botId?: unknown;
  channelId?: unknown;
  prompt?: unknown;
  triggerType?: unknown;
  delayMinutes?: unknown;
  intervalMinutes?: unknown;
  atTime?: unknown;
}

interface PatchBody {
  enabled?: unknown;
  name?: unknown;
  prompt?: unknown;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

function intOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

export function registerScheduleRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/schedules", async () => {
    const rows = listScheduleRows(ctx.db);
    return {
      schedules: rows.map((r) => toScheduleDto(ctx.db, r)),
      // 前端顶部横幅用：调度器没跑起来时提示「定时任务可能不会触发」
      schedulerRunning: ctx.scheduler?.running ?? false,
      minIntervalMinutes: config.limits.minScheduleIntervalMinutes,
    };
  });

  app.post<{ Body: CreateBody }>("/api/schedules", async (req, reply: FastifyReply) => {
    const body = req.body ?? {};

    const triggerType = typeof body.triggerType === "string" ? body.triggerType : "";
    if (!(TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      return json(reply, 400, {
        error: "invalid_trigger",
        field: "triggerType",
        message: "触发方式只能是 once（延迟）/ interval（周期）/ daily（每日）",
      });
    }

    const input = {
      name: typeof body.name === "string" ? body.name : "",
      botId: typeof body.botId === "string" ? body.botId : "",
      channelId: typeof body.channelId === "string" ? body.channelId : "",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      triggerType: triggerType as TriggerType,
      delayMinutes: intOrNull(body.delayMinutes),
      intervalMinutes: intOrNull(body.intervalMinutes),
      atTime: typeof body.atTime === "string" ? body.atTime.trim() : null,
    };

    const result = createSchedule(ctx.db, input, {
      minIntervalMinutes: config.limits.minScheduleIntervalMinutes,
    });
    if (!result.ok) {
      const status = result.code === "invalid_input" || result.code.startsWith("invalid_") ||
        result.code === "interval_too_small" || result.code === "delay_too_large"
        ? 400
        : result.code === "bot_not_found" || result.code === "channel_not_found"
          ? 404
          : 409;
      return json(reply, status, {
        error: result.code,
        ...(result.field === undefined ? {} : { field: result.field }),
        message: result.message,
      });
    }

    // 新建后重排：新任务的 next_run_at 可能比当前挂着的定时器更早
    ctx.scheduler?.reschedule();
    return json(reply, 201, { schedule: toScheduleDto(ctx.db, result.schedule) });
  });

  app.patch<{ Params: { id: string }; Body: PatchBody }>(
    "/api/schedules/:id",
    async (req, reply: FastifyReply) => {
      const row = getScheduleRow(ctx.db, req.params.id);
      if (!row) return json(reply, 404, { error: "schedule_not_found" });

      const body = req.body ?? {};
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (body.name !== undefined) {
        if (typeof body.name !== "string") {
          return json(reply, 400, { error: "invalid_input", field: "name", message: "名称必须是字符串" });
        }
        const name = body.name.trim();
        if (name.length === 0 || name.length > 60) {
          return json(reply, 400, {
            error: "invalid_input",
            field: "name",
            message: "名称需为 1–60 字符",
          });
        }
        sets.push("name = ?");
        params.push(name);
      }

      if (body.prompt !== undefined) {
        if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
          return json(reply, 400, {
            error: "invalid_input",
            field: "prompt",
            message: "任务内容不能为空",
          });
        }
        sets.push("prompt = ?");
        params.push(body.prompt.trim());
      }

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return json(reply, 400, {
            error: "invalid_input",
            field: "enabled",
            message: "enabled 必须是布尔值",
          });
        }
        sets.push("enabled = ?");
        params.push(body.enabled ? 1 : 0);

        if (body.enabled) {
          // 恢复：清失败计数并重算下次触发（暂停期间错过的不补跑 —— 用户已看到暂停）
          sets.push("fail_count = 0");
          const next = computeNextRun(
            {
              triggerType: (TRIGGER_TYPES as readonly string[]).includes(row.trigger_type)
                ? (row.trigger_type as TriggerType)
                : "once",
              delayMinutes: row.delay_minutes,
              intervalMinutes: row.interval_minutes,
              atTime: row.at_time,
            },
            Date.now(),
          );
          sets.push("next_run_at = ?");
          params.push(next);
        } else {
          // 暂停：清掉下次触发，调度器不会再挑中它
          sets.push("next_run_at = NULL");
        }
      }

      if (sets.length === 0) {
        return json(reply, 400, { error: "nothing_to_update" });
      }

      params.push(row.id);
      ctx.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      ctx.scheduler?.reschedule();

      const fresh = getScheduleRow(ctx.db, row.id);
      return { ok: true, schedule: fresh ? toScheduleDto(ctx.db, fresh) : null };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply: FastifyReply) => {
    const row = getScheduleRow(ctx.db, req.params.id);
    if (!row) return json(reply, 404, { error: "schedule_not_found" });
    ctx.db.prepare("DELETE FROM schedules WHERE id = ?").run(row.id);
    ctx.scheduler?.reschedule();
    return reply.code(204).send();
  });
}
