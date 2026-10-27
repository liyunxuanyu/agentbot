import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { validateWorkspacePath } from "../../core/process/session-cwd.js";
import {
  getChannel,
  lastEventIdOfChannel,
  lastEventIdsBySession,
  listChannelMessages,
  listChannels,
  listSessionsByChannel,
} from "../dto.js";

/**
 * 渠道与会话首屏。
 *
 *   `GET   /api/channels`       渠道列表（前端 ChatsPage 用）
 *   `POST  /api/channels`       新建渠道（私聊 / 群聊）
 *   `GET   /api/channels/:id`   渠道 + Session 列表 + 消息 + SSE 首连游标
 *   `PATCH /api/channels/:id`   会话/群聊工作区（R2，群聊全员共用）
 *
 * 错误码约定（前端 `isMissingEndpoint` 依赖它）：
 *   - 路由未注册 → `404 {"error":"not_found"}`（由 server.ts 的 setNotFoundHandler 统一给）
 *   - 已实现但查不到 → `404 {"error":"channel_not_found"}`
 * 两者语义完全不同：前者是「功能还没做」，后者是「这个会话真的不存在」。
 *
 * **为什么必须补 POST**（M14）：`POST /api/messages` 要 `channelId`，但 M1–M13 没有
 * 任何创建渠道的入口 —— 首启向导的「发第一条消息」（F1 步骤 4）与「新建群聊」（F2）
 * 都卡在「没有渠道 id」。本端点只建空壳渠道（不写消息、不 spawn 进程），
 * 发消息仍走 `/api/messages`，因此对既有链路零影响。
 *
 * 私聊**幂等**：同一 Bot 只有一条 dm，重复调用返回已有那条。否则每次点 Bot 卡片
 * 都会新建一个会话，`/chats` 会被同一个 Bot 的私聊刷满。
 */

interface CreateChannelBody {
  type?: unknown;
  name?: unknown;
  participantBotIds?: unknown;
  hostBotId?: unknown;
  /** 创建时直接指定工作区（可选；不填走回退链）。 */
  workspacePath?: unknown;
}

interface PatchChannelBody {
  /**
   * 会话/群聊工作区。
   *   - 字符串：校验后落库（存在、是目录、可写，不要求 git —— G8）
   *   - null / 空串：清空，回到回退链（Bot 默认工作区 → 服务进程 cwd）
   */
  workspacePath?: unknown;
}

/** 群聊人数区间（UX F2：2–5 个 Bot）。 */
const GROUP_MIN = 2;
const GROUP_MAX = 5;

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

