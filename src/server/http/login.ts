import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  authLockRemainingMs,
  clearAuthFailures,
  clearTokenCookie,
  cookieSecure,
  cookieToken,
  recordAuthFailure,
  tokenCookie,
  verifyToken,
} from "./auth.js";

/**
 * 登录页（P0-14 的可用性补充）。
 *
 * 背景：此前只能把控制台打印的 `?t=<token>` 拼到地址栏，用户每次换设备/清
 * cookie 都要去找那条 URL。现在提供一个服务端渲染的登录页：
 *
 *   GET  /login            → 登录表单（免鉴权，页面本身不含任何业务数据）
 *   POST /login            → 校验 token，成功种持久 HttpOnly cookie 后 303 回原页面
 *   POST /api/auth/logout  → 清除 cookie（免鉴权：只删凭证，不读数据）
 *   POST /logout           → 同上，但 303 回登录页（无 JS 时的兜底）
 *
 * 为什么是服务端渲染而不是 Vue 路由页：`http/server.ts` 的鉴权钩子覆盖**所有**
 * 路径（含静态资源），未登录时 SPA 的 index.html 与 JS 包都拿不到，前端路由页
 * 根本没机会渲染。把登录页放在钩子之外、且完全内联样式/脚本，是最小且自洽的做法。
 *
 * 安全约定：
 *   - 页面不回显任何 token（连脱敏预览都不显示），错误信息只说「不正确」；
 *   - cookie 为 HttpOnly + SameSite=Strict + 持久 Max-Age（见 auth.ts）；
 *   - `next` 只接受站内绝对路径，防止开放重定向；
 *   - 失败次数沿用 auth.ts 的限流（10 次 / 60s），与 API 鉴权共享计数。
 */

const LOCK_HINT = "连续失败次数过多，本机来源已被临时限流。";

/** 只允许站内路径，杜绝 `//evil.com` 与 `\` 变体。 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("\r") || raw.includes("\n")) {
    return "/";
  }
  return raw;
}

/**
 * 站内回跳地址：在 `safeNext` 基础上剥掉 `t` 参数。
 *
 * 原因：未登录访问 `/bots?t=错误值` 会被送到 `/login?next=/bots%3Ft%3D错误值`，
 * 登录成功后再带着这个错误 token 回跳，会立刻再次 401 → 又被送回登录页，形成
 * 死循环。`t` 只是鉴权参数，回跳时不需要它。
 */
export function nextFromUrl(raw: unknown): string {
  const path = safeNext(raw);
  // 回跳目标本身是登录/登出会成环：GET /login 带 cookie 时又 303 回 /login…
  if (path === "/login" || path.startsWith("/login?") || path.startsWith("/logout")) {
    return "/";
  }
  const qIndex = path.indexOf("?");
  if (qIndex < 0) return path;
  const base = path.slice(0, qIndex);
  const params = new URLSearchParams(path.slice(qIndex + 1));
  params.delete("t");
  const rest = params.toString();
  return rest ? `${base}?${rest}` : base;
}

