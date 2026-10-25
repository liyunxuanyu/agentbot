import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config } from "../../config.js";

/**
 * MCP server 配置（`~/.agentbot/mcp.json`）。
 *
 * 只支持 stdio 传输（本地命令），与设计 §11 一致；HTTP/SSE 传输不在首版范围。
 */

const serverSchema = z.object({
  id: z.string().min(1).max(64),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

const fileSchema = z.object({
  servers: z.array(serverSchema).default([]),
});

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpFile {
  servers: McpServerConfig[];
}

export function readMcpFile(path: string = config.mcpPath): McpFile {
  if (!existsSync(path)) return { servers: [] };
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) {
      console.warn(`[mcp] 配置格式无效：${parsed.error.issues[0]?.message ?? ""}`);
      return { servers: [] };
    }
    return { servers: parsed.data.servers as McpServerConfig[] };
  } catch (err) {
    console.warn(`[mcp] 读取失败：${err instanceof Error ? err.message : String(err)}`);
    return { servers: [] };
  }
}

export function writeMcpFile(file: McpFile, path: string = config.mcpPath): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // 权限收紧失败不阻断
    }
  }
}
