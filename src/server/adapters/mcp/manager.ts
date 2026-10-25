import { config } from "../../config.js";
import type { ToolDefinition, ToolResult } from "../../core/agent/tools/registry.js";
import { truncateText } from "../../core/agent/tools/truncate.js";
import { McpClient, type McpConnectionStatus, type McpToolInfo } from "./client.js";
import { readMcpFile, type McpServerConfig } from "./config.js";

/**
 * MCP server 管理器：随服务进程生命周期，连接所有 enabled 的 stdio server。
 *
 * 纪律：
 *   - 单个 server 失败不影响其他（失败标 unavailable，工具不注册）；
 *   - MCP 工具默认权限 `exec`（每次调用都要问）——它能做什么无法预判；
 *   - 工具名 `mcp__<server>__<tool>`，与设计文档一致。
 */

export interface McpServerStatus {
  id: string;
  command: string;
  args: string[];
  enabled: boolean;
  status: McpConnectionStatus;
  error: string | null;
  toolCount: number;
  tools: { name: string; description: string }[];
}

function sanitize(part: string, max = 24): string {
  const cleaned = part.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function toolNameOf(server: string, tool: string): string {
  const prefix = `mcp__${sanitize(server)}__`;
  const room = Math.max(1, 64 - prefix.length);
  return `${prefix}${sanitize(tool, room)}`;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private configs: McpServerConfig[] = [];
  private toolsCache: McpToolInfo[][] = [];
  private disposed = false;

  constructor(private readonly configPath: string = config.mcpPath) {}

  async start(): Promise<void> {
    const file = readMcpFile(this.configPath);
    this.configs = file.servers;
    this.clients.clear();
    this.toolsCache = [];
    await Promise.all(
      this.configs.map(async (cfg) => {
        const client = new McpClient(cfg);
        this.clients.set(cfg.id, client);
        if (!cfg.enabled) {
          client.status = "disabled";
          this.toolsCache.push([]);
          return;
        }
        try {
          await client.connect();
          this.toolsCache.push(client.tools);
        } catch (err) {
          console.warn(
            `[mcp] ${cfg.id} 连接失败：${err instanceof Error ? err.message : String(err)}`,
          );
          this.toolsCache.push([]);
        }
      }),
    );
  }

  async reload(): Promise<void> {
    await this.disposeClients();
    if (!this.disposed) await this.start();
  }

  async reconnect(id: string): Promise<boolean> {
    const existing = this.clients.get(id);
    if (existing) await existing.dispose();
    const cfg = readMcpFile(this.configPath).servers.find((s) => s.id === id);
    if (!cfg) return false;
    const client = new McpClient(cfg);
    this.clients.set(id, client);
    if (!cfg.enabled) {
      client.status = "disabled";
      return true;
    }
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    }
  }

  statuses(): McpServerStatus[] {
    return this.configs.map((cfg) => {
      const client = this.clients.get(cfg.id);
      return {
        id: cfg.id,
        command: cfg.command,
        args: cfg.args,
        enabled: cfg.enabled,
        status: client?.status ?? (cfg.enabled ? "unavailable" : "disabled"),
        error: client?.error ?? null,
        toolCount: client?.tools.length ?? 0,
        tools: (client?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      };
    });
  }

  /** 把已连接 server 的工具转成注册表条目（未连接的不出现）。 */
  tools(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const cfg of this.configs) {
      const client = this.clients.get(cfg.id);
      if (!client || client.status !== "connected") continue;
      for (const info of client.tools) {
        const exposed = toolNameOf(cfg.id, info.name);
        out.push({
          name: exposed,
          description: `[MCP ${cfg.id}] ${info.description || info.name}`,
          parameters: info.inputSchema,
          permission: "exec",
          source: "mcp",
          mcp: { server: cfg.id, tool: info.name },
          async execute(_ctx, args): Promise<ToolResult> {
            const started = Date.now();
            try {
              const result = await client.callTool(info.name, args);
              const truncated = truncateText(result.output);
              return {
                ok: result.ok,
                output: truncated.text,
                ...(result.ok ? {} : { error: truncated.text }),
                ...(truncated.truncated ? { truncated: true } : {}),
                durationMs: Date.now() - started,
              };
            } catch (err) {
              const message = `MCP 调用失败：${err instanceof Error ? err.message : String(err)}`;
              return { ok: false, output: message, error: message, durationMs: Date.now() - started };
            }
          },
        });
      }
    }
    return out;
  }

  private async disposeClients(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.dispose().catch(() => undefined)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposeClients();
  }
}
