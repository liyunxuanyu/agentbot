import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { toPosix } from "../paths.js";
import { AGENT_LIMITS } from "../../limits.js";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { resolveInside } from "../paths.js";
import { truncateText } from "../truncate.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);

interface Match {
  file: string;
  line: number;
  text: string;
}

function walk(root: string, current: string, out: Match[], regex: RegExp, limit: number): void {
  if (out.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, full, out, regex, limit);
      continue;
    }
    if (!entry.isFile()) continue;
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > 1024 * 1024) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        out.push({
          file: toPosix(relative(root, full)) || entry.name,
          line: i + 1,
          text: line.length > 300 ? `${line.slice(0, 297)}…` : line,
        });
        if (out.length >= limit) return;
      }
    }
  }
}

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "在工作目录内按正则搜索文本文件（跳过 .git/node_modules/dist）。返回 文件:行号: 内容，最多 200 条。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript 正则表达式" },
      path: { type: "string", description: "搜索起点，缺省为工作目录根" },
      caseSensitive: { type: "boolean", description: "是否区分大小写，缺省 false" },
    },
    required: ["pattern"],
  },
  permission: "read",
  source: "builtin",
  async execute(ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const pattern = typeof args["pattern"] === "string" ? args["pattern"] : "";
    if (pattern.length === 0) {
      const message = "pattern 不能为空";
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
    const rawPath = typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : ".";
    const resolved = resolveInside(ctx.cwd, rawPath);
    if (!resolved.ok) {
      return { ok: false, output: resolved.error, error: resolved.error, durationMs: Date.now() - started };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, args["caseSensitive"] === true ? "" : "i");
    } catch (err) {
      const message = `正则无效：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
    try {
      const stat = statSync(resolved.abs);
      const matches: Match[] = [];
      if (stat.isDirectory()) {
        walk(resolved.abs, resolved.abs, matches, regex, AGENT_LIMITS.maxGrepMatches);
      } else {
        const text = readFileSync(resolved.abs, "utf8");
        text.split("\n").forEach((line, i) => {
          if (matches.length < AGENT_LIMITS.maxGrepMatches && regex.test(line)) {
            matches.push({ file: resolved.relative, line: i + 1, text: line });
          }
        });
      }
      if (matches.length === 0) {
        return { ok: true, output: `没有匹配：${pattern}`, durationMs: Date.now() - started };
      }
      const truncated = truncateText(
        matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n"),
      );
      return {
        ok: true,
        output: truncated.text,
        ...(truncated.truncated ? { truncated: true } : {}),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = `搜索失败：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
  },
};
