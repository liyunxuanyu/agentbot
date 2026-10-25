import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * 路径安全：任何文件工具都必须先过这里。
 *
 * 三条规则：
 *   ① 相对路径按会话 cwd 解析，绝对路径也必须在 cwd 内；
 *   ② 词法检查挡 `..`，realpath 检查挡符号链接逃逸（链接目标可能在 cwd 外）；
 *   ③ 目标还不存在时（写新文件），从最近的已存在祖先做 realpath，再把剩余段拼回去。
 *
 * 失败一律返回可读原因，由工具转成 `tool_result{ok:false}` 让模型换做法。
 */

export type ResolveInsideResult =
  | { ok: true; abs: string; relative: string }
  | { ok: false; error: string };

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return process.platform === "win32"
    ? child.toLowerCase().startsWith(prefix.toLowerCase())
    : child.startsWith(prefix);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** 找最近的存在祖先，返回 [realAncestor, 未存在的剩余段]。 */
function nearestExisting(path: string): { real: string; rest: string[] } | null {
  const rest: string[] = [];
  let current = path;
  while (true) {
    const real = realpathOrNull(current);
    if (real !== null) return { real, rest: [...rest].reverse() };
    const parent = dirname(current);
    if (parent === current) return null;
    rest.push(current.slice(parent.length).replace(/^[/\\]+/, ""));
    current = parent;
  }
}

export function resolveInside(cwd: string, input: string): ResolveInsideResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "路径不能为空" };
  }
  if (input.includes("\0")) return { ok: false, error: "路径包含非法字符" };

  const cwdAbs = resolve(cwd);
  const target = isAbsolute(input) ? normalize(input) : resolve(cwdAbs, input);
  const rel = relative(cwdAbs, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: `路径越出工作目录：${input}` };
  }

  const realCwd = realpathOrNull(cwdAbs);
  if (realCwd === null) {
    return { ok: false, error: `工作目录不存在：${cwdAbs}` };
  }

  // 已存在的目标：直接 realpath（符号链接会解析到真实位置）
  const realTarget = realpathOrNull(target);
  if (realTarget !== null) {
    if (!isInside(realCwd, realTarget)) {
      return { ok: false, error: `路径越出工作目录（符号链接指向外部）：${input}` };
    }
    return { ok: true, abs: realTarget, relative: relative(realCwd, realTarget) || "." };
  }

  // 不存在：检查最近祖先 + 剩余段没有 `..`
  const ancestor = nearestExisting(target);
  if (ancestor === null) return { ok: false, error: `无法解析路径：${input}` };
  if (!isInside(realCwd, ancestor.real)) {
    return { ok: false, error: `路径越出工作目录：${input}` };
  }
  if (ancestor.rest.some((part) => part === "..")) {
    return { ok: false, error: `路径越出工作目录：${input}` };
  }
  return {
    ok: true,
    abs: resolve(ancestor.real, ...ancestor.rest),
    relative: relative(realCwd, resolve(ancestor.real, ...ancestor.rest)) || ".",
  };
}

/** 文件大小（不存在返回 null）。 */
export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
