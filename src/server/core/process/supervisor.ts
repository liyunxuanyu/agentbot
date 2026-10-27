import type { DB } from "../db/db.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  CompactionResult,
  ExitInfo,
  PermissionDecision,
  PromptControls,
  RuntimePermissionRequest,
  SessionHandle,
} from "../../adapters/contract.js";
import type { CanonicalEvent, PermissionMode } from "../../../shared/events.js";
import { config } from "../../config.js";
import type { EventBus } from "../events/bus.js";
import { createIngest } from "../events/ingest.js";
import { buildBootstrapContext, buildRebuildContext } from "../orchestrator/context.js";
import { killTree, killTreeSync } from "./kill-tree.js";
import { resolveSessionCwd, resolveWorkspace } from "./session-cwd.js";
import {
  createPidRegistry,
  installExitHooks,
  type PidRegistry,
} from "./pid-registry.js";

/**
 * 进程 Supervisor（M5）：一个 Session 一个运行时进程的**唯一**管理者。
 *
 * 编排层只做 `await supervisor.ensure(sessionId)` 拿句柄，不再自己 spawn、
 * 不再自己管 pid、不再自己判断 resume。搬出来的原因不是「代码整洁」，
 * 而是进程有生命周期（空闲回收、崩溃、僵尸清扫），而 Turn 只在几秒到几分钟内存在。
 *
 * 状态机（落 `sessions.status`，词表与前端 `SessionDto.status` 一致）：
 *
 *   created → starting → ready ⇄ running ⇄ waiting_permission
 *                          │         │
 *                          │         └→ idle ─(空闲 10min)→ reaped（杀进程，留 runtime_session_id）
 *                          └→ crashed（非预期退出）
 *   任意态 →(用户结束 / 关服 / 改绑运行时)→ ended
 *
 *   注：任务书里的 `busy` 在本文件即 `running` —— 数据库与前端已按 running 定稿，
 *   多造一个同义词只会让 dto 与 UI 各自猜一次。
 *
 * 四条纪律：
 *   ① **`driver.onExit` 只在这里注册**。崩溃时把该 Session 所有进行中的 Turn
 *      标失败（`messages.status='failed'`），再通知订阅者（权限层据此转失效）。
 *   ② **空闲回收只杀进程**，保留 `runtime_session_id`；下次消息走 resume 或重建。
 *   ③ **resume 失败/不支持一律走产品层重建**，不向用户报错中断（P0-15）。
 *   ④ **事件与权限回调也只在这里接线**：每个句柄注册一次，重连/重建后自动重挂。
 *
 * 本文件不出现任何协议字符串：运行时绑定由装配层注入（声明 + 驱动）。
 */

/** 运行时绑定（与编排层的 TurnRuntime 同形；结构相同即可传）。 */
export interface RuntimeBinding {
  runtimeId: string;
  declaration: AdapterDeclaration;
  driver: ChannelDriver;
}

/** 触发来源：决定权限的超时档位（board 03-decisions 决定 Q1）。 */
export type TurnSource = "interactive" | "assignment" | "schedule";

export interface TurnRef {
  turnId: string;
  messageId: string;
  botId: string;
  source: TurnSource;
  startedAt: number;
}

export interface EnsuredSession {
  sessionId: string;
  botId: string;
  runtimeId: string;
  declaration: AdapterDeclaration;
  driver: ChannelDriver;
  handle: SessionHandle;
  pid: number | null;
  /** 本次 ensure 的上下文状态。 */
  resumeState: "fresh" | "resumed" | "rebuilt";
  /** 重建时被省略的历史条数（0 = 没省略）。 */
  omittedMessages: number;
  /** true 表示复用了已有进程（没有重新 spawn）。 */
  reused: boolean;
}

export interface EnsureOptions {
  /**
   * 本轮自己的 turnId。
   *
   * 编排层的顺序是「先写 user 消息 → 再 ensure」，所以库里已经有本轮的用户原话。
   * 重建上下文时必须把它排除，否则：
   *   ① 首轮会被误判成「有历史」而走重建（应该走「人格 + 记忆」的首轮上下文）；
   *   ② 重建的历史里会重复出现本轮的问题（模型看到同一句话两遍）。
   */
  excludeTurnId?: string;
}

