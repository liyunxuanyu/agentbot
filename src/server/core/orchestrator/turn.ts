import { randomUUID } from "node:crypto";
import type { CanonicalEvent, EventType } from "../../../shared/events.js";
import type { DB } from "../db/db.js";
import type { AdapterDeclaration, ChannelDriver } from "../../adapters/contract.js";
import { clearTurnContext, setTurnContext } from "../../adapters/turn-context.js";
import type { EventBus } from "../events/bus.js";
import { createIngest } from "../events/ingest.js";
import * as messagesRepo from "../repo/messages.js";
import { sessionLock, type SessionLock } from "./session-lock.js";
import type { Supervisor, TurnSource } from "../process/supervisor.js";
import { resolveSessionCwd, WorktreeNotReadyError } from "../process/session-cwd.js";
import type { UsageRecorder, UsageSample } from "../usage/recorder.js";
import type { Summarizer } from "../memory/summarizer.js";

/**
 * 一次 Turn 的完整流程（P0-04 + P0-05 + P0-15 的最小闭环）。
 *
 *   建 user message → supervisor.ensure 拿进程 → 建 assistant message
 *   → 绑定本轮上下文 → 发 prompt → 事件流式经 ingest 落库+广播
 *   → done/error 收口（消息状态、Session 状态、放锁）
 *
 * 五条纪律：
 *   ① **正文权威副本是 `messages.content`**：本文件从不读事件重建正文，
 *      收口只改状态（正文由 ingest 在 `message_delta` 里追加）。
 *   ② **未声明类型在 ingest 处丢弃**：这里把声明的掩码原样传下去，
 *      不在本层再判一次（两处判定迟早漂移）。
 *   ③ **事件 payload 带 botId**：群聊里主持人 ≠ 发言人。驱动不知道谁是发言人，
 *      由本层在入 ingest 前补上。
 *   ④ **同一 Session 串行**：锁拿不到就返回 queued，绝不并发 prompt 同一进程。
 *   ⑤ **进程归 Supervisor**：本文件不再 spawn、不管 pid、不管空闲回收；
 *      `driver.onExit` 也只由 Supervisor 注册（它先把 Turn 标失败，再通知这里）。
 *
 * 本文件不出现任何协议字符串：运行时由装配层以 `TurnRuntime` 注入。
 */

/** 装配层提供的运行时绑定：声明 + 驱动。 */
export interface TurnRuntime {
  runtimeId: string;
  declaration: AdapterDeclaration;
  driver: ChannelDriver;
}

export interface TurnDeps {
  db: DB;
  /** 不传则只落库不广播（单元测试）。 */
  bus?: EventBus;
  /** 按 Bot 解析运行时绑定；未绑定时返回 null（发送被阻止，P0-02）。 */
  resolveRuntime(botId: string): TurnRuntime | null;
  /** 进程管理者：唯一 spawn / resume / 空闲回收的地方。 */
  supervisor: Supervisor;
  /** 注入便于测试；生产用进程级单例。 */
  lock?: SessionLock;
  /**
   * 用量记录（M13）。收口时调用一次：一轮一条，未上报也落一条 `reported=0`
   * （PRD P0-12「记为未上报，不估算」）。不传则完全不记录（单元测试）。
   */
  usageRecorder?: UsageRecorder;
  /**
   * 自动摘要（M7）。两个挂载点：
   *   - 每轮开始前：重试该 Bot 的待摘要标记（PRD「下次会话开始前重试，不阻塞对话」）；
   *   - 每轮收口后：消息数达 40 时生成摘要。
   * 不传则完全不碰记忆（单元测试）。
   */
  summarizer?: Summarizer;
}