export function registerChannelRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/channels", async () => {
    return { channels: listChannels(ctx.db) };
  });

  app.post<{ Body: CreateChannelBody }>("/api/channels", async (req, reply: FastifyReply) => {
    const body = req.body ?? {};
    const type = body.type;
    if (type !== "dm" && type !== "group") {
      return json(reply, 400, {
        error: "invalid_channel_type",
        field: "type",
        message: "渠道类型只能是 dm 或 group",
      });
    }

    const rawIds = Array.isArray(body.participantBotIds) ? body.participantBotIds : [];
    const participantIds = [
      ...new Set(rawIds.filter((x): x is string => typeof x === "string" && x.length > 0)),
    ];
    if (participantIds.length === 0) {
      return json(reply, 400, {
        error: "participants_required",
        field: "participantBotIds",
        message: "至少选择一个 Bot",
      });
    }
    if (type === "dm" && participantIds.length !== 1) {
      return json(reply, 400, {
        error: "invalid_participants",
        field: "participantBotIds",
        message: "私聊只能有一个 Bot",
      });
    }
    if (type === "group" && (participantIds.length < GROUP_MIN || participantIds.length > GROUP_MAX)) {
      return json(reply, 400, {
        error: "invalid_participants",
        field: "participantBotIds",
        message: `群聊需要 ${GROUP_MIN}–${GROUP_MAX} 个 Bot`,
      });
    }

    // 逐个校验存在性：不存在的 Bot 会让发送时 resolveRuntime 落空，用户看到的是
    // 「发送失败」，而根因在建渠道这一步 —— 提前拦下并指名。
    const placeholders = participantIds.map(() => "?").join(",");
    const known = new Set(
      (
        ctx.db
          .prepare(`SELECT id FROM bots WHERE status = 'active' AND id IN (${placeholders})`)
          .all(...participantIds) as { id: string }[]
      ).map((r) => r.id),
    );
    const missing = participantIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      return json(reply, 400, {
        error: "bot_not_found",
        field: "participantBotIds",
        message: `Bot 不存在或已归档：${missing.join("、")}`,
      });
    }

    if (type === "dm") {
      const existing = listChannels(ctx.db).find(
        (c) =>
          c.type === "dm" &&
          c.participantBotIds.length === 1 &&
          c.participantBotIds[0] === participantIds[0],
      );
      if (existing) return { channel: existing };
    }

    const names = participantIds.map((id) => {
      const row = ctx.db.prepare("SELECT name FROM bots WHERE id = ?").get(id) as
        | { name: string }
        | undefined;
      return row?.name ?? id;
    });

    const explicitName = typeof body.name === "string" ? body.name.trim() : "";
    const name =
      explicitName.length > 0
        ? explicitName.slice(0, 60)
        : type === "dm"
          ? (names[0] ?? "私聊")
          : names.join("、").slice(0, 60);

    // 主持人必须在参与者里；缺省取第一个（= 最早创建的那个 Bot，与 UX 默认一致）
    let hostBotId: string | null = null;
    if (type === "group") {
      const requested = typeof body.hostBotId === "string" ? body.hostBotId : "";
      hostBotId = participantIds.includes(requested) ? requested : (participantIds[0] ?? null);
    }

    // 可选工作区：创建时就校验（G8），避免建完才发现路径不可用
    let workspacePath: string | null = null;
    if (body.workspacePath !== undefined && body.workspacePath !== null && body.workspacePath !== "") {
      if (typeof body.workspacePath !== "string") {
        return json(reply, 400, {
          error: "invalid_workspace",
          field: "workspacePath",
          message: "工作区路径必须是字符串",
        });
      }
      const check = validateWorkspacePath(body.workspacePath);
      if (!check.ok) {
        return json(reply, 400, {
          error: "invalid_workspace",
          field: "workspacePath",
          code: check.code ?? "invalid",
          message: check.message ?? "工作区不可用",
        });
      }
      workspacePath = check.path ?? body.workspacePath.trim();
    }

    const id = `${type}_${randomUUID()}`;
    ctx.db
      .prepare(
        `INSERT INTO channels
           (id, type, name, participant_bot_ids, host_bot_id, workspace_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, type, name, JSON.stringify(participantIds), hostBotId, workspacePath, Date.now());

    return json(reply, 201, { channel: getChannel(ctx.db, id) });
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id", async (req, reply: FastifyReply) => {
    const channelId = req.params.id;
    const channel = getChannel(ctx.db, channelId);
    if (!channel) {
      return reply
        .code(404)
        .header("content-type", "application/json; charset=utf-8")
        .send({ error: "channel_not_found" });
    }

    return {
      channel,
      sessions: listSessionsByChannel(ctx.db, channelId),
      messages: listChannelMessages(ctx.db, channelId),
      // 向后兼容的全局值（渠道内所有 Session 的最大 events.id）
      lastEventId: lastEventIdOfChannel(ctx.db, channelId),
      // 正确用法：每个 Session 各自的游标。群聊里主持人/发言人各有一个 Session，
      // 用全局最大值建连会把主 Session 的事件整段跳过（critic 实测）。
      lastEventIdBySession: lastEventIdsBySession(ctx.db, channelId),
    };
  });

  /**
   * 修改会话/群聊工作区（R2）。
   *
   * 只改 `channels.workspace_path`：群聊里所有 Bot 共用同一个工作区（G10），
   * 会话级覆盖仍由 `sessions.workspace_path` 承担（会话设置里单独改）。
   * 内置引擎下一轮 prompt 直接生效（没有进程 cwd 概念）；其它运行时本轮只落库，
   * 前端对它们显示禁用态。
   *
   * 空串 / null = 清空，回到回退链 —— 不是「把工作区设成服务进程目录」。
   */
  app.patch<{ Params: { id: string }; Body: PatchChannelBody }>(
    "/api/channels/:id",
    async (req, reply: FastifyReply) => {
      const channelId = req.params.id;
      const existing = ctx.db
        .prepare("SELECT id FROM channels WHERE id = ?")
        .get(channelId) as { id: string } | undefined;
      if (!existing) return json(reply, 404, { error: "channel_not_found" });

      const body = req.body ?? {};
      if (body.workspacePath === undefined) {
        return json(reply, 400, {
          error: "nothing_to_update",
          message: "没有可更新的字段（workspacePath）",
        });
      }

      let workspacePath: string | null = null;
      if (body.workspacePath !== null && body.workspacePath !== "") {
        if (typeof body.workspacePath !== "string") {
          return json(reply, 400, {
            error: "invalid_workspace",
            field: "workspacePath",
            message: "工作区路径必须是字符串",
          });
        }
        const check = validateWorkspacePath(body.workspacePath);
        if (!check.ok) {
          return json(reply, 400, {
            error: "invalid_workspace",
            field: "workspacePath",
            code: check.code ?? "invalid",
            message: check.message ?? "工作区不可用",
          });
        }
        workspacePath = check.path ?? body.workspacePath.trim();
      }

      ctx.db
        .prepare("UPDATE channels SET workspace_path = ? WHERE id = ?")
        .run(workspacePath, channelId);

      return { ok: true, channel: getChannel(ctx.db, channelId) };
    },
  );
}
