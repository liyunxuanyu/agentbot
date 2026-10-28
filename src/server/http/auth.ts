import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { config } from "../config.js";

let cachedToken: string | null = null;

/**
 * 32 字节随机 token，写入仅当前用户可读的文件。
 * Windows 没有 chmod 语义，用 icacls 去掉继承并只授当前用户；失败只记 warning，不阻断启动。
 */
export function ensureToken(): string {
  if (cachedToken) return cachedToken;

  if (existsSync(config.tokenPath)) {
    const existing = readFileSync(config.tokenPath, "utf8").trim();
    if (existing.length >= 32) {
      cachedToken = existing;
      return existing;
    }
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(config.tokenPath), { recursive: true });
  writeFileSync(config.tokenPath, token, { encoding: "utf8", mode: 0o600 });
  hardenPermissions(config.tokenPath);
  cachedToken = token;
  return token;
}

export function resetToken(): string {
  cachedToken = null;
  return ensureToken();
}

export function currentToken(): string | null {
  return cachedToken;
}

function hardenPermissions(path: string): void {
  if (process.platform === "win32") {
    try {
      const user = process.env.USERNAME;
      if (!user) return;
      execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 权限加固失败不应阻断启动，但要让用户知道
      console.warn("[auth] 无法收紧 token 文件权限（icacls 失败），文件仍为当前用户可读");
    }
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    console.warn("[auth] 无法 chmod token 文件");
  }
}

/** 常量时间比较，避免按字节提前返回泄露信息。 */
export function verifyToken(candidate: string | undefined | null): boolean {
  if (!candidate || !cachedToken) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(cachedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 从 `?t=` 或 cookie 取 token。 */
export function extractToken(headers: Record<string, unknown>, query: Record<string, unknown>): string | null {
  const q = query["t"];
  if (typeof q === "string" && q.length > 0) return q;

  const cookie = headers["cookie"];
  if (typeof cookie === "string") {
    const m = /(?:^|;\s*)agentbot_token=([^;]+)/.exec(cookie);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** 登录态 cookie 的有效期：30 天。持久 cookie，浏览器重启后仍在。 */
export const TOKEN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * 是否给 cookie 加 `Secure`。
 *
 * 本地服务默认走 http://127.0.0.1，加 Secure 会让浏览器直接丢弃 cookie
 * （登录页看似成功、刷新又回到登录页）。所以默认只在 HTTPS 或
 * `NODE_ENV=production` 时开启，并允许用环境变量显式覆盖：
 *   AGENTBOT_COOKIE_SECURE=1  强制开启（反向代理终止 TLS 时用）
 *   AGENTBOT_COOKIE_SECURE=0  强制关闭（本机以 NODE_ENV=production 跑 http 时）
 */
export function cookieSecure(protocol?: string): boolean {
  const override = process.env["AGENTBOT_COOKIE_SECURE"];
  if (override === "1") return true;
  if (override === "0") return false;
  if (protocol === "https") return true;
  return process.env["NODE_ENV"] === "production";
}

/** 持久登录 cookie：HttpOnly（JS 读不到）+ SameSite=Strict（跨站带不上）。 */
export function tokenCookie(token: string, secure: boolean = cookieSecure()): string {
  const parts = [
    `agentbot_token=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${TOKEN_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** 退出登录：让浏览器立即删除 cookie（属性必须与种下时一致）。 */
export function clearTokenCookie(secure: boolean = cookieSecure()): string {
  const parts = [
    "agentbot_token=",
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * 鉴权失败限流（P0-14）：同一来源连续 10 次失败 → 60s 内一律 429。
 * 成功一次即清零，避免正常用户被自己手误锁死。
 */
export const AUTH_FAIL_LIMIT = 10;
export const AUTH_LOCK_MS = 60_000;

interface FailureRecord {
  count: number;
  lockedUntil: number;
}

const failures = new Map<string, FailureRecord>();

/** 返回剩余锁定毫秒数；0 表示未锁定。 */
export function authLockRemainingMs(source: string, nowMs: number = Date.now()): number {
  const rec = failures.get(source);
  if (!rec) return 0;
  const remain = rec.lockedUntil - nowMs;
  if (remain <= 0) {
    // 锁已过期，连计数一起清掉，给一次全新的机会
    if (rec.lockedUntil !== 0) failures.delete(source);
    return 0;
  }
  return remain;
}

/** 记一次失败，返回是否已触发锁定。 */
export function recordAuthFailure(source: string, nowMs: number = Date.now()): boolean {
  const rec = failures.get(source) ?? { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= AUTH_FAIL_LIMIT) {
    rec.lockedUntil = nowMs + AUTH_LOCK_MS;
    rec.count = 0;
    failures.set(source, rec);
    return true;
  }
  failures.set(source, rec);
  return false;
}

export function clearAuthFailures(source: string): void {
  failures.delete(source);
}

