import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { config } from "../../config.js";
import type { DB } from "../db/db.js";

/**
 * 执行位置：local / git worktree（P0-13）。
 *
 * 三条纪律：
 *   ① **保存时只校验，不承诺**：仓库不是 git → 保存失败（400）；创建失败（磁盘满/权限）
 *      → Bot 照常保存，但标 `worktree_state='failed'`，发送时被阻止并可重试。
 *   ② **同一 Bot 复用同一 worktree**：路径由 botId 决定（不是随机），后续 Session 直接复用。
 *      两个 Bot 指向同一仓库 → 各自独立路径，互不干扰。
 *   ③ **永不自动删除用户文件**：本文件只创建，不删除。清理提示归设置页（架构 §5）。
 *
 * 为什么放在 core/assignment 而不是 process/：worktree 是「执行位置」这一产品概念，
 * 由 Bot 配置驱动；Supervisor 只认 `bots.worktree_path` 这一列（`sessionCwdOf`）。
 * 本文件是唯一写那一列的地方。
 *
 * git 调用一律 `execFileSync` + 参数数组（不经 shell，架构 §8 的命令注入防线），
 * 并带超时——git 在坏仓库上卡住不能拖死 HTTP 请求。
 */

/** git 执行结果（不抛错，失败也是数据）。 */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 可注入的 git 执行器：单测用假实现验证「非 git 仓库」「创建失败」分支。 */
export type GitRunner = (args: string[], cwd: string) => GitRunResult;

const GIT_TIMEOUT_MS = 15_000;

export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" && e.stderr.length > 0
          ? e.stderr
          : typeof e.message === "string"
            ? e.message
            : "git 执行失败",
      code: typeof e.status === "number" ? e.status : null,
    };
  }
};

export type WorktreeFailureCode =
  | "not_configured"
  | "repo_missing"
  | "not_git_repo"
  | "create_failed";

export interface WorktreeResult {
  ok: boolean;
  /** 实际生效的目录；失败时为 null。 */
  path: string | null;
  /** true 表示本次真的执行了 `git worktree add`。 */
  created: boolean;
  /** 复用已有 worktree。 */
  reused?: boolean;
  code?: WorktreeFailureCode;
  message?: string;
}

export type RepoValidationCode =
  | "not_absolute"
  | "not_found"
  | "not_directory"
  | "not_git_repo"
  | "not_repo_root"
  | "git_unavailable";

export interface RepoValidation {
  ok: boolean;
  /** 归一化后的仓库根（git 报告的 toplevel）。 */
  repoRoot?: string;
  code?: RepoValidationCode;
  message?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** realpath 归一化（Windows 短名 8.3 与符号链接都会让字符串比较失败）。 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function samePath(a: string, b: string): boolean {
  const left = canonical(a);
  const right = canonical(b);
  // Windows 大小写不敏感；POSIX 敏感（用平台判断而不是无脑 toLowerCase）
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 校验「仓库根路径」（P0-13 边界「路径非 git 仓库：保存失败并提示」）。
 *
 * 两道检查：
 *   ① `git rev-parse --show-toplevel` 成功 → 是 git 仓库（否则 not_git_repo）。
 *   ② 该 toplevel 必须**就是**用户填的目录（否则 not_repo_root，并把真实根返回给前端）。
 *
 * 为什么要求是根而不是「仓库内任意目录」：字段语义就是「仓库根路径」，
 * 而且 `git worktree add` 必须从根发起。更重要的是 —— 一个临时目录可能恰好落在
 * 某个父级仓库里（实测：用户家目录本身是 git 仓库时，任意子目录都会「校验通过」），
 * 只判 ① 会把这种情况误判为合法。
 */
export function validateRepoPath(
  repoPath: string,
  run: GitRunner = defaultGitRunner,
): RepoValidation {
  const trimmed = repoPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "not_found", message: "仓库根路径不能为空" };
  }
  if (!isAbsolute(trimmed)) {
    return { ok: false, code: "not_absolute", message: "请填绝对路径" };
  }
  if (!existsSync(trimmed)) {
    return { ok: false, code: "not_found", message: "目录不存在" };
  }
  if (!isDirectory(trimmed)) {
    return { ok: false, code: "not_directory", message: "不是目录" };
  }
  const top = run(["rev-parse", "--show-toplevel"], trimmed);
  if (!top.ok) {
    const detail = top.stderr.trim().split(/\r?\n/)[0] ?? "";
    // git 不存在（ENOENT）与「不是 git 仓库」必须区分：前者是环境问题，不该怪用户
    if (/ENOENT|not recognized|不是内部或外部命令/i.test(detail)) {
      return { ok: false, code: "git_unavailable", message: "本机找不到 git 命令" };
    }
    return { ok: false, code: "not_git_repo", message: "不是 git 仓库" };
  }
  const root = (top.stdout.trim().split(/\r?\n/)[0] ?? "").trim();
  if (root.length === 0) {
    return { ok: false, code: "not_git_repo", message: "不是 git 仓库" };
  }
  if (!samePath(root, trimmed)) {
    return {
      ok: false,
      code: "not_repo_root",
      repoRoot: root,
      message: `请填仓库根路径（该目录属于仓库 ${root}）`,
    };
  }
  return { ok: true, repoRoot: root };
}

