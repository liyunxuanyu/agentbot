import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { DB } from "../core/db/db.js";
import type { TurnOrchestrator, TurnRuntime } from "../core/orchestrator/turn.js";
import type { PermissionResolver } from "../core/permissions/resolver.js";
import type { AssignmentRunner } from "../core/assignment/runner.js";
import type { Scheduler } from "../core/scheduling/scheduler.js";
import type { Summarizer } from "../core/memory/summarizer.js";
import type { AdapterDeclaration, CompactionResult, PromptControls } from "../adapters/contract.js";
import type { McpManager } from "../adapters/mcp/manager.js";
import {
  authLockRemainingMs,
  clearAuthFailures,
  cookieSecure,
  currentToken,
  extractToken,
  recordAuthFailure,
  tokenCookie,
  verifyToken,
} from "./auth.js";
import { registerRoutes } from "./routes/index.js";
import { loginPage, nextFromUrl, registerLoginRoutes } from "./login.js";

/**
 * HTTP 入口。
 *
 * 两条路径互不干扰：
 *   /api/health —— 唯一免鉴权端点，只回 {ok:true}，用于探活；
 *   其余一切（含静态资源）—— 先过 token 钩子，失败 401 且不带任何业务数据。
 *
 * 登录页（`/login`）与退出（`/logout`、`/api/auth/logout`）同样免鉴权：
 * 前者是拿 token 换 cookie 的唯一入口，后者只删凭证。
 *
 * 静态资源在首页带 `?t=` 打开时会随响应种下 HttpOnly cookie，
 * 之后的 <script>/<link> 请求自动带上，所以资源也走同一道闸。
 */

/** 无需 token 的路径（登录/登出/探活）。只按路径判断，不按方法。 */
function isPublicPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/login" ||
    path === "/logout" ||
    path === "/api/auth/logout"
  );
}

/**
 * 浏览器地址栏直接访问（而非 fetch/XHR/EventSource）时，401 应给人看的页面。
 *
 * 判据只看 `Accept` 是否偏好 HTML：地址栏导航会带 `text/html`，
 * 而前端的 fetch 默认通配、EventSource 是 `text/event-stream`，都不受影响。
 * 这样 API 仍然只回 JSON（P0-14「不含任何业务数据」），人也不会撞见一屏 JSON。
 */
function wantsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("text/html")) return false;
  // /api/* 永远回 JSON：那里是程序读的，不是人读的
  return !req.url.split("?")[0]!.startsWith("/api/");
}

export interface ServerContext {
  db: DB;
  /** 运行时列表（探测结果），M4 起为真实数据。 */
  runtimes: RuntimeSummary[];
  schemaVersion: number;
  startedAt: number;
  /**
   * 按 Bot 解析运行时绑定（声明 + 驱动）。
   * 由 `main.ts` 注入，避免 http 层 import adapter 工厂而绕开装配顺序。
   */
  resolveRuntime: (botId: string) => TurnRuntime | null;
  /** 编排器：发消息与取消的唯一入口。 */
  orchestrator: TurnOrchestrator;
  /** 权限裁决：卡片状态读取与用户决策的唯一入口。 */
  permissions: PermissionResolver;
  /**
   * 生成中更新会话控制项（内置引擎）。缺省时只落库、下次 spawn 生效。
   * 由装配层从 Supervisor 注入 —— http 层不持有进程表。
   */
  setSessionControls?: (sessionId: string, controls: PromptControls) => void;
  /**
   * 手动压缩上下文（内置引擎）。进程不在 / 通道不支持时返回 null。
   */
  compactSession?: (sessionId: string, opts: { force?: boolean }) => Promise<CompactionResult | null>;
  /** Assignment 队列与执行（M11）。 */
  assignments: AssignmentRunner;
  /**
   * 定时任务调度器（M12）。缺省时 `/api/schedules` 仍可读写，但列表里
   * `schedulerRunning=false`，前端显示「定时任务可能不会触发」。
   */
  scheduler?: Scheduler;
  /** 群聊主持人决策超时（测试注入更短的值；缺省见 group/host）。 */
  groupDecisionTimeoutMs?: number;
  /** 群聊单个发言人超时（0/缺省 = 只等运行时自己结束）。 */
  groupSpeakerTimeoutMs?: number;
  /**
   * 自动摘要（M7）。缺省时由 `registerMemoryRoutes` 用 `ctx.db` 建一个默认实例
   * （纯 DB 操作，无状态），因此老测试不必改动。
   */
  summarizer?: Summarizer;
  /**
   * 运行时倍率提示（M13）：返回 `modes.multiplierHint`，未声明返回 null。
   * 由装配层从 adapter 声明注入 —— core 不依赖 adapters（分离铁律）。
   */
  runtimeMultiplier?: (runtimeId: string | null) => number | null;
  /**
   * 已加载的 adapter 声明（声明 id → 声明），供单运行时重探用（P0-01 重试按钮）。
   *
   * 由 `main.ts` 注入：内置运行时来自 YAML，自定义运行时从
   * `runtime_definitions.capabilities._declaration` 读回。http 层不自己读文件，
   * 也不自己选驱动 —— 声明与驱动的解析只有一个来源。
   *
   * 缺省时 `/api/runtimes/:id/probe` 只对自定义运行时生效（声明在库里），
   * 内置运行时回 `409 declaration_missing`，不假装探测成功。
   */
  declarations?: ReadonlyMap<string, AdapterDeclaration>;
  /**
   * 供应商配置变化后的回调（新增/修改/删除/设默认）。
   * 内置引擎的可用性取决于是否至少配置了一个供应商；装配层用它刷新
   * `runtime_definitions` 里 builtin 行的 health_status。
   */
  onProvidersChanged?: () => void;
  /** MCP server 管理器（N4）；缺省时 /api/mcp 返回空列表。 */
  mcp?: McpManager;
}

