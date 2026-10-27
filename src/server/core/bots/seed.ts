import type { DB } from "../db/db.js";
import { createBot, type BotCreateLookup } from "./create.js";

/**
 * 管理员 Bot 种子（R6 / Q16）。
 *
 * 触发条件（两条都满足才种）：
 *   ① `bots` 表为空 —— 用户已经有 Bot 就不替他做决定；
 *   ② 至少配置了一个模型供应商 —— 没有供应商时管理员也聊不起来，种了只会误导。
 *
 * 只执行一次：`schema_meta` 里的 `admin_seeded` 标记保证「用户删光 Bot 后重启
 * 不会再冒出一个管理员」。要重新种只能清库或手工删标记 —— 这是有意的。
 *
 * 种子 Bot 只是普通 Bot + `role='admin'`：不自动获得 full 权限（G4），
 * 默认权限模式仍是 confirm，工作区为空（跟随会话/渠道回退链）。
 */

export const ADMIN_SEED_MARKER = "admin_seeded";

export const ADMIN_BOT_NAME = "管理员";

export interface SeedAdminBotOptions {
  /** 当前是否至少有一个模型供应商。 */
  hasProviders: boolean;
  /** 内置引擎的运行时 id（`runtime_definitions.id`）；null 表示运行时未注册。 */
  runtimeId: string | null;
  log?: (message: string) => void;
}

export interface SeedAdminBotResult {
  seeded: boolean;
  botId?: string;
  reason?: "already_seeded" | "has_bots" | "no_provider" | "no_runtime" | "failed";
}

export function seedAdminBot(db: DB, opts: SeedAdminBotOptions): SeedAdminBotResult {
  const log = opts.log ?? ((msg: string) => console.log(`[agentbot] ${msg}`));

  const marker = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(ADMIN_SEED_MARKER) as { value: string } | undefined;
  if (marker) return { seeded: false, reason: "already_seeded" };

  const count = db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number } | undefined;
  if ((count?.n ?? 0) > 0) return { seeded: false, reason: "has_bots" };

  if (!opts.hasProviders) {
    log("未配置模型供应商，跳过管理员 Bot 种子（配置后重启会再尝试）");
    return { seeded: false, reason: "no_provider" };
  }
  if (opts.runtimeId === null) {
    log("内置引擎运行时未注册，跳过管理员 Bot 种子");
    return { seeded: false, reason: "no_runtime" };
  }

  const runtimeId = opts.runtimeId;
  const lookup: BotCreateLookup = {
    runtimeExists: (id) => id === runtimeId,
    runtimeRequiresWorktree: () => false,
    runtimeDisplayName: () => "内置引擎",
    providerExists: () => false,
  };

  const result = createBot(
    db,
    {
      name: ADMIN_BOT_NAME,
      persona:
        "你是这个 AgentBot 实例的管理员。你可以在用户确认后创建新的 Bot：" +
        "先问清名称、职责/人格、用哪个模型供应商与默认工作区，再调用 create_bot。" +
        "不要替用户臆测需求；创建完成后把 Bot 名称与 id 告诉用户。",
      runtimeId,
      role: "admin",
    },
    lookup,
  );

  if (!result.outcome.ok) {
    log(`管理员 Bot 种子失败：${result.outcome.fields.map((f) => f.message).join("；")}`);
    return { seeded: false, reason: "failed" };
  }

  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, '1')").run(
    ADMIN_SEED_MARKER,
  );
  log(`已创建管理员 Bot「${ADMIN_BOT_NAME}」（${result.outcome.botId}）`);
  return { seeded: true, botId: result.outcome.botId };
}
