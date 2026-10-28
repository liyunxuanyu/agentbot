/**
 * 兜底轮询的调度器（2026-10-28 公网实测后的第二次修正）。
 *
 * 为什么把它从 ChatPage 里抽出来：轮询的**生命周期**比「开一个 setTimeout」
 * 复杂得多，而之前用页面内的几个裸变量实现时踩到一个只在公网复现的致命 bug：
 *
 *   Turn 收口 → `window.setTimeout(stopPoll, 3000)` 排了一个「3 秒后停」。
 *   用户在这 3 秒内发下一条消息 → 新一轮 `schedulePoll()` 起好定时器 →
 *   3 秒到了，**上一轮排的 stopPoll 把新一轮的定时器清掉**。
 *   此时 cloudflared 又缓冲了 SSE（实测 body 0 字节），客户端从此再也收不到
 *   任何事件：界面上停在「排队中」，批准权限后 diff / 回复永远不出现。
 *
 * 正确做法是把「停止」也变成可取消的预约：任何一次 `start()` 都要作废
 * 之前排的停止预约；`stop()` 只清自己的。这样「收口后留 3s 收尾」与
 * 「立刻开始下一轮」不会互相踩。
 *
 * 依赖注入 `setTimeout` / `clearTimeout` 与 `now`，纯逻辑可单测（不依赖 DOM）。
 */

export interface PollSchedulerOptions {
  /** 拉一次增量；返回是否有新帧（只用于「贴底时滚到底」这类副作用）。 */
  poll: () => Promise<boolean>;
  /** 还有进行中的 Turn 吗？决定是否继续排下一次。 */
  isActive: () => boolean;
  /** SSE 健康（已连接且近期有帧）→ 用低频；否则高频兜底。 */
  isHealthy: () => boolean;
  /** SSE 健康时的间隔，默认 5000ms。 */
  healthyMs?: number;
  /** SSE 不健康（隧道缓冲）时的间隔，默认 1200ms。 */
  degradedMs?: number;
  /** 单次「轮询会话」的最长持续时间，默认 90s（防止游标异常时无限轮询）。 */
  maxMs?: number;
  /** 收口后再补拉一次并等多久停止，默认 3000ms。 */
  tailMs?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
  /** 有新帧时的回调（页面用来贴底）。 */
  onFrames?: () => void;
}

export interface PollScheduler {
  /** 开始（或续期）轮询：幂等，已在跑就只作废「停止预约」。 */
  start(): void;
  /** 收口：立刻补拉一次，`tailMs` 后停。可被随后的 `start()` 取消。 */
  finish(): void;
  /** 立即停止（关页面用）。 */
  stop(): void;
  /** 当前是否在轮询（测试与诊断用）。 */
  readonly running: boolean;
}

export function createPollScheduler(opts: PollSchedulerOptions): PollScheduler {
  const healthyMs = opts.healthyMs ?? 5000;
  const degradedMs = opts.degradedMs ?? 1200;
  const maxMs = opts.maxMs ?? 90_000;
  const tailMs = opts.tailMs ?? 3000;
  const now = opts.now ?? (() => Date.now());
  const setT =
    opts.setTimeoutFn ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearT = opts.clearTimeoutFn ?? ((h) => globalThis.clearTimeout(h));

  /** 下一次 tick 的定时器；`null` 表示没排（正在跑或已停）。 */
  let timer: number | null = null;
  /** 「收口后停」的预约：必须可取消，否则会误杀下一轮（见文件头）。 */
  let stopTimer: number | null = null;
  /** 一次 poll 正在进行中：防止 tick 与 start 并发排出两个定时器。 */
  let inFlight = false;
  let startedAt = 0;
  let running = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  function clearStopTimer(): void {
    if (stopTimer !== null) {
      clearT(stopTimer);
      stopTimer = null;
    }
  }

  function interval(): number {
    return opts.isHealthy() ? healthyMs : degradedMs;
  }

  function schedule(): void {
    if (timer !== null || inFlight) return;
    timer = setT(() => void tick(), interval());
  }

  async function tick(): Promise<void> {
    timer = null;
    if (!running || inFlight) return;
    inFlight = true;
    let got = false;
    try {
      got = await opts.poll();
    } catch {
      // 轮询失败不打断调度：SSE 或下一次轮询会补上
    } finally {
      inFlight = false;
    }
    if (got) opts.onFrames?.();
    if (!running) return;
    const expired = now() - startedAt > maxMs;
    if (opts.isActive() && !expired) {
      schedule();
    } else if (!opts.isActive()) {
      // 期间收口了：走正常收尾（补一次 + 尾巴）
      finishInternal();
    }
    // 超时（expired）且仍有进行中的 Turn：不再续排。下一次 start() 会重新开始
    // （页面在 hasLiveTurn 变化时会调它；长时间无事件本来也该让用户看见「无响应」）。
  }

  function start(): void {
    // 关键：作废上一轮排的「3 秒后停」。不作废的话，用户在收口后 3s 内
    // 发下一条消息，新一轮的定时器会被旧的 stop 清掉（公网实测踩到）。
    clearStopTimer();
    if (running) {
      schedule();
      return;
    }
    running = true;
    startedAt = now();
    void tick();
  }

  function finishInternal(): void {
    if (!running) return;
    // 收尾补拉一次（拿最后几帧）；失败不影响停止
    void opts.poll().then(
      (got) => {
        if (got) opts.onFrames?.();
      },
      () => undefined,
    );
    clearTimer();
    clearStopTimer();
    stopTimer = setT(() => {
      stopTimer = null;
      // 只有真的没有进行中的 Turn 才停：tail 期间用户可能又发了消息，
      // 那时 start() 已经清掉这个预约；这里是双保险。
      if (!opts.isActive()) {
        running = false;
        clearTimer();
      }
    }, tailMs);
  }

  function finish(): void {
    finishInternal();
  }

  function stop(): void {
    running = false;
    clearTimer();
    clearStopTimer();
  }

  return {
    start,
    finish,
    stop,
    get running() {
      return running;
    },
  };
}
