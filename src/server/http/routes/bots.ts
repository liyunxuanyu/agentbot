import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { listBots, toRuntimeDto } from "../dto.js";
import { listRuntimes } from "../../adapters/probe.js";
import { getProvider } from "../../adapters/providers/store.js";
import { normalizeAllowedDirs, readBoundary } from "../../core/permissions/boundary.js";
import { listGrants } from "../../core/permissions/grants.js";
import { createBot } from "../../core/bots/create.js";
import {
  runtimeDisplayName,
  runtimeExists,
  runtimeRequiresWorktree,
} from "../../core/bots/runtime-lookup.js";
import {
  ensureWorktreeForBot,
  readExecutionConfig,
  validateRepoPath,
  validateWorkingDir,
} from "../../core/assignment/worktree.js";
import {
  RISK_CONFIRMATION_REQUIRED,
  worktreeRiskMessage,
} from "../../core/permissions/worktree-guard.js";

/**
 * Bot 端点。
 *
 *   `GET   /api/bots`       → `{ bots: BotDto[] }`
 *   `GET   /api/bots/:id`   → `{ bot, boundary, grants }`
 *   `POST  /api/bots`       → 新建（P0-03 + 安全底线）
 *   `PATCH /api/bots/:id`   → 边界字段 / 运行时 / 执行位置（P0-09、P0-13）
 *
 * 形状对齐 `src/web/net/types.ts` 的 `BotsResponse`：运行时**内联展开**，
 * 前端不做第二次请求拼装。空工作区返回 `{bots: []}` —— 这是「还没有 Bot」，
 * 与端点缺失（404 not_found）必须区分开（前端靠它决定空态还是错误态）。
 *
 * **安全底线（用户裁定）**：运行时 `permission.channel === 'none'` 时不提供权限请求，
 * 产品层无法拦截文件写入。因此：
 *   - 新建：执行位置强制 worktree，且必须填仓库根路径；
 *   - 编辑：把运行时换成这类、或把执行位置改成 local → 必须带 `confirmRisk:true`，
 *     否则回 `400 {error:"risk_confirmation_required", message}`。
 * 判定集中在 `core/permissions/worktree-guard.ts`，这里只做请求编排。
 *
 * PATCH 的字段级校验（P0-09 边界处理「目录不存在或不可写：保存时内联报错」）：
 * 返回 `400 { error:"invalid_boundary", fields:[{field,index?,code,message}] }`，
 * 前端按 `field` 把错误挂到对应输入框下方，而不是弹一个笼统的 toast。
 *
 * 边界的写入**先校验后落库**，且同一事务里更新 `updated_at` ——
 * `updated_at` 就是 `boundary_version`，进行中的请求按旧版本判定（P0-09）。
 */

interface CreateBotBody {
  name?: unknown;
  persona?: unknown;
  avatar?: unknown;
  runtimeId?: unknown;
  /** 内置引擎：绑定的模型供应商 id（缺省用默认供应商）。 */
  providerId?: unknown;
  executionLocation?: unknown;
  repoPath?: unknown;
}

interface PatchBoundaryBody {
  allowDirs?: unknown;
  allowShell?: unknown;
  allowNetwork?: unknown;
  autoApproveWrite?: unknown;
  /** P0-13：执行位置与仓库根路径。 */
  executionLocation?: unknown;
  repoPath?: unknown;
  /** 运行时改绑（P0-02）。 */
  runtimeId?: unknown;
  /** 内置引擎：模型供应商绑定（null / 空串 = 用默认供应商）。 */
  providerId?: unknown;
  /** 管理员角色切换（R6）：admin | member。 */
  role?: unknown;
  /**
   * 人格（P0-03「编辑人格后下一条消息即生效」）。
   *
   * 生效路径不需要额外动作：每轮开始时 `memory/assembler` 重新读 `bots.persona`
   * 拼系统提示，没有任何缓存层。这里只负责校验与落库。
   */
  persona?: unknown;
  /**
   * 二次确认（安全底线）：把没有权限通道的运行时放到 local 时必须为 true。
   * 前端弹确认框，用户点「我明白风险」后带上它重试。
   */
  confirmRisk?: unknown;
}

interface FieldError {
  field:
    | "name"
    | "persona"
    | "runtimeId"
    | "providerId"
    | "allowDirs"
    | "allowShell"
    | "allowNetwork"
    | "autoApproveWrite"
    | "executionLocation"
    | "repoPath"
    | "role";
  index?: number;
  code: string;
  message: string;
}

