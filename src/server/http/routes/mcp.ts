import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import { readMcpFile, writeMcpFile, type McpServerConfig } from "../../adapters/mcp/config.js";

/**
 * MCP server 端点（N4）。
 *
 *   GET    /api/mcp               → 每个 server 的连接状态与工具数
 *   POST   /api/mcp               → 新增
 *   PATCH  /api/mcp/:id           → 修改
 *   DELETE /api/mcp/:id           → 删除
 *   POST   /api/mcp/:id/reconnect → 重连
 *
 * 配置写入 `~/.agentbot/mcp.json`；变更后**只动受影响的那一个连接**（N3-2）：
 * 新增走 `manager.add`、修改走 `manager.replace`、删除走 `manager.remove`，
 * 其它 server 的连接保持不动。不需要重启服务，下一轮对话即可用/不可用新工具。
 * 连接失败只标状态，不 500（配置本身是合法的）。
 */

interface FieldError {
  field: string;
  code: string;
  message: string;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface McpBody {
  id?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  enabled?: unknown;
  /** 工具权限性质（R5-c）：read 的 server 在计划模式下仍然可用。 */
  permission?: unknown;
}

const MCP_PERMISSIONS = ["read", "write", "exec", "network"] as const;

function readServerInput(
  body: McpBody,
  fields: FieldError[],
  opts: { requireAll: boolean },
): Partial<McpServerConfig> & { id?: string } {
  const out: Partial<McpServerConfig> & { id?: string } = {};
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !ID_PATTERN.test(body.id)) {
      fields.push({ field: "id", code: "invalid_value", message: "id 只能包含字母、数字、- 和 _" });
    } else out.id = body.id;
  } else if (opts.requireAll) {
    fields.push({ field: "id", code: "required", message: "id 不能为空" });
  }

  if (body.command !== undefined) {
    if (typeof body.command !== "string" || body.command.trim().length === 0) {
      fields.push({ field: "command", code: "invalid_value", message: "command 不能为空" });
    } else out.command = body.command.trim();
  } else if (opts.requireAll) {
    fields.push({ field: "command", code: "required", message: "command 不能为空" });
  }

  if (body.args !== undefined) {
    if (!Array.isArray(body.args) || body.args.some((a) => typeof a !== "string")) {
      fields.push({ field: "args", code: "not_string_array", message: "args 必须是字符串数组" });
    } else out.args = body.args as string[];
  }

  if (body.env !== undefined) {
    if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
      fields.push({ field: "env", code: "not_object", message: "env 必须是键值对象" });
    } else {
      const env: Record<string, string> = {};
      let ok = true;
      for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof value !== "string") {
          fields.push({ field: "env", code: "not_string", message: `env.${key} 必须是字符串` });
          ok = false;
          break;
        }
        env[key] = value;
      }
      if (ok) out.env = env;
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      fields.push({ field: "enabled", code: "invalid_value", message: "enabled 必须是布尔值" });
    } else out.enabled = body.enabled;
  }

  if (body.permission !== undefined) {
    if (
      typeof body.permission !== "string" ||
      !(MCP_PERMISSIONS as readonly string[]).includes(body.permission)
    ) {
      fields.push({
        field: "permission",
        code: "invalid_value",
        message: "permission 只能是 read / write / exec / network",
      });
    } else {
      out.permission = body.permission as (typeof MCP_PERMISSIONS)[number];
    }
  }
  return out;
}

export function registerMcpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/mcp", async () => ({
    servers: ctx.mcp?.statuses() ?? [],
    running: ctx.mcp !== undefined,
  }));

  app.post<{ Body: McpBody }>("/api/mcp", async (req, reply) => {
    const fields: FieldError[] = [];
    const input = readServerInput(req.body ?? {}, fields, { requireAll: true });
    const file = readMcpFile();
    if (input.id && file.servers.some((s) => s.id === input.id)) {
      fields.push({ field: "id", code: "duplicate", message: `MCP server 已存在：${input.id}` });
    }
    if (fields.length > 0) return json(reply, 400, { error: "invalid_mcp_server", fields });

    const server: McpServerConfig = {
      id: input.id as string,
      command: input.command as string,
      args: input.args ?? [],
      ...(input.env !== undefined ? { env: input.env } : {}),
      enabled: input.enabled ?? true,
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
    };
    writeMcpFile({ servers: [...file.servers, server] });
    // N3-2：运行期直接连，不重启；全量 reload 会抖掉无关 server 的工具
    const outcome = await ctx.mcp?.add(server);
    const status = ctx.mcp?.statuses().find((s) => s.id === server.id) ?? null;
    return json(reply, 201, { server: status, hot: outcome !== undefined });
  });

  app.patch<{ Params: { id: string }; Body: McpBody }>("/api/mcp/:id", async (req, reply) => {
    const file = readMcpFile();
    const current = file.servers.find((s) => s.id === req.params.id);
    if (!current) return json(reply, 404, { error: "mcp_server_not_found" });
    const fields: FieldError[] = [];
    const input = readServerInput(req.body ?? {}, fields, { requireAll: false });
    if (fields.length > 0) return json(reply, 400, { error: "invalid_mcp_server", fields });
    const updated: McpServerConfig = {
      ...current,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
    };
    writeMcpFile({ servers: file.servers.map((s) => (s.id === current.id ? updated : s)) });
    // N3-2：只重连这一个（改了 command/args/env 必须重起进程；只改 enabled 等价启停）
    await ctx.mcp?.replace(updated);
    return { server: ctx.mcp?.statuses().find((s) => s.id === current.id) ?? null };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/:id", async (req, reply) => {
    const file = readMcpFile();
    if (!file.servers.some((s) => s.id === req.params.id)) {
      return json(reply, 404, { error: "mcp_server_not_found" });
    }
    writeMcpFile({ servers: file.servers.filter((s) => s.id !== req.params.id) });
    // N3-2：断开并移除，工具立刻从下一轮注册表里消失（不残留）
    await ctx.mcp?.remove(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/mcp/:id/reconnect", async (req, reply) => {
    if (!ctx.mcp) return json(reply, 409, { error: "mcp_unavailable" });
    const result = await ctx.mcp.reconnect(req.params.id);
    if (result === "not_found") return json(reply, 404, { error: "mcp_server_not_found" });
    return {
      ok: result === "connected",
      server: ctx.mcp.statuses().find((s) => s.id === req.params.id) ?? null,
    };
  });
}
