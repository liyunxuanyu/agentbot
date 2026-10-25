import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { toMemoryDto, type MemoryInjectionDto } from "../dto.js";
import { assemble } from "../../core/memory/assembler.js";
import { createSummarizer, type Summarizer } from "../../core/memory/summarizer.js";
import * as memoryRepo from "../../core/repo/memory.js";

/**
 * 记忆端点（M7，P0-10）。
 *
 *   `GET    /api/bots/:id/memory`              → `{ entries, injection }`
 *   `POST   /api/bots/:id/memory`              → 新建条目（手写 / 手动加摘要）
 *   `PATCH  /api/bots/:id/memory/:memId`       → 改内容或注入开关
 *   `DELETE /api/bots/:id/memory/:memId`       → 删除
 *   `POST   /api/bots/:id/memory/summarize`    → 立即摘要
 *
 * 三条行为约定（对应 PRD 边界）：
 *   ① **保存后 1s 内生效**：注入装配每轮都重新读库（`assembler.assemble`），
 *      没有任何缓存层，所以「下一条消息」用的就是最新内容。
 *   ② **删除只影响后续注入**：本层只删 `memory_entries` 行，
 *      从不改写 `messages` —— 历史对话保持原样。
 *   ③ **空记忆不注入空段落**：`injection.includedCount === 0` 时前端渲染空态，
 *      装配器本身也不会输出空的「## 记忆」壳。
 *
 * 待摘要标记（`mem_pending_*`，injected=0）**不在列表里出现**：
 * 它是内部状态，暴露给用户只会让人困惑（用户看到一条「运行时不可用」的伪记忆）。
 * 摘要失败后重试发生在下一条消息前，用户无需操作。
 */

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

function botExists(ctx: ServerContext, botId: string): boolean {
  return ctx.db.prepare("SELECT 1 AS ok FROM bots WHERE id = ?").get(botId) !== undefined;
}

/**
 * 注入估算。
 *
 * `personaChars` 从装配结果里反推：人格段总是第一个 section，
 * 有记忆段时止于「\n\n## 记忆」，否则到结尾。
 */
function injectionOf(ctx: ServerContext, botId: string): MemoryInjectionDto {
  const result = assemble(ctx.db, botId);
  const split = result.text.indexOf("\n\n## 记忆");
  const personaChars = result.text.startsWith("## 人格")
    ? split >= 0
      ? split
      : result.text.length
    : 0;
  return {
    budget: result.budget,
    usedChars: result.usedChars,
    includedCount: result.included.length,
    truncatedCount: result.truncatedCount,
    personaChars,
    personaTruncated: result.personaTruncated,
  };
}

interface CreateBody {
  content?: unknown;
  kind?: unknown;
  injected?: unknown;
  sourceSessionId?: unknown;
}

interface PatchBody {
  content?: unknown;
  injected?: unknown;
}

