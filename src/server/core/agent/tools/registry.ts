import type { ProviderTool } from "../provider.js";
import type { PermissionMode } from "../../../../shared/events.js";

/**
 * 工具注册表：内置工具与 MCP 工具同一张表。
 *
 * 权限语义：
 *   - `null` / `read` → loop 直接执行；
 *   - `write` / `exec` / `network` / `admin` → loop 在 `execute` 之前统一调
 *     `askPermission`，由现有权限层（边界 → 授权 → 用户）裁决。
 *     工具内部不要再问一次：一次调用只能对应一张权限卡。
 *
 * 这里不 import 任何协议/数据库模块，便于单测与边界检查。
 */

export type ToolPermission = "read" | "write" | "exec" | "network" | "admin" | null;

export interface ToolPermissionRequest {
  action: Exclude<ToolPermission, null | "read">;
  target: string;
  detail?: unknown;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** 当前会话的权限模式（工具可据此调整行为；裁决本身在权限层）。 */
  permissionMode: PermissionMode;
  /** 调用者角色：`create_bot` 只对管理员开放（M3）。 */
  botRole: "member" | "admin";
  /** 权限门禁：返回 true 才执行。拒绝文案由 loop 回灌给模型。 */
  askPermission(req: ToolPermissionRequest): Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  /** 回灌给模型的文本（已截断）。 */
  output: string;
  error?: string;
  truncated?: boolean;
  durationMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema。 */
  parameters: Record<string, unknown>;
  permission: ToolPermission;
  source: "builtin" | "mcp";
  mcp?: { server: string; tool: string };
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** 交给 provider 的工具描述。 */
  toProviderTools(): ProviderTool[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

export function createToolRegistry(tools: readonly ToolDefinition[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  return registry;
}
