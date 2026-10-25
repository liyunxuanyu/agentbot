import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DB } from "../../core/db/db.js";
import type { ServerContext } from "../server.js";
import { getChannel, getSession, type ChannelDto } from "../dto.js";
import { TurnError } from "../../core/orchestrator/turn.js";
import { decideSpeakers, type HostDecision } from "../../core/group/host.js";
import { dispatchSpeakers, type DispatchResult } from "../../core/group/dispatcher.js";
import { currentSessionOf } from "../../core/group/notices.js";

/**
 * 发送与取消（M10 群聊派发已接入）。
 *
 *   `POST /api/messages`              → 私聊：`{ messageId, turnId, sessionId, queued? }`
 *                                        群聊：额外 `{ speakers, calls, skipReason, degraded, notice }`
 *   `POST /api/sessions/:id/cancel`   → `{ turnId }`
 *
 * 三种渠道各走各的路：
 *
 *   dm    → 直接跑该 Bot（唯一参与者），行为与 M4 完全一致（不回归）。
 *   group → 主持人决策（`group/host`）→ 按名单依次派发（`group/dispatcher`）。
 *           响应在**决策完成时**返回（含发言人名单），派发在后台继续跑：
 *           一轮可能 3×20s，HTTP 不能等它跑完（P0-04 首 token 走 SSE，不走响应体）。
 *   task  → 只接受 Assignment runner 内部的调用（不从这里进入）。
 *
 * 群聊的四条硬约束都在 host/dispatcher 里落地，本文件只做「组装 + 错误码映射」：
 *   - 未点名 Bot 0 次调用（dispatcher 只执行名单）；
 *   - @ 必被包含且优先（host.applyMentions）；
 *   - 单轮 ≤3（host 截断）；
 *   - 主持人不可用/超时/非 JSON 都有降级与群内系统提示。
 */

interface SendBody {
  channelId?: unknown;
  text?: unknown;
  mentionBotIds?: unknown;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

/** 群聊响应：在 SendMessageResponse 之上扩展（旧前端读不到新字段也不报错）。 */
export interface GroupSendResponse {
  /** 主持人那一轮的助手消息（前端乐观渲染用；用户消息同 turnId）。 */
  messageId: string;
  turnId: string;
  sessionId: string;
  speakers: { botId: string; reason: string }[];
  /** 本轮实际发起的运行时调用数（≤3）。 */
  calls: number;
  skipReason: string | null;
  degraded: HostDecision["degraded"];
  /** 群内系统提示（主持人不可用/超时/丢弃了不存在的 Bot）。 */
  notice: string | null;
  warnings: string[];
  /** 每个发言人的结果；派发未完成时为 null（后台继续跑）。 */
  results: DispatchResult["results"] | null;
}

export function registerMessageRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: SendBody }>("/api/messages", async (req, reply: FastifyReply) => {
    const body = req.body ?? {};
    const channelId = typeof body.channelId === "string" ? body.channelId : "";
    const text = typeof body.text === "string" ? body.text : "";

    if (channelId.length === 0) return json(reply, 400, { error: "channel_id_required" });
    if (text.trim().length === 0) return json(reply, 400, { error: "text_required" });

    const channel = getChannel(ctx.db, channelId);
    if (!channel) return json(reply, 404, { error: "channel_not_found" });

    const mentionBotIds = Array.isArray(body.mentionBotIds)
      ? body.mentionBotIds.filter((x): x is string => typeof x === "string")
      : [];

    if (channel.type === "group") {
      return sendGroup(ctx, reply, channel, text, mentionBotIds, req.log);
    }

    // ---- 私聊：与 M4 一致，只跑唯一参与者（@ 在私聊里不改变目标） ----
    const botId = channel.participantBotIds[0] ?? null;
    if (!botId) return json(reply, 409, { error: "no_bot_in_channel" });

    const runtime = ctx.resolveRuntime(botId);
    if (!runtime) return json(reply, 409, { error: "runtime_unavailable" });

    try {
      const info = await ctx.orchestrator.start({ channelId, botId, text });
      return {
        messageId: info.messageId,
        turnId: info.turnId,
        sessionId: info.sessionId,
        ...(info.queued ? { queued: true, position: info.position ?? 1 } : {}),
      };
    } catch (err) {
      if (err instanceof TurnError) {
        const status = err.code === "session_not_found" ? 404 : 409;
        // worktree_not_ready 必须带 message：前端要显示「为什么不能发」+ 重试入口
        return json(reply, status, {
          error: err.code,
          ...(err.code === "worktree_not_ready" ? { message: err.message } : {}),
        });
      }
      req.log.error?.(err);
      console.error("[http] 发送失败:", err instanceof Error ? err.message : err);
      return json(reply, 500, { error: "send_failed" });
    }
  });

  app.post<{ Params: { id: string }; Body: { turnId?: unknown } }>(
    "/api/sessions/:id/cancel",
    async (req, reply: FastifyReply) => {
      const sessionId = req.params.id;
      const session = getSession(ctx.db, sessionId);
      if (!session) return json(reply, 404, { error: "session_not_found" });

      const turnId = typeof req.body?.turnId === "string" ? req.body.turnId : "";
      if (turnId.length === 0) return json(reply, 400, { error: "turn_id_required" });

      const ok = await ctx.orchestrator.cancel(sessionId, turnId);
      if (!ok) return json(reply, 409, { error: "turn_not_running" });
      return { cancelled: true, turnId };
    },
  );
}

