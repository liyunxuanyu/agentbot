import { readFileSync, writeFileSync } from "node:fs";
import { FILE_CHANGE_MAX_CHARS, renderUnifiedDiff, unifiedDiff } from "../diff.js";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { resolveInside } from "../paths.js";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "在文件里做一次精确替换。oldText 必须在文件中唯一出现，否则报错让你补充上下文后重试。写操作需要用户批准。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      oldText: { type: "string", description: "要替换的原文（必须唯一）" },
      newText: { type: "string", description: "替换后的文本；空字符串表示删除" },
    },
    required: ["path", "oldText", "newText"],
  },
  permission: "write",
  source: "builtin",
  async execute(ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const raw = typeof args["path"] === "string" ? args["path"] : "";
    const oldText = typeof args["oldText"] === "string" ? args["oldText"] : "";
    const newText = typeof args["newText"] === "string" ? args["newText"] : "";
    if (oldText.length === 0) {
      const message = "oldText 不能为空；新建文件请用 write_file。";
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
    const resolved = resolveInside(ctx.cwd, raw);
    if (!resolved.ok) {
      return { ok: false, output: resolved.error, error: resolved.error, durationMs: Date.now() - started };
    }
    try {
      const current = readFileSync(resolved.abs, "utf8");
      const count = countOccurrences(current, oldText);
      if (count === 0) {
        const message = `在 ${resolved.relative} 中找不到 oldText。请先 read_file 确认原文。`;
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }
      if (count > 1) {
        const message = `oldText 在 ${resolved.relative} 中出现了 ${count} 次，不唯一。请带上更多上下文让它唯一。`;
        return { ok: false, output: message, error: message, durationMs: Date.now() - started };
      }
      const next = current.replace(oldText, newText);
      writeFileSync(resolved.abs, next, "utf8");
      // diff 数据（超长截断）：前端据此在同一行展开「改了什么」
      const beforeText = current.slice(0, FILE_CHANGE_MAX_CHARS);
      const afterText = next.slice(0, FILE_CHANGE_MAX_CHARS);
      const change = unifiedDiff(beforeText, afterText);
      return {
        ok: true,
        output: `已更新 ${resolved.relative}`,
        durationMs: Date.now() - started,
        data: {
          kind: "file_change",
          path: resolved.relative,
          before: beforeText,
          after: afterText,
          added: change.added,
          removed: change.removed,
          diff: renderUnifiedDiff(resolved.relative, change),
          ...(current.length > FILE_CHANGE_MAX_CHARS || next.length > FILE_CHANGE_MAX_CHARS || change.truncated
            ? { truncated: true }
            : {}),
        },
      };
    } catch (err) {
      const message = `编辑失败：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
  },
};
