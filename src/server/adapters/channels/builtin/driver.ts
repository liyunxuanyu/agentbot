import type {
  AdapterDeclaration,
  ChannelDriver,
  ExitInfo,
  PermissionDecision,
  ProbeResult,
  RuntimePermissionRequest,
  SessionHandle,
  SpawnContext,
} from "../../contract.js";
import { metaEvent } from "../../contract.js";
import type { CanonicalEvent } from "../../../../shared/events.js";
import { getTurnContext } from "../../turn-context.js";
import {
  ProviderError,
  type ChatMessage,
  type ProviderConfig,
} from "../../../core/agent/provider.js";
import { createProviderClient } from "../../providers/index.js";
import { resolveProvider } from "../../providers/store.js";
import { runAgentLoop, type AgentLoopResult } from "../../../core/agent/loop.js";
import { buildSystemPrompt } from "../../../core/agent/prompt.js";
import { scanSkills } from "../../../core/agent/skills.js";
import { createBuiltinTools } from "../../../core/agent/tools/builtin/index.js";
import {
  createToolRegistry,
  type ToolDefinition,
  type ToolPermissionRequest,
} from "../../../core/agent/tools/registry.js";
import { AGENT_LIMITS } from "../../../core/agent/limits.js";
import type { McpManager } from "../../mcp/manager.js";

/**
 * 内置引擎通道驱动（N2）。
 *
 * 与其它三条通道最大的不同：**没有子进程**。agent loop 跑在服务进程内，
 * 直接调模型 API；工具调用发生在自己的循环里，所以每个写/执行/联网动作
 * 都能在执行前走产品层权限裁决。
 *
 * 生命周期：
 *   start → 建内存状态（pid=null）
 *   newSession → 存 systemPrompt（人格 + 记忆 + 运行规则 + 技能索引）
 *   prompt → 跑一轮 agent loop，事件经 onEvent 交 ingest
 *   dispose → 取消进行中的轮次、拒绝挂起权限、丢历史
 */

export interface BuiltinDriverOptions {
  mcp?: McpManager;
  skillsDir?: string;
  /** 便于单测注入；生产用 providers.json。 */
  resolveProvider?: (providerId: string | null) => ProviderConfig | null;
  /** 便于单测注入；生产用内置工具全集。 */
  tools?: ToolDefinition[];
  log?: (message: string) => void;
}

interface PendingPermission {
  resolve(decision: PermissionDecision): void;
}

interface SessionState {
  handle: SessionHandle;
  sessionId: string;
  cwd: string;
  botId: string | null;
  providerId: string | null;
  systemPrompt: string;
  history: ChatMessage[];
  eventCb: ((event: CanonicalEvent) => void) | null;
  permissionCb: ((req: RuntimePermissionRequest) => void) | null;
  exitCb: ((info: ExitInfo) => void) | null;
  pending: Map<string, PendingPermission>;
  controller: AbortController | null;
  disposed: boolean;
}

let permissionCounter = 0;

function makeEvent(
  type: CanonicalEvent["type"],
  turnId: string,
  payload: CanonicalEvent["payload"],
): CanonicalEvent {
  return { type, turnId, ts: Date.now(), payload } as CanonicalEvent;
}