// ---------------------------------------------------------------------------
// 群聊
// ---------------------------------------------------------------------------

/**
 * 群聊里的「锚点 Session」：用户消息与系统提示要落在某个 Session 上。
 *
 * 主持人跑过一轮时用它的 Session；没跑（不可用/没有主持人）时，渠道里可能一个
 * Session 都没有 —— 那就补建一个空 Session（`status='created'`，不 spawn 进程）。
 * 不补的话用户发出的消息会**完全消失**，这是比「多一个空会话」严重得多的错误。
 */
function ensureAnchorSession(db: DB, channelId: string, botId: string | null): string | null {
  const existing = currentSessionOf(db, channelId, botId ?? undefined);
  if (existing) return existing;
  if (!botId) return null;
  const id = `sess_${randomUUID()}`;
  try {
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
       VALUES (?, ?, ?, NULL, 'fresh', 'created', ?)`,
    ).run(id, botId, channelId, Date.now());
    return id;
  } catch {
    return null;
  }
}

async function sendGroup(
  ctx: ServerContext,
  reply: FastifyReply,
  channel: ChannelDto,
  text: string,
  mentionBotIds: string[],
  log: { error?: (e: unknown) => void } | undefined,
): Promise<GroupSendResponse | FastifyReply> {
  // 主持人决策（内部：主持人 Turn + 解析 + @ 合并 + 截断）
  let decision: HostDecision;
  try {
    decision = await decideSpeakers(
      {
        db: ctx.db,
        orchestrator: ctx.orchestrator,
        isRuntimeAvailable: (botId) => ctx.resolveRuntime(botId) !== null,
        ...(ctx.groupDecisionTimeoutMs === undefined
          ? {}
          : { decisionTimeoutMs: ctx.groupDecisionTimeoutMs }),
      },
      {
        id: channel.id,
        participantBotIds: channel.participantBotIds,
        hostBotId: channel.hostBotId,
      },
      text,
      mentionBotIds,
    );
  } catch (err) {
    log?.error?.(err);
    console.error("[http] 主持人决策失败:", err instanceof Error ? err.message : err);
    return json(reply, 500, { error: "host_decision_failed" });
  }

  // 用户消息必须入流：主持人这一轮已经写了（userMessageText = 用户原文）。
  // 没有主持人/主持人不可用时没有 Turn，需要自己补一条用户消息，否则用户看不到自己说过的话。
  let anchor = decision.hostTurn;
  if (!anchor) {
    const sessionId = ensureAnchorSession(ctx.db, channel.id, decision.hostBotId ?? channel.participantBotIds[0] ?? null);
    if (sessionId) {
      const id = `msg_${randomUUID()}`;
      const turnId = `user_${randomUUID()}`;
      try {
        ctx.db
          .prepare(
            `INSERT INTO messages
               (id, session_id, channel_id, turn_id, role, content, content_version, status,
                tokens_in, tokens_out, created_at)
             VALUES (?, ?, ?, ?, 'user', ?, 0, 'done', NULL, NULL, ?)`,
          )
          .run(id, sessionId, channel.id, turnId, text, Date.now());
        anchor = { turnId, sessionId, messageId: id };
      } catch (err) {
        console.warn(`[http] 群聊用户消息写入失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 群内系统提示（降级/丢弃不存在的 Bot）
  if (decision.notice) {
    const sessionId = anchor?.sessionId ?? ensureAnchorSession(ctx.db, channel.id, decision.hostBotId);
    if (sessionId) {
      try {
        ctx.db
          .prepare(
            `INSERT INTO messages
               (id, session_id, channel_id, turn_id, role, content, content_version, status,
                tokens_in, tokens_out, created_at)
             VALUES (?, ?, ?, ?, 'system', ?, 0, 'done', NULL, NULL, ?)`,
          )
          .run(
            `msg_${randomUUID()}`,
            sessionId,
            channel.id,
            `group_${randomUUID()}`,
            decision.notice,
            Date.now(),
          );
      } catch {
        // 提示写不进去不影响本轮派发
      }
    }
  }

  // 派发：不 await（HTTP 立刻回名单；SSE 推流式内容）
  const parallel = mentionBotIds.length > 1;
  if (decision.speakers.length > 0) {
    void dispatchSpeakers(
      {
        db: ctx.db,
        orchestrator: ctx.orchestrator,
        isRuntimeAvailable: (botId) => ctx.resolveRuntime(botId) !== null,
      },
      {
        channelId: channel.id,
        speakers: decision.speakers,
        text,
        parallel,
        ...(ctx.groupSpeakerTimeoutMs === undefined
          ? {}
          : { perSpeakerTimeoutMs: ctx.groupSpeakerTimeoutMs }),
      },
    ).catch((err: unknown) => {
      console.error("[http] 群聊派发失败:", err instanceof Error ? err.message : err);
    });
  }

  const response: GroupSendResponse = {
    messageId: anchor?.messageId ?? "",
    turnId: anchor?.turnId ?? "",
    sessionId: anchor?.sessionId ?? "",
    speakers: decision.speakers.map((s) => ({ botId: s.botId, reason: s.reason })),
    calls: decision.speakers.length,
    skipReason: decision.skipReason,
    degraded: decision.degraded,
    notice: decision.notice,
    warnings: decision.warnings,
    results: null,
  };
  return response;
}
