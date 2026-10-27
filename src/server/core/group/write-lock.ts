/**
 * 渠道级写锁（G7）。
 *
 * 问题：群聊里显式 @ 多个 Bot 时走 `Promise.all`，两个 Bot 在同一 cwd 并发写
 * 同一个文件，两次都成功、后者覆盖前者、没有任何提示。`local` 执行位置下
 * 这是真实的数据丢失，worktree 隔离也不是免费的（同仓库多 worktree 仍可能
 * 写同一批文件）。
 *
 * 做法：按 `channelId` 串行化**写类工具**（write / exec / network / admin），
 * 读类工具（read / null）不拿锁，并发读不受影响。
 *
 * 三条约束：
 *   ① **只锁写**：读不排队。锁的粒度是「一次工具执行」，不是整个 Turn ——
 *      模型在一轮里可能先读后写，把整个 Turn 串起来会让并行派发失去意义。
 *   ② **不引第三方依赖**：每个渠道一个 FIFO 队列 + busy 标记。
 *   ③ **取消不留悬挂锁**：排队期间 signal abort（用户取消 / 超时）→ 从队列里
 *      撤出、不执行工具；如果正好在这一刻拿到锁，也要立刻释放交给下一位。
 *
 * 单 Bot 会话（或群里只有一个写者）时，开销只有一次 Map 查找，不额外延迟。
 */

export interface WriteLock {
  /** 拿锁执行；同渠道的写类调用串行，跨渠道并行。 */
  run<T>(channelId: string, fn: () => Promise<T>): Promise<T>;
  /** 拿锁执行，但等待期间可被 signal 取消；取消返回 `cancelled` 且不执行 fn。 */
  runCancellable<T>(
    channelId: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "cancelled" }>;
  /** 当前有排队或持锁的渠道数（诊断与测试用）。 */
  pendingCount(): number;
}

interface Waiter {
  /** 轮到它时 resolve（锁的所有权在这一刻移交）。 */
  grant: () => void;
}

interface ChannelQueue {
  busy: boolean;
  waiters: Waiter[];
}

export function createWriteLock(): WriteLock {
  const queues = new Map<string, ChannelQueue>();

  function queueOf(channelId: string): ChannelQueue {
    let q = queues.get(channelId);
    if (!q) {
      q = { busy: false, waiters: [] };
      queues.set(channelId, q);
    }
    return q;
  }

  function cleanup(channelId: string, q: ChannelQueue): void {
    if (!q.busy && q.waiters.length === 0) queues.delete(channelId);
  }

  /** 释放：把所有权直接交给队首（busy 保持 true），否则清空。 */
  function release(channelId: string): void {
    const q = queueOf(channelId);
    const next = q.waiters.shift();
    if (next) {
      next.grant();
      return;
    }
    q.busy = false;
    cleanup(channelId, q);
  }

  /**
   * 拿锁。可取消时返回一个 `cancel` 函数：取消后如果还没轮到就撤出队列，
   * 如果已经轮到（grant 已发生）就由调用方立即 release。
   */
  function acquire(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<
    | { acquired: true; release: () => void }
    | { acquired: false; reason: "cancelled" }
  > {
    const q = queueOf(channelId);
    if (signal?.aborted) return Promise.resolve({ acquired: false, reason: "cancelled" });

    if (!q.busy) {
      q.busy = true;
      return Promise.resolve({ acquired: true, release: () => release(channelId) });
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ acquired: true, release: () => release(channelId) });
        },
      };
      const onAbort = (): void => {
        const index = q.waiters.indexOf(waiter);
        // 还在队列里：撤出即可（ownership 没移交，不需要 release）
        if (index >= 0) {
          q.waiters.splice(index, 1);
          cleanup(channelId, q);
          resolve({ acquired: false, reason: "cancelled" });
          return;
        }
        // 已经轮到（grant 已调用并 resolve）：立刻把锁交给下一位。
        // 这个分支通常是 no-op，因为 grant 会先移除 abort 监听；
        // 保留它是为了「abort 与 grant 同一 tick 竞争」时不丢释放。
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      q.waiters.push(waiter);
    });
  }

  async function run<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const got = await acquire(channelId);
    if (!got.acquired) throw new Error("write lock 意外取消");
    try {
      return await fn();
    } finally {
      got.release();
    }
  }

  async function runCancellable<T>(
    channelId: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "cancelled" }> {
    const got = await acquire(channelId, signal);
    if (!got.acquired) return { ok: false, reason: "cancelled" };
    try {
      // 拿到锁的瞬间也可能已被取消：不执行，但仍要放锁
      if (signal.aborted) return { ok: false, reason: "cancelled" };
      return { ok: true, value: await fn() };
    } finally {
      got.release();
    }
  }

  function pendingCount(): number {
    return queues.size;
  }

  return { run, runCancellable, pendingCount };
}

/** 进程级单例：渠道锁必须跨驱动共享（每个内置引擎会话一个驱动实例）。 */
let shared: WriteLock | null = null;

export function sharedWriteLock(): WriteLock {
  shared ??= createWriteLock();
  return shared;
}
