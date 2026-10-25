import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { resolveInside } from "../paths.js";

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
      mkdirSync(dirname(resolved.abs), { recursive: true });
      writeFileSync(resolved.abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        ok: true,
        output: `已写入 ${resolved.relative}（${bytes} 字节）`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = `写入失败：${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
  },
};
