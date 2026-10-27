import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { getProvider } from "../../adapters/providers/store.js";
import type { ProviderConfig } from "../../core/agent/provider.js";
import { createIngest } from "../../core/events/ingest.js";
import { eventBus } from "../../core/events/bus.js";
import { resolveWorkspace, validateWorkspacePath } from "../../core/process/session-cwd.js";
import { listSessionsByChannel } from "../dto.js";

/**
 * 会话控制（R2 / R4 / R5 / R7）。
 *
 *   `PATCH /api/sessions/:id/controls`  工作区 / 供应商 / 模型 / 权限模式
 *   `POST  /api/sessions/:id/compact`   手动压缩上下文
 *
 * 三条纪律：
 *   ① **只影响后续轮次与尚未裁决的调用**：控制项落库后，编排层每轮 prompt 重新读；
 *      已生成的正文不回滚（G3）。
 *   ② 切到 plan 时把挂起的写类请求直接置为 rejected（resolver 负责回传与审计）。
 *   ③ 每次控制变更写一条 `meta/config_update` 事件（审计可回溯），不进渲染流。
 */

interface ControlsBody {
  /** null / 空串 = 清除会话级覆盖，回退到 Bot 的供应商。 */
  providerId?: unknown;
  /** null / 空串 = 用供应商默认模型。 */
  model?: unknown;
  permissionMode?: unknown;
  /** null / 空串 = 清除会话级工作区，回退到渠道 → Bot → 服务目录。 */
  workspacePath?: unknown;
}

interface SessionRow {
  id: string;
  bot_id: string;
  channel_id: string;
  provider_id: string | null;
  model: string | null;
  permission_mode: string;
  workspace_path: string | null;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

function modeOf(value: unknown): "confirm" | "auto" | "plan" | "full" | null {
  return value === "confirm" || value === "auto" || value === "plan" || value === "full"
    ? value
    : null;
}

/** 有效供应商：会话覆盖 → Bot 绑定 → 默认供应商。 */
function effectiveProviderId(
  ctx: ServerContext,
  session: SessionRow,
  requested: string | null | undefined,
): string | null {
  if (requested !== undefined) return requested;
  if (session.provider_id !== null && session.provider_id.length > 0) return session.provider_id;
  const bot = ctx.db.prepare("SELECT provider_id FROM bots WHERE id = ?").get(session.bot_id) as
    | { provider_id: string | null }
    | undefined;
  return bot?.provider_id ?? null;
}

function providerOf(ctx: ServerContext, id: string | null): ProviderConfig | null {
  if (id === null) return null;
  // getProvider 读的是 ~/.agentbot/providers.json；不存在返回 null
  return getProvider(id) ?? null;
}

export function registerSessionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const ingest = createIngest({ db: ctx.db, bus: eventBus });

