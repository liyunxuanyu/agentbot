import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import type { DB } from "../db/db.js";
import type { BoundaryVerdict, PermissionAction } from "../../../shared/events.js";

/**
 * Bot 级边界判定（P0-09，架构 §6 ①②）。
 *
 * **默认全关**：只读放行、写需批准、shell 与联网一律拒绝。
 * 这是产品最重要的一条安全默认值 —— 用户不配置时，Bot 只能读、不能写、不能跑命令。
 *
 * 判定不涉及「谁在问」：边界是 Bot 的属性，与 Turn / 用户无关。
 * 授权命中（记住 / preauth）与超时策略都不在这里，属于 `resolver.ts` / `policy.ts`。
 *
 * 路径解析按架构 §6 的六步走：
 *   ① `resolve(sessionCwd, raw)`；结果非绝对路径 → 拒绝
 *   ② 逐段向上找最近存在的祖先，`realpathSync.native()` 解符号链接，再拼回未存在段
 *   ③ Windows：剥 `\\?\` 前缀、拒绝盘符相对路径（`C:foo`）与 UNC，比较前 toLowerCase
 *   ④ `isInside(root, t)`：`t === root || t.startsWith(root + sep)`
 *   ⑤ 允许目录在保存时也做 realpath 归一化（`normalizeAllowedDirs`）
 *   ⑥ shell **不做命令解析**：只有 `allowShell` 布尔（board 05-pm-answer 明确同意）
 */

export type { BoundaryVerdict };

/** 边界快照：判定时冻结，后续修改不影响进行中的请求（P0-09 边界处理）。 */
export interface BoundarySnapshot {
  /** 归一化后的绝对路径列表。 */
  allowDirs: string[];
  allowShell: boolean;
  allowNetwork: boolean;
  autoApproveWrite: boolean;
  /** 快照版本：`bots.updated_at`。进行中请求记录它，审计可回溯。 */
  version: number;
}

export interface BoundaryCheck {
  verdict: BoundaryVerdict;
  /** 归一化后的目标（绝对路径 / 命令原文 / 主机名）。 */
  target: string;
  /** 拒绝或待定的原因，直接给审计与卡片用（中文，面向用户）。 */
  reason?: string;
  /** 命中的允许目录（`allowed` 且有目录命中时）。 */
  matchedDir?: string;
}

export interface BotBoundaryRow {
  id: string;
  allow_dirs: string;
  allow_shell: number;
  allow_network: number;
  auto_approve_write: number;
  updated_at: number;
}

const WIN = process.platform === "win32";

/** 读 Bot 边界；Bot 不存在返回 null。 */
export function readBoundary(db: DB, botId: string): BoundarySnapshot | null {
  const row = db
    .prepare(
      `SELECT id, allow_dirs, allow_shell, allow_network, auto_approve_write, updated_at
         FROM bots WHERE id = ?`,
    )
    .get(botId) as BotBoundaryRow | undefined;
  if (!row) return null;
  return {
    allowDirs: parseDirs(row.allow_dirs),
    allowShell: row.allow_shell === 1,
    allowNetwork: row.allow_network === 1,
    autoApproveWrite: row.auto_approve_write === 1,
    version: row.updated_at,
  };
}