interface DeleteBotBody {
  confirmName?: unknown;
  mode?: unknown;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

interface BotRow {
  id: string;
  name: string;
  default_runtime_id: string | null;
  allow_dirs: string;
  allow_shell: number;
  allow_network: number;
  auto_approve_write: number;
  updated_at: number;
}

function boundaryDto(botId: string, ctx: ServerContext): unknown {
  const boundary = readBoundary(ctx.db, botId);
  if (!boundary) return null;
  return {
    allowDirs: boundary.allowDirs,
    allowShell: boundary.allowShell,
    allowNetwork: boundary.allowNetwork,
    autoApproveWrite: boundary.autoApproveWrite,
    version: boundary.version,
  };
}

export function registerBotRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/bots", async () => {
    const runtimeMap = new Map(listRuntimes(ctx.db).map((r) => [r.id, toRuntimeDto(r)]));
    return { bots: listBots(ctx.db, runtimeMap) };
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id", async (req, reply: FastifyReply) => {
    const bot = ctx.db.prepare("SELECT * FROM bots WHERE id = ?").get(req.params.id) as
      | BotRow
      | undefined;
    if (!bot) return json(reply, 404, { error: "bot_not_found" });

    const runtimeMap = new Map(listRuntimes(ctx.db).map((r) => [r.id, toRuntimeDto(r)]));
    const dto = listBots(ctx.db, runtimeMap).find((b) => b.id === bot.id) ?? null;

