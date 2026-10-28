import type {
  AdapterDeclaration,
  ChannelDriver,
  CompactionResult,
  ExitInfo,
  PermissionDecision,
  ProbeResult,
  PromptControls,
  RuntimePermissionRequest,
  SessionHandle,
  SpawnContext,
} from "../../contract.js";
import type { CanonicalEvent, PermissionMode } from "../../../../shared/events.js";
import { config } from "../../../config.js";
import { getTurnContext } from "../../turn-context.js";
import {
  ProviderError,
  type ChatMessage,
  type ProviderClient,
  type ProviderConfig,
} from "../../../core/agent/provider.js";
import { createProviderClient } from "../../providers/index.js";
import { resolveProvider } from "../../providers/store.js";
import { runAgentLoop, type AgentLoopResult } from "../../../core/agent/loop.js";
import { buildSystemPrompt } from "../../../core/agent/prompt.js";
import { filterSkillsByEnabled, scanSkills, type SkillInfo } from "../../../core/agent/skills.js";
import {
  createBuiltinTools,
  createListSkillsTool,
  type CreateBotHandler,
} from "../../../core/agent/tools/builtin/index.js";
import {
  createToolRegistry,
  type ToolDefinition,
  type ToolPermissionRequest,
} from "../../../core/agent/tools/registry.js";
import type { McpManager } from "../../mcp/manager.js";
import { sharedWriteLock, type WriteLock } from "../../../core/group/write-lock.js";

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
  /** 便于单测注入假 provider；生产按配置创建真实客户端。 */
  createClient?: (cfg: ProviderConfig) => import("../../../core/agent/provider.js").ProviderClient;
  /** 便于单测注入；生产用内置工具全集。 */
  tools?: ToolDefinition[];
  /**
   * 管理员 Bot 的 `create_bot` 实现（M3）。装配层注入，工具本身不碰数据库。
   * 不注入时不提供该工具 —— 普通 Bot 的模型根本看不到它。
   */
  createBot?: CreateBotHandler;
  /**
   * 每轮重新装配「人格 + 记忆」基础提示（R3）。
   *
   * 驱动不碰数据库：装配层注入一个只读回调，`prompt` 前调用一次，
   * 记忆保存后下一轮立即生效；返回 null 表示会话不存在，保留旧值。
   */
  refreshBasePrompt?: (sessionId: string) => string | null;
  /**
   * 渠道级写锁（G7）：同一个渠道里的写类工具（write/exec/network/admin）串行执行，
   * 读类工具不排队。缺省用进程级单例 —— 群聊里每个 Bot 一个驱动实例，
   * 各建一把锁等于没锁。
   */
  writeLock?: WriteLock;
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
  /** 会话所属渠道（G7 写锁的键）；单测可不传。 */
  channelId: string | null;
  /** Bot 启用的技能目录名（N3-1 / N4）；null = 全部启用。 */
  enabledSkills: string[] | null;
  providerId: string | null;
  /** 会话级模型覆盖（R4）；null = 用供应商默认模型。 */
  model: string | null;
  /** 四档权限模式（R5）；每轮从 PromptControls 更新。 */
  permissionMode: PermissionMode;
  /** 管理员多一个 create_bot 工具（M3）。 */
  botRole: "member" | "admin";
  /** 编排层给的人格 + 记忆；每轮据此重建系统提示（cwd / 模式可能变）。 */
  baseSystemPrompt: string;
  systemPrompt: string;
  history: ChatMessage[];
  eventCb: ((event: CanonicalEvent) => void) | null;
  permissionCb: ((req: RuntimePermissionRequest) => void) | null;
  exitCb: ((info: ExitInfo) => void) | null;
  pending: Map<string, PendingPermission>;
  controller: AbortController | null;
  disposed: boolean;
}

/** 写类动作：计划模式下这些工具直接从工具表里裁掉。 */
function isWriteLike(permission: ToolDefinition["permission"]): boolean {
  return permission === "write" || permission === "exec" || permission === "network" || permission === "admin";
}