/** `/api/meta` 里的运行时摘要：形状对齐 `src/web/net/types.ts` 的 RuntimeSummary。 */
export interface RuntimeSummary {
  id: string;
  displayName: string;
  protocol: string;
  version: string | null;
  healthStatus: string;
  capabilitiesSource: "probed" | "declared";
  capabilities?: {
    plan: boolean | null;
    permission: boolean | null;
    resume: boolean | null;
    contextWindow: number | null;
    streaming: boolean;
  };
}

export interface BuildServerOptions {
  /** 生产静态目录；默认按产物位置推 dist/web。不存在则不注册静态服务（开发态交给 Vite）。 */
  webRoot?: string;
  /** 测试时可关掉鉴权。 */
  authEnabled?: boolean;
}

/**
 * 生产静态目录默认值：以本文件位置为准推 `dist/web`，不依赖 cwd。
 * 打包后 dist/server.js 同目录即 dist/web；开发态从 src/server/http 上溯三层。
 */
function defaultWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "web"), // 打包后：dist/web
    resolve(here, "../../../dist/web"), // 开发态：src/server/http → 项目根/dist/web
    resolve(process.cwd(), "dist/web"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return candidates[0] ?? resolve(process.cwd(), "dist/web");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function clientSource(req: FastifyRequest): string {
  return req.ip || "unknown";
}

/** 静态资源：命中即返回文件，未命中交给 SPA 兜底。 */
function serveStatic(
  root: string,
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const urlPath = (req.url.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // 非法百分号编码：当作未命中，交上层回 404，不抛 500
    return false;
  }
  const rel = urlPath === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(root, normalize(rel));

  // 目录穿越防护：解析后必须仍在 webRoot 内
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return false;

  let filePath = target;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // /api/ 下未命中就是 404，绝不回落 SPA：否则打错端点会拿到 200 的 HTML
    if (urlPath === "/api" || urlPath.startsWith("/api/")) return false;
    // 非 API 的未知路径回落到 index.html（前端路由接管）
    filePath = join(rootResolved, "index.html");
    if (!existsSync(filePath)) return false;
  }

  const ext = extname(filePath).toLowerCase();
  reply
    .code(200)
    .header("content-type", MIME[ext] ?? "application/octet-stream")
    .header("cache-control", ext === ".html" ? "no-store" : "public, max-age=31536000, immutable");
  reply.send(readFileSync(filePath));
  return true;
}

