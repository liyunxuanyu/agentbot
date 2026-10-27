import type { DB } from "../db/db.js";
import type { AdapterDeclaration } from "../../adapters/contract.js";
import { ensureWorktreeForBot, validateWorkingDir } from "../assignment/worktree.js";
import { requiresWorktree } from "../permissions/worktree-guard.js";

/**
 * Session 启动时决定工作目录（架构 §5 + P0-13 + 用户裁定的安全底线 + R2）。
 *
 * 两条规则：
 *   ① 运行时没有权限请求通道（`permission.channel === 'none'`）→ **一定**跑在 worktree。
 *      这是兜底，不是建议：用户可能手动把执行位置改成 local（二次确认过），
 *      也可能是历史数据（升级前建的 Bot），这里都不相信配置，直接强制。
 *   ② worktree 未就绪（没填仓库、不是 git 仓库、`git worktree add` 失败）
 *      → 抛 `WorktreeNotReadyError`，由调用方阻止发送并回 409。
 *      **绝不静默降级到 local** —— 降级等于把「无法拦截的运行时」放回用户仓库。
 *
 * 内置引擎（protocol=builtin）没有 worktree：工作区按会话级回退链解析
 *   `sessions.workspace_path → channels.workspace_path → bots.repo_path → process.cwd()`
 * 其它运行时保持既有规则（worktree 优先，其次 Bot 的 repo_path，最后服务 cwd）。
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

/** 工作区回退链的命中位置。 */
export type WorkspaceSource = "session" | "channel" | "bot" | "process";

export interface WorkspaceResolution {
  path: string;
  source: WorkspaceSource;
}

export interface ResolvedCwd {
  cwd: string;
  /** true 表示这次是因为「运行时无权限通道」而被强制切到 worktree。 */
  forcedWorktree: boolean;
  /** 实际工作区（内置引擎的 cwd 就是它；其它通道用于展示与相对路径解析）。 */
  workspacePath: string;
  /** 工作区来源：排查「为什么跑在这里」时用。 */
  workspaceSource: WorkspaceSource;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 会话工作区回退链（R2 / G10）。
 *
 * 群聊里所有 Bot 共用 `channels.workspace_path`；DM 的渠道工作区就是该会话工作区。
 * 不要求目录此刻存在（历史会话可能指向已删除目录），存在性由发送前校验负责。
 */
export function resolveWorkspace(
  db: DB,
  input: { botId: string; sessionId?: string | null; channelId?: string | null },
): WorkspaceResolution {
  let sessionWs: string | null = null;
  let channelId = input.channelId ?? null;

  if (input.sessionId) {
    const row = db
      .prepare("SELECT workspace_path, channel_id FROM sessions WHERE id = ?")
      .get(input.sessionId) as
      | { workspace_path: string | null; channel_id: string | null }
      | undefined;
    sessionWs = nonEmpty(row?.workspace_path);
    channelId = channelId ?? row?.channel_id ?? null;
  }

  let channelWs: string | null = null;
  if (channelId) {
    const row = db.prepare("SELECT workspace_path FROM channels WHERE id = ?").get(channelId) as
      | { workspace_path: string | null }
      | undefined;
    channelWs = nonEmpty(row?.workspace_path);
  }

  const bot = db.prepare("SELECT repo_path FROM bots WHERE id = ?").get(input.botId) as
    | { repo_path: string | null }
    | undefined;
  const botWs = nonEmpty(bot?.repo_path);

  if (sessionWs) return { path: sessionWs, source: "session" };
  if (channelWs) return { path: channelWs, source: "channel" };
  if (botWs) return { path: botWs, source: "bot" };
  return { path: process.cwd(), source: "process" };
}

/**
 * 校验用户显式设置的工作区（R2 / G8）：必须存在、是目录、可写，**不要求 git**。
 * 返回归一化后的真实路径；失败时给出可直接展示的中文原因。
 */
export function validateWorkspacePath(input: string): {
  ok: boolean;
  path?: string;
  code?: string;
  message?: string;
} {
  const result = validateWorkingDir(input);
  return result.ok
    ? { ok: true, path: result.dir ?? input.trim() }
    : { ok: false, code: result.code, message: result.message };
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
 * - 内置引擎：会话级工作区回退链（R2）；
 * - 其它运行时：沿用既有规则（worktree 优先，其次 repo，最后服务 cwd）。
 */
export function resolveSessionCwd(
  db: DB,
  botId: string,
  declaration: AdapterDeclaration,
  scope: { sessionId?: string | null; channelId?: string | null } = {},
): ResolvedCwd {
  if (!requiresWorktree(declaration)) {
    if (declaration.protocol === "builtin") {
      const workspace = resolveWorkspace(db, {
        botId,
        sessionId: scope.sessionId ?? null,
        channelId: scope.channelId ?? null,
      });
      return {
        cwd: workspace.path,
        forcedWorktree: false,
        workspacePath: workspace.path,
        workspaceSource: workspace.source,
      };
    }
    const cwd = configuredCwdOf(db, botId);
    return { cwd, forcedWorktree: false, workspacePath: cwd, workspaceSource: "bot" };
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
  return {
    cwd: result.path,
    forcedWorktree: row.execution_location !== "worktree",
    workspacePath: result.path,
    workspaceSource: "bot",
  };
}