/** 估算 token：与编排层同一口径（2 字符 ≈ 1 token，保守高估）。 */
function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.toolCalls) {
      for (const call of m.toolCalls) chars += call.rawArguments.length;
    }
  }
  return Math.ceil(chars / 2);
}

/** 计划模式 / 自动模式 / 完全访问的运行时提示（写在系统提示末尾）。 */
function modeNote(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "## 当前权限模式：计划模式（只读）\n你只能读取和分析，不能写文件、执行命令或访问网络。先给出方案，等用户切换模式后再动手。";
    case "auto":
      return "## 当前权限模式：自动模式\n边界内的写操作会自动批准；超出 Bot 边界的写操作会被直接拒绝（不会弹卡），需要时请说明缺少哪个目录的权限。执行命令与访问网络仍需用户确认。";
    case "full":
      return "## 当前权限模式：完全访问\n所有动作直接执行并记审计；仍需遵守工作目录约束之外的常识性安全。";
    default:
      return "";
  }
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
  const makeClient = opts.createClient ?? createProviderClient;
  const baseTools =
    opts.tools ??
    createBuiltinTools({
      ...(opts.createBot === undefined ? {} : { createBot: opts.createBot }),
    });
  const log = opts.log ?? ((msg: string) => console.warn(`[builtin] ${msg}`));
  // G7：写锁必须是进程级单例（群里每个 Bot 一个驱动实例，各建一把 = 没锁）
  const lock = opts.writeLock ?? sharedWriteLock();

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

  /**
   * 重建系统提示：cwd / 供应商 / 权限模式都可能在会话内变化。
   *
   * 技能目录每轮重扫（scanSkills 自带 mtime 缓存，文件变化即失效 → 热插拔），
   * 再按 Bot 的启用列表过滤（N3-1 / N4）。过滤只影响系统提示索引；
   * `list_skills` / `read_skill` 仍然能看到/读取未启用的技能。
   */
  function systemPromptOf(state: SessionState): string {
    const providerName = resolveCfg(state.providerId)?.name;
    const all: SkillInfo[] = scanSkills(opts.skillsDir);
    const base = buildSystemPrompt({
      ...(state.baseSystemPrompt.length > 0 ? { baseSystemPrompt: state.baseSystemPrompt } : {}),
      cwd: state.cwd,
      skills: filterSkillsByEnabled(all, state.enabledSkills),
      totalSkills: all.length,
      ...(providerName === undefined ? {} : { providerName }),
    });
    const note = modeNote(state.permissionMode);
    return note.length > 0 ? `${base}\n\n${note}` : base;
  }

  /**
   * 本轮暴露给模型的工具：
   *   - 普通 Bot 看不到 `create_bot`（管理员专属，M3）；
   *   - 计划模式下写类工具直接从列表裁掉（不是调用时才拒，R5/G3）；
   *     MCP 工具同一规则（R5-c）—— 它的权限由 server 声明决定，缺省 exec。
   *
   * 过滤放在驱动侧而不是 `McpManager.tools()`：manager 只负责连接与工具发现，
   * 不该知道「当前会话是什么权限模式」。
   */
  function toolsFor(state: SessionState): ToolDefinition[] {
    const mcpTools = opts.mcp ? opts.mcp.tools() : [];
    return [...baseTools, ...mcpTools]
      .map((tool) =>
        // list_skills 要知道本会话的技能目录与启用列表：工具实例是全驱动共享的，
        // 但这两项是会话级状态，所以每轮换成一个绑定到 state 的实例（N4）。
        tool.name === "list_skills"
          ? createListSkillsTool({
              ...(opts.skillsDir === undefined ? {} : { skillsDir: opts.skillsDir }),
              enabledSkills: () => state.enabledSkills,
            })
          : tool,
      )
      .filter((tool) => {
        if (tool.name === "create_bot" && state.botRole !== "admin") return false;
        if (state.permissionMode === "plan" && isWriteLike(tool.permission)) return false;
        return true;
      });
  }

  function clipText(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  /** 把待压缩的消息渲染成一段纯文本，供摘要器阅读。 */
  function renderTranscript(messages: readonly ChatMessage[]): string {
    const parts: string[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      const label = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具";
      const body = m.content.trim();
      const calls =
        m.toolCalls
          ?.map((c) => `[调用 ${c.name} ${clipText(c.rawArguments, 200)}]`)
          .join(" ") ?? "";
      if (body.length === 0 && calls.length === 0) continue;
      parts.push(`${label}：${clipText(body, 1500)}${calls.length > 0 ? ` ${calls}` : ""}`);
    }
    return parts.join("\n\n");
  }

  /** 抽取式兜底摘要：模型不可用 / 超时时也能压，绝不阻塞对话。 */
  function extractiveSummary(messages: readonly ChatMessage[]): string {
    const tail = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-8)
      .map((m) => `${m.role === "user" ? "用户" : "助手"}：${clipText(m.content.trim(), 200)}`)
      .filter((line) => !line.endsWith("："));
    return clipText(`此前对话要点（自动压缩）：\n${tail.join("\n")}`, 2000);
  }

  async function summarizeWithModel(
    client: ProviderClient,
    transcript: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      const completion = await client.complete({
        messages: [
          {
            role: "system",
            content:
              "你是对话压缩器。把下面的对话压成要点，保留：用户目标、已达成的结论、关键文件路径与命令、未完成事项。不要编造。只输出摘要正文，不超过 1200 字。",
          },
          { role: "user", content: transcript },
        ],
        tools: [],
        signal,
      });
      const text = completion.text.trim();
      return text.length > 0 ? clipText(text, 4000) : null;
    } catch (err) {
      log(`摘要模型调用失败，改用抽取式摘要：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 压缩内存历史（R7 / G5）。
   *
   * 结构：[system 提示, system 摘要, ...最近 keepRecent 条]
   * 切点向前对齐到 user 消息，避免把 assistant 的 tool_calls 与 tool 结果拆开。
   * 摘要优先用当前会话模型；模型不可用时退化为抽取式摘要（永远有结果）。
   */
  async function compactHistory(
    state: SessionState,
    trigger: "auto" | "manual",
    client: ProviderClient,
    signal: AbortSignal,
  ): Promise<CompactionResult> {
    const beforeTokens = estimateTokens(state.history);
    const keep = Math.max(2, config.limits.compactionKeepRecent);
    const system = state.history[0]?.role === "system" ? state.history[0] : null;
    const rest = system ? state.history.slice(1) : [...state.history];

    if (rest.length <= keep + 1) {
      return {
        ok: false,
        removedMessages: 0,
        summaryChars: 0,
        beforeTokens,
        afterTokens: beforeTokens,
        trigger,
        reason: `消息太少（${rest.length} 条），不需要压缩`,
      };
    }

    let cut = Math.max(0, rest.length - keep);
    while (cut < rest.length && rest[cut]?.role !== "user") cut += 1;
    if (cut >= rest.length) cut = Math.max(0, rest.length - keep);
    const old = rest.slice(0, cut);
    const recent = rest.slice(cut);
    if (old.length === 0) {
      return {
        ok: false,
        removedMessages: 0,
        summaryChars: 0,
        beforeTokens,
        afterTokens: beforeTokens,
        trigger,
        reason: "没有可压缩的历史",
      };
    }

    const transcript = renderTranscript(old);
    const summary =
      (await summarizeWithModel(client, transcript, signal)) ?? extractiveSummary(old);
    const summaryMessage: ChatMessage = {
      role: "system",
      content: `## 此前对话摘要（已压缩 ${old.length} 条原始消息）\n${summary}\n\n原文仍保存在事件记录里，但不再注入上下文。`,
    };
    const next: ChatMessage[] = [...(system ? [system] : []), summaryMessage, ...recent];
    state.history.splice(0, state.history.length, ...next);

    return {
      ok: true,
      removedMessages: old.length,
      summaryChars: summary.length,
      beforeTokens,
      afterTokens: estimateTokens(state.history),
      trigger,
    };
  }

  /** 自动压缩：占用超过阈值才动手（默认 70%）。 */
  async function maybeCompact(
    state: SessionState,
    client: ProviderClient,
    provider: ProviderConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const window = provider.contextWindow ?? config.limits.defaultContextWindow;
    if (!Number.isFinite(window) || window <= 0) return;
    const before = estimateTokens(state.history);
    if (before < Math.floor(window * config.limits.compactionRatio)) return;

    const result = await compactHistory(state, "auto", client, signal);
    if (!result.ok) return;
    const turnId = getTurnContext(state.handle)?.turnId ?? `meta_${state.sessionId}`;
    emit(
      state,
      makeEvent("meta", turnId, {
        kind: "compaction",
        data: {
          removedMessages: result.removedMessages,
          summaryChars: result.summaryChars,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          trigger: result.trigger,
        },
      }),
    );
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

  /** 把本轮控制项写进会话状态（只影响后续轮次 / 未裁决调用）。 */
  function applyControls(
    state: SessionState,
    controls: {
      providerId?: string | null;
      model?: string | null;
      permissionMode?: PermissionMode;
      workspacePath?: string | null;
    },
  ): void {
    if (controls.providerId !== undefined) state.providerId = controls.providerId;
    if (controls.model !== undefined) state.model = controls.model;
    if (
      controls.permissionMode === "confirm" ||
      controls.permissionMode === "auto" ||
      controls.permissionMode === "plan" ||
      controls.permissionMode === "full"
    ) {
      state.permissionMode = controls.permissionMode;
    }
    if (typeof controls.workspacePath === "string" && controls.workspacePath.length > 0) {
      state.cwd = controls.workspacePath;
    }
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
    // 会话级模型覆盖（R4）：只影响本轮及之后，不改供应商配置本身
    const effective: ProviderConfig =
      state.model !== null && state.model.length > 0 ? { ...provider, model: state.model } : provider;

    const controller = new AbortController();
    state.controller = controller;

    // 记忆每轮重新装配（R3）：保存后下一轮立即生效，不必重开进程
    const refreshedBase = opts.refreshBasePrompt?.(state.sessionId);
    if (typeof refreshedBase === "string") state.baseSystemPrompt = refreshedBase;

    // 系统提示每轮重建：工作区可能在会话内切换，权限模式也要写进提示
    const prompt = systemPromptOf(state);
    if (state.history[0]?.role === "system") {
      state.history[0] = { role: "system", content: prompt };
    } else {
      state.history.unshift({ role: "system", content: prompt });
    }
    state.systemPrompt = prompt;

    const client = makeClient(effective);
    // G7：本会话所属渠道（写锁的键）。闭包里 TS 不保留外层判空收窄。
    const channelKey = state.channelId;
    // 上下文压缩（R7）：阈值按上下文窗口占用比，压缩完再追加本轮用户消息
    await maybeCompact(state, client, effective, controller.signal);
    if (state.disposed || controller.signal.aborted) {
      state.controller = null;
      return;
    }

    // 工具表每轮重建：MCP 工具与内置工具走同一套裁剪（R5-c）
    const registry = createToolRegistry(toolsFor(state));

    state.history.push({ role: "user", content: text });
    emitDelta(state, turnId, "start", "", messageId);

    let reasoningOpen = false;
    let result: AgentLoopResult;
    try {
      result = await runAgentLoop({
        provider: client,
        registry,
        messages: state.history,
        cwd: state.cwd,
        permissionMode: state.permissionMode,
        botRole: state.botRole,
        signal: controller.signal,
        // 供应商配置的单次输出上限：null 时不传，交给供应商默认值
        ...(effective.maxOutputTokens !== null
          ? { maxOutputTokens: effective.maxOutputTokens }
          : {}),
        // G7：写类工具按渠道串行。没有渠道（理论上不会发生）时不串行 ——
        // 宁可保持旧行为，也不要让所有会话共用一把「null 渠道」的锁。
        ...(channelKey === null
          ? {}
          : {
              serializeWrite: (_tool, execute) =>
                lock.runCancellable(channelKey, controller.signal, execute).then((r) =>
                  r.ok ? r.value : null,
                ),
            }),
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
            // 写类工具会带 `data.fileChange`：原样交给事件流，前端渲染 diff 块。
            // 形状由 ingest 校验（不合格就当没有），这里不做二次判断。
            const fileChange =
              toolResult.data !== null &&
              typeof toolResult.data === "object" &&
              (toolResult.data as { kind?: unknown }).kind === "file_change"
                ? (toolResult.data as Record<string, unknown>)
                : null;
            emit(
              state,
              makeEvent("tool_result", turnId, {
                callId: call.id,
                status: toolResult.ok ? "ok" : "error",
                output: toolResult.output,
                ...(toolResult.truncated ? { truncated: true } : {}),
                ...(fileChange === null ? {} : { fileChange }),
              } as CanonicalEvent["payload"]),
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
                ...(sample.cachedInputTokens === undefined
                  ? {}
                  : { cachedInputTokens: sample.cachedInputTokens }),
                ...(sample.cacheWriteTokens === undefined
                  ? {}
                  : { cacheWriteTokens: sample.cacheWriteTokens }),
                ...(sample.model === undefined ? {} : { model: sample.model }),
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
        cwd: ctx.workspacePath ?? ctx.cwd,
        botId: ctx.botId ?? null,
        channelId: ctx.channelId ?? null,
        enabledSkills: ctx.enabledSkills ?? null,
        providerId: ctx.providerId ?? null,
        model: ctx.model ?? null,
        permissionMode:
          ctx.permissionMode === "auto" ||
          ctx.permissionMode === "plan" ||
          ctx.permissionMode === "full"
            ? ctx.permissionMode
            : "confirm",
        botRole: ctx.botRole === "admin" ? "admin" : "member",
        baseSystemPrompt: "",
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
      state.baseSystemPrompt = session.systemPrompt ?? "";
      state.systemPrompt = systemPromptOf(state);
      // 产品层重建的历史直接作为对话消息（内置引擎有消息级历史）
      state.history = [
        { role: "system", content: state.systemPrompt },
        ...(session.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      ];
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
      applyControls(state, input);
      await runPrompt(state, input.text);
    },

    /**
     * 生成中切模式 / 换模型（G3）：只更新后续轮次与尚未裁决的工具调用，
     * 已经在执行的调用不回滚。权限裁决由 resolver 每次读库决定。
     */
    setControls(h, controls): void {
      const state = stateOf(h);
      if (!state) return;
      applyControls(state, controls);
    },

    async compact(h, compactOpts): Promise<CompactionResult | null> {
      const state = stateOf(h);
      if (!state) return null;
      const provider = resolveCfg(state.providerId);
      if (!provider) {
        return {
          ok: false,
          removedMessages: 0,
          summaryChars: 0,
          beforeTokens: estimateTokens(state.history),
          afterTokens: estimateTokens(state.history),
          trigger: "manual",
          reason: "未配置模型供应商，无法压缩",
        };
      }
      const effective: ProviderConfig =
        state.model !== null && state.model.length > 0 ? { ...provider, model: state.model } : provider;
      const before = estimateTokens(state.history);
      if (compactOpts.force !== true) {
        const window = effective.contextWindow ?? config.limits.defaultContextWindow;
        if (before < Math.floor(window * config.limits.compactionRatio)) {
          return {
            ok: false,
            removedMessages: 0,
            summaryChars: 0,
            beforeTokens: before,
            afterTokens: before,
            trigger: "manual",
            reason: "未达到压缩阈值",
          };
        }
      }
      const signal = state.controller?.signal ?? new AbortController().signal;
      const result = await compactHistory(state, "manual", makeClient(effective), signal);
      if (result.ok) {
        // 手动压缩同样要在流内留标记（R7：流内可见）
        const turnId = getTurnContext(state.handle)?.turnId ?? `meta_${state.sessionId}`;
        emit(
          state,
          makeEvent("meta", turnId, {
            kind: "compaction",
            data: {
              removedMessages: result.removedMessages,
              summaryChars: result.summaryChars,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
              trigger: result.trigger,
            },
          }),
        );
      }
      return result;
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
