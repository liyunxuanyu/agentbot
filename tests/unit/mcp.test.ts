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
      {
        cwd: dir,
        signal: new AbortController().signal,
        permissionMode: "confirm",
        botRole: "member",
        askPermission: async () => true,
      },
      { text: "manager" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("echo:manager");
    await manager.dispose();
  }, 20_000);
});

describe("MCP 工具权限声明（R5-c）", () => {
  it("server 声明 permission: read → 工具权限是 read；未声明 → exec", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const configPath = join(dir, "mcp.json");
    writeMcpFile(
      {
        servers: [
          { id: "ro", command: server.command, args: server.args, enabled: true, permission: "read" },
          { id: "rw", command: server.command, args: server.args, enabled: true },
        ],
      },
      configPath,
    );

    const manager = new McpManager(configPath);
    await manager.start();
    const tools = manager.tools();
    expect(tools.find((t) => t.name === "mcp__ro__echo")?.permission).toBe("read");
    expect(tools.find((t) => t.name === "mcp__rw__echo")?.permission).toBe("exec");
    // 状态里也带出来，设置页能显示「只读 / 执行」
    expect(manager.statuses().find((s) => s.id === "ro")?.permission).toBe("read");
    expect(manager.statuses().find((s) => s.id === "rw")?.permission).toBeNull();
    await manager.dispose();
  }, 20_000);
});

describe("MCP 热插拔（N3-2）", () => {
  it("运行期 add / replace / remove：不重启，工具立刻增删", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const configPath = join(dir, "mcp.json");
    writeMcpFile({ servers: [] }, configPath);

    const manager = new McpManager(configPath);
    await manager.start();
    expect(manager.tools()).toHaveLength(0);

    // 新增：立刻能列出工具
    const added = await manager.add({
      id: "hot",
      command: server.command,
      args: server.args,
      enabled: true,
    });
    expect(added).toBe("connected");
    expect(manager.tools().map((t) => t.name)).toEqual(["mcp__hot__echo"]);

    // 重复 id：拒绝（路由层已拦，这里是防御）
    expect(
      await manager.add({ id: "hot", command: server.command, args: server.args, enabled: true }),
    ).toBe("duplicate");

    // 修改为停用：工具立刻消失，状态是 disabled
    expect(
      await manager.replace({
        id: "hot",
        command: server.command,
        args: server.args,
        enabled: false,
      }),
    ).toBe("connected");
    expect(manager.tools()).toHaveLength(0);
    expect(manager.statuses().find((s) => s.id === "hot")?.status).toBe("disabled");

    // 再启用：工具回来
    await manager.replace({ id: "hot", command: server.command, args: server.args, enabled: true });
    expect(manager.tools()).toHaveLength(1);

    // 删除：工具消失、状态列表也不再有它
    expect(await manager.remove("hot")).toBe("removed");
    expect(manager.tools()).toHaveLength(0);
    expect(manager.statuses().find((s) => s.id === "hot")).toBeUndefined();

    // 删不存在的：not_found
    expect(await manager.remove("hot")).toBe("not_found");
    await manager.dispose();
  }, 30_000);

  it("新增一个无关 server 不会抖掉已有连接（只动受影响的那一个）", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const configPath = join(dir, "mcp.json");
    writeMcpFile(
      { servers: [{ id: "old", command: server.command, args: server.args, enabled: true }] },
      configPath,
    );
    const manager = new McpManager(configPath);
    await manager.start();
    const before = manager.statuses().find((s) => s.id === "old");
    expect(before?.status).toBe("connected");

    await manager.add({ id: "new", command: server.command, args: server.args, enabled: true });
    // 旧连接没有断开重连（连接状态保持）
    expect(manager.statuses().find((s) => s.id === "old")?.status).toBe("connected");
    expect(manager.tools()).toHaveLength(2);
    await manager.dispose();
  }, 30_000);
});

