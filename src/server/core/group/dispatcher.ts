import type { DB } from "../db/db.js";
import type { TurnOrchestrator } from "../orchestrator/turn.js";
import { waitTurnDone, type Speaker } from "./host.js";

/**
 * 群聊派发（M10 / board 03-decisions Q3「默认依次执行」）。
 *
 * 为什么默认串行：阅读顺序稳定、同一 worktree 同时只有一个写者（C7 文件冲突）、
 * UX 的「单展开原则」天然成立。只有用户**显式 @ 多个 Bot** 时才并行 ——
 * 那是用户明确表达「这几件事互不依赖」的唯一信号。
 *
 * 三条纪律：
 *   ① **只执行传入的名单**：本文件不决定谁发言，也不从参与者里补人。
 *      名单外的 Bot 一次 prompt 都不会发出（P0-06「未被点名 0 次调用」的落点）。
 *   ② **某一轮失败不阻塞后续**：每个发言人独立 Session（Supervisor 一 Session 一进程），
 *      一个崩了只影响它自己那一条结果。
 *   ③ **轮询 `messages.status` 等收口**：正文权威副本是 messages.content（P0-15）。
 */

export interface DispatchInput {
  channelId: string;
  speakers: readonly Speaker[];
  /** 用户原文；每个发言人的 Turn 都记录这段（而不是任何内部 prompt）。 */
  text: string;
  /** 显式 @ 了多个 Bot → 并行。 */
  parallel: boolean;
  /** 单个发言人的超时（0 = 不设超时，只等运行时自己结束）。 */
  perSpeakerTimeoutMs?: number;
}

export interface SpeakerResult {
  botId: string;
  reason: string;
  sessionId: string | null;
  turnId: string | null;
  messageId: string | null;
  status: "done" | "failed" | "interrupted" | "timeout" | "queued" | "start_failed";
  /** 失败原因（人话）；成功为 null。 */
  error: string | null;
  durationMs: number;
}

export interface DispatchResult {
  results: SpeakerResult[];
  /** 实际发出的运行时调用次数（= speakers 中成功启动的 Turn 数）。 */
  calls: number;
}

export interface DispatchDeps {
  db: DB;
  orchestrator: TurnOrchestrator;
  isRuntimeAvailable(botId: string): boolean;
  log?: (msg: string) => void;
}

function emptyResult(speaker: Speaker, status: SpeakerResult["status"], error: string | null): SpeakerResult {
  return {
    botId: speaker.botId,
    reason: speaker.reason,
    sessionId: null,
    turnId: null,
    messageId: null,
    status,
    error,
    durationMs: 0,
  };
}

async function runOne(
  deps: DispatchDeps,
  input: DispatchInput,
  speaker: Speaker,
): Promise<SpeakerResult> {
  const log = deps.log ?? ((m: string) => console.warn(`[group] ${m}`));
  const startedAt = Date.now();

  // 运行时不可用的发言人：不发 Turn，如实标失败（不能让用户以为它在想）
  if (!deps.isRuntimeAvailable(speaker.botId)) {
    log(`发言人 ${speaker.botId} 的运行时不可用，跳过`);
    return emptyResult(speaker, "start_failed", "运行时不可用");
  }

  let info: Awaited<ReturnType<TurnOrchestrator["start"]>>;
  try {
    info = await deps.orchestrator.start({
      channelId: input.channelId,
      botId: speaker.botId,
      text: input.text,
      // 用户消息已由主持人那一轮记录（或路由层补写），这里不再重复写
      recordUserMessage: false,
      source: "interactive",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`发言人 ${speaker.botId} 启动失败：${message}`);
    return emptyResult(speaker, "start_failed", message);
  }

  const base: SpeakerResult = {
    botId: speaker.botId,
    reason: speaker.reason,
    sessionId: info.sessionId,
    turnId: info.turnId,
    messageId: info.messageId,
    status: "queued",
    error: null,
    durationMs: 0,
  };

  if (info.queued) {
    // 同一 Bot 的会话锁被占（用户双标签页 / 上一轮未收口）：
    // 不阻塞其他发言人，如实标 queued，前端显示「排队中」
    return { ...base, status: "queued", error: "会话锁被占用，已排队" };
  }

  const timeout = input.perSpeakerTimeoutMs ?? 0;
  const waited = await waitTurnDone(deps.db, info.turnId, timeout > 0 ? timeout : Number.POSITIVE_INFINITY);
  const durationMs = Date.now() - startedAt;

  if (waited.status === "timeout") {
    // 超时：发 cancel，但这一条不阻塞后续发言人（P0-06 / dispatcher 纪律②）
    void deps.orchestrator.cancel(info.sessionId, info.turnId).catch(() => undefined);
    return { ...base, status: "timeout", error: "本轮超时，已请求中断", durationMs };
  }
  if (waited.status === "done") {
    return { ...base, status: "done", durationMs };
  }
  if (waited.status === "interrupted") {
    return { ...base, status: "interrupted", error: "已中断", durationMs };
  }
  return { ...base, status: "failed", error: "运行时报告失败", durationMs };
}

/**
 * 派发。`parallel=true` 时并发跑（仅当用户显式 @ 多个 Bot），否则按名单顺序串行。
 */
export async function dispatchSpeakers(
  deps: DispatchDeps,
  input: DispatchInput,
): Promise<DispatchResult> {
  if (input.speakers.length === 0) return { results: [], calls: 0 };

  let results: SpeakerResult[];
  if (input.parallel) {
    results = await Promise.all(input.speakers.map((s) => runOne(deps, input, s)));
  } else {
    results = [];
    for (const speaker of input.speakers) {
      // 串行：逐个 await，前一个收口后才启动下一个（阅读顺序 = 名单顺序）
      results.push(await runOne(deps, input, speaker));
    }
  }

  const calls = results.filter((r) => r.turnId !== null).length;
  return { results, calls };
}
