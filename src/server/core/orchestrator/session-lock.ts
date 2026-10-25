/**
 * Session 串行锁（P0-15 边界「同一 Bot 两标签页同时发消息：以 Session 为锁串行，
 * 第二个显示『排队中』」）。
 *
 * 为什么是内存锁而不是数据库行锁：单进程本地服务（架构 §1 明确不引入 Redis/队列）。
 * 但**排队位次落库**：`sessions.status` 由调用方写，重启后锁由 status 重建。
 *
 * 语义：
 *   - `acquire()` 立刻拿到 → `{ ok: true }`
 *   - 已被占用 → `{ ok: false, position }`，position 是「前面还有几个」（1 起）
 *   - 持锁方 `release()` 后，等待队列里最老的自动获得锁
 *   - 等待方可以被取消（浏览器断开、用户点停止），不占队列
 *
 * 这里刻意不做「自动重试」：P0-15 要求第二个请求**立刻**返回「排队中」，
 * 由前端决定什么时候重发，服务端不替它等。
 */

export type LockResult = { ok: true } | { ok: false; position: number };

interface Waiter {
  id: string;
  /** 被取消时从队列里摘掉。 */
  cancelled: boolean;
  /** 拿到锁时 resolve（由 release 触发）。 */
  grant: () => void;
}

interface Entry {
  ownerId: string;
  waiters: Waiter[];
}

export interface SessionLock {
  /** 尝试获得锁；已占用则返回排队位次（不阻塞）。 */
  tryAcquire(sessionId: string, ownerId: string): LockResult;
  /** 释放并让队列头部接棒；返回是否真的释放了（非持有者调用返回 false）。 */
  release(sessionId: string, ownerId: string): boolean;
  /** 排队并等待接棒；返回的 promise 在拿到锁时 resolve。 */
  wait(sessionId: string, ownerId: string): { position: number; granted: Promise<void>; cancel: () => void };
  /** 当前持有者（无则 null）。 */
  ownerOf(sessionId: string): string | null;
  /** 排队人数（不含持有者）。 */
  queueLength(sessionId: string): number;
  /** 清空（测试与关服）。 */
  reset(): void;
}

export function createSessionLock(): SessionLock {
  const entries = new Map<string, Entry>();

  function entryOf(sessionId: string): Entry | null {
    return entries.get(sessionId) ?? null;
  }

  return {
    tryAcquire(sessionId, ownerId) {
      const entry = entryOf(sessionId);
      if (!entry || entry.ownerId === ownerId) {
        entries.set(sessionId, { ownerId, waiters: [] });
        return { ok: true };
      }
      // 位次 = 前面的人数（含持有者）→ 前端显示「前面还有 N 个」
      const active = entry.waiters.filter((w) => !w.cancelled).length;
      return { ok: false, position: active + 1 };
    },

    release(sessionId, ownerId) {
      const entry = entryOf(sessionId);
      if (!entry || entry.ownerId !== ownerId) return false;
      // 摘掉已取消的等待者，让下一个活人接棒
      let next: Waiter | undefined;
      while (entry.waiters.length > 0) {
        const w = entry.waiters.shift();
        if (w && !w.cancelled) {
          next = w;
          break;
        }
      }
      if (next) {
        entry.ownerId = next.id;
        next.grant();
        return true;
      }
      entries.delete(sessionId);
      return true;
    },

    wait(sessionId, ownerId) {
      let entry = entryOf(sessionId);
      if (!entry) {
        entry = { ownerId, waiters: [] };
        entries.set(sessionId, entry);
      }
      let resolveGrant: () => void = () => undefined;
      const granted = new Promise<void>((resolve) => {
        resolveGrant = resolve;
      });
      const waiter: Waiter = { id: ownerId, cancelled: false, grant: resolveGrant };
      entry.waiters.push(waiter);
      const position = entry.waiters.filter((w) => !w.cancelled).length;
      return {
        position,
        granted,
        cancel: () => {
          waiter.cancelled = true;
          const e = entryOf(sessionId);
          if (!e) return;
          e.waiters = e.waiters.filter((w) => w !== waiter);
        },
      };
    },

    ownerOf(sessionId) {
      return entryOf(sessionId)?.ownerId ?? null;
    },

    queueLength(sessionId) {
      return entryOf(sessionId)?.waiters.filter((w) => !w.cancelled).length ?? 0;
    },

    reset() {
      entries.clear();
    },
  };
}

/** 进程级单例：一个服务进程只有一个会话锁表。 */
export const sessionLock: SessionLock = createSessionLock();
