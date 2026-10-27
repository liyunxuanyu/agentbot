import { describe, expect, it } from "vitest";
import { createWriteLock } from "../../src/server/core/group/write-lock.js";

/**
 * G7：渠道级写锁。
 *
 * 验收的三条：
 *   ① 同一渠道的两个写入串行，执行区间不重叠；
 *   ② 不同渠道互不阻塞（并行）；
 *   ③ 等待期间取消 → 不执行，且锁不悬挂（后续请求能拿到）。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("渠道级写锁（G7）", () => {
  it("同渠道两个写操作串行：执行区间不重叠", async () => {
    const lock = createWriteLock();
    const spans: { id: number; start: number; end: number }[] = [];

    const task = (id: number, ms: number) => async (): Promise<void> => {
      const start = Date.now();
      await sleep(ms);
      spans.push({ id, start, end: Date.now() });
    };

    await Promise.all([lock.run("ch1", task(1, 40)), lock.run("ch1", task(2, 10))]);

    spans.sort((a, b) => a.start - b.start);
    expect(spans).toHaveLength(2);
    // 第二个必须在前一个结束之后才开始
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  });

  it("不同渠道并行：总耗时接近较慢的那个，而不是相加", async () => {
    const lock = createWriteLock();
    const started = Date.now();
    await Promise.all([lock.run("chA", () => sleep(60)), lock.run("chB", () => sleep(60))]);
    const elapsed = Date.now() - started;
    // 串行会是 ~120ms；并行应明显小于它（留足 CI 抖动余量）
    expect(elapsed).toBeLessThan(110);
  });

  it("等待期间取消 → 不执行；锁不悬挂，后续请求正常", async () => {
    const lock = createWriteLock();
    let secondRan = false;
    const controller = new AbortController();

    const first = lock.run("ch1", () => sleep(60));
    const second = lock.runCancellable("ch1", controller.signal, async () => {
      secondRan = true;
      return "done";
    });
    // 让第二个进入排队，再取消它
    await sleep(10);
    controller.abort();
    const secondResult = await second;
    expect(secondResult).toEqual({ ok: false, reason: "cancelled" });
    expect(secondRan).toBe(false);

    await first;
    // 锁已释放：下一个请求能立刻拿到
    const third = await lock.run("ch1", async () => "ok");
    expect(third).toBe("ok");
    expect(lock.pendingCount()).toBe(0);
  });

  it("已经 abort 的 signal：直接返回 cancelled，不排队、不执行", async () => {
    const lock = createWriteLock();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const result = await lock.runCancellable("ch1", controller.signal, async () => {
      ran = true;
      return 1;
    });
    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(ran).toBe(false);
  });

  it("执行中抛错也释放锁（后续请求不被卡死）", async () => {
    const lock = createWriteLock();
    await expect(
      lock.run("ch1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lock.run("ch1", async () => "next")).toBe("next");
    expect(lock.pendingCount()).toBe(0);
  });

  it("单渠道无竞争时没有额外延迟（不排队直接执行）", async () => {
    const lock = createWriteLock();
    const started = Date.now();
    const value = await lock.run("ch1", async () => 42);
    expect(value).toBe(42);
    expect(Date.now() - started).toBeLessThan(20);
  });
});
