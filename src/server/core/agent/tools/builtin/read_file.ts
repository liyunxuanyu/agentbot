import { readFileSync, statSync } from "node:fs";
import { AGENT_LIMITS } from "../../limits.js";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { resolveInside } from "../paths.js";
import { truncateText } from "../truncate.js";

function fail(error: string, started: number): ToolResult {
  return { ok: false, output: error, error, durationMs: Date.now() - started };
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取工作目录内的文本文件。超过 64KB 会截断并注明省略量。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径（也可用绝对路径，但必须在工作目录内）" },
    },
    required: ["path"],
  },
  permission: "read",
  source: "builtin",
  async execute(ctx, args) {
    const started = Date.now();
    const raw = typeof args["path"] === "string" ? args["path"] : "";
    const resolved = resolveInside(ctx.cwd, raw);
    if (!resolved.ok) return fail(resolved.error, started);
    try {
      const stat = statSync(resolved.abs);
      if (stat.isDirectory()) return fail(`这是一个目录，不是文件：${raw}。请用 list_dir。`, started);
      if (stat.size > 2 * 1024 * 1024) {
        return fail(`文件过大（${stat.size} 字节），请用 grep 定位后再读取。`, started);
      }
      const text = readFileSync(resolved.abs, "utf8");
      if (text.includes("\0")) return fail("看起来是二进制文件，拒绝按文本读取。", started);
      const truncated = truncateText(text, { maxBytes: AGENT_LIMITS.maxFileReadBytes });
      return {
        ok: true,
        output: truncated.text.length === 0 ? "（空文件）" : truncated.text,
        ...(truncated.truncated ? { truncated: true } : {}),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return fail(`读取失败：${err instanceof Error ? err.message : String(err)}`, started);
    }
  },
};