/** 订阅者：编排层与权限层各注册一个，互不知道对方存在。 */
export interface SupervisorListener {
  onEvent?(sessionId: string, event: CanonicalEvent): void;
  onPermission?(sessionId: string, req: RuntimePermissionRequest): void;
  /** `crashed=false` 表示主动结束（kill / 关服 / 改绑）。 */
  onExit?(sessionId: string, info: ExitInfo, crashed: boolean): void;
}

export type SessionStatus =
  | "created"
  | "starting"
  | "ready"
  | "running"
  | "waiting_permission"
  | "idle"
  | "reaped"
  | "crashed"
  | "ended";

export type KillReason = "cancel" | "idle" | "runtime_switch" | "shutdown";

export interface SupervisorDeps {
  db: DB;
  /** 按 Bot 解析运行时；未绑定返回 null。 */
  resolveRuntime(botId: string): RuntimeBinding | null;
  /** 不传则 meta 事件只落库不广播（单元测试）。 */
  bus?: EventBus;
  /** 空闲回收时长；默认取 config.limits.idleReapMs（10 分钟）。 */
  idleReapMs?: number;
  /** 注入便于测试（默认走真实树杀）。 */
  killImpl?: (pid: number) => Promise<{ gone: boolean }>;
  registry?: PidRegistry;
  log?: (msg: string) => void;
}

export interface Supervisor {
  /** 复用或 spawn。并发调用合并成一次 spawn。 */
  ensure(sessionId: string, opts?: EnsureOptions): Promise<EnsuredSession>;
  /** 通知运行时取消当前轮（不杀进程）。 */
  cancel(sessionId: string): Promise<void>;
  /** 树杀进程。reason 决定落库状态（cancel→idle / idle→reaped / 其它→ended）。 */
  kill(sessionId: string, reason?: KillReason): Promise<void>;
  /** 进程是否在（权限卡片「请求已失效」判定用）。 */
  isAlive(sessionId: string): boolean;
  /** 当前进程（不 spawn）；没有返回 null。 */
  current(sessionId: string): EnsuredSession | null;
  /** 直接写会话状态（编排层失败收口用）。 */
  setStatus(sessionId: string, status: SessionStatus): void;
  /** Turn 开始：登记活跃 Turn，置 running，暂停空闲回收。 */
  beginTurn(sessionId: string, ref: TurnRef): void;
  /** Turn 收口：注销活跃 Turn；有待批权限时保持 waiting_permission，否则 idle。 */
  endTurn(sessionId: string, turnId: string): void;
  /** 当前活跃 Turn（权限层据此拿 botId / source / turnId）。 */
  activeTurn(sessionId: string): TurnRef | null;
  /** 权限挂起期间保活；解除后重新开始空闲计时。 */
  setHeld(sessionId: string, held: boolean): void;
  /** 把裁决回传运行时；进程已不在返回 false。 */
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<boolean>;
  /**
   * 生成中更新会话控制项（内置引擎）。只影响后续轮次与尚未裁决的调用（G3）。
   * 进程不在时静默忽略 —— 下次 ensure 会从库里重新读。
   */
  setControls(sessionId: string, controls: PromptControls): void;
  /**
   * 压缩会话上下文（内置引擎）。进程不在 / 驱动不支持时返回 null。
   * `force=true` 手动触发；否则只在超过阈值时压缩。
   */
  compact(sessionId: string, opts?: { force?: boolean }): Promise<CompactionResult | null>;
  addListener(listener: SupervisorListener): () => void;
  /** 关服：杀掉所有进程。 */
  dispose(): Promise<void>;
  readonly registry: PidRegistry;
}

interface Managed {
  sessionId: string;
  botId: string;
  runtimeId: string;
  declaration: AdapterDeclaration;
  driver: ChannelDriver;
  handle: SessionHandle;
  idleTimer: NodeJS.Timeout | null;
  /** 回调只接一次：重连/重建会换句柄，旧句柄随进程消失。 */
  wired: boolean;
  /** 主动杀进程时置位：退出回调不再按崩溃处理。 */
  closing: boolean;
}