export function buildServer(ctx: ServerContext, opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    // 本地单用户服务，不做 X-Forwarded-For 解析，避免伪造来源绕过限流
    trustProxy: false,
  });

  const authEnabled = opts.authEnabled ?? true;
  const webRoot = opts.webRoot ?? defaultWebRoot();
  const staticEnabled = existsSync(join(webRoot, "index.html"));

  // 鉴权开着却没有 token，等于把整个服务锁死；这种装配错误要立刻暴露
  if (authEnabled && currentToken() === null) {
    throw new Error("buildServer：鉴权已启用但 token 未初始化，请先调用 ensureToken()");
  }

  // ---- 鉴权前置钩子（P0-14）----
  app.addHook("onRequest", (req, reply, done) => {
    if (!authEnabled) return done();
    const path = req.url.split("?")[0] ?? "/";
    // 探活与登录/登出免鉴权：它们要么不含业务数据，要么就是拿来换 cookie 的
    if (isPublicPath(path)) return done();

    const source = clientSource(req);
    const locked = authLockRemainingMs(source);
    if (locked > 0) {
      // 连续失败已达上限：60s 内一律 429，连 token 都不再比对
      const retry = Math.ceil(locked / 1000);
      if (wantsHtml(req)) {
        // 人读的页面：给登录页并说明限流原因，而不是一屏 JSON
        reply
          .code(429)
          .header("retry-after", String(retry))
          .header("cache-control", "no-store")
          .header("content-type", "text/html; charset=utf-8")
          .send(loginPage({ next: nextFromUrl(req.url), lockedSeconds: retry }));
      } else {
        reply
          .code(429)
          .header("retry-after", String(retry))
          .header("content-type", "application/json; charset=utf-8")
          .send({ error: "too_many_requests" });
      }
      return done();
    }

    const query = req.query as Record<string, unknown>;
    const headers = req.headers as unknown as Record<string, unknown>;
    const token = extractToken(headers, query);

    if (!verifyToken(token)) {
      recordAuthFailure(source);
      if (wantsHtml(req)) {
        // 浏览器导航：送去登录页，登录成功后回到原地址（保留路径与查询串）
        reply
          .code(302)
          .header("location", `/login?next=${encodeURIComponent(nextFromUrl(req.url))}`)
          .header("cache-control", "no-store")
          .send("");
      } else {
        reply
          .code(401)
          .header("content-type", "application/json; charset=utf-8")
          .send({ error: "unauthorized" });
      }
      return done();
    }

    clearAuthFailures(source);
    // 首次带 ?t= 访问：种下持久 HttpOnly cookie，后续 fetch/EventSource 都用它
    if (typeof query["t"] === "string") {
      reply.header("set-cookie", tokenCookie(token as string, cookieSecure(req.protocol)));
    }
    return done();
  });

  // 登录表单提交是 application/x-www-form-urlencoded（浏览器原生表单，无 JS 也能用）
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const params = new URLSearchParams(String(body));
      const parsed: Record<string, string> = {};
      for (const [k, v] of params) parsed[k] = v;
      done(null, parsed);
    },
  );

  // 登录/登出（免鉴权，见 isPublicPath）
  registerLoginRoutes(app, { authEnabled });

  // ---- 路由 ----
  registerRoutes(app, ctx);

  // ---- 静态资源（仅生产构建存在时）----
  if (staticEnabled) {
    app.get("/*", (req, reply) => {
      // serveStatic 对 /api/* 未命中一律返回 false，由这里统一回 404
      if (serveStatic(webRoot, req, reply)) return reply;
      reply.code(404).header("content-type", "application/json; charset=utf-8").send({ error: "not_found" });
      return reply;
    });
  }

  // 统一 404：未命中的方法/路径也回 JSON，不返回空体
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).header("content-type", "application/json; charset=utf-8").send({ error: "not_found" });
  });

  // 统一错误处理：不把堆栈吐给客户端
  app.setErrorHandler((err: Error, _req, reply) => {
    console.error("[http] 未处理错误:", err.message);
    reply
      .code(500)
      .header("content-type", "application/json; charset=utf-8")
      .send({ error: "internal_error" });
  });

  return app;
}

/** 控制台打印带 token 的访问 URL（P0-14）。 */
export function accessUrl(token: string): string {
  return `http://${config.http.host}:${config.http.port}/?t=${token}`;
}
