/**
 * SSE 封装（架构 §7）。
 *
 * 为什么用 EventSource 而不是自己解析流：`Last-Event-ID` 由浏览器在重连时自动带上，
 * 服务端按 `events.id` 续推，直接兑现 P0-04「从最后一条已落库事件继续」。
 *
 * 这里补浏览器不给的三件事：
 *   ① 首连游标：`?lastEventId=`（REST 拉历史到建立连接之间的空隙）；
 *   ② 去重：`Last-Event-ID` 续推可能与本地已渲染的重叠，按 `id` 丢弃重复帧；
 *   ③ 心跳超时：服务端每 15s 发注释行 `: ping`，但注释不触发任何事件回调。
 *      连续 45s 没收到任何帧就主动重连 —— 否则半死连接会静默挂着（NAT/休眠唤醒后常见）。
 *
 * 另外 `replay_truncated` 是服务端在回放超上限时发的无 id 帧，必须单独监听：
 * 它意味着中间有缺口，要回调出去让页面用 REST 补齐。
 */

import type { SseFrame, ReplayTruncatedPayload } from "./types";
import { storedToken } from "./client";

/** 服务端可能推送的 9 类事件 + meta。逐个 addEventListener，才能拿到 event 名。 */
const EVENT_NAMES = [
  "message_delta",
  "thought",
  "tool_call",
  "tool_result",
  "plan",
  "permission_request",
  "usage",
  "done",
  "error",
  "meta",
] as const;

export type SseEventName = (typeof EVENT_NAMES)[number] | "replay_truncated";

export interface SseHandlers {
  /** 收到一条带 id 的帧。同一 id 只会回调一次。 */
  onFrame: (frame: SseFrame) => void;
  /** 连接打开。`reconnected` 为 true 表示不是首连。 */
  onOpen?: (reconnected: boolean) => void;
  /** 连接断开（浏览器会自动重连；这里只用于 UI 显示「正在重连」横幅）。 */
  onError?: (fatal: boolean) => void;
  /** 回放被截断：前端应走 REST 补齐缺口。 */
  onReplayTruncated?: (payload: ReplayTruncatedPayload) => void;
}

export interface SseOptions extends SseHandlers {
  sessionId: string;
  /**
   * 首连游标（REST 已覆盖到的最大 event id）。
   *
   * **总是发送**，包括 0：服务端只有收到游标才回放历史（`sse.ts` 里
   * `cursor !== null` 才走 replay），不传就只推新事件。首连给 0 = 从头回放。
   * 重连时浏览器会用 `Last-Event-ID` 覆盖它。
   */
  lastEventId?: number;
  /** 心跳超时阈值，默认 45s。 */
  heartbeatTimeoutMs?: number;
}

/** 45s：服务端 15s 一跳，容忍连续丢两跳。 */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export class SseConnection {
  private source: EventSource | null = null;
  private readonly seen = new Set<number>();
  /** 本地已知的最大 event id；重连时用于判断是否退步。 */
  private cursor = 0;
  private opened = false;
  private closedByUs = false;
  private heartbeatTimer: number | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  constructor(private readonly opts: SseOptions) {
    this.cursor = opts.lastEventId ?? 0;
  }

  /** 当前游标（最大已收 id）。页面刷新或补拉历史时用。 */
  get lastEventId(): number {
    return this.cursor;
  }

  /** 已收到的帧数，仅用于调试与「期间发生了什么」计数。 */
  get receivedCount(): number {
    return this.seen.size;
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  close(): void {
    this.closedByUs = true;
    this.teardown();
    this.source = null;
  }

  private open(): void {
    this.teardown();

    const params = new URLSearchParams({ sessionId: this.opts.sessionId });
    // 首连游标**总是显式带上**：服务端只在 cursor !== null 时回放历史
    // （`sse.ts` 的 `openStream`：不传游标 = 只推新事件，不重放）。
    // 首连给 0 表示「从头回放」，这才是「打开会话就能看到历史」的语义；
    // 重连时浏览器会覆盖成 Last-Event-ID，这里的值被忽略。
    params.set("lastEventId", String(this.cursor));
    // token 必须进 URL：EventSource 不支持自定义 header，且开发态没有 cookie
    const token = storedToken();
    if (token) params.set("t", token);

    const source = new EventSource(`/api/stream?${params.toString()}`, {
      withCredentials: true,
    });
    this.source = source;

    source.addEventListener("open", () => {
      const reconnected = this.opened;
      this.opened = true;
      this.reconnectAttempts = 0;
      this.touchHeartbeat();
      this.opts.onOpen?.(reconnected);
    });

    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (ev) => {
        this.touchHeartbeat();
        this.handleFrame(ev as MessageEvent<string>);
      });
    }

    source.addEventListener("replay_truncated", (ev) => {
      this.touchHeartbeat();
      try {
        const payload = JSON.parse((ev as MessageEvent<string>).data) as ReplayTruncatedPayload;
        this.opts.onReplayTruncated?.(payload);
      } catch {
        // 帧体坏了不影响主流；缺口靠下一次 REST 刷新补
      }
    });

    source.addEventListener("error", () => {
      if (this.closedByUs) return;
      // readyState === CLOSED 表示浏览器放弃重连（401/404/协议错误），
      // CONNECTING 表示它在自己退避重连 —— 前者要暴露给 UI，后者只需提示
      const fatal = source.readyState === EventSource.CLOSED;
      this.opts.onError?.(fatal);
      if (fatal) {
        this.teardown();
        this.source = null;
        this.scheduleManualReconnect();
      } else {
        this.touchHeartbeat();
      }
    });
  }

  private handleFrame(ev: MessageEvent<string>): void {
    const rawId = ev.lastEventId;
    const id = rawId ? Number.parseInt(rawId, 10) : Number.NaN;

    let frame: SseFrame;
    try {
      frame = JSON.parse(ev.data) as SseFrame;
    } catch {
      return;
    }

    // 去重：id 以帧体为准（lastEventId 在个别浏览器实现里可能为空）
    const frameId = Number.isFinite(frame.id) ? frame.id : id;
    if (!Number.isFinite(frameId)) {
      // 没有 id 的帧（服务端只在 replay_truncated 这样发）不进渲染流
      return;
    }
    if (this.seen.has(frameId)) return;

    this.seen.add(frameId);
    if (frameId > this.cursor) this.cursor = frameId;
    this.opts.onFrame(frame);
  }

  /** 每收到任何帧（含心跳之外的事件）都重置超时计时。 */
  private touchHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    const limit = this.opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatTimer = window.setTimeout(() => {
      // 45s 没有任何帧：判定半死连接，主动重连（EventSource 自己不会察觉）
      this.source?.close();
      this.source = null;
      this.open();
    }, limit);
  }

  /** 浏览器放弃重连后，自己按指数退避重试（1s→30s + 抖动）。 */
  private scheduleManualReconnect(): void {
    if (this.closedByUs) return;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    const attempt = Math.min(this.reconnectAttempts, 5);
    const base = Math.min(30_000, 1000 * 2 ** attempt);
    const jitter = Math.random() * 400;
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.open(), base + jitter);
  }

  private teardown(): void {
    if (this.heartbeatTimer !== null) {
      window.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }
}

/** 便捷工厂：页面里 `const conn = openStream({...})`，卸载时 `conn.close()`。 */
export function openStream(opts: SseOptions): SseConnection {
  const conn = new SseConnection(opts);
  conn.connect();
  return conn;
}
