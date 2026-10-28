/**
 * 极简行级 unified diff（无第三方依赖）。
 *
 * 为什么自己写：内置引擎的 write_file / edit_file 需要在 tool_result 里带上
 * 「这次改了什么」，而引入 diff 库会把一个纯展示能力变成依赖。这里的输入是
 * 已经读进内存的两个字符串（单文件 ≤ 64KB），用 LCS 足够；超大文件按行数截断，
 * 并在结果里标 truncated，绝不把整段 diff 塞进上下文。
 */

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

export interface UnifiedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** 单侧最多比较的行数：超过就只给「前 N 行」的 diff，避免 O(n*m) 卡住进程。 */
export const DIFF_MAX_LINES = 2000;
/** 单个文件在事件里保留的最大字符数（before / after 各自）。 */
export const FILE_CHANGE_MAX_CHARS = 32 * 1024;
/** diff 文本最大字符数。 */
export const DIFF_MAX_CHARS = 64 * 1024;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

/**
 * LCS 表 + 回溯。`a` 是旧行，`b` 是新行。
 *
 * 行数超限时只比较前 DIFF_MAX_LINES 行，剩余部分按「整段替换」处理并标 truncated。
 */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度；用 Int32Array 逐行存，内存可控
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: "-", text: a[i++]! });
  while (j < m) out.push({ kind: "+", text: b[j++]! });
  return out;
}

/**
 * 生成 unified diff（不带 hunk 头，前端自己按上下文折叠）。
 *
 * 这里保留全部行，不裁剪上下文：前端默认只渲染「变更行 ± 3 行」，
 * 完整结果仍可用于「查看完整文件」。
 */
export function unifiedDiff(before: string, after: string): UnifiedDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const truncated = a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES;
  const left = truncated ? a.slice(0, DIFF_MAX_LINES) : a;
  const right = truncated ? b.slice(0, DIFF_MAX_LINES) : b;

  const lines = lcsDiff(left, right);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "+") added += 1;
    else if (line.kind === "-") removed += 1;
  }
  return { lines, added, removed, truncated };
}

/** 渲染成 `diff --git` 风格的纯文本（存事件、复制到剪贴板都够用）。 */
export function renderUnifiedDiff(
  path: string,
  change: UnifiedDiff,
  maxChars = DIFF_MAX_CHARS,
): string {
  const body = change.lines.map((line) => `${line.kind}${line.text}`).join("\n");
  const text = `--- a/${path}\n+++ b/${path}\n${body}`;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
