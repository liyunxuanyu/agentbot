import type { DB } from "../db/db.js";
import { createBot, type BotCreateLookup } from "./create.js";

/**
 * 管理员 Bot 种子（R6 / Q16）。
 *
 * 触发条件：
 *   ① 还没有 `role='admin'` 的 Bot —— 用户已有普通 Bot 也照样补一个管理员；
 *   ② 至少配置了一个模型供应商 —— 没有供应商时管理员也聊不起来，种了只会误导。
 *
 * 同名冲突：已存在一个叫「管理员」的内置引擎 Bot 时**提升它的角色**而不是再造一个
 * （UNIQUE(name) 会撞，且用户的意图本来就是「要一个管理员」）。
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
  reason?: "already_seeded" | "has_admin" | "no_provider" | "no_runtime" | "failed";
}

export function seedAdminBot(db: DB, opts: SeedAdminBotOptions): SeedAdminBotResult {
  const log = opts.log ?? ((msg: string) => console.log(`[agentbot] ${msg}`));

  const marker = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(ADMIN_SEED_MARKER) as { value: string } | undefined;
  if (marker) return { seeded: false, reason: "already_seeded" };

  const existingAdmin = db.prepare("SELECT id FROM bots WHERE role = 'admin' LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (existingAdmin) return { seeded: false, reason: "has_admin" };

  if (!opts.hasProviders) {
    log("未配置模型供应商，跳过管理员 Bot 种子（配置后重启会再尝试）");
    return { seeded: false, reason: "no_provider" };
  }
  if (opts.runtimeId === null) {
    log("内置引擎运行时未注册，跳过管理员 Bot 种子");
    return { seeded: false, reason: "no_runtime" };
  }

  // 同名 Bot 已存在且就是内置引擎：提升角色，不再新建（UNIQUE(name) 也不允许重名）。
  const sameName = db
    .prepare("SELECT id, default_runtime_id FROM bots WHERE name = ?")
    .get(ADMIN_BOT_NAME) as { id: string; default_runtime_id: string | null } | undefined;
  if (sameName && sameName.default_runtime_id === opts.runtimeId) {
    db.prepare("UPDATE bots SET role = 'admin', updated_at = ? WHERE id = ?").run(
      Date.now(),
      sameName.id,
    );
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, '1')").run(
      ADMIN_SEED_MARKER,
    );
    log(`已把同名 Bot「${ADMIN_BOT_NAME}」提升为管理员（${sameName.id}）`);
    return { seeded: true, botId: sameName.id };
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
      name: sameName ? `${ADMIN_BOT_NAME}（内置）` : ADMIN_BOT_NAME,
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