function parseDirs(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** Windows 上统一小写 + 去掉扩展长度前缀，避免同一路径两种写法比不相等。 */
function canonical(p: string): string {
  let out = p;
  if (out.startsWith("\\\\?\\")) out = out.slice(4);
  if (out.startsWith("\\\\?\\UNC\\")) out = `\\\\${out.slice(8)}`;
  // 去掉尾部分隔符（根目录除外）
  if (out.length > 1 && (out.endsWith("\\") || out.endsWith("/"))) {
    out = out.replace(/[\\/]+$/, "");
  }
  return WIN ? out.toLowerCase() : out;
}

function isAbsolutePath(p: string): boolean {
  if (!isAbsolute(p)) return false;
  if (!WIN) return true;
  // `C:foo` 是「C 盘当前目录」，不是绝对路径 —— isAbsolute 在 Windows 上会认它
  if (/^[a-zA-Z]:(?![\\/])/.test(p)) return false;
  // 拒绝 UNC（\\server\share）：远程路径不受本地目录边界保护
  if (p.startsWith("\\\\") && !p.startsWith("\\\\?\\")) return false;
  return true;
}

/**
 * 解析到「最近存在祖先的真实路径 + 未存在段」。
 *
 * 为什么必须这样做：`allowDirs` 与目标都可能是符号链接（Windows 上还有 junction）。
 * 直接比字符串会让 `C:\link\to\etc` 绕过 `C:\link` 的允许，或者反过来误拒。
 */
export function resolveRealish(raw: string): string {
  const abs = resolve(raw);
  const segments: string[] = [];
  let cur = abs;
  for (;;) {
    if (existsSync(cur)) {
      let real: string;
      try {
        real = realpathSync.native(cur);
      } catch {
        // 无权访问 / 已被删：退回原路径，后续比较仍会失败 → 保守拒绝
        real = cur;
      }
      return segments.length === 0 ? real : resolve(real, ...segments.reverse());
    }
    const parent = dirname(cur);
    if (parent === cur) return abs; // 到达根仍不存在（盘符不存在）
    segments.push(parse(cur).base);
    cur = parent;
  }
}

/** `t` 是否在 `root` 之内（含相等）。两侧都应已 canonical 化。 */
export function isInside(root: string, t: string): boolean {
  if (t === root) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return t.startsWith(withSep);
}

/**
 * 把用户输入的允许目录归一化（保存时用，P0-09 边界处理「目录不存在或不可写：保存时内联报错」）。
 *
 * 返回 `ok:false` 时带字段级错误码，路由层直接转 400 + 内联文案。
 */
export type NormalizeDirResult =
  | { ok: true; dir: string }
  | { ok: false; code: "not_absolute" | "not_found" | "not_directory" | "not_writable"; message: string };

export function normalizeAllowedDir(input: string): NormalizeDirResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "not_absolute", message: "路径不能为空" };
  }
  if (!isAbsolutePath(trimmed)) {
    return {
      ok: false,
      code: "not_absolute",
      message: WIN
        ? "必须是绝对路径（如 D:\\work\\project），不接受相对路径与 UNC 网络路径"
        : "必须是绝对路径（如 /home/me/project）",
    };
  }
  const resolved = resolveRealish(trimmed);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    return { ok: false, code: "not_found", message: `目录不存在：${resolved}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, code: "not_directory", message: `不是目录：${resolved}` };
  }
  try {
    // 写权限探测：不真写文件，用 accessSync（Windows 上对目录语义稍弱，但能挡住只读盘）
    accessSync(resolved, constants.W_OK);
  } catch {
    return { ok: false, code: "not_writable", message: `目录不可写：${resolved}` };
  }
  return { ok: true, dir: resolved };
}

/**
 * 归一化整个允许目录列表。任一条失败就整体失败（保存时一次性报清）。
 */
export function normalizeAllowedDirs(inputs: readonly string[]): {
  ok: boolean;
  dirs: string[];
  errors: { index: number; value: string; code: string; message: string }[];
} {
  const dirs: string[] = [];
  const errors: { index: number; value: string; code: string; message: string }[] = [];
  inputs.forEach((value, index) => {
    const res = normalizeAllowedDir(value);
    if (res.ok) dirs.push(res.dir);
    else errors.push({ index, value, code: res.code, message: res.message });
  });
  return { ok: errors.length === 0, dirs, errors };
}

/**
 * 单个动作的边界判定（不含授权命中与超时）。
 *
 * `sessionCwd` 是相对路径的解析基准（Bot 的 repoPath / worktreePath）。
 */
export function checkBoundary(
  snapshot: BoundarySnapshot,
  action: PermissionAction,
  rawTarget: string,
  sessionCwd: string,
): BoundaryCheck {
  switch (action) {
    case "exec": {
      if (snapshot.allowShell) {
        // shell 不做命令解析（不可靠且会被绕过）：完整命令交给人看卡片判断
        return { verdict: "allowed", target: rawTarget, reason: "Bot 允许执行命令" };
      }
      return {
        verdict: "denied",
        target: rawTarget,
        reason: "该 Bot 未开启 shell 执行",
      };
    }

    case "network": {
      if (snapshot.allowNetwork) {
        return { verdict: "allowed", target: rawTarget, reason: "Bot 允许联网" };
      }
      return { verdict: "denied", target: rawTarget, reason: "该 Bot 未开启联网" };
    }

    case "read":
    case "write": {
      if (rawTarget.trim().length === 0) {
        // 没有目标路径：写操作无法判定，保守拒绝；读操作按「只读默认放行」也不放
        return {
          verdict: "denied",
          target: "",
          reason: "请求没有给出目标路径，无法判定边界",
        };
      }
      const abs = isAbsolutePath(rawTarget) ? rawTarget : resolve(sessionCwd, rawTarget);
      if (!isAbsolutePath(abs)) {
        // P0-09：无法解析为绝对路径即拒绝
        return {
          verdict: "denied",
          target: rawTarget,
          reason: "目标不是绝对路径，无法解析",
        };
      }
      const resolved = resolveRealish(abs);
      const targetCanon = canonical(resolved);
      const dirs = snapshot.allowDirs.map((d) => canonical(resolveRealish(d)));
      const matched = dirs.find((d) => isInside(d, targetCanon));

      if (action === "read") {
        // 默认只读：不要求目录白名单（读不改变磁盘），但给了白名单就只认白名单
        if (dirs.length === 0 || matched !== undefined) {
          return {
            verdict: "allowed",
            target: resolved,
            ...(matched === undefined ? {} : { matchedDir: matched }),
          };
        }
        return {
          verdict: "denied",
          target: resolved,
          reason: "目标不在 Bot 的允许目录内",
        };
      }

      // write：必须在允许目录内；不在就拒绝（不弹卡、不占 120s）
      if (matched !== undefined) {
        return { verdict: "allowed", target: resolved, matchedDir: matched };
      }
      return {
        verdict: "denied",
        target: resolved,
        reason:
          dirs.length === 0
            ? "该 Bot 未配置允许目录，写操作一律拒绝"
            : "目标不在 Bot 的允许目录内",
      };
    }

    default: {
      const never: never = action;
      return { verdict: "denied", target: rawTarget, reason: `未知动作：${String(never)}` };
    }
  }
}
