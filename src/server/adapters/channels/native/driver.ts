import type { CanonicalEvent } from "../../../../shared/events.js";
import type {
  AdapterDeclaration,
  CapabilitySet,
  ChannelDriver,
  ExitInfo,
  PermissionDecision,
  ProbeResult,
  RuntimePermissionRequest,
  SessionHandle,
  SpawnContext,
} from "../../contract.js";
import { effectiveLaunch } from "../../launch.js";
import { getTurnContext } from "../../turn-context.js";
import {
  createJsonRpcPeer,
  createStdioTransport,
  type JsonRpcPeer,
  type Transport,
} from "../acp/transport.js";
import {
  buildApprovalResponse,
  createCodexMapper,
  isApprovalMethod,
  isTurnCompleted,
  type CodexMapper,
} from "./mapping.js";

/**
 * 原生通道驱动：Codex app-server（JSONL / JSON-RPC over stdio，架构 §3.2 / §3.6）。
 *
 * 传输层**直接复用 ACP 的** `channels/acp/transport.ts`：
 *   - 两者的线格式都是「一行一个 JSON-RPC 2.0 消息」，逐行切分、stderr 尾窗、
 *     退出上报、id 关联（`JsonRpcPeer`）没有任何差异；
 *   - 复制一份只会让「单行上限 / 坏行吞掉 / 退出时 failAll」三处规则日后各漂各的。
 * 协议语义则完全独立在本目录的 `mapping.ts`（Codex 的 item 模型与 ACP 的
 * `session/update` 子类型不是一回事）。
 *
 * 会话模型（与 ACP 同构，但方法名不同）：
 *   握手     initialize            → 拿 healthStatus
 *   开会话   thread/start          → threadId（= 运行时会话 id）
 *   续接     thread/resume         → 进程重启后接着上一 thread 跑（resumeStrategy: native）
 *   一轮     turn/start            → 立刻返回 turn，事件经通知流式到达
 *   取消     turn/interrupt
 *
 * `prompt()` 的语义必须与 ACP 对齐：**等到本轮真正结束才 resolve**。
 * app-server 的 `turn/start` 只是「已受理」，立刻返回会让编排层马上补 done，
 * 后面的流式事件就全被丢掉了。所以这里等 `turn/completed` 通知。
 *
 * 权限（M6 的接缝）：收到审批请求时**只上报**，绝不自行应答；
 * 核心裁决后调 `respondPermission()` 回传（应答体形状见 `mapping.ts`）。
 */

interface PendingApproval {
  rpcId: string | number;
  method: string;
  params: unknown;
}

interface NativeState {
  transport: Transport;
  peer: JsonRpcPeer;
  decl: AdapterDeclaration;
  cwd: string;
  /** 运行时会话 id（app-server 的 threadId）。 */
  threadId: string | null;
  /** 当前 turn 的 mapper；会话锁保证同一时刻只有一个活跃 Turn。 */
  mapper: CodexMapper | null;
  /** 本轮运行时侧 turnId（cancel 用）。 */
  runtimeTurnId: string | null;
  /** prompt 等待本轮结束的闸门（turn/completed 或进程退出时打开）。 */
  turnDone: (() => void) | null;
  /** 我们的 requestId → 运行时侧的审批请求。 */
  pendingApprovals: Map<string, PendingApproval>;
  eventCbs: ((e: CanonicalEvent) => void)[];
  permissionCbs: ((req: RuntimePermissionRequest) => void)[];
  exitCbs: ((info: ExitInfo) => void)[];
  cancelled: boolean;
  disposed: boolean;
}

const states = new WeakMap<SessionHandle, NativeState>();

const INIT_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 20_000;
/** turn/start 只等「受理」；真正结束靠 turn/completed。 */
const TURN_START_TIMEOUT_MS = 60_000;
/** turn/interrupt 是尽力而为：拿不到响应也不能把取消卡住。 */
const INTERRUPT_TIMEOUT_MS = 3_000;

function stateOf(h: SessionHandle): NativeState {
  const s = states.get(h);
  if (!s) throw new Error("原生通道句柄无效（未经 start 创建或已释放）");
  return s;
}

