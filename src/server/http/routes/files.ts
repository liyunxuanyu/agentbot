import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { relative } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { sessionCwdOf } from "../../core/process/supervisor.js";
import { resolveInside, toPosix } from "../../core/agent/tools/paths.js";

/**
 * 文件查看与改动 diff（2026-10-28 移动端反馈）。
 *
 *   GET /api/files?botId=&sessionId=&path=      → 文件内容（文本，≤512KB）
 *   GET /api/files/changes?botId=&sessionId=    → 工作区改动列表（git）
 *   GET /api/files/changes?botId=&sessionId=&path= → 单文件 unified diff
 *
 * 三条纪律：
 *   ① **只读**：本模块不写盘、不跑写命令；diff 只调 `git status` / `git diff`。
 *   ② **路径必须落在工作区内**：统一走 `resolveInside`（含符号链接逃逸检查），
 *      不接受任意绝对路径 —— 这个端点从公网隧道进来，不能变成任意文件读取器。
 *   ③ **不编数字**：不是 git 仓库时如实返回 `git:false`，前端显示「无法统计」。
 *
 * 工作区解析与权限层同源（`sessionCwdOf`）：内置引擎走会话/渠道/Bot 回退链，
 * 其它运行时优先 worktree —— 用户看到的 diff 就是运行时真正改动的那份文件。
 */

const MAX_FILE_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 5000;

interface Query {
  botId?: string;
  sessionId?: string;
  path?: string;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitRun {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? "git 执行失败"),
    };
  }
}

function workspaceOf(ctx: ServerContext, botId: string, sessionId: string | null): string | null {
  const bot = ctx.db
    .prepare("SELECT id FROM bots WHERE id = ?")
    .get(botId) as { id: string } | undefined;
  if (!bot) return null;
  if (sessionId) {
    const session = ctx.db
      .prepare("SELECT id FROM sessions WHERE id = ? AND bot_id = ?")
      .get(sessionId, botId) as { id: string } | undefined;
    if (!session) return null;
  }
  return sessionCwdOf(ctx.db, botId, sessionId);
}

/** 执行目录相对路径（git 给的是仓库相对，这里换算成用户看到的目录相对）。 */
function relOf(workspace: string, path: string): string {
  return toPosix(relative(workspace, path)) || ".";
}

function isBinary(text: string): boolean {
  return text.includes("\0");
}

interface ChangedFile {
  path: string;
  status: string;
  insertions: number | null;
  deletions: number | null;
  diff: string;
}

/**
 * 未跟踪文件：git diff 看不到，按「全文都是新增」合成一份 diff。
 *
 * 三个容易画错的细节（真机验证时都踩到了）：
 *   ① 文件以换行结尾时 `split("\n")` 会多出一个空串 —— 直接 `+` 上去就是一条
 *      凭空多出来的空新增行，增删计数也跟着多 1。去掉末尾那个空串。
 *   ② 必须带 `--- /dev/null` / `+++ b/<path>` 头：前端的 diff 行解析与用户对
 *      「这是新文件」的判断都依赖它；没有头会渲染成一大片无归属的加号。
 *   ③ 增删计数要一起回：git 的 `--numstat` 不统计未跟踪文件，前端只能显示
 *      「+null」。全文新增就是 ins = 行数、del = 0。
 */
function untrackedDiff(absPath: string, userPath: string): { diff: string; ins: number; del: number } {
  let text = "";
  try {
    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return { diff: "（文件过大，未生成 diff）", ins: 0, del: 0 };
    text = readFileSync(absPath, "utf8");
  } catch {
    return { diff: "（无法读取文件）", ins: 0, del: 0 };
  }
  if (isBinary(text)) return { diff: "（二进制文件，不生成 diff）", ins: 0, del: 0 };

  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const diff = `--- /dev/null\n+++ b/${toPosix(userPath)}\n${body}`;
  return { diff, ins: lines.length, del: 0 };
}

/**
 * 列出工作区改动。
 *
 * `only` 非空时**只为这一个文件**生成 diff：面板打开时只列路径与增删行数，
 * 点中某个文件才拉它的 diff。旧实现不管调用方要不要，对每个改动文件都跑一次
 * `git diff`（N 个文件 = N 个子进程），改动一多，手机上打开面板要等好几秒。
 */
