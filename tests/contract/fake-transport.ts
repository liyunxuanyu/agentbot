import type { Transport, TransportExit } from "../../src/server/adapters/channels/acp/transport.js";

/**
 * 假传输：把 fixture 里的原始协议行喂给通道驱动，并记录驱动写回的行。
 *
 * 为什么不 spawn 真实运行时：契约测试要能在 CI 里跑（PRD §7「每个 adapter 必须有
 * 契约测试（用录制的运行时事件样本回放）」）。fixture 就是协议样本，不需要真实二进制。
 *
 * 用法：
 *   const t = new FakeTransport();
 *   const h = await driver.start(decl, { cwd, sessionId });
 *   // 驱动写了 initialize 请求 → 我们回 fixture 里的响应
 *   t.flushOutbound();            // 取出驱动写出的行
 *   t.feedLines([...]);           // 喂协议行
 *   t.close(0);                   // 模拟进程退出
 */
export class FakeTransport implements Transport {
  readonly pid: number | null;
  private lineCbs: ((line: string) => void)[] = [];
  private stderrCbs: ((text: string) => void)[] = [];
  private closeCbs: ((info: TransportExit) => void)[] = [];
  private outbound: string[] = [];
  private stderrBuf = "";
  private isClosed = false;

  constructor(opts: { pid?: number | null } = {}) {
    this.pid = opts.pid ?? 4321;
  }

  get stderrTail(): string {
    return this.stderrBuf;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(line: string): void {
    if (this.isClosed) return;
    this.outbound.push(line);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
  }

  onStderr(cb: (text: string) => void): void {
    this.stderrCbs.push(cb);
  }

  onClose(cb: (info: TransportExit) => void): void {
    if (this.isClosed) {
      cb({ code: 0 });
      return;
    }
    this.closeCbs.push(cb);
  }

  kill(): void {
    // 驱动调 kill 时模拟「进程被终止」：立即 close，事件顺序与真实一致
    this.close(null, "SIGTERM");
  }

  // ---- 测试侧 ----

  /** 喂若干原始协议行（原样字符串，不做 JSON 化）。 */
  feedLines(lines: string[]): void {
    for (const line of lines) {
      for (const cb of this.lineCbs) cb(line);
    }
  }

  /** 喂一段文本（按行拆）。 */
  feedText(text: string): void {
    this.feedLines(text.split(/\r?\n/).filter((l) => l.length > 0));
  }

  emitStderr(text: string): void {
    this.stderrBuf = (this.stderrBuf + text).slice(-8 * 1024);
    for (const cb of this.stderrCbs) cb(text);
  }

  close(code: number | null, signal?: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const cb of this.closeCbs) {
      cb(signal === undefined ? { code } : { code, signal });
    }
  }

  /** 取出并清空驱动写出的行（JSON 解析后的对象，便于断言）。 */
  takeOutbound(): Record<string, unknown>[] {
    const lines = this.outbound;
    this.outbound = [];
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** 只查看不消费。 */
  peekOutbound(): Record<string, unknown>[] {
    return this.outbound.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

/** 从 fixture 文本里挑出「服务端→客户端」的响应行（id 匹配某请求）。 */
export function findResponse(lines: string[], id: number | string): Record<string, unknown> | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (String(obj["id"]) === String(id) && obj["method"] === undefined) return obj;
    } catch {
      // 非 JSON 行（CLI 输出、日志噪声）跳过
    }
  }
  return null;
}