function clientSource(req: FastifyRequest): string {
  return req.ip || "unknown";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface LoginPageOptions {
  /** 登录成功后回到哪里（站内路径）。 */
  next?: string;
  /** 错误文案（不含任何 token 内容）。 */
  error?: string;
  /** 被限流时剩余秒数；有值时表单禁用。 */
  lockedSeconds?: number;
}

/** 登录页 HTML。样式与 `http/server.ts` 的 401 页同一套视觉语言。 */
export function loginPage(opts: LoginPageOptions = {}): string {
  const next = safeNext(opts.next ?? "/");
  const locked = typeof opts.lockedSeconds === "number" && opts.lockedSeconds > 0;
  const error = opts.error ?? (locked ? `${LOCK_HINT}请 ${opts.lockedSeconds} 秒后再试。` : "");
  const errorHtml = error
    ? `<div class="err" role="alert">${escapeHtml(error)}</div>`
    : "";
  const disabled = locked ? " disabled" : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · AgentBot</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #F6F8FA; color: #16202B;
    font-family: -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    line-height: 1.6;
  }
  .card {
    width: min(400px, calc(100vw - 48px)); margin: 24px; padding: 32px;
    background: #FFFFFF; border-radius: 14px;
    box-shadow: 0 1px 2px rgba(22,32,43,.05), 0 2px 8px rgba(22,32,43,.04);
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .brand-mark { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; width: 28px; height: 28px; }
  .brand-mark i { border-radius: 3px; background: #0C7A8F; }
  .brand-mark i:nth-child(2) { opacity: .62; }
  .brand-mark i:nth-child(3) { opacity: .38; }
  .brand-mark i:nth-child(4) { opacity: .82; }
  .brand-name { font-size: 16px; font-weight: 800; letter-spacing: -.01em; line-height: 1.1; }
  .brand-sub { font-size: 11px; color: #5A6B7A; margin-top: 2px; }
  h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -.01em; }
  p { margin: 0 0 12px; color: #3D4E5C; font-size: 14px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #5A6B7A; margin-bottom: 6px; }
  input[type=password] {
    width: 100%; box-sizing: border-box; height: 42px; padding: 0 14px;
    border: 1px solid #C6D0D8; border-radius: 8px; background: #FFFFFF;
    font-family: inherit; font-size: 14px; color: #16202B;
  }
  input[type=password]:focus { outline: none; border-color: #0C7A8F; box-shadow: 0 0 0 3px rgba(12,122,143,.28); }
  button {
    width: 100%; height: 42px; margin-top: 14px; border: 0; border-radius: 8px;
    background: #0C7A8F; color: #FFFFFF; font: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #096775; }
  button:disabled { background: #B9C6CE; cursor: not-allowed; }
  .err {
    margin: 0 0 14px; padding: 10px 12px; border-radius: 8px;
    background: #FDECEA; color: #96291F; font-size: 13px;
  }
  .hint { font-size: 12px; color: #5A6B7A; margin-top: 16px; line-height: 1.7; }
  code {
    padding: 1px 5px; border-radius: 4px; background: #EEF2F5;
    font-family: "SF Mono", "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 11.5px; word-break: break-all;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #11161B; color: #E9EEF2; }
    .card { background: #1A2129; box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 2px 8px rgba(0,0,0,.28); }
    p { color: #C2CDD6; }
    label { color: #9AA9B6; }
    input[type=password] { background: #0C1014; border-color: #3A4653; color: #E9EEF2; }
    .err { background: #3A1D1A; color: #F2B8B0; }
    .hint { color: #9AA9B6; }
    code { background: #0C1014; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span>
        <span class="brand-name">AgentBot</span>
        <span class="brand-sub">本地工作台</span>
      </span>
    </div>
    <h1>登录</h1>
    <p>输入访问令牌以打开工作台。登录后这台浏览器会被记住 30 天，不用再拼 token。</p>
    ${errorHtml}
    <form method="post" action="/login" autocomplete="off">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <label for="token">访问令牌</label>
      <input
        id="token" name="token" type="password"
        placeholder="粘贴启动服务时控制台打印的令牌"
        autocomplete="off" autocapitalize="off" spellcheck="false"${disabled}
        required autofocus
      >
      <button type="submit"${disabled}>${locked ? "暂时锁定" : "登录"}</button>
    </form>
    <p class="hint">
      令牌在服务启动时的控制台里打印过（形如 <code>?t=…</code> 里的那串字符），
      也可以查看 <code>~/.agentbot/token</code> 文件。旧的 <code>?t=</code> 访问方式仍然有效。
    </p>
  </div>
  <script>
    // 清掉前端可能残留的旧 token：它会被拼进每个请求的 ?t=，并在服务端优先于
    // cookie 校验。token 重置后旧副本会让「刚用新 token 登录」立刻又 401。
    try { sessionStorage.removeItem("agentbot.token"); } catch (e) {}
  </script>
</body>
</html>`;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
}

function html(reply: FastifyReply, code: number, body: string): FastifyReply {
  return noStore(reply).code(code).header("content-type", "text/html; charset=utf-8").send(body);
}

/** 登录表单的 body（由 buildServer 注册的 urlencoded 解析器产出）。 */
function bodyField(req: FastifyRequest, key: string): string | null {
  const body = req.body;
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export interface LoginRoutesOptions {
  authEnabled: boolean;
}

/**
 * 注册登录/登出路由。必须在 `buildServer` 里、与鉴权钩子的豁免名单配套调用。
 */
export function registerLoginRoutes(app: FastifyInstance, opts: LoginRoutesOptions): void {
  const { authEnabled } = opts;

  app.get("/login", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authEnabled) return reply.redirect("/", 303);
    const query = req.query as Record<string, unknown>;
    const next = nextFromUrl(query["next"]);

    // 已经登录（cookie 或 ?t=）就直接放行；带 ?t= 时顺手种下持久 cookie。
    // 这让 `?t=` 老链接依然能「一次登录、长期记住」。
    // 优先级：有效 cookie > ?t=。这样地址栏里残留一个过期 token 时，
    // 已登录的浏览器不会被重新拦到登录页。
    const fromQuery = typeof query["t"] === "string" ? (query["t"] as string) : null;
    const cookieValue = cookieToken(req.headers as unknown as Record<string, unknown>);

    if (verifyToken(cookieValue)) {
      clearAuthFailures(clientSource(req));
      return reply.redirect(next, 303);
    }
    if (fromQuery && verifyToken(fromQuery)) {
      clearAuthFailures(clientSource(req));
      reply.header("set-cookie", tokenCookie(fromQuery, cookieSecure(req.protocol)));
      return reply.redirect(next, 303);
    }

    const lockedMs = authLockRemainingMs(clientSource(req));
    if (lockedMs > 0) {
      return html(
        reply,
        429,
        loginPage({ next, lockedSeconds: Math.ceil(lockedMs / 1000) }),
      );
    }
    return html(reply, 200, loginPage({ next }));
  });

  app.post("/login", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authEnabled) return reply.redirect("/", 303);
    const next = nextFromUrl(bodyField(req, "next"));
    const source = clientSource(req);

    const lockedMs = authLockRemainingMs(source);
    if (lockedMs > 0) {
      return html(reply, 429, loginPage({ next, lockedSeconds: Math.ceil(lockedMs / 1000) }));
    }

    const token = bodyField(req, "token")?.trim() ?? "";
    if (!token || !verifyToken(token)) {
      const locked = recordAuthFailure(source);
      if (locked) {
        return html(
          reply,
          429,
          loginPage({ next, lockedSeconds: Math.ceil(authLockRemainingMs(source) / 1000) }),
        );
      }
      return html(reply, 401, loginPage({ next, error: "令牌不正确，请检查后重试。" }));
    }

    clearAuthFailures(source);
    reply.header("set-cookie", tokenCookie(token, cookieSecure(req.protocol)));
    return reply.redirect(next, 303);
  });

  // 退出登录：只清凭证、不读业务数据，所以免鉴权 —— cookie 已失效时也能干净退出。
  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("set-cookie", clearTokenCookie(cookieSecure(req.protocol)));
    return reply.code(204).send();
  });

  app.post("/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("set-cookie", clearTokenCookie(cookieSecure(req.protocol)));
    return reply.redirect("/login", 303);
  });
}
