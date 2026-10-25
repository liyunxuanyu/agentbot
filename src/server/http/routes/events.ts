import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { createBotIdEnricher, getSession, toEventDto } from "../dto.js";
import * as eventsRepo from "../../core/repo/events.js";

/**
 * 事件回放（P0-04「重连后从最后一条已落库事件继续」/ P0-05「9 类事件统一呈现」）。
 *
 *   `GET /api/sessions/:id/events?afterSeq=0&limit=2000`
 *     → `{ events: EventDto[], hasMore, lastEventId }`
 *
 * 为什么需要它（critic 实测的根因）：
 *   SSE 只负责「从现在起」的增量；刷新页面后要重建整轮事件块，必须有一次
 *   历史拉取。之前只有 SSE、没有 REST 回放端点，前端首连游标又取了渠道级
 *   最大 id（= 跳过全部历史），于是刷新后 thought / plan / tool_call /
 *   tool_result / usage 全部消失 —— 只剩 messages 表里的正文。
 *
 * 三条形状约定：
 *   ① **`meta` 也返回**：前端靠它生成 Session 分隔条（`events.ts` 的 dividers）。
 *      它是「不渲染」而不是「不返回」—— 过滤掉会让分隔条在刷新后全部丢失。
 *   ② **字段与 SSE 帧的 `data` 一致**：同一个 `toEventDto`，同一份 `botId` 补全。
 *      两条路径形状不同会让问题只在刷新后复现。
 *   ③ **按 `seq` 分页**（会话内单调），不是 `id`：`seq` 才是 UI 排序键。
 *      `lastEventId` 回的是本页覆盖到的最大**全局 id**，正好可以当 SSE 首连游标。
 */

/** 默认页大小：一次够画完一个长会话（PRD 单轮上限 20000，实测单会话常见 <2000）。 */
const DEFAULT_LIMIT = 2000;
/** 上限：防止异常游标把整库倒出来（PRD「单轮事件 >2000 条」用虚拟滚动，不靠一次拉完）。 */
const MAX_LIMIT = 5000;

interface EventsQuery {
  afterSeq?: string;
  limit?: string;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

/** 解析非负整数查询参数；非法值按默认值处理（翻页参数不该让整页 400）。 */
function parseNonNegativeInt(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function registerEventRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // 补 botId 的出帧器与 SSE 共用：历史与实时的同一事件必须逐字段相同
  const enrich = createBotIdEnricher(ctx.db);

  app.get<{ Params: { id: string }; Querystring: EventsQuery }>(
    "/api/sessions/:id/events",
    async (req, reply: FastifyReply) => {
      const sessionId = req.params.id;
      const session = getSession(ctx.db, sessionId);
      if (!session) return json(reply, 404, { error: "session_not_found" });

      const afterSeq = parseNonNegativeInt(req.query.afterSeq, 0);
      const requested = parseNonNegativeInt(req.query.limit, DEFAULT_LIMIT);
      // limit=0 会让前端永远翻不动页；按 1 处理而不是返回空页
      const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);

      // 多取一条判断 hasMore：比再发一次 COUNT 便宜，且与分页语义严格一致
      const rows = eventsRepo.listBySession(ctx.db, sessionId, afterSeq, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // 游标：本页最大全局 id。空页回该会话当前最大 id ——
      // 否则前端拿 0 建 SSE 会把整段历史再推一遍（重复渲染）。
      const lastRow = page[page.length - 1];
      let lastEventId: number;
      if (lastRow !== undefined) {
        lastEventId = lastRow.id;
      } else {
        const row = ctx.db
          .prepare("SELECT MAX(id) AS mx FROM events WHERE session_id = ?")
          .get(sessionId) as { mx: number | null } | undefined;
        lastEventId = row?.mx ?? 0;
      }

      return {
        events: page.map((row) => toEventDto(row, enrich)),
        hasMore,
        lastEventId,
      };
    },
  );
}
