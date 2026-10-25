import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree } from "../../core/process/kill-tree.js";
import type { McpServerConfig } from "./config.js";

/**
 * 最小 MCP stdio 客户端：initialize → tools/list → tools/call。
 *
 * 只实现首版需要的三个方法；不做 resources / prompts / sampling。
 * 单个 server 连接失败只影响它自己，管理器会把状态标成 unavailable。
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpConnectionStatus = "connecting" | "connected" | "unavailable" | "disabled";

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const CLIENT_INFO = { name: "agentbot", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

export class McpClient {
  readonly id: string;
  private readonly cfg: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private disposed = false;

  status: McpConnectionStatus = "disabled";
  error: string | null = null;
  tools: McpToolInfo[] = [];

  constructor(cfg: McpServerConfig) {
    this.id = cfg.id;
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    if (!this.cfg.enabled) {
      this.status = "disabled";
      return;
    }
    this.status = "connecting";
    this.error = null;
    try {
      this.child = spawn(this.cfg.command, this.cfg.args, {
        cwd: process.cwd(),
        env: { ...process.env, ...(this.cfg.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      const child = this.child;
      child.on("error", (err) => this.fail(`启动失败：${err.message}`));
      child.on("exit", (code, signal) => {
        if (!this.disposed) {
          this.fail(`进程已退出（code=${String(code)}${signal ? ` signal=${signal}` : ""}）`);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4096);
      });
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => this.onLine(line));

      await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        20_000,
      );
      this.notify("notifications/initialized", {});
      this.tools = await this.listTools();
      this.status = "connected";
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      await this.dispose();
      throw err;
    }
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const msg = message as {
      id?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message ?? `MCP 错误 ${msg.error.code ?? ""}`));
    else pending.resolve(msg.result);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error("MCP 进程未启动"));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(payload, (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list", {}, 20_000)) as {
      tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
    };
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools
      .filter((t) => typeof t.name === "string" && t.name.length > 0)
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema:
          typeof t.inputSchema === "object" && t.inputSchema !== null
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    if (this.status !== "connected") {
      return { ok: false, output: `MCP server ${this.id} 未连接：${this.error ?? this.status}` };
    }
    const result = (await this.request("tools/call", { name, arguments: args }, 120_000)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = Array.isArray(result.content)
      ? result.content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text ?? "")
          .join("\n")
      : "";
    return { ok: result.isError !== true, output: text.length > 0 ? text : JSON.stringify(result) };
  }

  private fail(message: string): void {
    this.status = "unavailable";
    this.error = this.stderrTail.trim().length > 0 ? `${message}\n${this.stderrTail.trim()}` : message;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.error));
    }
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP 客户端已关闭"));
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (child && child.pid !== undefined) {
      await killTree(child.pid).catch(() => undefined);
    }
    this.status = "disabled";
  }
}