export function registerMemoryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // 摘要器无状态（纯 DB + 纯函数），未注入时本地建一个：
  // 这样老测试的 buildServer({...}) 不必新增必填字段。
  const summarizer: Summarizer = ctx.summarizer ?? createSummarizer({ db: ctx.db });

  app.get<{ Params: { id: string } }>(
    "/api/bots/:id/memory",
    async (req, reply: FastifyReply) => {
      const botId = req.params.id;
      if (!botExists(ctx, botId)) return json(reply, 404, { error: "bot_not_found" });

      // 待摘要标记是内部状态，不暴露（见文件头说明）
      const entries = memoryRepo
        .listByBot(ctx.db, botId)
        .filter((e) => !memoryRepo.isPendingId(e.id))
        .map(toMemoryDto);

      return { entries, injection: injectionOf(ctx, botId) };
    },
  );

  app.post<{ Params: { id: string }; Body: CreateBody }>(
    "/api/bots/:id/memory",
    async (req, reply: FastifyReply) => {
      const botId = req.params.id;
      if (!botExists(ctx, botId)) return json(reply, 404, { error: "bot_not_found" });

      const body = req.body ?? {};
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (content.length === 0) return json(reply, 400, { error: "content_required" });
      if (body.kind !== undefined && body.kind !== "manual" && body.kind !== "summary") {
        return json(reply, 400, { error: "kind_invalid" });
      }
      if (body.injected !== undefined && typeof body.injected !== "boolean") {
        return json(reply, 400, { error: "injected_invalid" });
      }

      const entry = memoryRepo.create(ctx.db, {
        id: `mem_${randomUUID()}`,
        botId,
        content,
        kind: body.kind === "summary" ? "summary" : "manual",
        sourceSessionId:
          typeof body.sourceSessionId === "string" && body.sourceSessionId.length > 0
            ? body.sourceSessionId
            : null,
        injected: body.injected !== false,
      });

      return { entry: toMemoryDto(entry), injection: injectionOf(ctx, botId) };
    },
  );

  app.patch<{ Params: { id: string; memId: string }; Body: PatchBody }>(
    "/api/bots/:id/memory/:memId",
    async (req, reply: FastifyReply) => {
      const botId = req.params.id;
      const memId = req.params.memId;
      if (!botExists(ctx, botId)) return json(reply, 404, { error: "bot_not_found" });
      // 待摘要标记不可编辑（它不是用户数据）
      if (memoryRepo.isPendingId(memId)) return json(reply, 404, { error: "memory_not_found" });

      const existing = memoryRepo.getById(ctx.db, memId);
      if (!existing || existing.botId !== botId) {
        return json(reply, 404, { error: "memory_not_found" });
      }

      const body = req.body ?? {};
      const hasContent = body.content !== undefined;
      const hasInjected = body.injected !== undefined;
      if (!hasContent && !hasInjected) {
        return json(reply, 400, { error: "nothing_to_update" });
      }
      if (hasContent && (typeof body.content !== "string" || body.content.trim().length === 0)) {
        return json(reply, 400, { error: "content_required" });
      }
      if (hasInjected && typeof body.injected !== "boolean") {
        return json(reply, 400, { error: "injected_invalid" });
      }

      const updated = memoryRepo.update(ctx.db, memId, {
        ...(typeof body.content === "string" ? { content: body.content.trim() } : {}),
        ...(typeof body.injected === "boolean" ? { injected: body.injected } : {}),
      });

      return {
        entry: updated ? toMemoryDto(updated) : null,
        injection: injectionOf(ctx, botId),
      };
    },
  );

  app.delete<{ Params: { id: string; memId: string } }>(
    "/api/bots/:id/memory/:memId",
    async (req, reply: FastifyReply) => {
      const botId = req.params.id;
      const memId = req.params.memId;
      if (!botExists(ctx, botId)) return json(reply, 404, { error: "bot_not_found" });
      if (memoryRepo.isPendingId(memId)) return json(reply, 404, { error: "memory_not_found" });

      const existing = memoryRepo.getById(ctx.db, memId);
      if (!existing || existing.botId !== botId) {
        return json(reply, 404, { error: "memory_not_found" });
      }

      // 只删记忆行：历史消息是独立表，删除不影响已发生的对话（PRD P0-10 边界）
      memoryRepo.remove(ctx.db, memId);
      return { ok: true, injection: injectionOf(ctx, botId) };
    },
  );

  app.post<{ Params: { id: string }; Body: { sessionId?: unknown } }>(
    "/api/bots/:id/memory/summarize",
    async (req, reply: FastifyReply) => {
      const botId = req.params.id;
      if (!botExists(ctx, botId)) return json(reply, 404, { error: "bot_not_found" });

      // 「立即摘要」作用于一个 Session：显式传优先，否则取该 Bot 最近的 Session
      const explicit = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
      const sessionId =
        explicit.length > 0
          ? explicit
          : (
              ctx.db
                .prepare(
                  "SELECT id FROM sessions WHERE bot_id = ? ORDER BY started_at DESC LIMIT 1",
                )
                .get(botId) as { id: string } | undefined
            )?.id;

      if (!sessionId) return json(reply, 409, { error: "no_session" });

      const owned = ctx.db
        .prepare("SELECT 1 AS ok FROM sessions WHERE id = ? AND bot_id = ?")
        .get(sessionId, botId);
      if (!owned) return json(reply, 404, { error: "session_not_found" });

      const outcome = summarizer.summarizeNow(sessionId);
      // 运行时不可用时 outcome.ok=false，但**待摘要标记已保留**，不是错误响应：
      // 用户点「立即摘要」不该看到红色报错，前端按 reason 显示「将在下次会话前重试」。
      return {
        ok: outcome.ok,
        entryId: outcome.entryId ?? null,
        skipped: outcome.skipped ?? false,
        reason: outcome.reason ?? null,
        chars: outcome.chars ?? null,
        injection: injectionOf(ctx, botId),
      };
    },
  );
}