const KILL_STATUS: Record<KillReason, SessionStatus> = {
  cancel: "idle",
  idle: "reaped",
  runtime_switch: "ended",
  shutdown: "ended",
};

/**
 * 会话的工作目录：worktree 优先，其次会话/渠道工作区，最后服务进程 cwd。
 * 权限层做相对路径解析时用的是同一个基准（装配层复用它）。
 *
 * 传 sessionId 时会按 R2 的回退链解析（内置引擎的 cwd 就是它）；
 * 不传时保持历史行为（只认 Bot），供 Assignment 等没有 Session 的场景使用。
 */
export function sessionCwdOf(db: DB, botId: string, sessionId?: string | null): string {
  const bot = db
    .prepare("SELECT repo_path, worktree_path, execution_location FROM bots WHERE id = ?")
    .get(botId) as
    | { repo_path: string | null; worktree_path: string | null; execution_location: string }
    | undefined;
  if (bot) {
    // worktree 是隔离执行位置，优先级最高；内置引擎不用 worktree，会落到回退链
    if (bot.execution_location === "worktree" && bot.worktree_path && bot.worktree_path.length > 0) {
      return bot.worktree_path;
    }
  }
  if (sessionId) {
    return resolveWorkspace(db, { botId, sessionId }).path;
  }
  if (bot && bot.repo_path && bot.repo_path.length > 0) return bot.repo_path;
  // 没配路径时用服务进程 cwd：至少落在用户启动服务的地方，不会乱跑
  return process.cwd();
}

interface SessionRow {
  id: string;
  bot_id: string;
  runtime_id: string | null;
  runtime_session_id: string | null;
  resume_state: string;
  /** 会话级覆盖（R4/R5）；空值表示回退到 Bot 默认值。 */
  session_provider_id: string | null;
  session_model: string | null;
  session_workspace_path: string | null;
  permission_mode: string | null;
  /** Bot 默认值。 */
  bot_provider_id: string | null;
  bot_permission_mode: string | null;
  bot_role: string | null;
  channel_id: string | null;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const idleReapMs = deps.idleReapMs ?? config.limits.idleReapMs;
  const log = deps.log ?? ((msg: string) => console.warn(`[supervisor] ${msg}`));
  const registry = deps.registry ?? createPidRegistry();
  const ingest = createIngest({ db: deps.db, ...(deps.bus ? { bus: deps.bus } : {}) });
  const listeners = new Set<SupervisorListener>();

  const managed = new Map<string, Managed>();
  /** 同一 Session 的并发 ensure 合并（双标签页同时发消息时不会 spawn 两次）。 */
  const inflight = new Map<string, Promise<EnsuredSession>>();
  /** 活跃 Turn：每 Session 最多一个（会话锁保证）。 */
  const turns = new Map<string, TurnRef>();
  /** 权限挂起中的 Session（保活，不回收）。 */
  const held = new Set<string>();
  let disposed = false;

  installExitHooks(registry);

  const killImpl = deps.killImpl ?? (async (pid: number) => ({ gone: (await killTree(pid)).gone }));

  // -------------------------------------------------------------------------
  // 状态与空闲回收
  // -------------------------------------------------------------------------

