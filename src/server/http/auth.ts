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

export function tokenCookie(token: string): string {
  // SameSite=Strict + HttpOnly：同机其他程序既拿不到也带不上
  return `agentbot_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
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

