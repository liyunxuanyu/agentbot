import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { openStream, type SseConnection } from "../net/stream";
import type { SseFrame } from "../net/types";

/**
 * SSE 生命周期 composable（架构 §7）。
 *
 * 职责边界：
 *   - 建连接 / 关连接（`onUnmounted` 自动 close，避免多标签页泄漏连接）；
 *   - 把帧回调给调用方（store 合并逻辑不在这里）；
 *   - 维护连接态（open / reconnecting / closed）供 UI 显示横幅。
 *
 * 不在这里做的：去重（`api/stream.ts` 已按 id 去重）、事件合并（events store）。
 *
 * `sessionId` 变化时自动重连（切 Session 只读透镜）。`enabled` 为 false 时不建连接，
 * 用于「渠道还没加载出来」或「明确要看错误态」的场景。
 */
export interface UseSseStreamOptions {
  sessionId: Ref<string | null>;
  /** 首连游标（REST 已覆盖到的最大 id）。变化时重建连接。 */
  lastEventId: Ref<number>;
  enabled: Ref<boolean>;
  onFrame: (frame: SseFrame) => void;
  onMeta?: (frame: SseFrame) => void;
  onReplayTruncated?: (lastEventId: number) => void;
}

export type StreamState = "connecting" | "open" | "reconnecting" | "closed";

export function useSseStream(opts: UseSseStreamOptions) {
  const state = ref<StreamState>("connecting");
  const attempts = ref(0);
  const lastFrameAt = ref(0);
  let conn: SseConnection | null = null;

  function stop(): void {
    conn?.close();
    conn = null;
    state.value = "closed";
  }

  function start(): void {
    stop();
    const id = opts.sessionId.value;
    if (!id || !opts.enabled.value) {
      state.value = "closed";
      return;
    }

    state.value = "connecting";
    conn = openStream({
      sessionId: id,
      lastEventId: opts.lastEventId.value,
      onOpen: (reconnected) => {
        state.value = "open";
        attempts.value = 0;
        if (reconnected) {
          // 重连成功：让页面知道可以撤掉「正在重连」横幅
        }
      },
      onError: (fatal) => {
        state.value = fatal ? "reconnecting" : "reconnecting";
        attempts.value += 1;
      },
      onFrame: (frame) => {
        lastFrameAt.value = Date.now();
        if (frame.type === "meta") opts.onMeta?.(frame);
        else opts.onFrame(frame);
      },
      onReplayTruncated: (payload) => opts.onReplayTruncated?.(payload.lastEventId),
    });
  }

  onMounted(() => {
    start();
  });

  // 切会话 / 开关：重建连接（游标变了也必须重连，EventSource 无法改 URL）
  watch([opts.sessionId, opts.enabled], () => start());

  onBeforeUnmount(stop);

  return {
    state,
    attempts,
    lastFrameAt,
    restart: start,
    stop,
  };
}
