import type { DB } from "../db/db.js";
import { requiresWorktree } from "../permissions/worktree-guard.js";

/**
 * 运行时的三个展示/判定查询（HTTP 路由与装配层共用）。
 *
 * 为什么从 `runtime_definitions` 的探测缓存读权限通道，而不是读声明文件：
 * `/api/runtimes` 用的也是同一份数据，两处判定不会漂移；HTTP 层也不必碰
 * adapters 的加载细节。
 */

export function runtimeExists(db: DB, runtimeId: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM runtime_definitions WHERE id = ?").get(runtimeId) !== undefined;
}

export function runtimeRequiresWorktree(db: DB, runtimeId: string | null): boolean {
  if (!runtimeId) return false;
  const row = db
    .prepare("SELECT capabilities FROM runtime_definitions WHERE id = ?")
    .get(runtimeId) as { capabilities: string } | undefined;
  if (!row) return false;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.capabilities) as Record<string, unknown>;
  } catch {
    return false;
  }
  const probe = (parsed["_probe"] ?? {}) as Record<string, unknown>;
  return requiresWorktree({
    permission: {
      channel: typeof probe["permissionChannel"] === "string" ? probe["permissionChannel"] : undefined,
    },
  });
}

export function runtimeDisplayName(db: DB, runtimeId: string | null): string {
  if (!runtimeId) return "该运行时";
  const row = db
    .prepare("SELECT display_name FROM runtime_definitions WHERE id = ?")
    .get(runtimeId) as { display_name: string } | undefined;
  return row?.display_name ?? "该运行时";
}