    return {
      bot: dto,
      boundary: boundaryDto(bot.id, ctx),
      grants: listGrants(ctx.db, bot.id).map((g) => ({
        id: g.id,
        actionKey: g.actionKey,
        scope: g.scope,
        sessionId: g.sessionId,
        expiresAt: g.expiresAt,
        createdAt: g.createdAt,
      })),
    };
  });

  /**
   * 新建 Bot（P0-03）。
   *
   * 与 PATCH 共用同一套「执行位置」规则，但多一条**强制默认值**：
   * 运行时没有权限通道 → `execution_location` 强制 `worktree`，且 `repoPath` 必填。
   * 用户传 `local` 也按 worktree 保存 —— 新建流程里不给「带风险保存」的口子，
   * 想改回 local 必须走 PATCH 并显式二次确认。
   */
  app.post<{ Body: CreateBotBody }>("/api/bots", async (req, reply: FastifyReply) => {
    const body = req.body ?? {};

    // 创建逻辑与管理员工具 `create_bot` 共用 `core/bots/create.ts`，
    // 这里只负责把 HTTP 字段翻译成输入、把字段级错误回给前端。
    const result = createBot(
      ctx.db,
      {
        name: body.name,
        persona: body.persona,
        avatar: body.avatar,
        runtimeId: body.runtimeId,
        providerId: body.providerId,
        executionLocation: body.executionLocation,
        workspacePath: body.repoPath,
      },
      {
        runtimeExists: (id) =>
          ctx.db.prepare("SELECT id FROM runtime_definitions WHERE id = ?").get(id) !== undefined,
        runtimeRequiresWorktree: (id) => runtimeRequiresWorktree(ctx.db, id),
        runtimeDisplayName: (id) => runtimeDisplayName(ctx.db, id),
        providerExists: (id) => getProvider(id) !== null,
      },
    );

    if (!result.outcome.ok) {
      return json(reply, 400, { error: "invalid_bot", fields: result.outcome.fields });
    }
    if (result.worktreeError !== undefined) {
      console.warn(`[http] 新建 Bot ${result.outcome.botId} 的 worktree 未就绪：${result.worktreeError}`);
    }

    const id = result.outcome.botId;
    const runtimeMap = new Map(listRuntimes(ctx.db).map((r) => [r.id, toRuntimeDto(r)]));
    const dto = listBots(ctx.db, runtimeMap).find((b) => b.id === id) ?? null;
    return json(reply, 201, {
      bot: dto,
      boundary: boundaryDto(id, ctx),
      execution: readExecutionConfig(ctx.db, id),
    });
  });

  app.patch<{ Params: { id: string }; Body: PatchBoundaryBody }>(
    "/api/bots/:id",
    async (req, reply: FastifyReply) => {
      const bot = ctx.db.prepare("SELECT * FROM bots WHERE id = ?").get(req.params.id) as
        | BotRow
        | undefined;
      if (!bot) return json(reply, 404, { error: "bot_not_found" });

      const body = req.body ?? {};
      const fields: FieldError[] = [];

      // ---- 允许目录：逐条归一化，任一条失败整体不保存 ----
      let allowDirs: string[] | null = null;
      if (body.allowDirs !== undefined) {
        if (!Array.isArray(body.allowDirs)) {
          fields.push({ field: "allowDirs", code: "not_array", message: "允许目录必须是数组" });
        } else {
          const inputs = body.allowDirs.filter((d): d is string => typeof d === "string");
          if (inputs.length !== body.allowDirs.length) {
            fields.push({
              field: "allowDirs",
              code: "not_string",
              message: "允许目录的每一项都必须是字符串",
            });
          }
          const normalized = normalizeAllowedDirs(inputs);
          for (const err of normalized.errors) {
            fields.push({
              field: "allowDirs",
              index: err.index,
              code: err.code,
              message: err.message,
            });
          }
          // 去重：同一目录写两遍没有意义，还会让审计看起来像两条规则
          allowDirs = [...new Set(normalized.dirs)];
        }
      }

      const readBool = (name: "allowShell" | "allowNetwork" | "autoApproveWrite"): number | null => {
        const v = body[name];
        if (v === undefined) return null;
        if (typeof v !== "boolean") {
          fields.push({ field: name, code: "not_boolean", message: "必须是布尔值" });
          return null;
        }
        return v ? 1 : 0;
      };

      const allowShell = readBool("allowShell");
      const allowNetwork = readBool("allowNetwork");
      const autoApproveWrite = readBool("autoApproveWrite");

      // ---- 人格（P0-03）----
      //
      // 只校验长度并落库。生效不需要额外动作：`memory/assembler` 每轮重新读
      // `bots.persona`，没有缓存层，所以「下一条消息即生效（不重启服务）」。
      // 空串是合法的「清空人格」—— 装配器对空人格不输出「## 人格」空壳。
      let persona: string | null = null;
      if (body.persona !== undefined) {
        if (typeof body.persona !== "string") {
          fields.push({ field: "persona", code: "not_string", message: "人格必须是字符串" });
        } else if (body.persona.length > 4000) {
          fields.push({ field: "persona", code: "too_long", message: "人格最多 4000 个字符" });
        } else {
          persona = body.persona;
        }
      }

      // ---- 运行时改绑（P0-02）----
      let runtimeId: string | null = null;
      if (body.runtimeId !== undefined) {
        if (typeof body.runtimeId !== "string" || body.runtimeId.length === 0) {
          fields.push({ field: "runtimeId", code: "invalid_value", message: "运行时 id 无效" });
        } else {
          const rt = ctx.db
            .prepare("SELECT id FROM runtime_definitions WHERE id = ?")
            .get(body.runtimeId) as { id: string } | undefined;
          if (!rt) {
            fields.push({ field: "runtimeId", code: "not_found", message: "运行时不存在" });
          } else {
            runtimeId = rt.id;
          }
        }
      }

      // ---- 模型供应商（内置引擎）----
      let providerTouched = false;
      let providerId: string | null = null;
      if (body.providerId !== undefined) {
        providerTouched = true;
        if (body.providerId === null || body.providerId === "") {
          providerId = null;
        } else if (typeof body.providerId !== "string") {
          fields.push({ field: "providerId", code: "invalid_value", message: "供应商 id 无效" });
        } else if (!getProvider(body.providerId)) {
          fields.push({ field: "providerId", code: "not_found", message: "模型供应商不存在" });
        } else {
          providerId = body.providerId;
        }
      }

      // ---- 管理员角色（R6）----
      //
      // 只改角色，不改边界：管理员只是多一个 create_bot 工具（G4），
      // 不自动获得 full 权限。切换写一条控制台审计；权限模式本身仍按会话四档裁决。
      let role: "member" | "admin" | null = null;
      if (body.role !== undefined) {
        if (body.role !== "member" && body.role !== "admin") {
          fields.push({ field: "role", code: "invalid_value", message: "角色只能是 member 或 admin" });
        } else {
          role = body.role;
        }
      }

      // ---- 执行位置（P0-13）----
      //
      // 校验顺序：先看字段类型，再看「选 worktree 时仓库路径必须是 git 仓库」。
      // 路径校验用 git rev-parse（能识别子目录/worktree），失败一律内联报错、
      // 整体不保存 —— PRD「路径非 git 仓库：保存失败并提示」。
      let executionLocation: "local" | "worktree" | null = null;
      if (body.executionLocation !== undefined) {
        if (body.executionLocation !== "local" && body.executionLocation !== "worktree") {
          fields.push({
            field: "executionLocation",
            code: "invalid_value",
            message: "执行位置只能是 local 或 worktree",
          });
        } else {
          executionLocation = body.executionLocation;
        }
      }

      let repoPath: string | null = null;
      if (body.repoPath !== undefined) {
        if (typeof body.repoPath !== "string") {
          fields.push({ field: "repoPath", code: "not_string", message: "仓库根路径必须是字符串" });
        } else {
          repoPath = body.repoPath.trim();
        }
      }

      // 生效后的执行位置（可能只改其中一项）
      const current = readExecutionConfig(ctx.db, bot.id);
      const effectiveLocation = executionLocation ?? current?.executionLocation ?? "local";
      const effectiveRepo = repoPath ?? current?.repoPath ?? "";
      const effectiveRuntimeId = runtimeId ?? bot.default_runtime_id;

      // ---- 安全底线（用户裁定）：无权限通道的运行时不允许静默放在 local ----
      //
      // 触发条件：本次请求改动了执行配置（运行时 / 执行位置），且**结果**是
      // 「无权限通道 + local」。此时必须显式确认，否则 400。
      // 只改边界字段（allowDirs 等）的请求不受影响 —— 历史数据仍可编辑。
      const touchesExecution = runtimeId !== null || executionLocation !== null;
      if (
        touchesExecution &&
        effectiveLocation === "local" &&
        runtimeRequiresWorktree(ctx.db, effectiveRuntimeId)
      ) {
        if (body.confirmRisk !== true) {
          return json(reply, 400, {
            error: RISK_CONFIRMATION_REQUIRED,
            message: worktreeRiskMessage(runtimeDisplayName(ctx.db, effectiveRuntimeId)),
          });
        }
      }

      if (effectiveLocation === "worktree") {
        if (effectiveRepo.length === 0) {
          fields.push({
            field: "repoPath",
            code: "required",
            message: "选 worktree 时必须填仓库根路径",
          });
        } else {
          const validation = validateRepoPath(effectiveRepo);
          if (!validation.ok) {
            fields.push({
              field: "repoPath",
              code: validation.code ?? "invalid",
              message: validation.message ?? "仓库路径不可用",
            });
          } else if (repoPath !== null) {
            // 用 git 报告的 toplevel 落库：用户填子目录时也能拿到真正的仓库根
            repoPath = validation.repoRoot ?? repoPath;
          }
        }
      } else if (repoPath !== null && repoPath.length > 0) {
        // local：允许指定任意可用目录（内置引擎这类有权限通道的运行时用得上）。
        const validation = validateWorkingDir(repoPath);
        if (!validation.ok) {
          fields.push({
            field: "repoPath",
            code: validation.code ?? "invalid",
            message: validation.message ?? "工作目录不可用",
          });
        } else {
          repoPath = validation.dir ?? repoPath;
        }
      }

      if (fields.length > 0) {
        return json(reply, 400, { error: "invalid_boundary", fields });
      }

      // ---- 落库：一次事务，updated_at 即 boundary_version ----
      const now = Date.now();
      const write = ctx.db.transaction(() => {
        const sets: string[] = ["updated_at = ?"];
        const params: (string | number | null)[] = [now];
        if (allowDirs !== null) {
          sets.push("allow_dirs = ?");
          params.push(JSON.stringify(allowDirs));
        }
        if (allowShell !== null) {
          sets.push("allow_shell = ?");
          params.push(allowShell);
        }
        if (allowNetwork !== null) {
          sets.push("allow_network = ?");
          params.push(allowNetwork);
        }
        if (autoApproveWrite !== null) {
          sets.push("auto_approve_write = ?");
          params.push(autoApproveWrite);
        }
        if (runtimeId !== null) {
          sets.push("default_runtime_id = ?");
          params.push(runtimeId);
          // 换运行时：旧 runtime_session_id 对新运行时无意义（架构 §5 改绑语义）
          sets.push("worktree_state = NULL");
        }
        if (executionLocation !== null) {
          sets.push("execution_location = ?");
          params.push(executionLocation);
        }
        if (repoPath !== null) {
          sets.push("repo_path = ?");
          params.push(repoPath);
          // 换了仓库根 → 旧 worktree 属于旧仓库，必须作废（否则会往旧目录写）
          sets.push("worktree_path = NULL, worktree_state = NULL");
        }
        if (executionLocation === "local") {
          // 改回 local：保留 worktree 路径（用户可能还会切回来），只清状态标记
          sets.push("worktree_state = NULL");
        }
        if (persona !== null) {
          sets.push("persona = ?");
          params.push(persona);
        }
        if (providerTouched) {
          sets.push("provider_id = ?");
          params.push(providerId);
        }
        if (role !== null) {
          sets.push("role = ?");
          params.push(role);
        }
        params.push(bot.id);
        ctx.db.prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      });
      write();

      // 选 worktree：保存后立刻尝试创建（P0-13「首个 Session 创建独立 worktree」提前到保存时，
      // 用户能马上看到失败原因）。创建失败**不回滚保存**：Bot 可保存但标「worktree 未就绪」。
      let worktree = readExecutionConfig(ctx.db, bot.id);
      if (effectiveLocation === "worktree") {
        const result = ensureWorktreeForBot(ctx.db, bot.id);
        if (!result.ok) {
          console.warn(
            `[http] Bot ${bot.id} 的 worktree 未就绪：${result.code ?? "unknown"} ${result.message ?? ""}`,
          );
        }
        worktree = readExecutionConfig(ctx.db, bot.id);
      }

      if (role !== null) {
        console.log(
          `[audit] Bot ${bot.id}（${bot.name}）角色切换为 ${role}（decided_by=user）`,
        );
      }

      return {
        ok: true,
        role:
          role ??
          (
            ctx.db.prepare("SELECT role FROM bots WHERE id = ?").get(bot.id) as
              | { role: string }
              | undefined
          )?.role ??
          "member",
        boundary: boundaryDto(bot.id, ctx),
        execution: worktree,
        // 前端据此在详情页继续显示「此运行时不提供权限请求」的提示
        requiresWorktree: runtimeRequiresWorktree(ctx.db, effectiveRuntimeId),
      };
    },
  );

  /**
   * 删除 Bot（P0-03）。
   *
   *   `DELETE /api/bots/:id`  body `{ confirmName, mode: "cascade" | "archive" }`
   *
   * 两条硬要求：
   *   ① **名称必须完全一致**（PRD「删除需输入 Bot 名称二次确认」）：
   *      不一致回 `400 {error:"name_mismatch"}`，不做 trim/大小写宽容 ——
   *      二次确认的意义就是「你真的知道自己在删哪个」。
   *   ② **必须显式选模式**（PRD「需显式选择一并删除或归档保留」）：
   *      缺省不猜，回 `400 {error:"mode_required"}`。选错模式的代价不对等：
   *      误删不可逆，误归档只需再删一次。
   *
   * `cascade` 的删除范围：channels / sessions / messages / events /
   * memory_entries / schedules / assignments / permission_requests /
   * permission_grants / runtime_bindings / bots。**`usage_records` 不删** ——
   * P0-12 要求「删除 Bot 后历史用量默认保留并标『已删除 Bot』」。
   *
   * **worktree 不自动删**（P0-13 / PRD §6「删除 Bot 时 worktree 保留 7 天后
   * 提示清理，不自动删用户文件」）：用户目录里的东西只能由用户删。
   *
   * `archive` 只把 `bots.status` 置 'archived'，一行数据都不删。
   * 归档后 Bot 从列表消失（`listBots` 只查 active），定时任务显示 `bot_archived`。
   */
  app.delete<{ Params: { id: string }; Body: DeleteBotBody }>(
    "/api/bots/:id",
    async (req, reply: FastifyReply) => {
      const bot = ctx.db
        .prepare("SELECT id, name, status, worktree_path FROM bots WHERE id = ?")
        .get(req.params.id) as
        | { id: string; name: string; status: string; worktree_path: string | null }
        | undefined;
      if (!bot) return json(reply, 404, { error: "bot_not_found" });

      const body = req.body ?? {};

      const confirmName = typeof body.confirmName === "string" ? body.confirmName : "";
      if (confirmName !== bot.name) {
        return json(reply, 400, {
          error: "name_mismatch",
          message: `输入的 Bot 名称与「${bot.name}」不一致`,
        });
      }

      const mode = body.mode;
      if (mode !== "cascade" && mode !== "archive") {
        return json(reply, 400, {
          error: "mode_required",
          message: "必须显式选择删除方式：cascade（一并删除）或 archive（归档保留）",
        });
      }

      if (mode === "archive") {
        // 已归档再归档：幂等返回，不报错（用户重复点不该看到失败）
        if (bot.status !== "archived") {
          ctx.db
            .prepare("UPDATE bots SET status = 'archived', updated_at = ? WHERE id = ?")
            .run(Date.now(), bot.id);
        }
        // 归档会让该 Bot 的定时任务状态变 bot_archived，调度器要重排
        ctx.scheduler?.reschedule();
        return { ok: true, mode, botId: bot.id, deleted: {} };
      }

      // ---- cascade：按外键序从叶到根 ----
      //
      // 为什么手工按序删而不是全靠 ON DELETE CASCADE：
      //   - `channels` 没有指向 Bot 的外键（`participant_bot_ids` 是 JSON），
      //     必须按「该 Bot 参与的渠道」显式清理，否则留下没有参与者的空渠道；
      //   - `events` 靠 sessions 级联，但显式删一次能拿到准确行数（响应里回报）；
      //   - `usage_records` **故意不删**（P0-12）。
      const deleted: Record<string, number> = {};

      // 该 Bot 参与的所有渠道（含 task 渠道）。群聊里还有其他 Bot：
      // 只把本 Bot 从参与者里摘掉，群聊本身保留。
      const channelRows = ctx.db
        .prepare("SELECT id, type, participant_bot_ids, host_bot_id FROM channels")
        .all() as {
        id: string;
        type: string;
        participant_bot_ids: string;
        host_bot_id: string | null;
      }[];

      const soloChannelIds: string[] = [];
      const sharedChannelUpdates: { id: string; participants: string[]; hostBotId: string | null }[] =
        [];

      for (const row of channelRows) {
        let participants: string[] = [];
        try {
          const parsed: unknown = JSON.parse(row.participant_bot_ids);
          if (Array.isArray(parsed)) {
            participants = parsed.filter((x): x is string => typeof x === "string");
          }
        } catch {
          // 坏 JSON 当空参与者：这个渠道只剩名字，跟着 Bot 一起清掉更安全
        }
        if (!participants.includes(bot.id)) continue;

        const rest = participants.filter((id) => id !== bot.id);
        if (row.type === "task" || rest.length === 0) {
          soloChannelIds.push(row.id);
          continue;
        }
        sharedChannelUpdates.push({
          id: row.id,
          participants: rest,
          // 主持人是被删的 Bot → 顺延给剩下的第一个（P0-06「群主 Bot 删除时需重选主持人」）
          hostBotId: row.host_bot_id === bot.id ? (rest[0] ?? null) : row.host_bot_id,
        });
      }

      // 要级联删除的 session（该 Bot 名下 + 独占渠道里的所有 session）
      const sessionIds: string[] = [];
      {
        const own = ctx.db
          .prepare("SELECT id FROM sessions WHERE bot_id = ?")
          .all(bot.id) as { id: string }[];
        for (const s of own) sessionIds.push(s.id);
        if (soloChannelIds.length > 0) {
          const placeholders = soloChannelIds.map(() => "?").join(",");
          const inSolo = ctx.db
            .prepare(`SELECT id FROM sessions WHERE channel_id IN (${placeholders})`)
            .all(...soloChannelIds) as { id: string }[];
          for (const s of inSolo) {
            if (!sessionIds.includes(s.id)) sessionIds.push(s.id);
          }
        }
      }

      // 删之前先停掉在跑的轮次：进程还活着时把 sessions 行删掉，运行时的后续
      // 事件会写到不存在的会话上（`eventsRepo.insert` 抛「会话不存在」）。
      // 取消是尽力而为 —— 已结束的会话没有活跃 Turn，`activeTurn` 返回 null。
      for (const sessionId of sessionIds) {
        const active = ctx.orchestrator.activeTurn(sessionId);
        if (!active) continue;
        try {
          await ctx.orchestrator.cancel(sessionId, active.turnId);
        } catch {
          // 取消失败不阻断删除：用户明确要求删，残留进程由 Supervisor 关服时清
        }
      }

      const remove = ctx.db.transaction(() => {
        // ① 权限：先按 session 清，再按 bot 清（grant 可能没有 session_id）
        if (sessionIds.length > 0) {
          const ph = sessionIds.map(() => "?").join(",");
          deleted["permission_requests"] = ctx.db
            .prepare(`DELETE FROM permission_requests WHERE session_id IN (${ph})`)
            .run(...sessionIds).changes;
          ctx.db
            .prepare(`DELETE FROM permission_grants WHERE session_id IN (${ph})`)
            .run(...sessionIds);
        } else {
          deleted["permission_requests"] = 0;
        }
        ctx.db.prepare("DELETE FROM permission_grants WHERE bot_id = ?").run(bot.id);
        ctx.db.prepare("DELETE FROM permission_requests WHERE bot_id = ?").run(bot.id);

        // ② 事件 → 消息（按 session 逐层）
        if (sessionIds.length > 0) {
          const ph = sessionIds.map(() => "?").join(",");
          deleted["events"] = ctx.db
            .prepare(`DELETE FROM events WHERE session_id IN (${ph})`)
            .run(...sessionIds).changes;
          deleted["messages"] = ctx.db
            .prepare(`DELETE FROM messages WHERE session_id IN (${ph})`)
            .run(...sessionIds).changes;
        } else {
          deleted["events"] = 0;
          deleted["messages"] = 0;
        }

        // ③ 会话
        deleted["sessions"] = ctx.db
          .prepare("DELETE FROM sessions WHERE bot_id = ?")
          .run(bot.id).changes;
        if (soloChannelIds.length > 0) {
          const ph = soloChannelIds.map(() => "?").join(",");
          deleted["sessions"] += ctx.db
            .prepare(`DELETE FROM sessions WHERE channel_id IN (${ph})`)
            .run(...soloChannelIds).changes;
        }

        // ④ Bot 直属：记忆 / 定时任务 / 任务 / 运行时绑定
        deleted["memory_entries"] = ctx.db
          .prepare("DELETE FROM memory_entries WHERE bot_id = ?")
          .run(bot.id).changes;
        deleted["schedules"] = ctx.db
          .prepare("DELETE FROM schedules WHERE bot_id = ?")
          .run(bot.id).changes;
        deleted["assignments"] = ctx.db
          .prepare("DELETE FROM assignments WHERE bot_id = ?")
          .run(bot.id).changes;
        deleted["runtime_bindings"] = ctx.db
          .prepare("DELETE FROM runtime_bindings WHERE bot_id = ?")
          .run(bot.id).changes;

        // ⑤ 渠道：独占的整条删，共享的只摘掉这个 Bot
        deleted["channels"] = 0;
        if (soloChannelIds.length > 0) {
          const ph = soloChannelIds.map(() => "?").join(",");
          deleted["channels"] += ctx.db
            .prepare(`DELETE FROM channels WHERE id IN (${ph})`)
            .run(...soloChannelIds).changes;
        }
        for (const upd of sharedChannelUpdates) {
          ctx.db
            .prepare("UPDATE channels SET participant_bot_ids = ?, host_bot_id = ? WHERE id = ?")
            .run(JSON.stringify(upd.participants), upd.hostBotId, upd.id);
        }

        // ⑥ Bot 本体
        ctx.db.prepare("DELETE FROM bots WHERE id = ?").run(bot.id);
      });
      remove();

      // 归档/删除后调度器要重排（内存里可能还挂着该 Bot 的定时器）
      ctx.scheduler?.reschedule();

      // `usage_records` 保留：P0-12 要求历史用量默认保留并标「已删除 Bot」。
      // 这里如实回报保留条数，让前端能说清「用量还在」。
      const usageKept = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM usage_records WHERE bot_id = ?")
        .get(bot.id) as { n: number } | undefined;

      return {
        ok: true,
        mode,
        botId: bot.id,
        deleted,
        usageRecordsKept: usageKept?.n ?? 0,
        // worktree 不删（P0-13）：把路径回给前端，让设置页提示「7 天后可清理」
        worktreeKept: bot.worktree_path,
      };
    },
  );
}
