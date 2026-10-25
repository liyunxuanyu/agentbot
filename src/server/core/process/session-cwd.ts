import type { DB } from "../db/db.js";
import type { AdapterDeclaration } from "../../adapters/contract.js";
import { ensureWorktreeForBot } from "../assignment/worktree.js";
import { requiresWorktree } from "../permissions/worktree-guard.js";

/**
 * Session 启动时决定工作目录（架构 §5 + P0-13 + 用户裁定的安全底线）。
 *
 * 两条规则：
 *   ① 运行时没有权限请求通道（`permission.channel === 'none'`）→ **一定**跑在 worktree。
 *      这是兜底，不是建议：用户可能手动把执行位置改成 local（二次确认过），
 *      也可能是历史数据（升级前建的 Bot），这里都不相信配置，直接强制。
 *   ② worktree 未就绪（没填仓库、不是 git 仓库、`git worktree add` 失败）
 *      → 抛 `WorktreeNotReadyError`，由调用方阻止发送并回 409。
 *      **绝不静默降级到 local** —— 降级等于把「无法拦截的运行时」放回用户仓库。
 *
 * 为什么单独一个文件而不是塞进 supervisor：这段判定要被 HTTP 层（发送前的预检）
 * 与 Supervisor（真正 spawn 时）共用；放独立模块避免两处各写一遍。
 * 本文件**不 import supervisor**，避免循环依赖（supervisor 反过来 import 这里）。
 */

/** 明确的「worktree 未就绪」错误：HTTP 层映射 409 `worktree_not_ready`。 */
export class WorktreeNotReadyError extends Error {
  readonly code = "worktree_not_ready";
  constructor(
    message: string,
    /** 底层失败码（repo_missing / not_git_repo / create_failed），便于日志排查。 */
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "WorktreeNotReadyError";
  }
}

export interface ResolvedCwd {
  cwd: string;
  /** true 表示这次是因为「运行时无权限通道」而被强制切到 worktree。 */
  forcedWorktree: boolean;
}

interface BotExecRow {
  execution_location: string;
  repo_path: string | null;
  worktree_path: string | null;
}

/** 常规工作目录：worktree 优先，其次 repo，最后服务进程 cwd（与 supervisor 同规则）。 */
function configuredCwdOf(db: DB, botId: string): string {
  const bot = db
    .prepare("SELECT execution_location, repo_path, worktree_path FROM bots WHERE id = ?")
    .get(botId) as BotExecRow | undefined;
  if (bot) {
    const preferred = bot.execution_location === "worktree" ? bot.worktree_path : bot.repo_path;
    if (preferred && preferred.length > 0) return preferred;
  }
  return process.cwd();
}

/**
 * 解析本次 Session 的工作目录。
 *
 * - 无权限通道的运行时：强制 worktree（Bot 配的是 local 也强制）；
 * - 其它运行时：沿用既有规则（worktree 优先，其次 repo，最后服务 cwd）。
 */
export function resolveSessionCwd(
  db: DB,
  botId: string,
  declaration: AdapterDeclaration,
): ResolvedCwd {
  if (!requiresWorktree(declaration)) {
    return { cwd: configuredCwdOf(db, botId), forcedWorktree: false };
  }

  const row = db
    .prepare("SELECT execution_location FROM bots WHERE id = ?")
    .get(botId) as { execution_location: string } | undefined;
  if (!row) {
    throw new WorktreeNotReadyError(`Bot 不存在：${botId}`, "bot_missing");
  }

  // force：即使 execution_location 是 local 也建/复用 worktree（安全兜底）
  const result = ensureWorktreeForBot(db, botId, { force: true });
  if (!result.ok || !result.path) {
    throw new WorktreeNotReadyError(
      `该运行时（${declaration.displayName}）不提供权限请求，必须使用 worktree，但 worktree 未就绪：${
        result.message ?? "未知原因"
      }`,
      result.code ?? null,
    );
  }
  return { cwd: result.path, forcedWorktree: row.execution_location !== "worktree" };
}