function emitAll(state: NativeState, events: CanonicalEvent[]): void {
  for (const e of events) {
    for (const cb of state.eventCbs) {
      try {
        cb(e);
      } catch (err) {
        console.warn(
          `[native] 事件回调抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从 thread/start 与 thread/resume 的响应里取 threadId。 */
function readThreadId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const thread = isRecord(result["thread"]) ? result["thread"] : null;
  const direct = thread?.["id"] ?? result["threadId"];
  return typeof direct === "string" && direct.length > 0 ? direct : null;
}

/**
 * 从 `protocolOptions` 读通道私有参数。
 *
 * 为什么放在声明里而不是硬编码：sandbox / approvalPolicy 是「这个运行时怎么被
 * 驱动」的策略，不是产品语义。用户想收紧沙箱或换策略时改 YAML 即可，
 * 核心与驱动都不用动（架构 §3.9：通道私有配置走 protocolOptions）。
 *
 * 默认值 `workspace-write` + `on-request`：
 *   - `workspace-write` 让 Bot 能在自己的仓库/worktree 里真正干活；
 *   - `on-request` 让越界动作（写外部路径、联网、提权）**变成审批请求**流向核心，
 *     由边界与用户裁决 —— 这正是 permission.channel=jsonrpc-approval 的意义。
 */
interface SandboxOptions {
  sandbox: string;
  approvalPolicy: string;
}

function sandboxOptionsOf(decl: AdapterDeclaration): SandboxOptions {
  const opts = isRecord(decl.protocolOptions) ? decl.protocolOptions : {};
  return {
    sandbox: typeof opts["sandbox"] === "string" ? opts["sandbox"] : "workspace-write",
    approvalPolicy:
      typeof opts["approvalPolicy"] === "string" ? opts["approvalPolicy"] : "on-request",
  };
}

export interface NativeDriverOptions {
  /** 测试注入：用假传输替代 spawn（fixture 回放）。生产不传。 */
  transportFactory?: (spec: { command: string; args: string[]; cwd: string }) => Transport;
}

export function createNativeDriver(opts: NativeDriverOptions = {}): ChannelDriver {
  return {
    protocol: "codex-app-server",

    async start(decl: AdapterDeclaration, ctx: SpawnContext): Promise<SessionHandle> {
      const launch = effectiveLaunch(decl);
      if (launch.note) console.warn(`[native] ${decl.id}: ${launch.note}`);

      const transport =
        opts.transportFactory?.({ command: launch.command, args: launch.args, cwd: ctx.cwd }) ??
        createStdioTransport({
          command: launch.command,
          args: launch.args,
          cwd: ctx.cwd,
          env: { ...decl.launch.env, ...ctx.env },
        });

      const state: NativeState = {
        transport,
        peer: null as unknown as JsonRpcPeer,
        decl,
        cwd: ctx.cwd,
        threadId: null,
        mapper: null,
        runtimeTurnId: null,
        turnDone: null,
        pendingApprovals: new Map(),
        eventCbs: [],
        permissionCbs: [],
        exitCbs: [],
        cancelled: false,
        disposed: false,
      };

      const peer = createJsonRpcPeer(
        transport,
        {
          onNotification: (method, params) => {
            const mapper = state.mapper;
            if (!mapper) {
              // 没有活跃 Turn：握手期通知（thread/started、remoteControl/status/changed…）
              // 与渲染无关，直接丢弃。等 mapper 建好后才有「事件」的概念。
              return;
            }
            emitAll(state, mapper.handleNotification(method, params));
            if (isTurnCompleted(method)) {
              // 本轮结束：映射器已收口，放行 prompt
              state.mapper = null;
              state.runtimeTurnId = null;
              const done = state.turnDone;
              state.turnDone = null;
              done?.();
            }
          },
          onRequest: (method, params, id) => {
            if (!isApprovalMethod(method)) {
              // 不认识的交互类反向请求（requestUserInput、elicitation、dynamicToolCall…）：
              // 明确回 -32601，让运行时自己决定降级，别让它干等
              peer.respondError(id, { code: -32601, message: `不支持的反向请求：${method}` });
              return;
            }
            const mapper = state.mapper;
            if (!mapper) {
              // 没有活跃 Turn 时来的审批：回拒绝，避免运行时永久阻塞
              peer.respond(id, buildApprovalResponse(method, params, { kind: "deny" }));
              return;
            }
            const events = mapper.handleApprovalRequest(method, params, id);
            emitAll(state, events);
            const ev = events[0];
            if (!ev) return;
            const payload = ev.payload as {
              requestId: string;
              action: RuntimePermissionRequest["action"];
              target: string;
            };
            state.pendingApprovals.set(payload.requestId, { rpcId: id, method, params });
            const req: RuntimePermissionRequest = {
              requestId: payload.requestId,
              action: payload.action,
              target: payload.target,
              detail: params,
            };
            for (const cb of state.permissionCbs) {
              try {
                cb(req);
              } catch (err) {
                console.warn(
                  `[native] 权限回调抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          },
        },
        TURN_START_TIMEOUT_MS,
      );
      state.peer = peer;

      transport.onClose((info) => {
        // 主动释放（cancel / 空闲回收 / 关服）不算崩溃：先返回，否则会多报一条
        // fatal「进程已退出」，与编排层已经写好的 cancelled 收口打架。
        // （顺序与 ACP 驱动一致：disposed 判定必须在发 error 之前。）
        if (state.disposed) {
          state.runtimeTurnId = null;
          const done = state.turnDone;
          state.turnDone = null;
          done?.();
          return;
        }

        // 未收口的 Turn 立刻失败，否则 UI 永远停在「生成中」（P0-04 崩溃分支）
        if (state.mapper) {
          const tail = transport.stderrTail.trim();
          emitAll(
            state,
            state.mapper.transportError(
              info.code === null ? "运行时进程已退出" : `运行时进程已退出（exit ${String(info.code)}）`,
              tail.length > 0 ? tail : undefined,
            ),
          );
          state.mapper = null;
        }
        state.runtimeTurnId = null;
        const done = state.turnDone;
        state.turnDone = null;
        done?.();

        const exit: ExitInfo = {
          code: info.code,
          ...(info.signal === undefined ? {} : { signal: info.signal }),
          stderrTail: transport.stderrTail.trim(),
        };
        for (const cb of state.exitCbs) {
          try {
            cb(exit);
          } catch {
            // 忽略
          }
        }
      });

      const handle: SessionHandle = {
        sessionId: ctx.sessionId,
        pid: transport.pid,
        get runtimeSessionId() {
          return state.threadId;
        },
      };
      states.set(handle, state);
      return handle;
    },

    /**
     * 握手。app-server 的 `initialize` 响应只给环境信息（codexHome / platform），
     * 没有能力清单，所以能力值按「协议本身确有的」保守上报，其余留 unknown
     * 让声明的值兜底（C3：探测失败 ≠ 不支持）。
     */
    async initialize(h: SessionHandle): Promise<ProbeResult> {
      const state = stateOf(h);
      const empty: CapabilitySet = {
        plan: "unknown",
        permissionRequest: "unknown",
        resume: "unknown",
        images: "unknown",
        streaming: "unknown",
        contextWindow: null,
      };
      try {
        await state.peer.request(
          "initialize",
          { clientInfo: { name: "agentbot", version: "0.1.0" }, capabilities: null },
          INIT_TIMEOUT_MS,
        );
        return {
          capabilities: {
            // 握手成功只能证明「进程活着且说的是 JSON-RPC」。
            // 审批（item/*/requestApproval）、续接（thread/resume）、流式（item/*/delta）
            // 都是 app-server 协议内置能力，可以置 true；plan / images / contextWindow
            // 需要真实一轮才知道，留 unknown 交给声明兜底。
            plan: "unknown",
            permissionRequest: true,
            resume: true,
            images: "unknown",
            streaming: true,
            contextWindow: null,
          },
          source: "probed",
          version: null,
          healthStatus: "healthy",
        };
      } catch (err) {
        // 失败不致命：探测层退回声明值并标 unhealthy
        return {
          capabilities: empty,
          source: "declared",
          version: null,
          healthStatus: "unhealthy",
          detail: err instanceof Error ? err.message : "initialize 失败",
        };
      }
    },

    async newSession(h, o) {
      const state = stateOf(h);
      const opts = sandboxOptionsOf(state.decl);
      const result = await state.peer.request(
        "thread/start",
        {
          cwd: o.cwd,
          approvalPolicy: opts.approvalPolicy,
          sandbox: opts.sandbox,
          ...(o.systemPrompt === undefined ? {} : { developerInstructions: o.systemPrompt }),
        },
        SESSION_TIMEOUT_MS,
      );
      const id = readThreadId(result);
      if (!id) throw new Error("thread/start 未返回 threadId");
      state.threadId = id;
      return { runtimeSessionId: id };
    },

    async resumeSession(h, runtimeSessionId) {
      const state = stateOf(h);
      try {
        // excludeTurns：只要会话本身，不回灌历史（历史由产品层按 messages 渲染，
        // 回灌会让同一段对话在事件流里再出现一遍）
        const result = await state.peer.request(
          "thread/resume",
          { threadId: runtimeSessionId, excludeTurns: true },
          SESSION_TIMEOUT_MS,
        );
        const id = readThreadId(result) ?? runtimeSessionId;
        state.threadId = id;
        return { ok: true };
      } catch (err) {
        // rollout 不存在 / 版本不兼容：如实报失败，核心走产品层重建（§5）
        return { ok: false, reason: err instanceof Error ? err.message : "resume 失败" };
      }
    },

    async prompt(h, input) {
      const state = stateOf(h);
      if (!state.threadId) throw new Error("prompt 前必须先 newSession");

      // 上一轮没收到 turn/completed 就发下一轮：先收口旧轮，避免事件串台
      if (state.mapper) {
        emitAll(state, state.mapper.finalize("error"));
        state.mapper = null;
        state.runtimeTurnId = null;
        // 必须放行上一轮 prompt 的闸门，否则它的 await 永远挂着（会话锁会一起卡死）
        const previous = state.turnDone;
        state.turnDone = null;
        previous?.();
      }

      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? `turn_${Date.now().toString(36)}`;
      const messageId = ctx?.messageId ?? "assistant";

      const mapper = createCodexMapper({ turnId, messageId });
      state.mapper = mapper;
      state.cancelled = false;

      // 闸门必须在发请求之前装好：turn 的通知可能在 turn/start 响应之前就到
      const finished = new Promise<void>((resolve) => {
        state.turnDone = resolve;
      });

      try {
        const result = await state.peer.request(
          "turn/start",
          { threadId: state.threadId, input: [{ type: "text", text: input.text }] },
          TURN_START_TIMEOUT_MS,
        );
        const turn = isRecord(result) && isRecord(result["turn"]) ? result["turn"] : null;
        const runtimeTurnId = turn?.["id"];
        // 通知可能先于响应到达（turn/completed 已经把本轮收口）：只在仍是本轮时记 id
        if (typeof runtimeTurnId === "string" && state.mapper === mapper) {
          state.runtimeTurnId = runtimeTurnId;
        }
      } catch (err) {
        if (state.mapper === mapper) {
          emitAll(
            state,
            mapper.transportError(
              "这一轮没有启动",
              err instanceof Error ? err.message : String(err),
            ),
          );
          state.mapper = null;
        }
        state.turnDone = null;
        return;
      }

      // 等到 turn/completed（或进程退出）才返回 —— 与 ACP 的 prompt 语义一致
      await finished;
      if (state.mapper === mapper) {
        // 进程退出路径已经把 mapper 收口过；这里兜「通知丢了」的极端情况。
        // 主动释放（dispose）时不再补事件：编排层已经自己收口，多一条 done 会打架。
        if (!state.disposed) {
          emitAll(state, mapper.finalize(state.cancelled ? "cancelled" : "end"));
        }
        state.mapper = null;
      }
    },

    async cancel(h) {
      const state = stateOf(h);
      state.cancelled = true;
      if (!state.threadId || !state.runtimeTurnId) return;
      // turn/interrupt 是请求而非通知；拿不到响应也不能把取消卡住
      await state.peer
        .request(
          "turn/interrupt",
          { threadId: state.threadId, turnId: state.runtimeTurnId },
          INTERRUPT_TIMEOUT_MS,
        )
        .catch(() => undefined);
    },

    async respondPermission(h, requestId, decision: PermissionDecision) {
      const state = stateOf(h);
      const pending = state.pendingApprovals.get(requestId);
      if (!pending) {
        throw new Error(`权限请求不存在或已应答：${requestId}`);
      }
      state.pendingApprovals.delete(requestId);
      state.peer.respond(
        pending.rpcId,
        buildApprovalResponse(pending.method, pending.params, decision),
      );
    },

    onEvent(h, cb) {
      stateOf(h).eventCbs.push(cb);
    },
    onPermission(h, cb) {
      stateOf(h).permissionCbs.push(cb);
    },
    onExit(h, cb) {
      stateOf(h).exitCbs.push(cb);
    },

    async dispose(h) {
      const state = states.get(h);
      if (!state || state.disposed) return;
      state.disposed = true;
      state.peer.failAll("句柄已释放");
      state.turnDone = null;
      if (state.transport.closed) {
        states.delete(h);
        return;
      }
      state.transport.kill();
      // 给进程 1.5s 优雅退出，超时强杀（Windows 上 kill() 即终止）
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          state.transport.kill("SIGKILL");
          finish();
        }, 1500);
        timer.unref?.();
        state.transport.onClose(() => {
          clearTimeout(timer);
          finish();
        });
      });
      states.delete(h);
    },
  };
}
