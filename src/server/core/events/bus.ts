import type { EventRow } from "./model.js";

/**
 * 进程内事件总线。
 *
 * 单进程本地服务，不引入 Redis / 消息队列（架构 §1 明确不做）。
 * 职责只有两件：
 *   1. 把落库后的事件广播给该会话的所有 SSE 订阅者；
 *   2. 保留每会话最近 N 条事件的环形缓冲，供重连先命中内存（架构 §7）。
 *
 * 容错底线：任何订阅者抛错只记 warning，不影响其他订阅者，更不影响
 * 调用方（落库已完成，广播是尽力而为的副作用）。
 */

export type EventListener = (row: EventRow) => void;

export interface EventBusOptions {
  /** 每会话环形缓冲条数，默认取 config.sse.ringSize。 */
  ringSize?: number;
}

export interface EventBus {
  subscribe(sessionId: string, listener: EventListener): () => void;
  publish(sessionId: string, row: EventRow): void;
  /** 订阅者数量；不传 sessionId 返回总数（用于泄漏自检）。 */
  subscriberCount(sessionId?: string): number;
  /**
   * 内存重放：返回该会话环形缓冲里 `id > afterId` 的事件，按 id 升序。
   * 返回 null 表示缓冲无法完整回答（发生过淘汰，或游标早于缓冲起点），
   * 调用方应回退查库。
   *
   * 注意：`events.id` 是全局 AUTOINCREMENT，跨会话不连续，因此不能用
   * 「id 是否连续」判断缺口；只有「缓冲从未淘汰过」时它才是完整答案。
   */
  recent(sessionId: string, afterId: number): EventRow[] | null;
  /** 清空全部订阅与缓冲（测试用，以及 token 重置时配合断流）。 */
  reset(): void;
}

const DEFAULT_RING_SIZE = 500;

export function createEventBus(opts: EventBusOptions = {}): EventBus {
  const ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
  /** sessionId -> 订阅者集合（用 Set 保证重复 subscribe 只算一次）。 */
  const listeners = new Map<string, Set<EventListener>>();
  /** sessionId -> 最近事件（按到达顺序，id 单调）。 */
  const rings = new Map<string, EventRow[]>();
  /** sessionId -> 本进程内该会话第一条事件的 id；重放判断「缓冲是否覆盖」的基准。 */
  const baseIds = new Map<string, number>();
  /** sessionId -> 是否发生过淘汰；淘汰过就不能声称内存缓冲完整。 */
  const trimmed = new Set<string>();

  function ringFor(sessionId: string): EventRow[] {
    let ring = rings.get(sessionId);
    if (!ring) {
      ring = [];
      rings.set(sessionId, ring);
    }
    return ring;
  }

  return {
    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = listeners.get(sessionId);
        if (!current) return;
        current.delete(listener);
        // 没有订阅者就回收这一格，避免长跑后 Map 无限膨胀
        if (current.size === 0) listeners.delete(sessionId);
      };
    },

    publish(sessionId, row) {
      // 先进缓冲：即使此刻没有订阅者，重连也能从内存拿到最近事件
      const ring = ringFor(sessionId);
      if (ring.length === 0) baseIds.set(sessionId, row.id);
      ring.push(row);
      if (ring.length > ringSize) {
        ring.splice(0, ring.length - ringSize);
        trimmed.add(sessionId);
      }

      const set = listeners.get(sessionId);
      if (!set || set.size === 0) return;

      // 快照遍历：订阅者在回调里 unsubscribe 不会打乱本次广播
      for (const listener of [...set]) {
        try {
          listener(row);
        } catch (err) {
          console.warn(
            `[events] 订阅者回调失败（session=${sessionId}, event=${row.id}）：`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    },

    subscriberCount(sessionId) {
      if (sessionId !== undefined) return listeners.get(sessionId)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },

    recent(sessionId, afterId) {
      const ring = rings.get(sessionId);
      if (!ring || ring.length === 0) return null;
      // 淘汰过就可能有缺口，交给数据库
      if (trimmed.has(sessionId)) return null;
      const base = baseIds.get(sessionId);
      // 本进程从 base 开始记录；afterId < base 说明游标早于内存缓冲起点，必须查库
      if (base === undefined || afterId < base - 1) return null;
      return ring.filter((r) => r.id > afterId);
    },

    reset() {
      listeners.clear();
      rings.clear();
      baseIds.clear();
      trimmed.clear();
    },
  };
}

/**
 * 进程级单例。
 *
 * M1 的 `main.ts` 只需 import 这个实例并把它传给 ingest 与 SSE 路由；
 * 不需要手动 start —— 总线无生命周期，订阅/退订即全部状态。
 */
export const eventBus: EventBus = createEventBus();
