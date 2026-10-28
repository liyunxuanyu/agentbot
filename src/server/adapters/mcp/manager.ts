import { config } from "../../config.js";
import type { ToolDefinition, ToolResult } from "../../core/agent/tools/registry.js";
import { truncateText } from "../../core/agent/tools/truncate.js";
import { McpClient, type McpConnectionStatus } from "./client.js";
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
  /** 工具权限性质（R5-c）；未声明时为 undefined，等价 exec。 */
  permission: "read" | "write" | "exec" | "network" | null;
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
  private disposed = false;

  constructor(private readonly configPath: string = config.mcpPath) {}

  async start(): Promise<void> {
    const file = readMcpFile(this.configPath);
    this.configs = file.servers;
    this.clients.clear();
    await Promise.all(
      this.configs.map(async (cfg) => {
        const client = new McpClient(cfg);
        this.clients.set(cfg.id, client);
        if (!cfg.enabled) {
          client.status = "disabled";
          return;
        }
        try {
          await client.connect();
        } catch (err) {
          console.warn(
            `[mcp] ${cfg.id} 连接失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  /**
   * 重新读配置并全量重连。
   *
   * N3-2 的 CRUD 路径不再用它：POST/PATCH/DELETE 只动受影响的那一个 server
   * （`add` / `replace` / `remove`），其它连接保持不动 —— 全量 reload 会让
   * 无关 server 的工具短暂消失，正在跑的会话可能正好在调它。
   * 保留给「配置文件被外部手改，用户点刷新」的场景。
   */
  async reload(): Promise<void> {
    await this.disposeClients();
    if (!this.disposed) await this.start();
  }

  /**
   * 运行期新增一个 server 并连接（N3-2）。
   *
   * 不需要重启服务：配置由路由层先写盘，这里只负责把新连接加进内存表。
   * 同名已存在时视为失败（路由层已经拦过重复，这里是防御）。
   */
  async add(cfg: McpServerConfig): Promise<"connected" | "failed" | "duplicate"> {
    if (this.disposed) return "failed";
    if (this.clients.has(cfg.id)) return "duplicate";
    this.configs = [...this.configs.filter((s) => s.id !== cfg.id), cfg];
    const client = new McpClient(cfg);
    this.clients.set(cfg.id, client);
    if (!cfg.enabled) {
      client.status = "disabled";
      return "connected";
    }
    try {
      await client.connect();
      return client.status === "connected" ? "connected" : "failed";
    } catch {
      return "failed";
    }
  }

  /**
   * 运行期修改一个 server（N3-2）：先断旧连接，再按新配置连。
   *
   * 改了 command/args/env/permission 都必须重连（进程按旧参数起不来）；
   * 只改 enabled 时等价于启/停。旧连接先 dispose，避免孤儿进程。
   */
  async replace(cfg: McpServerConfig): Promise<"connected" | "failed" | "not_found"> {
    if (this.disposed) return "failed";
    const existing = this.clients.get(cfg.id);
    if (!existing && !this.configs.some((s) => s.id === cfg.id)) return "not_found";
    if (existing) await existing.dispose().catch(() => undefined);
    this.configs = this.configs.map((s) => (s.id === cfg.id ? cfg : s));
    const client = new McpClient(cfg);
    this.clients.set(cfg.id, client);
    if (!cfg.enabled) {
      client.status = "disabled";
      return "connected";
    }
    try {
      await client.connect();
      return client.status === "connected" ? "connected" : "failed";
    } catch {
      return "failed";
    }
  }

  /**
   * 运行期删除一个 server（N3-2）：断开连接、从内存表移除。
   *
   * 删除后 `tools()` 立刻不再返回它的工具 —— 下一轮对话模型就看不到、
   * 也调不到；不会残留（客户端实例与配置行同时移除）。
   */
  async remove(id: string): Promise<"removed" | "not_found"> {
    const existed = this.clients.has(id) || this.configs.some((s) => s.id === id);
    if (!existed) return "not_found";
    const client = this.clients.get(id);
    if (client) await client.dispose().catch(() => undefined);
    this.clients.delete(id);
    this.configs = this.configs.filter((s) => s.id !== id);
    return "removed";
  }

  /**
   * 重连一个 server（也会把 `mcp.json` 里**新增**的条目接进来）。
   *
   * 为什么要重新读盘并合并：`npm run setup:browser` 这类脚本是直接写
   * `mcp.json` 的（不经过 HTTP 路由），而内存里的 `configs` 是启动时快照。
   * 旧实现只从盘上找**已有**的那个 id，盘上新增的条目永远进不来 ——
   * 用户按文档装完浏览器控制、重启服务才生效，与「MCP 热插拔」的说法矛盾
   * （真机踩到：/api/mcp 一直回空列表）。
   */
  async reconnect(id: string): Promise<"not_found" | "connected" | "failed"> {
    const existing = this.clients.get(id);
    if (existing) await existing.dispose();

    const file = readMcpFile(this.configPath);
    const cfg = file.servers.find((s) => s.id === id);
    if (!cfg) {
      // 盘上也没有：把它从内存配置里摘掉（外部删了条目，状态不该继续挂着）
      this.configs = this.configs.filter((s) => s.id !== id);
      this.clients.delete(id);
      return "not_found";
    }
    // 盘上的条目是权威：合并进内存配置（新增则追加，已有则替换）
    this.configs = this.configs.some((s) => s.id === id)
      ? this.configs.map((s) => (s.id === id ? cfg : s))
      : [...this.configs, cfg];

    const client = new McpClient(cfg);
    this.clients.set(id, client);
    if (!cfg.enabled) {
      client.status = "disabled";
      return "connected";
    }
    try {
      await client.connect();
      return "connected";
    } catch {
      return "failed";
    }
  }

  /**
   * 把所有 `mcp.json` 里还没接进来的条目补上（不重连已连接的）。
   *
   * 给「外部脚本改了配置文件，用户点刷新」这个场景用；返回新接入的 id。
   */
  async syncFromFile(): Promise<string[]> {
    const file = readMcpFile(this.configPath);
    const added: string[] = [];
    for (const cfg of file.servers) {
      if (this.clients.has(cfg.id)) continue;
      this.configs = [...this.configs.filter((s) => s.id !== cfg.id), cfg];
      const client = new McpClient(cfg);
      this.clients.set(cfg.id, client);
      added.push(cfg.id);
      if (!cfg.enabled) {
        client.status = "disabled";
        continue;
      }
      try {
        await client.connect();
      } catch {
        // 单个失败只标状态，不影响其它
      }
    }
    return added;
  }

  statuses(): McpServerStatus[] {
    return this.configs.map((cfg) => {
      const client = this.clients.get(cfg.id);
      return {
        id: cfg.id,
        command: cfg.command,
        args: cfg.args,
        enabled: cfg.enabled,
        permission: cfg.permission ?? null,
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
      // R5-c：权限取 server 的声明（缺省 exec —— 不猜「它大概是只读的」）。
      // 计划模式下的裁剪放在驱动侧（manager 不感知权限模式）。
      const permission = cfg.permission ?? "exec";
      for (const info of client.tools) {
        const exposed = toolNameOf(cfg.id, info.name);
        out.push({
          name: exposed,
          description: `[MCP ${cfg.id}] ${info.description || info.name}`,
          parameters: info.inputSchema,
          permission,
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
