import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../../src/server/adapters/mcp/client.js";
import { McpManager } from "../../src/server/adapters/mcp/manager.js";
import { readMcpFile, writeMcpFile } from "../../src/server/adapters/mcp/config.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-mcp-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

const SERVER_SCRIPT = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send(m.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1.0" } });
  } else if (m.method === "tools/list") {
    send(m.id, { tools: [{ name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  } else if (m.method === "tools/call") {
    send(m.id, { content: [{ type: "text", text: "echo:" + m.params.arguments.text }], isError: false });
  }
});
`;

function fakeServer(dir: string): { command: string; args: string[] } {
  const path = join(dir, "fake-mcp.mjs");
  writeFileSync(path, SERVER_SCRIPT, "utf8");
  return { command: process.execPath, args: [path] };
}

describe("MCP stdio 客户端", () => {
  it("initialize → tools/list → tools/call", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const client = new McpClient({ id: "fake", command: server.command, args: server.args, enabled: true });
    await client.connect();
    expect(client.status).toBe("connected");
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0]).toMatchObject({ name: "echo", description: "回声" });
    const result = await client.callTool("echo", { text: "hi" });
    expect(result).toEqual({ ok: true, output: "echo:hi" });
    await client.dispose();
    expect(client.status).toBe("disabled");
  }, 20_000);

  it("命令不存在 → unavailable，不挂住", async () => {
    const client = new McpClient({
      id: "bad",
      command: "/definitely/not/a/command",
      args: [],
      enabled: true,
    });
    await expect(client.connect()).rejects.toThrow();
    expect(client.status).toBe("unavailable");
    await client.dispose();
  }, 20_000);
});

describe("MCP 管理器", () => {
  it("读取 mcp.json、连接、把工具映射为 mcp__server__tool", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const configPath = join(dir, "mcp.json");
    writeMcpFile(
      {
        servers: [
          { id: "fake", command: server.command, args: server.args, enabled: true },
          { id: "off", command: server.command, args: server.args, enabled: false },
        ],
      },
      configPath,
    );
    expect(readMcpFile(configPath).servers).toHaveLength(2);

    const manager = new McpManager(configPath);
    await manager.start();
    const statuses = manager.statuses();
    expect(statuses.find((s) => s.id === "fake")?.status).toBe("connected");
    expect(statuses.find((s) => s.id === "off")?.status).toBe("disabled");

    const tools = manager.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__fake__echo");
    expect(tools[0]?.permission).toBe("exec");
    expect(tools[0]?.mcp).toEqual({ server: "fake", tool: "echo" });

    const result = await tools[0]!.execute(
      { cwd: dir, signal: new AbortController().signal, askPermission: async () => true },
      { text: "manager" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("echo:manager");
    await manager.dispose();
  }, 20_000);
});
