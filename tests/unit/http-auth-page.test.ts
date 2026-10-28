import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import { createAssignmentRunner } from "../../src/server/core/assignment/runner.js";
import { buildServer } from "../../src/server/http/server.js";
import { ensureToken } from "../../src/server/http/auth.js";
import type { AdapterDeclaration, ChannelDriver, SessionHandle } from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * 鉴权失败时的「人 vs 程序」分流（P0-14 的可用性补充）。
 *
 * 真实事故：用户在地址栏直接敲 `http://127.0.0.1:8792/bots`（没带 `?t=`），
 * 浏览器里出现一屏 `{"error":"unauthorized"}` —— 安全上没错，但人看不懂。
 *
 * 约定：
 *   - 浏览器导航（Accept 含 text/html、且不是 /api/*）→ 302 到 `/login`，
 *     登录页本身不含任何业务数据；
 *   - fetch / EventSource / /api/* → 仍然只回 JSON，且不含任何业务数据。
 */

let workDir = "";
let db: DB;
let app: FastifyInstance;
let base = "";
let token = "";

const decl: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake",
  displayName: "Fake",
  protocol: "cli-stdio",
  launch: { command: process.execPath, args: ["-e", ""] },
  detect: { command: process.execPath, versionArgs: ["--version"], versionPattern: "(?<version>\\d+)" },
  capabilities: { plan: "unknown", permissionRequest: "unknown", resume: "unknown", images: "unknown", streaming: false, contextWindow: null },
  eventCapabilities: ["message_delta", "done", "error"],
  permission: { channel: "none", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "process-lifetime",
  executionLocations: ["local", "worktree"],
};

/** 不会被真正调用的驱动：本文件只测鉴权闸门。 */
const driver: ChannelDriver = {
  protocol: "cli-stdio",
  async start(): Promise<SessionHandle> {
    throw new Error("not used");
  },
  async initialize() {
    return { capabilities: decl.capabilities, source: "declared", version: null, healthStatus: "healthy" };
  },
  async newSession() {
    return { runtimeSessionId: "x" };
  },
  async resumeSession() {
    return { ok: false };
  },
  async prompt() {},
  async cancel() {},
  async respondPermission() {},
  onEvent(_h: SessionHandle, _cb: (e: CanonicalEvent) => void) {},
  onPermission() {},
  onExit() {},
  async dispose() {},
};

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-auth-html-"));
  process.env["AGENTBOT_HOME"] = workDir;
  db = openDb(join(workDir, "agentbot.db"));
  token = ensureToken();

  const bus = createEventBus({ ringSize: 50 });
  const resolveRuntime = () => ({ runtimeId: decl.id, declaration: decl, driver });
  const supervisor = createSupervisor({ db, bus, resolveRuntime, idleReapMs: 0, log: () => undefined });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock: createSessionLock(),
    resolveRuntime,
    supervisor,
  });
  const permissions = createPermissionResolver({
    db,
    bus,
    isSessionAlive: () => true,
    sessionCwdOf: () => workDir,
    respond: async () => true,
    setHeld: () => undefined,
    setSessionStatus: () => undefined,
    log: () => undefined,
  });
  const assignments = createAssignmentRunner({
    db,
    orchestrator,
    isRuntimeAvailable: () => true,
    log: () => undefined,
  });
  app = buildServer(
    {
      db,
      runtimes: [],
      schemaVersion: 1,
      startedAt: Date.now(),
      resolveRuntime: () => ({ runtimeId: decl.id, declaration: decl, driver }),
      orchestrator,
      permissions,
      assignments,
    },
    { authEnabled: true, webRoot: join(workDir, "no-web") },
  );
  base = await listenEphemeral(app);
});

afterAll(async () => {
  await app.close();
  try {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
  delete process.env["AGENTBOT_HOME"];
});

describe("鉴权失败的人机分流", () => {
  it("浏览器导航（Accept: text/html）跳到登录页，而不是 JSON", async () => {
    const res = await fetch(`${base}/bots`, {
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/login\?next=/);
    expect(decodeURIComponent(location)).toContain("/bots");

    const page = await fetch(`${base}${location}`, {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("访问令牌");
    expect(html).toContain('type="password"');
    // 不含任何业务数据，也不回显 token
    expect(html).not.toContain("unauthorized");
    expect(html).not.toContain(token);
  });

  it("/api/* 即使 Accept 含 text/html 也只回 JSON", async () => {
    const res = await fetch(`${base}/api/bots`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("fetch 默认 Accept（*/*）回 JSON，不给人看的页面", async () => {
    const res = await fetch(`${base}/bots`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("带正确 token 的浏览器导航能进 SPA（并种下 cookie）", async () => {
    const res = await fetch(`${base}/bots?t=${encodeURIComponent(token)}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).not.toBe(401);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("agentbot_token=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("429 限流同样给人看的页面（说明稍等再试）", async () => {
    // 连续失败触发锁定
    for (let i = 0; i < 12; i++) {
      await fetch(`${base}/api/bots?t=wrong-token-${i}`);
    }
    const res = await fetch(`${base}/login`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).toContain("暂时锁定");
    expect(html).toContain("60");
  });
});
