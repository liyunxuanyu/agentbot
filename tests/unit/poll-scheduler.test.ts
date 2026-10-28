import { describe, expect, it, vi } from "vitest";
import { createPollScheduler } from "../../src/web/lib/pollScheduler";

/**
 * 兜底轮询调度器（2026-10-28 公网实测）。
 *
 * 这一组用例锁住一个只在公网隧道下复现的致命 bug：
 *   上一轮收口时排的「3 秒后停」会误杀下一轮刚起的轮询；而 cloudflared
 *   会缓冲 SSE（实测 body 0 字节），于是客户端再也收不到任何事件 ——
 *   界面上停在「排队中」，批准权限后 diff 与回复永远不出现。
 */

/** 可控时钟 + 定时器：测试里不真的等 3 秒。 */
function fakeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeoutFn = (fn: () => void, ms: number): number => {
    const id = seq++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const clearTimeoutFn = (id: number): void => {
    timers.delete(id);
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const t = timers.get(nextId)!;
      timers.delete(nextId);
      now = t.at;
      t.fn();
    }
    now = target;
  };
  return {
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    pending: () => timers.size,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(opts: { healthy?: boolean; active?: boolean } = {}) {
  const clock = fakeClock();
  let healthy = opts.healthy ?? false;
  let active = opts.active ?? true;
  const poll = vi.fn(async () => true);
  const scheduler = createPollScheduler({
    poll,
    isActive: () => active,
    isHealthy: () => healthy,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    degradedMs: 1000,
    healthyMs: 5000,
    tailMs: 3000,
  });
  return {
    clock,
    poll,
    scheduler,
    setHealthy: (v: boolean) => {
      healthy = v;
    },
    setActive: (v: boolean) => {
      active = v;
    },
  };
}

describe("pollScheduler · 生命周期", () => {
  it("start() 立刻拉一次，并按降级间隔续排", async () => {
    const { clock, poll, scheduler } = make();
    scheduler.start();
    await flush();
    expect(poll).toHaveBeenCalledTimes(1);
    clock.advance(1000);
    await flush();
    expect(poll).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("SSE 健康时用低频间隔", async () => {
    const { clock, poll, scheduler, setHealthy } = make({ healthy: true });
    scheduler.start();
    await flush();
    clock.advance(1000);
    await flush();
    expect(poll).toHaveBeenCalledTimes(1);
    clock.advance(4000);
    await flush();
    expect(poll).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("收口后补拉一次，tail 到点才停", async () => {
    const { clock, poll, scheduler, setActive } = make();
    scheduler.start();
    await flush();
    expect(poll).toHaveBeenCalledTimes(1);

    setActive(false);
    scheduler.finish();
    await flush();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(scheduler.running).toBe(true);

    clock.advance(3000);
    expect(scheduler.running).toBe(false);
  });

  /**
   * 核心回归：收口 3s 内又发下一条 —— 旧的 stop 定时器不得杀掉新一轮。
   */
  it("finish() 之后立刻 start()：旧的停止预约被作废，轮询继续", async () => {
    const { clock, poll, scheduler, setActive } = make();
    scheduler.start();
    await flush();

    setActive(false);
    scheduler.finish();
    await flush();

    // 1 秒后用户又发了一条（旧实现：3 秒到点会把新定时器清掉）
    clock.advance(1000);
    setActive(true);
    scheduler.start();
    await flush();

    const before = poll.mock.calls.length;
    clock.advance(3000); // 跨过旧 finish 的 3s 点
    await flush();
    clock.advance(1000);
    await flush();
    expect(poll.mock.calls.length).toBeGreaterThan(before);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  it("stop() 之后不再拉取", async () => {
    const { clock, poll, scheduler } = make();
    scheduler.start();
    await flush();
    const before = poll.mock.calls.length;
    scheduler.stop();
    clock.advance(10_000);
    await flush();
    expect(poll.mock.calls.length).toBe(before);
    expect(scheduler.running).toBe(false);
  });

  it("poll 抛错不会打断调度", async () => {
    const clock = fakeClock();
    let calls = 0;
    const scheduler = createPollScheduler({
      poll: async () => {
        calls += 1;
        throw new Error("boom");
      },
      isActive: () => true,
      isHealthy: () => false,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      degradedMs: 1000,
    });
    scheduler.start();
    await flush();
    clock.advance(1000);
    await flush();
    expect(calls).toBe(2);
    scheduler.stop();
  });

  it("超过 maxMs 后不再续排（避免游标异常时无限轮询）", async () => {
    const clock = fakeClock();
    let calls = 0;
    const scheduler = createPollScheduler({
      poll: async () => {
        calls += 1;
        return true;
      },
      isActive: () => true,
      isHealthy: () => false,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      degradedMs: 1000,
      maxMs: 2500,
    });
    scheduler.start();
    await flush();
    clock.advance(1000);
    await flush();
    clock.advance(1000);
    await flush();
    // 到点后再跨过一个已排定的 tick 就会停（最多多一次，不无限续排）
    clock.advance(5000);
    await flush();
    const after = calls;
    clock.advance(10_000);
    await flush();
    expect(calls).toBe(after);
    scheduler.stop();
  });
});
