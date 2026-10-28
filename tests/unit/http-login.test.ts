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
import { clearAuthFailures, cookieSecure, ensureToken, tokenCookie } from "../../src/server/http/auth.js";
import { loginPage, nextFromUrl, safeNext } from "../../src/server/http/login.js";
import type { AdapterDeclaration, ChannelDriver, SessionHandle } from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * 登录页与持久登录态。
 *
 * 覆盖任务要求的四条主线：
 *   ① 未登录访问受保护页面 → 登录页；
 *   ② 输入正确 token → 种持久 HttpOnly cookie；
 *   ③ 之后带 cookie 不再需要 `?t=`；刷新（重新请求）仍有效；
 *   ④ 退出登录 → cookie 被清除，恢复要求登录。
 *
 * 另外覆盖安全边界：不回显 token、开放重定向、错误 token 不种 cookie、
 * 锁定期间禁用表单、`?t=` 向后兼容。
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
  workDir = mkdtempSync(join(tmpdir(), "agentbot-login-"));
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

/** 从 Set-Cookie 里取 `name=value`（fetch 不维护 cookie jar，手动回带）。 */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

describe("登录页", () => {
  it("未登录访问受保护页面 → 302 到 /login 并保留回跳地址", async () => {
    const res = await fetch(`${base}/chat/c1?foo=bar`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/login?next=")).toBe(true);
    expect(decodeURIComponent(location)).toContain("/chat/c1?foo=bar");
  });

  it("登录页可匿名打开，含 token 输入框与说明，且不回显 token", async () => {
    const res = await fetch(`${base}/login`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('name="token"');
    expect(html).toContain("~/.agentbot/token");
    expect(html).toContain("30 天");
    expect(html).not.toContain(token);
  });

  it("错误 token：401 回登录页，不种 cookie，错误文案不回显输入", async () => {
    clearAuthFailures("127.0.0.1");
    const wrong = "definitely-not-the-token";
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: form({ token: wrong }),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("令牌不正确");
    expect(html).not.toContain(wrong);
  });

  it("正确 token：303 回原页面，种下持久 HttpOnly cookie", async () => {
    clearAuthFailures("127.0.0.1");
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: form({ token, next: "/chat/c1?foo=bar" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/chat/c1?foo=bar");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("agentbot_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toMatch(/Max-Age=\d+/);
    // 本地 http 默认不加 Secure（否则浏览器会丢弃 cookie）
    expect(setCookie).not.toContain("Secure");
  });

  it("带 cookie 访问 API 与页面，不再需要 ?t=", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ token }),
      redirect: "manual",
    });
    const cookie = cookiePair(login.headers.get("set-cookie") ?? "");
    expect(cookie).toContain("agentbot_token=");

    const api = await fetch(`${base}/api/meta`, { headers: { cookie } });
    expect(api.status).toBe(200);
    const meta = (await api.json()) as { version: string };
    expect(typeof meta.version).toBe("string");

    // 「刷新」= 重新发一次页面请求，依然 200
    const page = await fetch(`${base}/bots`, {
      headers: { cookie, accept: "text/html" },
      redirect: "manual",
    });
    expect(page.status).not.toBe(401);
    expect(page.status).not.toBe(302);
  });

  it("退出登录：清 cookie，之后恢复要求登录", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ token }),
      redirect: "manual",
    });
    const cookie = cookiePair(login.headers.get("set-cookie") ?? "");

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(204);
    const cleared = logout.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("agentbot_token=;");
    expect(cleared).toContain("Max-Age=0");

    // 浏览器按 Max-Age=0 删除 cookie 后，后续请求不再带它 → 又是未登录
    const after = await fetch(`${base}/bots`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(after.status).toBe(302);
    expect(after.headers.get("location") ?? "").toContain("/login");
  });

  it("无 JS 的退出表单：POST /logout → 303 回登录页", async () => {
    const res = await fetch(`${base}/logout`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("已登录再打开 /login 直接回站内页面（不重复登录）", async () => {
    const cookie = cookiePair(tokenCookie(token, false));
    const res = await fetch(`${base}/login?next=/bots`, {
      headers: { cookie, accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/bots");
  });

  it("?t= 老链接仍可用：/login?t= 直接放行并种持久 cookie", async () => {
    const res = await fetch(`${base}/login?t=${encodeURIComponent(token)}&next=/usage`, {
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/usage");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("agentbot_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toMatch(/Max-Age=\d+/);
  });

  it("next 不允许跳出站外（开放重定向防护）", async () => {
    clearAuthFailures("127.0.0.1");
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ token, next }),
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("回跳地址会剥掉 ?t=（避免带着错误 token 打转）", () => {
    expect(nextFromUrl("/bots?t=old&x=1")).toBe("/bots?x=1");
    expect(nextFromUrl("/bots?t=old")).toBe("/bots");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
  });

  it("回跳目标不会指回 /login 或 /logout（否则登录后原地打转）", () => {
    expect(nextFromUrl("/login")).toBe("/");
    expect(nextFromUrl("/login?next=/bots")).toBe("/");
    expect(nextFromUrl("/logout")).toBe("/");
  });

  it("地址栏残留旧 ?t= 但 cookie 有效：仍然放行（cookie 优先）", async () => {
    const cookie = cookiePair(tokenCookie(token, false));
    const res = await fetch(`${base}/api/meta?t=stale-token-from-old-session`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });
});

describe("登录页限流", () => {
  it("连续失败后表单禁用并说明稍后再试", async () => {
    clearAuthFailures("127.0.0.1");
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ token: `wrong-${i}` }),
        redirect: "manual",
      });
      last = res.status;
    }
    expect(last).toBe(429);

    // 锁定期间即使 token 正确也不放行，且不种 cookie
    const correct = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ token }),
      redirect: "manual",
    });
    expect(correct.status).toBe(429);
    expect(correct.headers.get("set-cookie")).toBeNull();
    const html = await correct.text();
    expect(html).toContain("暂时锁定");
    expect(html).toContain('disabled');

    clearAuthFailures("127.0.0.1");
  });
});

describe("cookie 属性", () => {
  it("HTTPS / 生产环境加 Secure，本地 http 默认不加", () => {
    const saved = { secure: process.env["AGENTBOT_COOKIE_SECURE"], nodeEnv: process.env["NODE_ENV"] };
    try {
      delete process.env["AGENTBOT_COOKIE_SECURE"];
      delete process.env["NODE_ENV"];
      expect(cookieSecure("http")).toBe(false);
      expect(cookieSecure("https")).toBe(true);
      process.env["NODE_ENV"] = "production";
      expect(cookieSecure("http")).toBe(true);

      process.env["AGENTBOT_COOKIE_SECURE"] = "0";
      expect(cookieSecure("https")).toBe(false);
      process.env["AGENTBOT_COOKIE_SECURE"] = "1";
      delete process.env["NODE_ENV"];
      expect(cookieSecure("http")).toBe(true);
    } finally {
      if (saved.secure === undefined) delete process.env["AGENTBOT_COOKIE_SECURE"];
      else process.env["AGENTBOT_COOKIE_SECURE"] = saved.secure;
      if (saved.nodeEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = saved.nodeEnv;
    }
    expect(tokenCookie("abc", true)).toContain("Secure");
    expect(tokenCookie("abc", false)).not.toContain("Secure");
    expect(tokenCookie("abc", true)).toContain("HttpOnly");
  });

  it("登录页 HTML 转义回跳地址（防注入）", () => {
    const html = loginPage({ next: '/x"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