/** Bot 的 worktree 路径：由 botId 决定，保证「同一 Bot 复用、不同 Bot 互不干扰」。 */
export function worktreePathFor(botId: string, botName: string, root = config.worktreeRoot): string {
  const slug = botName
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  // botId 末 8 位做后缀：名字相同也不会撞路径
  const suffix = botId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "bot";
  return join(root, `${slug.length > 0 ? slug : "bot"}-${suffix}`);
}

interface BotPathRow {
  name: string;
  execution_location: string;
  repo_path: string | null;
  worktree_path: string | null;
}

function setWorktreeState(
  db: DB,
  botId: string,
  state: "ready" | "missing" | "failed",
  path: string | null,
): void {
  try {
    db.prepare("UPDATE bots SET worktree_path = ?, worktree_state = ?, updated_at = ? WHERE id = ?").run(
      path,
      state,
      Date.now(),
      botId,
    );
  } catch {
    // 库已关闭（关服/测试收尾）：状态没写成不影响本次执行
  }
}

/**
 * 确保该 Bot 的 worktree 就绪（首个 Session 前调用；保存配置时也会调一次）。
 *
 * 返回 `ok:false` 时调用方必须阻止发送（P0-13「发送时阻止并给重试」），
 * 并把 `code` 映射成用户能看懂的提示。
 */
