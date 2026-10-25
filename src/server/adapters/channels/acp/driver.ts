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
  Tri,
} from "../../contract.js";
import { effectiveLaunch } from "../../launch.js";
import { getTurnContext } from "../../turn-context.js";
import { createAcpMapper, type AcpMapper } from "./mapping.js";
import {
  createJsonRpcPeer,
  createStdioTransport,
  type JsonRpcPeer,
  type Transport,
} from "./transport.js";

/**
 * ACP 通道驱动（架构 §3.2 / §3.5）。
 *
 * 协议侧只做四件事：握手（initialize）、开会话（session/new|session/load）、
 * 发 prompt（session/prompt）、取消（session/cancel）。
 * 事件语义全部交给 `mapping.ts`，这里不解析任何 update 内容。
 *
 * 一个 Session 一个进程（架构 §5）。`SessionHandle` 挂本驱动的私有状态，
 * 核心只把它当不透明句柄传回来。
 *
 * 权限（M6 的接缝）：收到反向请求时**只上报**，绝不自行应答；
 * 核心裁决后调 `respondPermission()` 回传。超时策略由核心实现，本驱动不碰。
 *
 * 事件里不带 turnId 的业务语义：turnId / messageId 由编排层通过
 * `setTurnContext()` 在 prompt 前注入（见 `adapters/turn-context.ts`）。
 */

interface AcpState {
  transport: Transport;
  peer: JsonRpcPeer;
  decl: AdapterDeclaration;
  /** 当前 turn 的 mapper；会话锁保证同一时刻只有一个活跃 Turn。 */
  mapper: AcpMapper | null;
  runtimeSessionId: string | null;
  /** 我们的 requestId → 运行时侧的 JSON-RPC id（应答时要原样回传）。 */
  pendingPermissions: Map<string, string | number>;
  eventCbs: ((e: CanonicalEvent) => void)[];
  permissionCbs: ((req: RuntimePermissionRequest) => void)[];
  exitCbs: ((info: ExitInfo) => void)[];
  cancelled: boolean;
  disposed: boolean;
}

const states = new WeakMap<SessionHandle, AcpState>();

const INIT_TIMEOUT_MS = 10_000;
const NEW_SESSION_TIMEOUT_MS = 20_000;
/** prompt 不设上限：长任务可能跑几分钟，进程退出会 failAll 掉未决请求。 */
const PROMPT_TIMEOUT_MS = 0;

function stateOf(h: SessionHandle): AcpState {
  const s = states.get(h);
  if (!s) throw new Error("ACP 句柄无效（未经 start 创建或已释放）");
  return s;
}