export interface StartTurnInput {
  channelId: string;
  botId: string;
  /** 用户输入原文。 */
  text: string;
  /**
   * 落库的用户消息正文；缺省等于 `text`。
   *
   * 为什么需要它：群聊主持人这一轮发给运行时的是内部决策 prompt（长且含成员表），
   * 但会话流里用户看到的那条消息必须是**用户自己说的话**。Assignment 同理：
   * 执行 prompt 是任务说明，用户消息是来源消息原文。
   */
  userMessageText?: string;
  /**
   * 是否写 `role='user'` 的消息行；缺省 true。
   *
   * 群聊里同一条用户消息会驱动多个 Bot 的 Turn，每个 Turn 各写一条用户消息会让
   * 会话流里出现 N+1 条一模一样的用户气泡（前端按渠道读全部 user 消息）。
   * 因此只让**主持人那一轮**（或降级路径下补写的那条）记录用户原文，
   * 其余发言人的 Turn 传 false —— 它们的助手回复仍按自己的 Session 归属。
   */
  recordUserMessage?: boolean;
  /** 复用指定 Session（渠道详情里的当前会话）。 */
  sessionId?: string;
  /** 重发场景：显式开新 Session（崩溃后重发，P0-15）。 */
  forceNewSession?: boolean;
  /**
   * 触发来源，决定权限卡片的超时档位（board 03-decisions Q1）。
   * 缺省 `interactive`；M11 Assignment / M12 定时任务必须显式传。
   */
  source?: TurnSource;
}

export interface TurnHandleInfo {
  turnId: string;
  sessionId: string;
  messageId: string;
  /** true 表示会话锁被占用，已排队，没有真正执行。 */
  queued: boolean;
  position?: number;
}

/** 编排层的可预期错误：HTTP 层按 code 映射状态码。 */
export class TurnError extends Error {
  constructor(
    readonly code: "runtime_not_bound" | "session_not_found" | "busy" | "worktree_not_ready",
    message: string,
  ) {
    super(message);
    this.name = "TurnError";
  }
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  messageId: string;
  botId: string;
  runtime: TurnRuntime;
  source: TurnSource;
  startedAt: number;
  /** 已收到终态事件（done / fatal error），后续事件不再触发收口。 */
  settled: boolean;
  cancelled: boolean;
  /** 本轮运行时上报的用量；缺失保持 null（P0-12：不估算）。 */
  tokens: { input: number; output: number } | null;
  /** 本轮收到的全部 usage 样本（含未上报的），收口时交用量记录器裁决。 */
  usageSamples: UsageSample[];
  /** 已写用量记录（收口只写一次）。 */
  usageRecorded: boolean;
  /** 排队中的 Turn：等锁放行；已开始的 Turn 没有这个字段。 */
  waiter?: { position: number; granted: Promise<void>; cancel: () => void };
}

export interface TurnOrchestrator {
  start(input: StartTurnInput): Promise<TurnHandleInfo>;
  cancel(sessionId: string, turnId: string): Promise<boolean>;
  /** 当前活跃 Turn（诊断用）。 */
  activeTurn(sessionId: string): { turnId: string; botId: string } | null;
  /** 关服：撤出排队、放锁（进程由 Supervisor 关）。 */
  dispose(): Promise<void>;
}