function listChanges(
  workspace: string,
  only?: string | null,
): { git: boolean; message?: string; files: ChangedFile[] } {
  const inside = git(["rev-parse", "--is-inside-work-tree"], workspace);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { git: false, files: [], message: "工作区不是 git 仓库，无法统计改动" };
  }

  // pathspec `-- .` 必带：工作区落在某个大仓库的子目录时，不带它会扫整个仓库（实测 60s+）
  const status = git(["status", "--porcelain=v1", "-uall", "--", "."], workspace);
  if (!status.ok) {
    return { git: true, files: [], message: status.stderr.trim().slice(0, 300) || "git status 失败" };
  }

  const prefixOut = git(["rev-parse", "--show-prefix"], workspace);
  const prefix = prefixOut.ok ? prefixOut.stdout.trim() : "";

  const numstat = new Map<string, { ins: number | null; del: number | null }>();
  const diffStat = git(["diff", "--numstat", "HEAD", "--", "."], workspace);
  if (diffStat.ok) {
    for (const line of diffStat.stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [ins, del, path] = parts;
      if (path === undefined) continue;
      numstat.set(path, {
        ins: ins === "-" || ins === undefined ? null : Number.parseInt(ins, 10),
        del: del === "-" || del === undefined ? null : Number.parseInt(del, 10),
      });
    }
  }

  const files: ChangedFile[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const state = line.slice(0, 2);
    const rest = line.slice(3).trim();
    if (rest.length === 0) continue;
    const arrow = rest.indexOf(" -> ");
    const repoPath = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    const userPath = prefix.length > 0 && repoPath.startsWith(prefix)
      ? repoPath.slice(prefix.length)
      : repoPath;
    const untracked = state === "??";
    const userPathPosix = toPosix(userPath);
    // 只要 diff 的调用方只关心一个文件：其余文件跳过子进程
    const wanted = only === null || only === undefined || toPosix(only) === userPathPosix;

    let diff = "";
    let stat = numstat.get(repoPath);
    if (!wanted) {
      // 不生成 diff，但增删行数仍要给（列表视图显示 +N −M）
      files.push({
        path: userPathPosix,
        status: state.trim() || "?",
        insertions: stat?.ins ?? null,
        deletions: stat?.del ?? null,
        diff: "",
      });
      continue;
    }
    if (untracked) {
      const resolved = resolveInside(workspace, userPath);
      if (resolved.ok) {
        const synthesized = untrackedDiff(resolved.abs, userPath);
        diff = synthesized.diff;
        // numstat 不统计未跟踪文件：用合成结果补上增删行数（否则前端显示 +null）
        if (stat === undefined && diff.startsWith("--- /dev/null")) {
          stat = { ins: synthesized.ins, del: synthesized.del };
        }
      } else {
        diff = "（路径越界，已跳过）";
      }
    } else {
      const out = git(["diff", "--no-color", "HEAD", "--", repoPath], workspace);
      diff = out.ok ? out.stdout : out.stderr.slice(0, 4000);
    }

    files.push({
      path: userPathPosix,
      status: state.trim() || "?",
      insertions: stat?.ins ?? null,
      deletions: stat?.del ?? null,
      diff,
    });
  }
  return { git: true, files };
}

interface TreeEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
}

/** 递归列目录，带硬上限（防止把巨型仓库一次倒进前端）。 */
function listTree(root: string, rel: string): { entries: TreeEntry[]; truncated: boolean } {
  const resolved = resolveInside(root, rel.length > 0 ? rel : ".");
  if (!resolved.ok) return { entries: [], truncated: false };
  const out: TreeEntry[] = [];
  let truncated = false;
  const walk = (abs: string, relBase: string, depth: number): void => {
    if (out.length >= 500) {
      truncated = true;
      return;
    }
    if (depth > 8) {
      truncated = true;
      return;
    }
    let items;
    try {
      items = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= 500) {
        truncated = true;
        return;
      }
      // 不列版本库与依赖目录：它们不是用户要看的「工作区文件」
      if (item.name === ".git" || item.name === "node_modules" || item.name === ".agentbot") continue;
      const relPath = relBase.length > 0 ? `${relBase}/${item.name}` : item.name;
      const full = join(abs, item.name);
      if (item.isDirectory()) {
        out.push({ path: relPath, name: item.name, type: "dir", size: 0 });
        walk(full, relPath, depth + 1);
      } else if (item.isFile()) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          size = 0;
        }
        out.push({ path: relPath, name: item.name, type: "file", size });
      }
    }
  };
  walk(resolved.abs, resolved.relative === "." ? "" : resolved.relative, 0);
  return { entries: out, truncated };
}