export function createBuiltinDriver(opts: BuiltinDriverOptions = {}): ChannelDriver {
  const states = new Map<string, SessionState>();
  const resolveCfg = opts.resolveProvider ?? ((id: string | null) => resolveProvider(id));
  const baseTools = opts.tools ?? createBuiltinTools();
  const log = opts.log ?? ((msg: string) => console.warn(`[builtin] ${msg}`));

  function stateOf(h: SessionHandle): SessionState | null {
    return states.get(h.sessionId) ?? null;
  }

  function emit(state: SessionState, event: CanonicalEvent): void {
    try {
      state.eventCb?.(event);
    } catch (err) {
      log(`事件回调抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function emitDelta(state: SessionState, turnId: string, phase: "start" | "delta" | "end", text: string, messageId: string): void {
    emit(
      state,
      makeEvent("message_delta", turnId, { messageId, phase, text }),
    );
  }

  function emitThought(state: SessionState, turnId: string, phase: "start" | "delta" | "end", text: string): void {
    emit(state, makeEvent("thought", turnId, { phase, text }));
  }

  function resolvePending(state: SessionState, requestId: string, decision: PermissionDecision): void {
    const pending = state.pending.get(requestId);
    if (!pending) return;
    state.pending.delete(requestId);
    pending.resolve(decision);
  }

  function askPermission(
    state: SessionState,
    signal: AbortSignal,
    req: ToolPermissionRequest,
  ): Promise<boolean> {
    if (state.disposed || signal.aborted) return Promise.resolve(false);
    const requestId = `builtin_perm_${++permissionCounter}`;
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => {
        state.pending.delete(requestId);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      state.pending.set(requestId, {
        resolve: (decision) => {
          signal.removeEventListener("abort", onAbort);
          resolve(decision.kind === "approve");
        },
      });
      if (!state.permissionCb) {
        // 没有接线（单测/异常装配）：按拒绝处理，绝不放行
        state.pending.delete(requestId);
        signal.removeEventListener("abort", onAbort);
        resolve(false);
        return;
      }
      state.permissionCb({
        requestId,
        action: req.action,
        target: req.target,
        ...(req.detail === undefined ? {} : { detail: req.detail }),
      });
    });
  }

  function trimHistory(history: ChatMessage[]): void {
    if (history.length <= 120) return;
    const system = history.filter((m) => m.role === "system");
    const rest = history.filter((m) => m.role !== "system");
    // 从最近的消息往前找一条 user，避免把 tool 消息和它的 assistant 调用拆开
    let start = Math.max(0, rest.length - 100);
    while (start < rest.length && rest[start]?.role !== "user") start += 1;
    history.splice(0, history.length, ...system, ...rest.slice(start));
  }

  async function runPrompt(state: SessionState, text: string): Promise<void> {
    const h = state.handle;
    const ctx = getTurnContext(h);
    if (!ctx) {
      log(`Session ${state.sessionId} 缺少 Turn 上下文，本轮无法产出事件`);
      return;
    }
    const { turnId, messageId } = ctx;
    const started = Date.now();

    const provider = resolveCfg(state.providerId);
    if (!provider) {
      emit(
        state,
        makeEvent("error", turnId, {
          code: "provider_unavailable",
          message: "未配置模型供应商。请到「设置 → 模型供应商」添加一个后再发送。",
          fatal: true,
        }),
      );
      return;
    }

    const controller = new AbortController();
    state.controller = controller;
    const registry = createToolRegistry([
      ...baseTools,
      ...(opts.mcp ? opts.mcp.tools() : []),
    ]);

    state.history.push({ role: "user", content: text });
    emitDelta(state, turnId, "start", "", messageId);

    let reasoningOpen = false;
    let result: AgentLoopResult;
    try {
      const client = createProviderClient(provider);
      result = await runAgentLoop({
        provider: client,
        registry,
        messages: state.history,
        cwd: state.cwd,
        signal: controller.signal,
        callbacks: {
          onTextDelta: (delta) => emitDelta(state, turnId, "delta", delta, messageId),
          onReasoningDelta: (delta) => {
            if (!reasoningOpen) {
              reasoningOpen = true;
              emitThought(state, turnId, "start", "");
            }
            emitThought(state, turnId, "delta", delta);
          },
          onToolCall: (call, tool) => {
            emit(
              state,
              makeEvent("tool_call", turnId, {
                callId: call.id,
                name: call.name,
                ...(tool?.permission ? { kind: tool.permission } : {}),
                input: call.args ?? { raw: call.rawArguments },
                status: "running",
              }),
            );
          },
          onToolResult: (call, toolResult) => {
            emit(
              state,
              makeEvent("tool_result", turnId, {
                callId: call.id,
                status: toolResult.ok ? "ok" : "error",
                output: toolResult.output,
                ...(toolResult.truncated ? { truncated: true } : {}),
              }),
            );
          },
          onUsage: (sample) => {
            emit(
              state,
              makeEvent("usage", turnId, {
                inputTokens: sample.inputTokens,
                outputTokens: sample.outputTokens,
                reported: sample.reported,
                cumulative: false,
              }),
            );
          },
          askPermission: (req) => askPermission(state, controller.signal, req),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(
        state,
        makeEvent("error", turnId, {
          code: err instanceof ProviderError ? err.code : "agent_loop_error",
          message,
          fatal: true,
        }),
      );
      state.controller = null;
      return;
    } finally {
      if (reasoningOpen) emitThought(state, turnId, "end", "");
    }

    // 本轮正文收口（失败时由编排层把消息标 failed，不再发 end 以免先被标 done）
    const failed = result.stopReason === "error";
    if (!failed) emitDelta(state, turnId, "end", "", messageId);

    if (result.stopReason === "max_iterations" || result.stopReason === "max_tool_calls") {
      emit(
        state,
        makeEvent("error", turnId, {
          code: result.stopReason,
          message:
            result.stopReason === "max_iterations"
              ? "已达模型调用轮数上限，可继续发消息接着做。"
              : "已达工具调用次数上限，可继续发消息接着做。",
          fatal: false,
        }),
      );
    }

    if (result.stopReason === "error") {
      emit(
        state,
        makeEvent("error", turnId, {
          code: result.error?.code ?? "agent_loop_error",
          message: result.error?.message ?? "内置引擎执行失败",
          ...(result.error?.detail !== undefined ? { detail: result.error.detail } : {}),
          fatal: true,
        }),
      );
    } else {
      const stopReason =
        result.stopReason === "cancelled"
          ? "cancelled"
          : result.stopReason === "length"
            ? "max_tokens"
            : "end";
      emit(
        state,
        makeEvent("done", turnId, { stopReason, durationMs: Date.now() - started }),
      );
    }

    trimHistory(state.history);
    state.controller = null;
  }

  return {
    protocol: "builtin",

    async start(_decl: AdapterDeclaration, ctx: SpawnContext): Promise<SessionHandle> {
      const handle: SessionHandle = {
        sessionId: ctx.sessionId,
        pid: null,
        runtimeSessionId: null,
      };
      const state: SessionState = {
        handle,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        botId: ctx.botId ?? null,
        providerId: ctx.providerId ?? null,
        systemPrompt: "",
        history: [],
        eventCb: null,
        permissionCb: null,
        exitCb: null,
        pending: new Map(),
        controller: null,
        disposed: false,
      };
      states.set(ctx.sessionId, state);
      return handle;
    },

    async initialize(_h: SessionHandle): Promise<ProbeResult> {
      return {
        capabilities: {
          plan: true,
          permissionRequest: true,
          resume: true,
          images: false,
          streaming: true,
          contextWindow: null,
        },
        source: "declared",
        version: "0.1.0",
        healthStatus: "healthy",
      };
    },

    async newSession(h, session): Promise<{ runtimeSessionId: string }> {
      const state = stateOf(h);
      if (!state) throw new Error(`内置引擎会话不存在：${h.sessionId}`);
      state.cwd = session.cwd;
      state.systemPrompt = buildSystemPrompt({
        ...(session.systemPrompt === undefined ? {} : { baseSystemPrompt: session.systemPrompt }),
        cwd: session.cwd,
        skills: scanSkills(opts.skillsDir),
        ...(resolveCfg(state.providerId)?.name !== undefined
          ? { providerName: resolveCfg(state.providerId)?.name }
          : {}),
      });
      state.history = [{ role: "system", content: state.systemPrompt }];
      return { runtimeSessionId: `builtin_${h.sessionId}` };
    },

    async resumeSession(h, runtimeSessionId): Promise<{ ok: boolean; reason?: string }> {
      const state = stateOf(h);
      if (state && state.history.length > 1 && runtimeSessionId === `builtin_${h.sessionId}`) {
        return { ok: true };
      }
      // 进程重启 / 被回收：内存历史已丢，交给产品层用 messages 表重建
      return { ok: false, reason: "内置引擎没有可恢复的内存历史" };
    },

    async prompt(h, input): Promise<void> {
      const state = stateOf(h);
      if (!state) throw new Error(`内置引擎会话不存在：${h.sessionId}`);
      await runPrompt(state, input.text);
    },

    async cancel(h): Promise<void> {
      const state = stateOf(h);
      if (!state) return;
      state.controller?.abort();
      for (const requestId of [...state.pending.keys()]) {
        resolvePending(state, requestId, { kind: "deny" });
      }
    },

    async respondPermission(h, requestId, decision): Promise<void> {
      const state = stateOf(h);
      if (!state) return;
      resolvePending(state, requestId, decision);
    },

    onEvent(h, cb): void {
      const state = stateOf(h);
      if (state) state.eventCb = cb;
    },

    onPermission(h, cb): void {
      const state = stateOf(h);
      if (state) state.permissionCb = cb;
    },

    onExit(h, cb): void {
      const state = stateOf(h);
      if (state) state.exitCb = cb;
    },

    async dispose(h): Promise<void> {
      const state = stateOf(h);
      if (!state) return;
      state.disposed = true;
      state.controller?.abort();
      for (const requestId of [...state.pending.keys()]) {
        resolvePending(state, requestId, { kind: "deny" });
      }
      state.pending.clear();
      state.history = [];
      states.delete(h.sessionId);
    },
  };
}

/** 供装配层/测试使用的 meta 事件构造器（保持与其它通道一致）。 */
export { metaEvent, AGENT_LIMITS };