export function createTurnOrchestrator(deps: TurnDeps): TurnOrchestrator {
  const lock = deps.lock ?? sessionLock;
  const sup = deps.supervisor;
  /** 正在执行的 Turn（每 Session 最多一个，会话锁保证）。 */
  const active = new Map<string, ActiveTurn>();
  /** 排队中的 Turn（FIFO）；`active` 里是持锁者，这里等它放锁。 */
  const queued = new Map<string, ActiveTurn[]>();
  /** 关服标记：置位后不再启动任何新 Turn（含排队的）。 */
  let disposed = false;
  const ingest = createIngest({ db: deps.db, ...(deps.bus ? { bus: deps.bus } : {}) });

  // -------------------------------------------------------------------------
  // 事件接线：按 sessionId 找活跃 Turn
  //
  // Supervisor 已把驱动事件转发给所有订阅者；这里不按句柄分发，因为句柄会随
  // resume / 重建变化，而 Turn 与 sessionId 一一对应（会话锁保证）。
  // -------------------------------------------------------------------------

  sup.addListener({
    onEvent(sessionId, event) {
      const turn = active.get(sessionId);
      if (!turn || turn.settled) return;
      handleDriverEvent(turn, event);
    },
    onExit(sessionId, info, crashed) {
      const turn = active.get(sessionId);
      if (!turn || turn.settled) return;
      // 主动杀（cancel / 关服）：cancel() 自己会收口，这里不重复
      if (!crashed) return;
      settleFailure(turn, `运行时进程已退出（exit ${String(info.code)}）`, info.stderrTail);
    },
  });

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  function findSessionId(botId: string, channelId: string): string | null {
    const row = deps.db
      .prepare(
        `SELECT id FROM sessions
          WHERE bot_id = ? AND channel_id = ? AND status NOT IN ('ended','crashed','failed')
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(botId, channelId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  function createSession(botId: string, channelId: string, runtimeId: string): string {
    const id = `sess_${randomUUID()}`;
    deps.db
      .prepare(
        `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
         VALUES (?, ?, ?, ?, 'fresh', 'created', ?)`,
      )
      .run(id, botId, channelId, runtimeId, Date.now());
    return id;
  }

  function removeQueued(sessionId: string, turn: ActiveTurn): void {
    const list = queued.get(sessionId);
    if (!list) return;
    const next = list.filter((t) => t !== turn);
    if (next.length === 0) queued.delete(sessionId);
    else queued.set(sessionId, next);
  }

  // -------------------------------------------------------------------------
  // 事件 → ingest
  // -------------------------------------------------------------------------

  /** 给 payload 补 botId：群聊里主持人 ≠ 发言人（M3 明确要求）。 */
  function withBotId(event: CanonicalEvent, botId: string): CanonicalEvent {
    const payload = event.payload as unknown;
    if (typeof payload !== "object" || payload === null) return event;
    return {
      ...event,
      payload: { ...(payload as Record<string, unknown>), botId },
    } as unknown as CanonicalEvent;
  }

  function safeIngest(
    ctx: {
      sessionId: string;
      messageId: string | null;
      turnId: string;
      eventCapabilities: readonly EventType[];
    },
    event: CanonicalEvent,
  ): void {
    try {
      ingest(ctx, event);
    } catch (err) {
      // 单条事件落库失败不能中断整轮（PRD §7 可靠性）
      console.warn(
        `[turn] 事件落库失败（${event.type}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function handleDriverEvent(turn: ActiveTurn, event: CanonicalEvent): void {
    // 权限请求**不在这里落库**：驱动上报的只是「运行时想做什么」，还没有边界裁决，
    // 而且驱动自己也会 emit 一条 `permission_request`。权威的那条由权限层裁决后发出
    // （带 boundaryVerdict，越界时是 denied）。两处都落会在流里出现同一 requestId
    // 的两张卡（一张 pending 占位 + 一张已决），前端按 requestId 取状态会打架。
    if (event.type === "permission_request") return;

    const enriched = withBotId(event, turn.botId);
    safeIngest(
      {
        sessionId: turn.sessionId,
        messageId: turn.messageId,
        turnId: turn.turnId,
        eventCapabilities: turn.runtime.declaration.eventCapabilities,
      },
      enriched,
    );
    if (event.type === "usage") {
      const u = event.payload as {
        inputTokens?: unknown;
        outputTokens?: unknown;
        reported?: unknown;
        cumulative?: unknown;
      };
      // 只记上报值；未上报就保持 null，不填 0（P0-12）
      if (u.reported === true) {
        turn.tokens = {
          input: typeof u.inputTokens === "number" ? u.inputTokens : 0,
          output: typeof u.outputTokens === "number" ? u.outputTokens : 0,
        };
      }
      // 同时把原始样本留给用量记录器：累计值 vs 增量的裁决在 recorder 里做
      turn.usageSamples.push({
        inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : 0,
        outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : 0,
        reported: u.reported === true,
        ...(u.cumulative === true ? { cumulative: true } : {}),
      });
    }
    if (isTerminal(event)) settleFromEvent(turn, event);
  }

  function isTerminal(event: CanonicalEvent): boolean {
    if (event.type === "done") return true;
    if (event.type === "error") {
      return (event.payload as { fatal?: unknown }).fatal !== false;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 收口
  // -------------------------------------------------------------------------

  /**
   * 落用量（M13）。**永不抛错**：它在收口路径上，失败只会让统计少一行，
   * 不能反过来把已经结束的一轮变成异常。
   */
  function recordUsage(turn: ActiveTurn, status: "done" | "interrupted" | "failed"): void {
    if (turn.usageRecorded) return;
    turn.usageRecorded = true;
    const recorder = deps.usageRecorder;
    if (!recorder) return;

    // 模式：交互 Turn 是 interactive；Assignment / 定时任务走 headless（P0-12 标注）
    const mode = turn.source === "interactive" ? "interactive" : "headless";
    try {
      recorder.record({
        botId: turn.botId,
        runtimeId: turn.runtime.runtimeId,
        sessionId: turn.sessionId,
        mode,
        samples: turn.usageSamples,
        outcome: status,
      });
    } catch (err) {
      console.warn(`[turn] 用量落库失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 收口后的记忆钩子：达 40 条自动摘要；失败只记日志（不能影响 Turn 结果）。 */
  function afterSettle(turn: ActiveTurn): void {
    try {
      deps.summarizer?.maybeSummarize(turn.sessionId);
    } catch (err) {
      console.warn(`[turn] 自动摘要失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function settleFromEvent(turn: ActiveTurn, event: CanonicalEvent): void {
    if (turn.settled) return;
    turn.settled = true;

    let status: "done" | "interrupted" | "failed" = "done";
    if (event.type === "error") {
      status = "failed";
    } else if (event.type === "done") {
      const stopReason = (event.payload as { stopReason?: unknown }).stopReason;
      if (stopReason === "cancelled") status = "interrupted";
      else if (stopReason === "error") status = "failed";
    }

    try {
      messagesRepo.finalize(deps.db, {
        id: turn.messageId,
        status,
        ...(turn.tokens ? { tokensIn: turn.tokens.input, tokensOut: turn.tokens.output } : {}),
      });
    } catch (err) {
      // 收口写库失败不能让异常冒到驱动的事件回调里
      console.warn(`[turn] 收口未写库：${err instanceof Error ? err.message : String(err)}`);
    }
    recordUsage(turn, status);
    afterSettle(turn);
    finish(turn, status === "failed" ? "crashed" : "idle");
  }

  /**
   * 编排层自己发现失败（启动失败、进程没了但驱动没报）：补一条 error 再收口。
   *
   * 这个函数**必须永不抛错**：它处在失败路径上，而且常被 `void promise.catch(...)`
   * 调用 —— 抛出去就是未捕获的 rejection（关服/关库时尤其容易发生）。
   */
  function settleFailure(turn: ActiveTurn, message: string, detail?: string): void {
    if (turn.settled) return;
    turn.settled = true;
    safeIngest(
      {
        sessionId: turn.sessionId,
        messageId: turn.messageId,
        turnId: turn.turnId,
        eventCapabilities: turn.runtime.declaration.eventCapabilities,
      },
      {
        type: "error",
        turnId: turn.turnId,
        ts: Date.now(),
        payload: {
          code: "runtime_crashed",
          message,
          ...(detail === undefined ? {} : { detail }),
          fatal: true,
          botId: turn.botId,
        } as unknown as CanonicalEvent["payload"],
      },
    );
    try {
      messagesRepo.finalize(deps.db, { id: turn.messageId, status: "failed" });
    } catch (err) {
      // 库已关闭（关服/测试收尾）：状态没写成也不影响进程退出
      console.warn(`[turn] 失败收口未写库：${err instanceof Error ? err.message : String(err)}`);
    }
    recordUsage(turn, "failed");
    afterSettle(turn);
    finish(turn, "crashed");
  }

  function finish(turn: ActiveTurn, status: "idle" | "crashed"): void {
    if (active.get(turn.sessionId) === turn) active.delete(turn.sessionId);
    // 先交还锁再改状态：放锁会立刻唤醒排队的 Turn，它会立刻把状态改回 running
    lock.release(turn.sessionId, `turn:${turn.turnId}`);
    try {
      if (status === "crashed") sup.setStatus(turn.sessionId, "crashed");
      else sup.endTurn(turn.sessionId, turn.turnId);
    } catch {
      // 关服路径上 Supervisor 可能已 dispose
    }
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------

  async function start(input: StartTurnInput): Promise<TurnHandleInfo> {
    // 会话开始前重试待摘要标记（PRD P0-10：摘要时运行时不可用 → 下次会话开始前重试）。
    // 放在最前面且吞掉异常：摘要失败绝不能挡住用户发消息。
    if (deps.summarizer) {
      try {
        deps.summarizer.retryPending(input.botId);
      } catch (err) {
        console.warn(`[turn] 待摘要重试失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 运行时绑定先确认（没绑就 409，不必建消息行）。Supervisor 内部会再解析一次，
    // 但那一次是给 spawn 用的，两者必须同源（装配层注入的同一个函数）。
    const runtime = deps.resolveRuntime(input.botId);
    if (!runtime) {
      throw new TurnError("runtime_not_bound", "该 Bot 未绑定可用的运行时");
    }

    // 发送前预检工作目录（P0-13「发送时阻止并给重试」+ 安全底线）：
    // 没有权限请求通道的运行时必须落在 worktree；worktree 未就绪就**在发送前**拒绝，
    // 不能等消息落库、进程 spawn 失败后才报错（那样用户会看到一条永远失败的消息）。
    try {
      resolveSessionCwd(deps.db, input.botId, runtime.declaration);
    } catch (err) {
      if (err instanceof WorktreeNotReadyError) {
        throw new TurnError("worktree_not_ready", err.message);
      }
      throw err;
    }

    let sessionId: string;
    if (input.sessionId && !input.forceNewSession) {
      const row = deps.db.prepare("SELECT id FROM sessions WHERE id = ?").get(input.sessionId);
      if (!row) throw new TurnError("session_not_found", `会话不存在：${input.sessionId}`);
      sessionId = input.sessionId;
    } else {
      sessionId =
        (!input.forceNewSession ? findSessionId(input.botId, input.channelId) : null) ??
        createSession(input.botId, input.channelId, runtime.runtimeId);
    }

    const turnId = `turn_${randomUUID()}`;
    const lockOwner = `turn:${turnId}`;
    const source: TurnSource = input.source ?? "interactive";

    // ① 用户消息先落库：即使运行时立刻崩，用户说过的话不能丢
    const userMessageId = `msg_${randomUUID()}`;
    if (input.recordUserMessage !== false) {
      messagesRepo.create(deps.db, {
        id: userMessageId,
        sessionId,
        channelId: input.channelId,
        turnId,
        role: "user",
        content: input.userMessageText ?? input.text,
        status: "done",
      });
    }

    // ② 助手消息行必须先建：ingest 追加正文时靠它
    const messageId = `msg_${randomUUID()}`;
    messagesRepo.create(deps.db, {
      id: messageId,
      sessionId,
      channelId: input.channelId,
      turnId,
      role: "assistant",
      status: "streaming",
    });

    // ③ 会话锁：拿不到就排队（P0-15 双标签页，前端显示「排队中」）
    const acquired = lock.tryAcquire(sessionId, lockOwner);

    const turn: ActiveTurn = {
      turnId,
      sessionId,
      messageId,
      botId: input.botId,
      runtime,
      source,
      startedAt: Date.now(),
      settled: false,
      cancelled: false,
      tokens: null,
      usageSamples: [],
      usageRecorded: false,
    };

    if (!acquired.ok) {
      // 排队：前一 Turn 收口时自动放行（P0-15「前一 Turn 结束自动放行」）
      const waiter = lock.wait(sessionId, lockOwner);
      turn.waiter = waiter;
      const list = queued.get(sessionId) ?? [];
      list.push(turn);
      queued.set(sessionId, list);

      void waiter.granted.then(() => {
        removeQueued(sessionId, turn);
        if (turn.cancelled || turn.settled) return;
        if (disposed) {
          // 关服中：排队的不再启动，如实标中断（不能让 await 悬着）
          turn.settled = true;
          messagesRepo.finalize(deps.db, { id: turn.messageId, status: "interrupted" });
          return;
        }
        turn.waiter = undefined;
        active.set(sessionId, turn);
        void run(turn, input).catch((err: unknown) => {
          settleFailure(turn, "这一轮启动失败", err instanceof Error ? err.message : String(err));
        });
      });
      return { turnId, sessionId, messageId, queued: true, position: waiter.position };
    }

    active.set(sessionId, turn);
    // 后台执行：HTTP 立刻返回 turnId，前端靠 SSE 收流
    void run(turn, input).catch((err: unknown) => {
      settleFailure(turn, "这一轮启动失败", err instanceof Error ? err.message : String(err));
    });

    return { turnId, sessionId, messageId, queued: false };
  }

  async function run(turn: ActiveTurn, input: StartTurnInput): Promise<void> {
    const { sessionId } = turn;
    if (disposed) return;

    // 进程由 Supervisor 提供：复用或 spawn（含 resume / 重建）。
    // 传本轮 turnId：本轮的 user 消息已经落库，重建上下文时要把它排除，
    // 否则首轮会被误判成「有历史」，且模型会看到同一句话两遍。
    const ensured = await sup.ensure(sessionId, { excludeTurnId: turn.turnId });

    sup.beginTurn(sessionId, {
      turnId: turn.turnId,
      messageId: turn.messageId,
      botId: turn.botId,
      source: turn.source,
      startedAt: turn.startedAt,
    });

    // 本轮上下文：驱动产出事件时读它（契约的 prompt 不接受 turnId）
    setTurnContext(ensured.handle, {
      turnId: turn.turnId,
      messageId: turn.messageId,
      botId: turn.botId,
    });

    try {
      await ensured.driver.prompt(ensured.handle, { text: input.text });
    } finally {
      clearTurnContext(ensured.handle);
      // prompt 正常返回但没收到终态事件（驱动只 resolve 不发 done）：
      // 不能让 UI 永远停在「生成中」，补一次收口
      if (!turn.settled) {
        settleFromEvent(turn, {
          type: "done",
          turnId: turn.turnId,
          ts: Date.now(),
          payload: {
            stopReason: turn.cancelled ? "cancelled" : "end",
            durationMs: Date.now() - turn.startedAt,
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 取消
  // -------------------------------------------------------------------------

  async function cancel(sessionId: string, turnId: string): Promise<boolean> {
    const queuedTurn = (queued.get(sessionId) ?? []).find((t) => t.turnId === turnId);
    if (queuedTurn) {
      // 排队中的 Turn：还没跑，撤出队列并收口，绝不能去 cancel 别人正在用的进程
      queuedTurn.cancelled = true;
      queuedTurn.settled = true;
      queuedTurn.waiter?.cancel();
      queuedTurn.waiter = undefined;
      removeQueued(sessionId, queuedTurn);
      messagesRepo.finalize(deps.db, { id: queuedTurn.messageId, status: "interrupted" });
      return true;
    }

    const turn = active.get(sessionId);
    if (!turn || turn.turnId !== turnId) {
      // 轮次已结束（或不是这一轮）：幂等返回 false，路由层回 409
      return false;
    }
    turn.cancelled = true;

    // ① 先请求运行时优雅取消（P0-04：1s 内发出）
    await sup.cancel(sessionId).catch(() => undefined);

    // ② 1s 内没有终态 → 树杀进程并如实标中断。
    //    运行时可能完全不响应 cancel（例如卡在等待权限），不杀会让进程一直占着
    //    会话锁，用户看到「停止中」永远不动；树杀后 runtime_session_id 保留，
    //    下一条消息走 resume / 重建。
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !turn.settled) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!turn.settled) {
      await sup.kill(sessionId, "cancel").catch(() => undefined);
      settleFromEvent(turn, {
        type: "done",
        turnId: turn.turnId,
        ts: Date.now(),
        payload: { stopReason: "cancelled", durationMs: Date.now() - turn.startedAt },
      });
    }
    return true;
  }

  async function dispose(): Promise<void> {
    disposed = true;

    // 排队中的 Turn 先撤出队列并收口：否则关服后它们的 promise 永远挂着，
    // 也可能在库关闭后尝试写库（测试里就是这条路径暴露的问题）
    for (const [sessionId, list] of queued) {
      for (const turn of list) {
        turn.settled = true;
        turn.cancelled = true;
        turn.waiter?.cancel();
        turn.waiter = undefined;
        try {
          messagesRepo.finalize(deps.db, { id: turn.messageId, status: "interrupted" });
        } catch {
          // 库可能已经关了：关服路径上不因收口失败而抛错
        }
        lock.release(sessionId, `turn:${turn.turnId}`);
      }
    }
    queued.clear();
    active.clear();
  }

  return {
    start,
    cancel,
    activeTurn: (sessionId) => {
      const t = active.get(sessionId);
      return t ? { turnId: t.turnId, botId: t.botId } : null;
    },
    dispose,
  };
}