export function registerFileRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: Query }>("/api/files", async (req, reply) => {
    const botId = typeof req.query.botId === "string" ? req.query.botId : "";
    const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId.length > 0
      ? req.query.sessionId
      : null;
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (botId.length === 0) return json(reply, 400, { error: "bot_id_required" });
    if (path.trim().length === 0) return json(reply, 400, { error: "path_required" });

    const workspace = workspaceOf(ctx, botId, sessionId);
    if (!workspace) return json(reply, 404, { error: "bot_or_session_not_found" });
    if (!existsSync(workspace)) {
      return json(reply, 409, { error: "workspace_missing", message: `工作区不存在：${workspace}` });
    }

    const resolved = resolveInside(workspace, path);
    if (!resolved.ok) return json(reply, 403, { error: "path_outside_workspace", message: resolved.error });

    let stat;
    try {
      stat = statSync(resolved.abs);
    } catch {
      return json(reply, 404, { error: "file_not_found", message: `文件不存在：${resolved.relative}` });
    }
    if (stat.isDirectory()) {
      return json(reply, 400, { error: "is_directory", message: "这是一个目录，请用 list_dir 查看" });
    }
    if (stat.size > MAX_FILE_BYTES) {
      return json(reply, 413, {
        error: "file_too_large",
        message: `文件 ${stat.size} 字节，超过 ${MAX_FILE_BYTES} 上限`,
      });
    }

    let text: string;
    try {
      text = readFileSync(resolved.abs, "utf8");
    } catch (err) {
      return json(reply, 500, {
        error: "read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (isBinary(text)) {
      return json(reply, 415, { error: "binary_file", message: "二进制文件，无法按文本查看" });
    }

    return {
      path: resolved.relative,
      workspace,
      size: stat.size,
      content: text,
      truncated: false,
    };
  });

  app.get<{ Querystring: Query }>("/api/files/tree", async (req, reply) => {
    const botId = typeof req.query.botId === "string" ? req.query.botId : "";
    const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId.length > 0
      ? req.query.sessionId
      : null;
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (botId.length === 0) return json(reply, 400, { error: "bot_id_required" });

    const workspace = workspaceOf(ctx, botId, sessionId);
    if (!workspace) return json(reply, 404, { error: "bot_or_session_not_found" });
    if (!existsSync(workspace)) {
      return json(reply, 409, { error: "workspace_missing", message: `工作区不存在：${workspace}` });
    }
    const tree = listTree(workspace, path);
    return { workspace, path: path || ".", ...tree };
  });

  app.get<{ Querystring: Query }>("/api/files/changes", async (req, reply) => {
    const botId = typeof req.query.botId === "string" ? req.query.botId : "";
    const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId.length > 0
      ? req.query.sessionId
      : null;
    const only = typeof req.query.path === "string" && req.query.path.length > 0 ? req.query.path : null;
    if (botId.length === 0) return json(reply, 400, { error: "bot_id_required" });

    const workspace = workspaceOf(ctx, botId, sessionId);
    if (!workspace) return json(reply, 404, { error: "bot_or_session_not_found" });
    if (!existsSync(workspace)) {
      return json(reply, 409, { error: "workspace_missing", message: `工作区不存在：${workspace}` });
    }

    // 单文件查询先校验路径，再只给它生成 diff（避免为列表里其它文件白跑 git）
    let onlyRel: string | null = null;
    if (only !== null) {
      const target = resolveInside(workspace, only);
      if (!target.ok) return json(reply, 403, { error: "path_outside_workspace", message: target.error });
      onlyRel = toPosix(target.relative);
    }

    const changes = listChanges(workspace, onlyRel);
    if (onlyRel !== null) {
      const hit = changes.files.find((f) => f.path === onlyRel);
      if (!hit) {
        return {
          git: changes.git,
          workspace,
          path: onlyRel,
          status: "unchanged",
          diff: "",
          insertions: null,
          deletions: null,
          ...(changes.message === undefined ? {} : { message: changes.message }),
        };
      }
      return {
        git: changes.git,
        workspace,
        path: hit.path,
        status: hit.status,
        diff: hit.diff,
        insertions: hit.insertions,
        deletions: hit.deletions,
      };
    }

    return {
      git: changes.git,
      workspace,
      files: changes.files.map((f) => ({
        path: f.path,
        status: f.status,
        insertions: f.insertions,
        deletions: f.deletions,
      })),
      ...(changes.message === undefined ? {} : { message: changes.message }),
    };
  });
}