export function ensureWorktreeForBot(
  db: DB,
  botId: string,
  opts: { run?: GitRunner; root?: string; force?: boolean } = {},
): WorktreeResult {
  const run = opts.run ?? defaultGitRunner;
  const bot = db
    .prepare("SELECT name, execution_location, repo_path, worktree_path FROM bots WHERE id = ?")
    .get(botId) as BotPathRow | undefined;
  if (!bot) return { ok: false, path: null, created: false, code: "not_configured", message: "Bot 不存在" };

  // local：不需要 worktree，直接用仓库目录（或服务 cwd，由 sessionCwdOf 兜底）。
  // `force` 是安全兜底专用（运行时没有权限通道时）：即使 Bot 配了 local，
  // 也照常建/复用 worktree。它**不改** bots 表的 execution_location，
  // 只保证返回一个可写的隔离目录。
  if (bot.execution_location !== "worktree" && opts.force !== true) {
    return { ok: true, path: bot.repo_path, created: false };
  }

  if (!bot.repo_path || bot.repo_path.trim().length === 0) {
    setWorktreeState(db, botId, "failed", null);
    return {
      ok: false,
      path: null,
      created: false,
      code: "repo_missing",
      message: "执行位置是 worktree，但没有填仓库根路径",
    };
  }

  // 已有且目录还在 → 复用（同一 Bot 后续 Session 复用同一 worktree）
  if (bot.worktree_path && isDirectory(bot.worktree_path)) {
    setWorktreeState(db, botId, "ready", bot.worktree_path);
    return { ok: true, path: bot.worktree_path, created: false, reused: true };
  }

  const validation = validateRepoPath(bot.repo_path, run);
  if (!validation.ok) {
    setWorktreeState(db, botId, "failed", null);
    return {
      ok: false,
      path: null,
      created: false,
      code: validation.code === "not_git_repo" ? "not_git_repo" : "repo_missing",
      message: validation.message ?? "仓库路径不可用",
    };
  }

  const repoRoot = validation.repoRoot ?? bot.repo_path;
  const target = worktreePathFor(botId, bot.name, opts.root ?? config.worktreeRoot);

  try {
    mkdirSync(opts.root ?? config.worktreeRoot, { recursive: true });
  } catch (err) {
    setWorktreeState(db, botId, "failed", null);
    return {
      ok: false,
      path: null,
      created: false,
      code: "create_failed",
      message: `无法创建 worktree 根目录：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 上次失败的残留目录可能让 `worktree add` 报 already exists：先 prune 再试
  run(["worktree", "prune"], repoRoot);

  const add = run(["worktree", "add", target, "--detach"], repoRoot);
  if (!add.ok) {
    // 「目录还在但 bots.worktree_path 被清空了」的恢复路径。
    //
    // 真实场景（M12 实测）：Bot 曾配成 local（清空 worktree_path），随后运行时
    // 被换成无权限通道的，安全兜底又要求 worktree —— 此时磁盘上的旧 worktree
    // 目录完好，但 `git worktree add` 只认「路径已存在」，于是永久失败。
    // 这里**只在确认它就是本仓库的 worktree**时复用它；绝不删除用户目录。
    const recovered = adoptExistingWorktree(target, repoRoot, run);
    if (recovered) {
      setWorktreeState(db, botId, "ready", target);
      return { ok: true, path: target, created: false, reused: true };
    }
    setWorktreeState(db, botId, "failed", null);
    const detail = (add.stderr || add.stdout).trim().split(/\r?\n/).slice(-2).join(" ").trim();
    return {
      ok: false,
      path: null,
      created: false,
      code: "create_failed",
      message: detail.length > 0 ? detail : "git worktree add 失败",
    };
  }

  setWorktreeState(db, botId, "ready", target);
  return { ok: true, path: target, created: true };
}

/**
 * 判断 `target` 是不是 `repoRoot` 的 worktree，是则认领它。
 *
 * 判据：目录存在，且 `git -C target rev-parse --git-common-dir` 指向的仓库
 * 与 `repoRoot` 的 `.git` 是同一个（worktree 的 .git 文件指回主仓库）。
 * 只读检查，不做任何删除或写入 —— 误判的代价是「不复用」，不是「删错东西」。
 */
function adoptExistingWorktree(target: string, repoRoot: string, run: GitRunner): boolean {
  if (!isDirectory(target)) return false;
  const common = run(["rev-parse", "--git-common-dir"], target);
  if (!common.ok) return false;
  const theirs = common.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (theirs.length === 0) return false;

  const ours = run(["rev-parse", "--git-common-dir"], repoRoot);
  if (!ours.ok) return false;
  const mine = ours.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (mine.length === 0) return false;

  // git 可能给相对路径（`.git`）或绝对路径；统一按各自 cwd 解析后比较
  const theirsAbs = isAbsolute(theirs) ? theirs : resolve(target, theirs);
  const mineAbs = isAbsolute(mine) ? mine : resolve(repoRoot, mine);
  return samePath(theirsAbs, mineAbs);
}

/** 读取 Bot 的执行位置配置（PATCH 校验后回显用）。 */
export function readExecutionConfig(
  db: DB,
  botId: string,
): { executionLocation: "local" | "worktree"; repoPath: string | null; worktreePath: string | null; worktreeState: string | null } | null {
  const row = db
    .prepare("SELECT execution_location, repo_path, worktree_path, worktree_state FROM bots WHERE id = ?")
    .get(botId) as
    | { execution_location: string; repo_path: string | null; worktree_path: string | null; worktree_state: string | null }
    | undefined;
  if (!row) return null;
  return {
    executionLocation: row.execution_location === "worktree" ? "worktree" : "local",
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    worktreeState: row.worktree_state,
  };
}

// ---------------------------------------------------------------------------
// 改动文件统计（报告用）
// ---------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  /** null 表示无法统计（未跟踪文件 / 非 git）。 */
  insertions: number | null;
  deletions: number | null;
  /** porcelain 的两位状态码，例如 ` M` / `A ` / `??`。 */
  status: string;
}

export interface ChangedFilesResult {
  git: boolean;
  files: ChangedFile[];
  message?: string;
}

/** 解析 `git status --porcelain` 的一行；重命名取新路径。 */
function parsePorcelain(line: string): { status: string; path: string } | null {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  const rest = line.slice(3).trim();
  if (rest.length === 0) return null;
  const arrow = rest.indexOf(" -> ");
  const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  return { status, path };
}

/**
 * 列出工作区改动（带 +/- 行数）。
 *
 * 数据来源两段：
 *   - `git status --porcelain` 决定「有哪些文件、什么状态」（含未跟踪）；
 *   - `git diff --numstat HEAD` 决定增删行数（未跟踪文件不在 diff 里 → 记 null）。
 * 非 git 目录如实返回 `git:false`，报告里写「无法统计」，不编数字。
 *
 * **必须限定 pathspec `-- .`**：执行目录若是某个巨大仓库的子目录（实测：临时目录
 * 落在用户家目录、而家目录本身是个 git 仓库），不带 pathspec 的 `git status`
 * 会扫整个仓库，一次 60s+，把任务收口卡死。加上之后只扫本目录。
 *
 * 返回的路径统一换算成**相对执行目录**：git 给的是仓库相对路径，
 * 用 `--show-prefix` 剥掉前缀，报告里看到的才是用户实际关心的文件。
 */
export function listChangedFiles(cwd: string, run: GitRunner = defaultGitRunner): ChangedFilesResult {
  if (!cwd || !isDirectory(cwd)) {
    return { git: false, files: [], message: "执行目录不存在" };
  }
  const inside = run(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { git: false, files: [], message: "不是 git 目录，无法统计改动文件" };
  }

  // 仓库相对 → 执行目录相对（在仓库根时 prefix 为空串，路径原样）
  const prefixOut = run(["rev-parse", "--show-prefix"], cwd);
  const prefix = prefixOut.ok ? prefixOut.stdout.trim() : "";
  const relOf = (path: string): string => {
    if (prefix.length === 0) return path;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };

  const status = run(["status", "--porcelain=v1", "-uall", "--", "."], cwd);
  if (!status.ok) {
    return { git: false, files: [], message: status.stderr.trim().slice(0, 300) || "git status 失败" };
  }

  const numstat = new Map<string, { ins: number | null; del: number | null }>();
  const diff = run(["diff", "--numstat", "HEAD", "--", "."], cwd);
  if (diff.ok) {
    for (const line of diff.stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const ins = parts[0];
      const del = parts[1];
      const path = parts[2];
      if (path === undefined) continue;
      numstat.set(path, {
        ins: ins === "-" || ins === undefined ? null : Number.parseInt(ins, 10),
        del: del === "-" || del === undefined ? null : Number.parseInt(del, 10),
      });
    }
  }

  const files: ChangedFile[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    const parsed = parsePorcelain(line);
    if (!parsed) continue;
    const stat = numstat.get(parsed.path);
    files.push({
      path: relOf(parsed.path),
      insertions: stat?.ins ?? null,
      deletions: stat?.del ?? null,
      status: parsed.status,
    });
  }
  return { git: true, files };
}

/**
 * 校验「工作目录」——**不要求是 git 仓库**。
 *
 * 为什么需要它：`local` 执行位置的 cwd 来自 `bots.repo_path`，而 worktree 的校验
 * 要求「git 仓库根」。内置引擎这类**有权限通道**的运行时允许 local，用户想让它
 * 在自己项目的任意目录里干活，那个目录完全可能不是 git 仓库（比如刚建的脚手架）。
 *
 * 与 `validateRepoPath` 的分工：这个只管「是个能用的目录」，不管版本控制；
 * 需要隔离与 diff 的场景仍走 worktree。
 */
export function validateWorkingDir(input: string): {
  ok: boolean;
  dir?: string;
  code?: "not_absolute" | "not_found" | "not_directory";
  message?: string;
} {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, code: "not_found", message: "工作目录不能为空" };
  if (!isAbsolute(trimmed)) return { ok: false, code: "not_absolute", message: "请填绝对路径" };
  if (!existsSync(trimmed)) return { ok: false, code: "not_found", message: "目录不存在" };
  let stat;
  try {
    stat = statSync(trimmed);
  } catch {
    return { ok: false, code: "not_found", message: "目录无法访问" };
  }
  if (!stat.isDirectory()) return { ok: false, code: "not_directory", message: "不是目录" };
  // 归一化到真实路径：符号链接与大小写差异会让「同一目录」看起来不同
  let real = trimmed;
  try {
    real = realpathSync(trimmed);
  } catch {
    /* 保留原值 */
  }
  return { ok: true, dir: real };
}