  function setStatus(sessionId: string, status: SessionStatus): void {
    try {
      deps.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, sessionId);
    } catch (err) {
      // 库已关闭（关服 / 测试收尾）：状态没写成不影响进程处理
      log(`状态写入失败（${sessionId} → ${status}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function clearIdle(entry: Managed): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  function pendingPermissions(sessionId: string): number {
    try {
      const row = deps.db
        .prepare("SELECT COUNT(*) AS n FROM permission_requests WHERE session_id = ? AND status = 'pending'")
        .get(sessionId) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  function scheduleIdle(sessionId: string): void {
    const entry = managed.get(sessionId);
    if (!entry || idleReapMs <= 0) return;
    if (held.has(sessionId) || turns.has(sessionId)) return;
    clearIdle(entry);
    const timer = setTimeout(() => {
      const cur = managed.get(sessionId);
      if (!cur || held.has(sessionId) || turns.has(sessionId)) return;
      log(`Session ${sessionId} 空闲超过 ${idleReapMs}ms，回收进程 ${String(cur.handle.pid)}`);
      void kill(sessionId, "idle");
    }, idleReapMs);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  // -------------------------------------------------------------------------
  // 杀进程
  // -------------------------------------------------------------------------

  async function kill(sessionId: string, reason: KillReason = "cancel"): Promise<void> {
    const entry = managed.get(sessionId);
    if (!entry) {
      setStatus(sessionId, KILL_STATUS[reason]);
      return;
    }
    entry.closing = true;
    clearIdle(entry);
    managed.delete(sessionId);
    held.delete(sessionId);

    const pid = entry.handle.pid;
    // 先树杀（快，且保证子进程一起走），再让驱动释放内部状态
    if (pid !== null) {
      const res = await killImpl(pid).catch(() => ({ gone: false }));
      if (!res.gone) log(`进程 ${pid}（Session ${sessionId}）未能确认退出，已尝试树杀`);
      registry.unregister(sessionId);
    }
    await entry.driver.dispose(entry.handle).catch(() => undefined);

    try {
      deps.db
        .prepare(
          "UPDATE sessions SET process_pid = NULL, process_started_at = NULL, status = ? WHERE id = ?",
        )
        .run(KILL_STATUS[reason], sessionId);
    } catch {
      // 库可能已关闭
    }
  }

  // -------------------------------------------------------------------------
  // resume / 重建
  // -------------------------------------------------------------------------

  function sessionRow(sessionId: string): SessionRow | null {
    const row = deps.db
      .prepare(
        `SELECT s.id, s.bot_id, s.runtime_id, s.runtime_session_id, s.resume_state,
                s.provider_id AS session_provider_id,
                s.model AS session_model,
                s.workspace_path AS session_workspace_path,
                s.permission_mode,
                s.channel_id,
                b.provider_id AS bot_provider_id,
                b.permission_mode AS bot_permission_mode,
                b.role AS bot_role
           FROM sessions s
           LEFT JOIN bots b ON b.id = s.bot_id
          WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  /** 会话级权限模式：会话值（非空）优先，其次 Bot 默认，最后 confirm（G2）。 */
  function permissionModeOf(row: SessionRow): PermissionMode {
    const candidate = row.permission_mode ?? row.bot_permission_mode ?? "confirm";
    return candidate === "auto" || candidate === "plan" || candidate === "full"
      ? candidate
      : "confirm";
  }

  /**
   * 该 Session 有没有历史消息（排除本轮自己）。
   *
   * 为什么不能只看 `runtime_session_id`：process-lifetime 通道（CLI）每轮一个进程，
   * `runtime_session_id` 是本驱动编的占位 id，进程退出后它仍在，但**上下文没了**；
   * 反过来，崩溃后重建的 Session 可能 `runtime_session_id` 为空却已经有几轮对话。
   * 唯一可靠的判据是产品层真相 —— `messages` 表里该 Session 有没有用户消息。
   */
  function sessionHasHistory(sessionId: string, excludeTurnId?: string): boolean {
    try {
      const row =
        excludeTurnId === undefined
          ? deps.db
              .prepare("SELECT 1 AS ok FROM messages WHERE session_id = ? AND role = 'user' LIMIT 1")
              .get(sessionId)
          : deps.db
              .prepare(
                `SELECT 1 AS ok FROM messages
                  WHERE session_id = ? AND role = 'user' AND turn_id != ? LIMIT 1`,
              )
              .get(sessionId, excludeTurnId);
      return row !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * 只在**状态变化**时落 meta（UX §2.3：分隔条只在这里切一刀）。
   * 否则 process-lifetime 的 CLI 每轮都插一条「已重建上下文」。
   *
   * `omittedMessages` **永远是数字**（0 表示没省略）：前端要区分「没省略」与
   * 「字段缺失」，给 undefined 会让它无法判断该不该画「已省略 N 条历史」。
   */
  function emitResumeMeta(
    sessionId: string,
    resumeState: "resumed" | "rebuilt",
    runtimeSessionId: string | null,
    omittedMessages: number,
  ): void {
    const metaTurnId = `meta_${sessionId}`;
    const data: Record<string, unknown> = { runtimeSessionId, omittedMessages };
    try {
      ingest(
        { sessionId, messageId: null, turnId: metaTurnId, eventCapabilities: [] },
        {
          type: "meta",
          turnId: metaTurnId,
          ts: Date.now(),
          payload: {
            kind: resumeState === "resumed" ? "session_resumed" : "session_rebuilt",
            data,
          },
        },
      );
    } catch (err) {
      log(`meta 写入失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function wire(sessionId: string, entry: Managed): void {
    if (entry.wired) return;
    entry.wired = true;
    const { driver, handle } = entry;

    driver.onEvent(handle, (event) => {
      for (const listener of [...listeners]) {
        try {
          listener.onEvent?.(sessionId, event);
        } catch (err) {
          log(`事件订阅者抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    driver.onPermission(handle, (req) => {
      for (const listener of [...listeners]) {
        try {
          listener.onPermission?.(sessionId, req);
        } catch (err) {
          log(`权限订阅者抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    driver.onExit(handle, (info) => onProcessExit(sessionId, entry, info));
  }

  function onProcessExit(sessionId: string, entry: Managed, info: ExitInfo): void {
    const current = managed.get(sessionId);
    const intentional = entry.closing || current !== entry;
    if (current === entry) {
      clearIdle(entry);
      managed.delete(sessionId);
    }
    held.delete(sessionId);
    registry.unregister(sessionId);

    const turn = turns.get(sessionId);
    /**
     * 预期退出（process-lifetime 通道的正常形态）。
     *
     * CLI 通道是「一次 prompt 一个进程」：每轮跑完进程就 exit 0，这是设计行为，
     * 不是崩溃。判定必须同时满足两个条件：
     *   ① exit code === 0；
     *   ② **该 Session 没有进行中的 Turn**。
     *
     * ② 是关键：长连接型通道 exit 0 但 Turn 还在跑 = 真崩溃（连接被对端关掉、
     * 运行时自己退出），必须仍判 crashed，否则那一轮会永远停在「生成中」。
     */
    const expected = !intentional && info.code === 0 && turn === undefined;

    // 崩溃：该 Session 所有进行中的 Turn 标失败（进程没了，消息不能停在 streaming）
    if (!intentional && !expected && turn) {
      try {
        deps.db
          .prepare("UPDATE messages SET status = 'failed' WHERE id = ? AND status = 'streaming'")
          .run(turn.messageId);
      } catch {
        // 库可能已关闭
      }
      turns.delete(sessionId);
    }

    if (!intentional) {
      if (expected) {
        // 正常收工：清进程字段、保留 runtime_session_id（下次仍可 resume / 重建），
        // 状态回 idle —— 绝不能写 crashed，否则下一轮 findSessionId 会新建 Session，
        // 历史随之丢失（P0-15 的整条链路就断在这里）。
        setStatus(sessionId, "idle");
        try {
          deps.db
            .prepare(
              "UPDATE sessions SET process_pid = NULL, process_started_at = NULL WHERE id = ?",
            )
            .run(sessionId);
        } catch {
          // 同上
        }
      } else {
        log(
          `Session ${sessionId} 进程退出（exit ${String(info.code)}${info.signal ? ` / ${info.signal}` : ""}）${
            info.stderrTail ? `：${info.stderrTail.slice(-300)}` : ""
          }`,
        );
        setStatus(sessionId, "crashed");
        try {
          deps.db
            .prepare("UPDATE sessions SET process_pid = NULL, ended_at = ? WHERE id = ?")
            .run(Date.now(), sessionId);
        } catch {
          // 同上
        }
      }
    }

    for (const listener of [...listeners]) {
      try {
        // 预期退出对订阅者而言不是崩溃（编排层据此不补 error 事件）
        listener.onExit?.(sessionId, info, !intentional && !expected);
      } catch (err) {
        log(`退出订阅者抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ensure
  // -------------------------------------------------------------------------

  async function spawn(
    sessionId: string,
    row: SessionRow,
    runtime: RuntimeBinding,
    opts?: EnsureOptions,
  ): Promise<EnsuredSession> {
    // 工作目录判定（安全底线）：运行时没有权限请求通道时**强制** worktree；
    // worktree 未就绪抛 WorktreeNotReadyError，绝不静默降级到 local。
    // 内置引擎走会话级工作区回退链（R2）。
    const resolved = resolveSessionCwd(deps.db, row.bot_id, runtime.declaration, {
      sessionId,
      channelId: row.channel_id,
    });
    const cwd = resolved.cwd;
    if (resolved.forcedWorktree) {
      log(
        `Session ${sessionId}：${runtime.declaration.displayName} 不提供权限请求，已强制在 worktree 执行（${cwd}）`,
      );
    }
    setStatus(sessionId, "starting");

    let handle: SessionHandle;
    try {
      handle = await runtime.driver.start(runtime.declaration, {
        cwd,
        workspacePath: resolved.workspacePath,
        sessionId,
        botId: row.bot_id,
        channelId: row.channel_id,
        providerId: row.session_provider_id ?? row.bot_provider_id ?? null,
        model: row.session_model ?? null,
        permissionMode: permissionModeOf(row),
        botRole: row.bot_role === "admin" ? "admin" : "member",
      });
    } catch (err) {
      setStatus(sessionId, "crashed");
      throw err;
    }

    const entry: Managed = {
      sessionId,
      botId: row.bot_id,
      runtimeId: runtime.runtimeId,
      declaration: runtime.declaration,
      driver: runtime.driver,
      handle,
      idleTimer: null,
      wired: false,
      closing: false,
    };
    managed.set(sessionId, entry);
    wire(sessionId, entry);
    if (handle.pid !== null) registry.register(sessionId, handle.pid);

    // initialize 失败不阻断：有的运行时不需要握手，newSession 才是硬要求
    await runtime.driver.initialize(handle).catch(() => undefined);

    const previousRuntimeSessionId = row.runtime_session_id;
    const previousState = row.resume_state;
    let runtimeSessionId: string | null = null;
    let resumeState: "fresh" | "resumed" | "rebuilt" = "fresh";
    let omitted = 0;

    // ① 优先试运行时 resume（P0-15）。声明为 none / process-lifetime 的直接跳过，
    //    省一次必然失败的往返。
    const strategy = runtime.declaration.resumeStrategy;
    const resumePossible =
      previousRuntimeSessionId !== null &&
      strategy !== "none" &&
      strategy !== "process-lifetime" &&
      runtime.declaration.capabilities.resume !== false;

    if (resumePossible && previousRuntimeSessionId !== null) {
      const resumed = await runtime.driver
        .resumeSession(handle, previousRuntimeSessionId)
        .catch(() => ({ ok: false as const, reason: "resume 调用失败" }));
      if (resumed.ok) {
        runtimeSessionId = previousRuntimeSessionId;
        resumeState = "resumed";
      } else {
        log(`Session ${sessionId} resume 未成功（${resumed.reason ?? "未知原因"}），转产品层重建`);
      }
    }

    // ② resume 不可用 / 失败 → 产品层重建（人格 + 记忆 + 最近 20 条消息）
    //
    // 「有没有历史」看的是 `messages` 表，而不是 `runtime_session_id`：
    // CLI 通道每轮一个进程，占位 id 一直存在但上下文早已丢失；反过来崩溃重建后
    // 的 Session 可能 id 为空却已经有几轮对话。判据错了就会跳过重建，
    // 模型在第二轮完全不知道自己刚才说过什么（P0-15）。
    if (!runtimeSessionId) {
      const hasHistory = sessionHasHistory(sessionId, opts?.excludeTurnId);
      let systemPrompt: string | undefined;
      let history: { role: "user" | "assistant"; content: string }[] | undefined;
      // 内置引擎有自己的对话历史：历史以消息形式交给它，系统提示只留
      // 「人格 + 记忆」并允许每轮刷新（记忆改了下一轮生效）。CLI 通道没有
      // 消息级历史，仍把历史段落写进系统提示。
      const builtinProtocol = runtime.declaration.protocol === "builtin";
      if (hasHistory) {
        const rebuilt = buildRebuildContext({
          db: deps.db,
          botId: row.bot_id,
          sessionId,
          contextWindow: runtime.declaration.capabilities.contextWindow,
          ...(opts?.excludeTurnId === undefined ? {} : { excludeTurnId: opts.excludeTurnId }),
        });
        if (builtinProtocol) {
          if (rebuilt.memoryText.length > 0) systemPrompt = rebuilt.memoryText;
          if (rebuilt.history.length > 0) history = rebuilt.history;
        } else if (rebuilt.systemPrompt.length > 0) {
          systemPrompt = rebuilt.systemPrompt;
        }
        omitted = rebuilt.omittedMessages;
        resumeState = "rebuilt";
      } else {
        // 首轮也要注入人格 + 记忆（P0-10「每轮注入」）：没有历史可重建，
        // 就只带「人格 + 记忆」，不带引导语与消息段。
        // 传 sessionId：session/channel 作用域的记忆靠它命中（R3）。
        const bootstrap = buildBootstrapContext({
          db: deps.db,
          botId: row.bot_id,
          sessionId,
        });
        if (bootstrap.systemPrompt.length > 0) systemPrompt = bootstrap.systemPrompt;
        omitted = 0;
      }
      try {
        const created = await runtime.driver.newSession(handle, {
          cwd,
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
          ...(history === undefined ? {} : { history }),
        });
        runtimeSessionId = created.runtimeSessionId;
      } catch (err) {
        // 开会话失败：进程留着没有意义，杀掉再抛（编排层会标这一轮失败）
        await kill(sessionId, "cancel").catch(() => undefined);
        setStatus(sessionId, "crashed");
        throw err;
      }
    }

    try {
      deps.db
        .prepare(
          `UPDATE sessions
              SET runtime_session_id = ?, resume_state = ?, status = 'ready',
                  process_pid = ?, process_started_at = ?
            WHERE id = ?`,
        )
        .run(runtimeSessionId, resumeState, handle.pid, Date.now(), sessionId);
    } catch (err) {
      log(`会话状态写入失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    }

    if (resumeState !== "fresh" && resumeState !== previousState) {
      emitResumeMeta(sessionId, resumeState, runtimeSessionId, omitted);
    }

    // 起 idle 计时：ensure 之后若没有 Turn 立刻开始（例如预启动、或 Turn 建消息失败），
    // 进程也要能被回收。beginTurn 会立刻 clear 掉它。
    scheduleIdle(sessionId);

    return {
      sessionId,
      botId: row.bot_id,
      runtimeId: runtime.runtimeId,
      declaration: runtime.declaration,
      driver: runtime.driver,
      handle,
      pid: handle.pid,
      resumeState,
      omittedMessages: omitted,
      reused: false,
    };
  }

  async function ensure(sessionId: string, opts?: EnsureOptions): Promise<EnsuredSession> {
    if (disposed) throw new Error("Supervisor 已关闭，不能再启动会话进程");

    const pending = inflight.get(sessionId);
    if (pending) return pending;

    const existing = managed.get(sessionId);
    const row = sessionRow(sessionId);
    if (!row) throw new Error(`会话不存在：${sessionId}`);

    const runtime = deps.resolveRuntime(row.bot_id);
    if (!runtime) throw new Error(`该 Bot 未绑定可用的运行时：${row.bot_id}`);

    if (existing && existing.runtimeId === runtime.runtimeId && !existing.closing) {
      // 复用时重排空闲计时（不重置的话，上次的计时器会按旧起点触发）
      scheduleIdle(sessionId);
      return {
        sessionId,
        botId: existing.botId,
        runtimeId: existing.runtimeId,
        declaration: existing.declaration,
        driver: existing.driver,
        handle: existing.handle,
        pid: existing.handle.pid,
        resumeState: "fresh",
        omittedMessages: 0,
        reused: true,
      };
    }

    const task = (async (): Promise<EnsuredSession> => {
      if (existing) {
        // 运行时被改绑：旧进程必须杀掉，否则两个进程会写同一个会话
        log(`Session ${sessionId} 运行时改绑 ${existing.runtimeId} → ${runtime.runtimeId}，先杀旧进程`);
        await kill(sessionId, "runtime_switch");
        // 改绑后旧的 runtime_session_id 对新运行时无意义，清掉走 fresh
        deps.db
          .prepare("UPDATE sessions SET runtime_session_id = NULL, resume_state = 'fresh' WHERE id = ?")
          .run(sessionId);
        const fresh = sessionRow(sessionId);
        if (!fresh) throw new Error(`会话不存在：${sessionId}`);
        return spawn(sessionId, fresh, runtime, opts);
      }
      return spawn(sessionId, row, runtime, opts);
    })();

    inflight.set(sessionId, task);
    try {
      return await task;
    } finally {
      inflight.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  const api: Supervisor = {
    ensure,

    async cancel(sessionId) {
      const entry = managed.get(sessionId);
      if (!entry) return;
      try {
        await entry.driver.cancel(entry.handle);
      } catch {
        // 进程已退出：取消自然生效
      }
    },

    kill,

    isAlive(sessionId) {
      return managed.has(sessionId);
    },

    current(sessionId) {
      const entry = managed.get(sessionId);
      if (!entry) return null;
      return {
        sessionId,
        botId: entry.botId,
        runtimeId: entry.runtimeId,
        declaration: entry.declaration,
        driver: entry.driver,
        handle: entry.handle,
        pid: entry.handle.pid,
        resumeState: "fresh",
        omittedMessages: 0,
        reused: true,
      };
    },

    setStatus,

    beginTurn(sessionId, ref) {
      turns.set(sessionId, ref);
      const entry = managed.get(sessionId);
      if (entry) clearIdle(entry);
      setStatus(sessionId, "running");
    },

    endTurn(sessionId, turnId) {
      const cur = turns.get(sessionId);
      if (cur && cur.turnId !== turnId) return;
      turns.delete(sessionId);
      // 权限挂起中不改状态：卡片还在等用户，Session 应显示 waiting_permission
      if (held.has(sessionId) || pendingPermissions(sessionId) > 0) {
        setStatus(sessionId, "waiting_permission");
        return;
      }
      setStatus(sessionId, "idle");
      scheduleIdle(sessionId);
    },

    activeTurn(sessionId) {
      return turns.get(sessionId) ?? null;
    },

    setHeld(sessionId, isHeld) {
      if (isHeld) {
        held.add(sessionId);
        const entry = managed.get(sessionId);
        if (entry) clearIdle(entry);
        setStatus(sessionId, "waiting_permission");
      } else {
        held.delete(sessionId);
        if (turns.has(sessionId)) setStatus(sessionId, "running");
        else {
          setStatus(sessionId, "idle");
          scheduleIdle(sessionId);
        }
      }
    },

    async respondPermission(sessionId, requestId, decision) {
      const entry = managed.get(sessionId);
      if (!entry) return false;
      try {
        await entry.driver.respondPermission(entry.handle, requestId, decision);
        return true;
      } catch (err) {
        log(
          `权限应答失败（${sessionId}/${requestId}）：${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    },

    async compact(sessionId, opts) {
      const entry = managed.get(sessionId);
      if (!entry || !entry.driver.compact) return null;
      try {
        return await entry.driver.compact(entry.handle, opts ?? {});
      } catch (err) {
        log(`上下文压缩失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },

    setControls(sessionId, controls) {
      const entry = managed.get(sessionId);
      entry?.driver.setControls?.(entry.handle, controls);
    },

    addListener(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async dispose() {
      disposed = true;
      const ids = [...managed.keys()];
      await Promise.all(ids.map((id) => kill(id, "shutdown").catch(() => undefined)));
      // 兜底：登记表里可能还有没走 managed 的 pid（例如 spawn 中途失败）
      registry.killAllSync();
      turns.clear();
      held.clear();
      listeners.clear();
      inflight.clear();
    },

    registry,
  };

  return api;
}

/** 供进程退出钩子兜底：同步杀掉登记表里的所有 pid（仅关服/测试用）。 */
export function killAllRegisteredSync(registry: PidRegistry): number {
  return registry.killAllSync();
}

/** 便于装配层与测试直接引用（树杀的同步版本）。 */
export { killTreeSync };
export type { PermissionDecision, RuntimePermissionRequest };
