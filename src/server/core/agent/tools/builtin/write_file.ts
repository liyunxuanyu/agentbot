import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { resolveInside } from "../paths.js";
import { FILE_CHANGE_MAX_CHARS, renderUnifiedDiff, unifiedDiff } from "../diff.js";

/** 读旧内容（新建文件 / 二进制 / 过大时返回空串 —— diff 只做文本比较）。 */
function readBefore(path: string): { text: string; truncated: boolean } {
  try {
    if (!existsSync(path)) return { text: "", truncated: false };
    const text = readFileSync(path, "utf8");
    if (text.includes("\0")) return { text: "", truncated: true };
    if (text.length > FILE_CHANGE_MAX_CHARS) {
      return { text: text.slice(0, FILE_CHANGE_MAX_CHARS), truncated: true };
    }
    return { text, truncated: false };
  } catch {
    return { text: "", truncated: true };
  }
}

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "在工作目录内创建或覆盖文本文件（自动创建父目录）。写操作需要用户批准。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      content: { type: "string", description: "完整文件内容" },
    },
    required: ["path", "content"],
  },
  permission: "write",
  source: "builtin",
  async execute(ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const raw = typeof args["path"] === "string" ? args["path"] : "";
    const content = typeof args["content"] === "string" ? args["content"] : "";
    const resolved = resolveInside(ctx.cwd, raw);
    if (!resolved.ok) {
      return { ok: false, output: resolved.error, error: resolved.error, durationMs: Date.now() - started };
    }
    try {
      const before = readBefore(resolved.abs);
      mkdirSync(dirname(resolved.abs), { recursive: true });
      writeFileSync(resolved.abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      // 改动前后都留一份给前端做 diff（超长截断，不占上下文）
      const after = content.length > FILE_CHANGE_MAX_CHARS ? content.slice(0, FILE_CHANGE_MAX_CHARS) : content;
      const change = unifiedDiff(before.text, after);
      return {
        ok: true,
        output: `已写入 ${resolved.relative}（${bytes} 字节）`,
        durationMs: Date.now() - started,
        data: {
          kind: "file_change",
          path: resolved.relative,
          before: before.text,
          after,
          added: change.added,
          removed: change.removed,
          diff: renderUnifiedDiff(resolved.relative, change),
          ...(before.truncated || after.length !== content.length || change.truncated
            ? { truncated: true }
            : {}),
        },
      };
    } catch (err) {
      const message = `写入失败：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
  },
};
