import type { ToolDefinition, ToolResult } from "../registry.js";

/**
 * `create_bot` —— 管理员 Bot 的专属工具（R6 / G4）。
 *
 * 三条纪律：
 *   ① 工具本身不碰数据库：真正的创建逻辑由装配层注入（`core/bots/create.ts`），
 *      与 `POST /api/bots` 共用同一份校验。
 *   ② 每次创建都走权限门禁（`action: "admin"`）：confirm 弹卡、auto 仍问、
 *      full 自动批准但写审计、plan 下工具根本不在列表里。门禁由 agent loop 按
 *      `permission: "admin"` 统一执行 —— 工具内不再重复询问，否则一次调用会
 *      落两张卡，第二张永远没人应答。
 *   ③ 非管理员即使拿到工具也会被拒（`ctx.botRole` 二次校验）—— 驱动已经按角色
 *      裁剪工具表，这里再挡一次，防止将来别的装配路径漏掉。
 */

export interface CreateBotRequest {
  name: string;
  persona?: string;
  runtimeId?: string;
  providerId?: string;
  workspacePath?: string;
}

export interface CreateBotResult {
  ok: boolean;
  botId?: string;
  name?: string;
  /** 失败原因（字段级错误合并成一句，直接回灌给模型）。 */
  message?: string;
}

export type CreateBotHandler = (input: CreateBotRequest) => CreateBotResult | Promise<CreateBotResult>;

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createCreateBotTool(handler: CreateBotHandler): ToolDefinition {
  return {
    name: "create_bot",
    description:
      "创建一个新的 Bot（仅管理员可用）。创建前先问清用户要建什么：名字、人格/职责、用哪个运行时与模型供应商、默认工作区（可选）。" +
      "运行时与供应商不填则用系统默认。创建成功后把 Bot 名称与 id 告诉用户。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bot 名称（必填，≤32 字符，不能与现有 Bot 重名）" },
        persona: { type: "string", description: "人格与职责说明（可选，≤4000 字符）" },
        runtimeId: { type: "string", description: "运行时 id（可选；不填用系统默认运行时）" },
        providerId: { type: "string", description: "模型供应商 id（可选；不填用默认供应商）" },
        workspacePath: {
          type: "string",
          description: "默认工作区绝对路径（可选；不填则跟随会话/群聊工作区或服务目录）",
        },
      },
      required: ["name"],
    },
    permission: "admin",
    source: "builtin",
    async execute(ctx, args): Promise<ToolResult> {
      const started = Date.now();
      if (ctx.botRole !== "admin") {
        const message = "只有管理员 Bot 可以创建 Bot。";
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }

      const name = str(args, "name");
      if (name === null) {
        const message = "name 不能为空";
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }

      const request: CreateBotRequest = { name };
      const persona = str(args, "persona");
      if (persona !== null) request.persona = persona;
      const runtimeId = str(args, "runtimeId");
      if (runtimeId !== null) request.runtimeId = runtimeId;
      const providerId = str(args, "providerId");
      if (providerId !== null) request.providerId = providerId;
      const workspacePath = str(args, "workspacePath");
      if (workspacePath !== null) request.workspacePath = workspacePath;

      let result: CreateBotResult;
      try {
        result = await handler(request);
      } catch (err) {
        const message = `创建失败：${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }

      if (!result.ok) {
        const message = result.message ?? "创建失败";
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }

      return {
        ok: true,
        output: `已创建 Bot「${result.name ?? name}」（id: ${result.botId ?? "unknown"}）。`,
        durationMs: Date.now() - started,
      };
    },
  };
}