describe("MCP 配置外部变更（npm run setup:browser 直接写盘）", () => {
  /**
   * 真机踩到：用脚本把 playwright 条目写进 mcp.json 后，`/api/mcp` 一直回空列表，
   * 必须重启服务才生效 —— 与「MCP 热插拔」的说法矛盾。
   *
   * 根因：`configs` 是启动时的内存快照，`reconnect()` 只从盘上找**已有**的 id，
   * 盘上新增的条目永远进不来。
   */
  it("syncFromFile() 接入盘上新增的条目，且不重连已连接的", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const configPath = join(dir, "mcp.json");
    writeMcpFile(
      { servers: [{ id: "old", command: server.command, args: server.args, enabled: true }] },
      configPath,
    );
    const manager = new McpManager(configPath);
    await manager.start();
    expect(manager.tools().map((t) => t.name)).toEqual(["mcp__old__echo"]);

    // 外部脚本追加一条（模拟 install-browser-mcp.mjs）
    writeMcpFile(
      {
        servers: [
          { id: "old", command: server.command, args: server.args, enabled: true },
          { id: "playwright", command: server.command, args: server.args, enabled: true, permission: "network" },
        ],
      },
      configPath,
    );

    const added = await manager.syncFromFile();
    expect(added).toEqual(["playwright"]);
    expect(manager.statuses().map((s) => s.id).sort()).toEqual(["old", "playwright"]);
    expect(manager.tools().map((t) => t.name).sort()).toEqual([
      "mcp__old__echo",
      "mcp__playwright__echo",
    ]);
    expect(manager.statuses().find((s) => s.id === "playwright")?.permission).toBe("network");

    // 幂等：再同步一次不重复接入
    expect(await manager.syncFromFile()).toEqual([]);
    await manager.dispose();
  }, 30_000);

  it("reconnect() 也能接入盘上新增的条目；盘上删掉后状态不再挂着", async () => {
    const dir = tempDir();
    const server = fakeServer(dir);
    const configPath = join(dir, "mcp.json");
    writeMcpFile({ servers: [] }, configPath);
    const manager = new McpManager(configPath);
    await manager.start();

    writeMcpFile(
      { servers: [{ id: "fresh", command: server.command, args: server.args, enabled: true }] },
      configPath,
    );
    expect(await manager.reconnect("fresh")).toBe("connected");
    expect(manager.tools().map((t) => t.name)).toEqual(["mcp__fresh__echo"]);

    // 外部把条目删掉：再 reconnect 要清掉内存里的状态
    writeMcpFile({ servers: [] }, configPath);
    expect(await manager.reconnect("fresh")).toBe("not_found");
    expect(manager.statuses()).toEqual([]);
    expect(manager.tools()).toEqual([]);
    await manager.dispose();
  }, 30_000);
});

describe("MCP 热插拔的 HTTP 层（N3-2）", () => {
  it("POST/PATCH/DELETE 直接生效，响应不要求重启", async () => {
    const { buildServer } = await import("../../src/server/http/server.js");
    const { openDb } = await import("../../src/server/core/db/db.js");
    const { createEventBus } = await import("../../src/server/core/events/bus.js");
    const { createSessionLock } = await import("../../src/server/core/orchestrator/session-lock.js");
    const { createTurnOrchestrator } = await import("../../src/server/core/orchestrator/turn.js");
    const { createSupervisor } = await import("../../src/server/core/process/supervisor.js");
    const { createPermissionResolver } = await import(
      "../../src/server/core/permissions/resolver.js"
    );
    const { listenEphemeral } = await import("./http-listen.js");

    const dir = tempDir();
    const server = fakeServer(dir);
    // 路由与控制台共用默认路径（config.mcpPath）；测试里临时改写模块常量做不到，
    // 所以这里直接确认「管理器有无」这条契约：有管理器就热插拔，没有就 409 提示。
    const db = openDb(":memory:");
    const bus = createEventBus();
    const supervisor = createSupervisor({ db, bus, resolveRuntime: () => null });
    const permissions = createPermissionResolver({
      db,
      bus,
      isSessionAlive: () => false,
      sessionCwdOf: () => process.cwd(),
      respond: async () => true,
      setHeld: () => undefined,
      setSessionStatus: () => undefined,
      log: () => undefined,
    });
    const orchestrator = createTurnOrchestrator({
      db,
      bus,
      lock: createSessionLock(),
      resolveRuntime: () => null,
      supervisor,
    });
    const manager = new McpManager(join(dir, "http-mcp.json"));
    await manager.start();

    const app = buildServer(
      {
        db,
        runtimes: [],
        schemaVersion: 4,
        startedAt: Date.now(),
        resolveRuntime: () => null,
        orchestrator,
        permissions,
        assignments: { stop: () => undefined } as never,
        mcp: manager,
      },
      { authEnabled: false, webRoot: join(dir, "no-web") },
    );
    const base = await listenEphemeral(app);
    try {
      const res = await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "hot",
          command: server.command,
          args: server.args,
          permission: "read",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        server: { id: string; status: string; permission: string | null } | null;
        hot: boolean;
      };
      expect(body.hot).toBe(true);
      expect(body.server?.status).toBe("connected");
      expect(body.server?.permission).toBe("read");
      // 管理器内存里真的有了这个连接（不重启）
      expect(manager.tools().map((t) => t.name)).toEqual(["mcp__hot__echo"]);
    } finally {
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      await manager.dispose();
      db.close();
      // 路由写的是默认 ~/.agentbot/mcp.json（本测试里是 vitest 的临时 home）：
      // 清掉，避免污染同一次运行里的其它用例
      const { config } = await import("../../src/server/config.js");
      try {
        rmSync(config.mcpPath, { force: true });
      } catch {
        // 忽略
      }
    }
  }, 30_000);
});