function emitAll(state: AcpState, events: CanonicalEvent[]): void {
  for (const e of events) {
    for (const cb of state.eventCbs) {
      try {
        cb(e);
      } catch (err) {
        console.warn(
          `[acp] 事件回调抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function tri(v: unknown): Tri {
  return typeof v === "boolean" ? v : "unknown";
}

/**
 * 从握手结果推断能力。
 *
 * ACP 的 `initialize` 返回 `agentCapabilities`，这是唯一权威来源。
 * 没声明的项一律 `unknown`（不是 false）—— C3 的核心要求。
 */
function capabilitiesFromInit(result: unknown): Partial<CapabilitySet> {
  const out: Partial<CapabilitySet> = {};
  if (typeof result !== "object" || result === null) return out;
  const rec = result as Record<string, unknown>;
  const capsRaw = rec["agentCapabilities"];
  const caps = typeof capsRaw === "object" && capsRaw !== null ? (capsRaw as Record<string, unknown>) : null;

  if (caps) {
    const promptRaw = caps["promptCapabilities"];
    if (typeof promptRaw === "object" && promptRaw !== null) {
      const p = promptRaw as Record<string, unknown>;
      if (typeof p["image"] === "boolean") out.images = p["image"];
    }
    if (typeof caps["loadSession"] === "boolean") out.resume = caps["loadSession"];
    if (typeof caps["plan"] === "boolean") out.plan = caps["plan"];
  }

  // ACP 的 session/update 本身就是增量通知：握手成功即可视为流式
  out.streaming = true;
  return out;
}

function readSessionId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const rec = result as Record<string, unknown>;
  const direct = rec["sessionId"] ?? rec["session_id"];
  return typeof direct === "string" && direct.length > 0 ? direct : null;
}

export interface AcpDriverOptions {
  /**
   * 测试注入：用假传输替代 spawn（fixture 回放）。
   * 生产不传，`start()` 自己 spawn 子进程。
   */
  transportFactory?: (spec: { command: string; args: string[]; cwd: string }) => Transport;
}

export function createAcpDriver(opts: AcpDriverOptions = {}): ChannelDriver {
  return {
    protocol: "acp",

    async start(decl: AdapterDeclaration, ctx: SpawnContext): Promise<SessionHandle> {
      const launch = effectiveLaunch(decl);
      if (launch.note) console.warn(`[acp] ${decl.id}: ${launch.note}`);

      const transport =
        opts.transportFactory?.({ command: launch.command, args: launch.args, cwd: ctx.cwd }) ??
        createStdioTransport({
          command: launch.command,
          args: launch.args,
          cwd: ctx.cwd,
          env: { ...decl.launch.env, ...ctx.env },
        });

      const state: AcpState = {
        transport,
        peer: null as unknown as JsonRpcPeer,
        decl,
        mapper: null,
        runtimeSessionId: null,
        pendingPermissions: new Map(),
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
            // 只认 session/update；其它通知不渲染也不报错
            if (method !== "session/update") return;
            if (!state.mapper) return;
            emitAll(state, state.mapper.handleSessionUpdate(params));
          },
          onRequest: (method, params, id) => {
            if (method !== "session/request_permission") {
              // 不认识的反向请求：明确回 -32601，让运行时自己决定怎么办
              peer.respondError(id, { code: -32601, message: `不支持的反向请求：${method}` });
              return;
            }
            if (!state.mapper) {
              // 没有活跃 Turn 时来的权限请求：回 cancelled，避免运行时永久阻塞
              peer.respond(id, { outcome: { outcome: "cancelled" } });
              return;
            }
            const events = state.mapper.handlePermissionRequest(params, id);
            emitAll(state, events);
            const ev = events[0];
            if (!ev) return;
            const payload = ev.payload as {
              requestId: string;
              action: RuntimePermissionRequest["action"];
              target: string;
            };
            state.pendingPermissions.set(payload.requestId, id);
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
                  `[acp] 权限回调抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          },
        },
        PROMPT_TIMEOUT_MS,
      );
      state.peer = peer;

      transport.onClose((info) => {
        if (state.disposed) return;
        const tail = transport.stderrTail.trim();
        // 未收口的 Turn 立刻失败，否则 UI 永远停在「生成中」（P0-04 崩溃分支）
        if (state.mapper) {
          emitAll(
            state,
            state.mapper.transportError(
              info.code === null ? "运行时进程已退出" : `运行时进程已退出（exit ${String(info.code)}）`,
              tail.length > 0 ? tail : undefined,
            ),
          );
          state.mapper = null;
        }
        const exit: ExitInfo = {
          code: info.code,
          ...(info.signal === undefined ? {} : { signal: info.signal }),
          stderrTail: tail,
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
          return state.runtimeSessionId;
        },
      };
      states.set(handle, state);
      return handle;
    },

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
        const result = await state.peer.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "agentbot", version: "0.1.0" },
          },
          INIT_TIMEOUT_MS,
        );
        const probed = capabilitiesFromInit(result);
        return {
          capabilities: {
            plan: probed.plan ?? "unknown",
            // ACP 若握手成功，说明反向请求通道可用（这是协议内置能力）
            permissionRequest: probed.permissionRequest ?? true,
            resume: probed.resume ?? "unknown",
            images: probed.images ?? "unknown",
            streaming: tri(probed.streaming),
            contextWindow: probed.contextWindow ?? null,
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
      const result = await state.peer.request(
        "session/new",
        {
          cwd: o.cwd,
          mcpServers: [],
          ...(o.systemPrompt === undefined ? {} : { _meta: { systemPrompt: o.systemPrompt } }),
        },
        NEW_SESSION_TIMEOUT_MS,
      );
      const id = readSessionId(result);
      if (!id) throw new Error("session/new 未返回 sessionId");
      state.runtimeSessionId = id;
      return { runtimeSessionId: id };
    },

    async resumeSession(h, runtimeSessionId) {
      const state = stateOf(h);
      try {
        await state.peer.request(
          "session/load",
          { sessionId: runtimeSessionId, cwd: process.cwd(), mcpServers: [] },
          NEW_SESSION_TIMEOUT_MS,
        );
        state.runtimeSessionId = runtimeSessionId;
        return { ok: true };
      } catch (err) {
        // 不支持 load 或会话已失效：核心走「重建上下文」路径（§5），这里只如实报错
        return { ok: false, reason: err instanceof Error ? err.message : "resume 失败" };
      }
    },

    async prompt(h, input) {
      const state = stateOf(h);
      if (!state.runtimeSessionId) throw new Error("prompt 前必须先 newSession");

      // 上一轮没收到 done 就发下一轮：先收口旧轮，避免事件串台
      if (state.mapper) {
        emitAll(state, state.mapper.finalize("error"));
        state.mapper = null;
      }

      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? `turn_${Date.now().toString(36)}`;
      const messageId = ctx?.messageId ?? "assistant";

      const mapper = createAcpMapper({ turnId, messageId });
      state.mapper = mapper;
      state.cancelled = false;

      try {
        const result = await state.peer.request(
          "session/prompt",
          {
            sessionId: state.runtimeSessionId,
            prompt: [{ type: "text", text: input.text }],
          },
          PROMPT_TIMEOUT_MS,
        );
        emitAll(state, mapper.handlePromptResult(result));
      } catch (err) {
        if (state.cancelled) {
          // 取消：已生成内容保留，只补收口（PRD P0-04）
          emitAll(state, mapper.finalize("cancelled"));
        } else {
          // transportError 幂等：进程退出已经报过 error 时这里返回空，不重复报
          emitAll(
            state,
            mapper.transportError(
              "这一轮没有完成",
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      } finally {
        state.mapper = null;
        state.cancelled = false;
      }
    },

    async cancel(h) {
      const state = stateOf(h);
      state.cancelled = true;
      if (!state.runtimeSessionId) return;
      state.peer.notify("session/cancel", { sessionId: state.runtimeSessionId });
    },

    async respondPermission(h, requestId, decision: PermissionDecision) {
      const state = stateOf(h);
      const rpcId = state.pendingPermissions.get(requestId);
      if (rpcId === undefined) {
        throw new Error(`权限请求不存在或已应答：${requestId}`);
      }
      state.pendingPermissions.delete(requestId);
      state.peer.respond(rpcId, {
        outcome:
          decision.kind === "approve"
            ? { outcome: "selected", optionId: "allow" }
            : { outcome: "cancelled" },
      });
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
