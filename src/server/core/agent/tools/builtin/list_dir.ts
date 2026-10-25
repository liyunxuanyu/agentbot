import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { resolveInside } from "../paths.js";
import { truncateText } from "../truncate.js";

export const listDirTool: ToolDefinition = {
  name: "list_dir",
  description: "列出工作目录内某个目录的直接子项（深度 1），标注目录/文件、大小与隐藏项。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的目录路径，缺省为工作目录根" },
    },
  },
  permission: "read",
  source: "builtin",
  async execute(ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const raw = typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : ".";
    const resolved = resolveInside(ctx.cwd, raw);
    if (!resolved.ok) {
      return { ok: false, output: resolved.error, error: resolved.error, durationMs: Date.now() - started };
    }
    try {
      if (!statSync(resolved.abs).isDirectory()) {
        const message = `不是目录：${raw}`;
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }
      const entries = readdirSync(resolved.abs, { withFileTypes: true })
        .map((entry) => {
          const full = join(resolved.abs, entry.name);
          let size = 0;
          try {
            size = entry.isDirectory() ? 0 : statSync(full).size;
          } catch {
            size = 0;
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
            size,
            hidden: entry.name.startsWith("."),
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

      const lines = entries.map((e) => {
        const flags = [e.type === "dir" ? "[dir]" : `[file ${e.size}B]`, e.hidden ? "(hidden)" : ""]
          .filter(Boolean)
          .join(" ");
        return `${flags} ${e.name}`;
      });
      const truncated = truncateText(lines.join("\n"));
      return {
        ok: true,
        output: truncated.text.length === 0 ? "（空目录）" : truncated.text,
        ...(truncated.truncated ? { truncated: true } : {}),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = `列目录失败：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
  },
};