  /** 控制变更审计：meta/config_update，落库但不渲染。 */
  function auditControls(
    sessionId: string,
    data: Record<string, unknown>,
  ): void {
    try {
      ingest(
        {
          sessionId,
          messageId: null,
          turnId: `meta_${sessionId}`,
          eventCapabilities: [],
        },
        {
          type: "meta",
          turnId: `meta_${sessionId}`,
          ts: Date.now(),
          payload: { kind: "config_update", data: { source: "session_controls", ...data } },
        },
      );
    } catch (err) {
      // 审计写不进去不该阻断控制变更；打日志便于排查
      console.warn(
        `[http] 会话控制审计写入失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  app.patch<{ Params: { id: string }; Body: ControlsBody }>(
    "/api/sessions/:id/controls",
    async (req, reply: FastifyReply) => {
      const sessionId = req.params.id;
      const session = ctx.db
        .prepare(
          `SELECT id, bot_id, channel_id, provider_id, model, permission_mode, workspace_path
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as SessionRow | undefined;
      if (!session) return json(reply, 404, { error: "session_not_found" });

      const body = req.body ?? {};
      const touches =
        body.providerId !== undefined ||
        body.model !== undefined ||
        body.permissionMode !== undefined ||
        body.workspacePath !== undefined;
      if (!touches) {
        return json(reply, 400, {
          error: "nothing_to_update",
          message: "没有可更新的字段（providerId / model / permissionMode / workspacePath）",
        });
      }

      const fields: { field: string; code: string; message: string }[] = [];

      // ---- 供应商 ----
      let providerTouched = false;
      let requestedProvider: string | null | undefined;
      if (body.providerId !== undefined) {
        providerTouched = true;
        if (body.providerId === null || body.providerId === "") {
          requestedProvider = null;
        } else if (typeof body.providerId !== "string") {
          fields.push({ field: "providerId", code: "invalid_value", message: "供应商 id 无效" });
        } else if (!getProvider(body.providerId)) {
          fields.push({ field: "providerId", code: "not_found", message: "模型供应商不存在" });
        } else {
          requestedProvider = body.providerId;
        }
      }

      // ---- 模型 ----
      let modelTouched = false;
      let requestedModel: string | null | undefined;
      if (body.model !== undefined) {
        modelTouched = true;
        if (body.model === null || body.model === "") {
          requestedModel = null;
        } else if (typeof body.model !== "string") {
          fields.push({ field: "model", code: "invalid_value", message: "模型名必须是字符串" });
        } else {
          const trimmed = body.model.trim();
          requestedModel = trimmed.length > 0 ? trimmed : null;
        }
      }

      // ---- 权限模式 ----
      let requestedMode: "confirm" | "auto" | "plan" | "full" | null = null;
      if (body.permissionMode !== undefined) {
        requestedMode = modeOf(body.permissionMode);
        if (requestedMode === null) {
          fields.push({
            field: "permissionMode",
            code: "invalid_value",
            message: "权限模式只能是 confirm / auto / plan / full",
          });
        }
      }

      // ---- 工作区 ----
      let workspaceTouched = false;
      let requestedWorkspace: string | null | undefined;
      if (body.workspacePath !== undefined) {
        workspaceTouched = true;
        if (body.workspacePath === null || body.workspacePath === "") {
          requestedWorkspace = null;
        } else if (typeof body.workspacePath !== "string") {
          fields.push({ field: "workspacePath", code: "invalid_value", message: "工作区路径必须是字符串" });
        } else {
          const check = validateWorkspacePath(body.workspacePath);
          if (!check.ok) {
            fields.push({
              field: "workspacePath",
              code: check.code ?? "invalid",
              message: check.message ?? "工作区不可用",
            });
          } else {
            requestedWorkspace = check.path ?? body.workspacePath.trim();
          }
        }
      }

      if (fields.length > 0) return json(reply, 400, { error: "invalid_controls", fields });

      // ---- 跨协议切换：不静默转换，返回「建议新开会话」（Q18）----
      let warning: string | undefined;
      if (providerTouched) {
        const before = providerOf(ctx, effectiveProviderId(ctx, session, undefined));
        const after = providerOf(ctx, effectiveProviderId(ctx, session, requestedProvider));
        if (before && after && before.protocol !== after.protocol) {
          warning =
            "供应商协议已变化（如 OpenAI ↔ Anthropic），历史上下文不会自动转换，建议新开一个会话。";
        }
      }

      // ---- 落库 ----
      const sets: string[] = [];
      const params: (string | null)[] = [];
      if (providerTouched) {
        sets.push("provider_id = ?");
        params.push(requestedProvider ?? null);
        // 换供应商但没指定模型：清掉会话模型，用新供应商的默认模型（避免把
        // 旧供应商的模型名发给新供应商）
        if (!modelTouched) {
          sets.push("model = ?");
          params.push(null);
        }
      }
      if (modelTouched) {
        sets.push("model = ?");
        params.push(requestedModel ?? null);
      }
      if (requestedMode !== null) {
        sets.push("permission_mode = ?");
        params.push(requestedMode);
      }
      if (workspaceTouched) {
        sets.push("workspace_path = ?");
        params.push(requestedWorkspace ?? null);
      }
      params.push(sessionId);
      ctx.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);

      // ---- 立即生效（进程活着时）----
      const after = ctx.db
        .prepare(
          `SELECT id, bot_id, channel_id, provider_id, model, permission_mode, workspace_path
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as SessionRow;

      const liveProvider = effectiveProviderId(ctx, after, undefined);
      // 清空会话工作区时按完整回退链重算，而不是把「空」下发给驱动
      const liveWorkspace = resolveWorkspace(ctx.db, {
        botId: after.bot_id,
        sessionId,
        channelId: after.channel_id,
      }).path;

      ctx.setSessionControls?.(sessionId, {
        providerId: liveProvider,
        model: after.model,
        permissionMode: modeOf(after.permission_mode) ?? "confirm",
        workspacePath: liveWorkspace,
      });

      // 切到 plan：挂起的写类请求直接拒绝（G3）
      let rejectedPending = 0;
      if (requestedMode === "plan") {
        rejectedPending = ctx.permissions.rejectPendingWrites(
          sessionId,
          "已切换到计划模式（只读）",
        );
      }

      auditControls(sessionId, {
        providerId: after.provider_id,
        model: after.model,
        permissionMode: after.permission_mode,
        workspacePath: after.workspace_path,
        rejectedPending,
        // G3：只有真的拒绝了才带上，0 不产生分隔条（避免每次切档都插一条噪音）
        ...(rejectedPending > 0 ? { modeSwitchedTo: "plan" } : {}),
      });

      const dto =
        listSessionsByChannel(ctx.db, after.channel_id).find((s) => s.id === sessionId) ?? null;
      return {
        ok: true,
        session: dto,
        ...(warning === undefined ? {} : { warning }),
        ...(rejectedPending > 0 ? { rejectedPending } : {}),
      };
    },
  );

  /**
   * 手动压缩（R7 / G5）。
   *
   * 只有内置引擎支持；进程不在时返回 409，前端提示「先发一条消息让会话启动」。
   * `force` 缺省 true（用户主动点的就是要现在压），显式传 false 时按阈值判断。
   */
  app.post<{ Params: { id: string }; Body: { force?: unknown } }>(
    "/api/sessions/:id/compact",
    async (req, reply: FastifyReply) => {
      const sessionId = req.params.id;
      const exists = ctx.db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(sessionId);
      if (!exists) return json(reply, 404, { error: "session_not_found" });

      if (!ctx.compactSession) {
        return json(reply, 409, {
          error: "compact_unavailable",
          message: "该运行时由 CLI 自身管理上下文，不支持手动压缩",
        });
      }

      const force = req.body?.force !== false;
      const result = await ctx.compactSession(sessionId, { force });
      if (result === null) {
        return json(reply, 409, {
          error: "compact_unavailable",
          message: "会话未在运行，先发一条消息再压缩",
        });
      }

      if (result.ok) {
        auditControls(sessionId, {
          compaction: {
            trigger: result.trigger,
            removedMessages: result.removedMessages,
            summaryChars: result.summaryChars,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
          },
        });
      }
      return { ok: result.ok, result };
    },
  );
}
