import type { CanonicalEvent, EventType, PayloadByType } from "../../../../shared/events.js";
import { metaEvent } from "../../contract.js";

/**
 * ACP `session/update` → 统一事件（架构 §3.5 映射表，所有 ACP 运行时共用一份）。
 *
 * 为什么集中在这一个文件：ACP v2 改一个字段名，只改这里；新增一个 update 子类型，
 * 只加一个 case。新增一个原生 ACP 运行时不需要动这里（它只是换个 YAML）。
 *
 * 三条不可动摇的规则：
 *   ① 未知 discriminator → `meta.unknown_protocol`，绝不抛错、绝不让整轮失败；
 *   ② 非渲染的协议状态（slash commands / config / mode）→ `meta`，不进渲染流；
 *   ③ `user_message_chunk` 丢弃 —— 用户消息由产品层写入，运行时回显会造成重复气泡。
 *
 * phase 规则：正文与思考都是增量。首个 chunk 补 `start`，`done` 时补 `end`。
 * 正文的权威副本是 `messages.content`（ingest 负责累积），事件只是增量通知。
 */

export interface AcpMapperOptions {
  turnId: string;
  /**
   * 助手消息 id。Turn 开始时已建好 messages 行，这里只回填 id；
   * 一个 Turn 内通常只有一条助手消息，但协议允许运行时新开一条（见 `resetMessage`）。
   */
  messageId: string;
  now?: () => number;
}

/** 单个 Turn 的 ACP 事件映射器：持有 phase / 工具调用状态。 */
export interface AcpMapper {
  /** `session/update` 通知 → 事件（可能 0 条：user_message_chunk 与未知类型被吸收）。 */
  handleSessionUpdate(params: unknown): CanonicalEvent[];
  /**
   * 反向请求 `session/request_permission` → permission_request 事件。
   * `rpcId` 是 JSON-RPC 的请求 id（ACP 的权限请求本身没有 requestId 字段，
   * 应答必须原样回这个 id），所以由 driver 传进来。
   */
  handlePermissionRequest(params: unknown, rpcId?: string | number): CanonicalEvent[];
  /** `session/prompt` 的响应 → done（+ 可选 usage）。 */
  handlePromptResult(result: unknown): CanonicalEvent[];
  /** 收口：把仍处于 start 的正文/思考补 end，避免 UI 永远显示「生成中」。 */
  finalize(stopReason: PayloadByType["done"]["stopReason"]): CanonicalEvent[];
  /**
   * 传输/进程错误 → fatal error 事件。
   * 已经收口过（done / 上一次 error）时返回空数组：同一次崩溃只能有一条 error，
   * 否则「进程退出」会被驱动和传输层各报一次，UI 出现两个错误块。
   */
  transportError(message: string, detail?: string): CanonicalEvent[];
  /** 当前 Turn 已见过的工具调用（供 driver 做权限归一化，不渲染）。 */
  toolCallKind(callId: string): string | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** ACP 的 content 块：`{type:'text', text}` 或 `{type:'resource_link'...}`。 */
function contentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!isRecord(v)) return "";
  const direct = str(v["text"]);
  if (direct !== undefined) return direct;
  if (Array.isArray(v["content"])) {
    // 有些实现给的是 content 数组
    return v["content"].map(contentText).join("");
  }
  return "";
}

/** tool_call 的 content 可能是数组（多个内容块），拼成一段文本输出。 */
function toolOutputText(v: unknown): string {
  if (Array.isArray(v)) return v.map(toolOutputText).filter((s) => s.length > 0).join("\n");
  return contentText(v);
}

/** ACP tool kind → 产品语义。只用于权限归一化与 UI 图标，不做安全判定。 */
const KIND_TO_ACTION: Record<string, "write" | "read" | "exec" | "network"> = {
  edit: "write",
  write: "write",
  delete: "write",
  move: "write",
  execute: "exec",
  exec: "exec",
  read: "read",
  search: "read",
  fetch: "network",
  think: "read",
};

export function acpActionOfKind(kind: string | undefined): "write" | "read" | "exec" | "network" {
  if (!kind) return "read";
  return KIND_TO_ACTION[kind.toLowerCase()] ?? "read";
}

export function createAcpMapper(opts: AcpMapperOptions): AcpMapper {
  const now = opts.now ?? (() => Date.now());
  const turnId = opts.turnId;
  const startedAt = now();
  const messageId = opts.messageId;

  /** 正文/思考的 phase 状态：还没发过 start 就要补一个。 */
  let messageStarted = false;
  let thoughtStarted = false;
  let finished = false;

  /** callId → 已知的工具调用信息：更新事件常省略 title/kind，要沿用首次的值。 */
  const toolCalls = new Map<string, { name: string; kind?: string; input?: unknown }>();
  /** callId → 是否已经产出过 tool_result，避免重复收口。 */
  const toolResults = new Set<string>();

  function emit<T extends EventType>(type: T, payload: PayloadByType[T]): CanonicalEvent<T> {
    return { type, turnId, ts: now(), payload };
  }

  function textChunk(
    update: Record<string, unknown>,
    type: "message_delta" | "thought",
  ): CanonicalEvent[] {
    const text = contentText(update["content"]);
    const out: CanonicalEvent[] = [];

    if (type === "message_delta") {
      if (!messageStarted) {
        messageStarted = true;
        out.push(
          emit("message_delta", { messageId, phase: "start", text: "" }),
        );
      }
      if (text.length > 0) out.push(emit("message_delta", { messageId, phase: "delta", text }));
      return out;
    }

    if (!thoughtStarted) {
      thoughtStarted = true;
      out.push(emit("thought", { phase: "start", text: "" }));
    }
    if (text.length > 0) out.push(emit("thought", { phase: "delta", text }));
    return out;
  }

  function toolCall(update: Record<string, unknown>): CanonicalEvent[] {
    const callId = str(update["toolCallId"]) ?? str(update["tool_call_id"]);
    if (!callId) {
      // 缺 callId 无法挂回调用：保留原始 JSON 交 UI 降级渲染（P0-05）
      return [
        {
          type: "tool_call",
          turnId,
          ts: now(),
          payload: {
            callId: "",
            name: str(update["title"]) ?? "未知工具",
            kind: str(update["kind"]),
            input: update["rawInput"],
            status: "pending",
          },
          raw: update,
        },
      ];
    }
    const kind = str(update["kind"]);
    const name = str(update["title"]) ?? kind ?? "未知工具";
    const input = update["rawInput"] ?? update["input"];
    toolCalls.set(callId, {
      name,
      ...(kind === undefined ? {} : { kind }),
      ...(input === undefined ? {} : { input }),
    });
    const status = update["status"] === "in_progress" ? "running" : "pending";
    return [
      emit("tool_call", {
        callId,
        name,
        ...(kind === undefined ? {} : { kind }),
        input,
        status,
      }),
    ];
  }

  function toolCallUpdate(update: Record<string, unknown>): CanonicalEvent[] {
    const callId = str(update["toolCallId"]) ?? str(update["tool_call_id"]);
    const status = str(update["status"]);
    if (!callId) return [];

    if (status === "in_progress" || status === undefined) {
      // 状态推进：按 callId 覆盖（UI 用同一个 callId 找现有块）。
      // 更新事件经常只带 status，所以 name/kind/input 一律沿用首次的值。
      const known = toolCalls.get(callId);
      const kind = str(update["kind"]) ?? known?.kind;
      const name = str(update["title"]) ?? known?.name ?? "未知工具";
      const input = update["rawInput"] ?? update["input"] ?? known?.input;
      toolCalls.set(callId, {
        name,
        ...(kind === undefined ? {} : { kind }),
        ...(input === undefined ? {} : { input }),
      });
      return [
        emit("tool_call", {
          callId,
          name,
          ...(kind === undefined ? {} : { kind }),
          input,
          status: "running",
        }),
      ];
    }

    if (status === "completed" || status === "failed") {
      if (toolResults.has(callId)) return [];
      toolResults.add(callId);
      const output =
        toolOutputText(update["content"]) || toolOutputText(update["rawOutput"]);
      const exitCodeRaw = update["exitCode"];
      const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : undefined;
      return [
        emit("tool_result", {
          callId,
          status: status === "completed" && (exitCode === undefined || exitCode === 0) ? "ok" : "error",
          output,
          ...(exitCode === undefined ? {} : { exitCode }),
        }),
      ];
    }

    // 其它状态（pending 等）：当作调用存在，不产生结果
    return [];
  }

  function plan(update: Record<string, unknown>): CanonicalEvent[] {
    const rawEntries = update["entries"];
    const entries = (Array.isArray(rawEntries) ? rawEntries : []).map((e) => {
      const rec = isRecord(e) ? e : {};
      const s = str(rec["status"]);
      return {
        content: str(rec["content"]) ?? "",
        status: s === "completed" || s === "done" ? ("done" as const) : s === "in_progress" ? ("in_progress" as const) : ("pending" as const),
      };
    });
    return [emit("plan", { entries })];
  }

  function handleSessionUpdate(params: unknown): CanonicalEvent[] {
    if (!isRecord(params)) {
      return [metaEvent(turnId, "unknown_protocol", { reason: "session/update 的 params 不是对象" })];
    }
    const update = params["update"];
    if (!isRecord(update)) {
      // 缺 update 体：记 meta，不抛错（协议噪声不该让整轮失败）
      return [metaEvent(turnId, "unknown_protocol", { reason: "session/update 缺少 update" })];
    }
    const kind = str(update["sessionUpdate"]) ?? str(update["session_update"]);
    if (!kind) {
      return [metaEvent(turnId, "unknown_protocol", { reason: "session/update 缺少 sessionUpdate" })];
    }

    switch (kind) {
      case "agent_message_chunk":
        return textChunk(update, "message_delta");
      case "agent_thought_chunk":
        return textChunk(update, "thought");
      case "user_message_chunk":
        // 用户消息由产品层写入；回显会造成重复气泡
        return [];
      case "tool_call":
        return toolCall(update);
      case "tool_call_update":
        return toolCallUpdate(update);
      case "plan":
        return plan(update);
      case "context_compaction":
        return [metaEvent(turnId, "compaction", { note: str(update["note"]) ?? null })];
      case "available_commands_update":
        return [metaEvent(turnId, "commands_update", { commands: update["availableCommands"] ?? [] })];
      case "current_mode_update":
      case "config_option_update":
        return [metaEvent(turnId, "config_update", { kind, data: update })];
      default:
        // 未知子类型：只记 meta，不影响渲染，也不让整轮失败
        return [metaEvent(turnId, "unknown_protocol", { kind })];
    }
  }

  function handlePermissionRequest(params: unknown, rpcId?: string | number): CanonicalEvent[] {
    const fallbackId = rpcId === undefined ? "" : String(rpcId);
    if (!isRecord(params)) {
      return [
        {
          type: "permission_request",
          turnId,
          ts: now(),
          payload: { requestId: fallbackId, action: "read", target: "", boundaryVerdict: "pending" },
          raw: params,
        },
      ];
    }
    // requestId 优先用协议字段；ACP 没这个字段时用 JSON-RPC id —— 两者都能用来应答
    const requestId =
      str(params["requestId"]) ??
      str(params["request_id"]) ??
      str(params["toolCallId"]) ??
      fallbackId;
    const toolCall = isRecord(params["toolCall"]) ? params["toolCall"] : {};
    const kind = str(toolCall["kind"]);
    const action = acpActionOfKind(kind);
    // target：优先给绝对路径，没有就退回标题/命令原文；核心会再做一次解析
    const target =
      str(toolCall["title"]) ??
      str(toolCall["command"]) ??
      str(isRecord(toolCall["rawInput"]) ? toolCall["rawInput"]["path"] : undefined) ??
      str(isRecord(toolCall["rawInput"]) ? toolCall["rawInput"]["command"] : undefined) ??
      "";

    return [
      emit("permission_request", {
        requestId,
        action,
        target,
        // 边界裁决归核心（M6）；通道层只如实说「还没判」
        boundaryVerdict: "pending",
      }),
    ];
  }

  function usageOf(result: unknown): PayloadByType["usage"] | null {
    if (!isRecord(result)) return null;
    const candidates = [result["usage"], isRecord(result["_meta"]) ? result["_meta"]["usage"] : undefined];
    for (const c of candidates) {
      if (!isRecord(c)) continue;
      const input = c["inputTokens"] ?? c["input_tokens"];
      const output = c["outputTokens"] ?? c["output_tokens"];
      if (typeof input !== "number" && typeof output !== "number") continue;
      return {
        inputTokens: typeof input === "number" ? input : 0,
        outputTokens: typeof output === "number" ? output : 0,
        reported: true,
      };
    }
    return null;
  }

  function handlePromptResult(result: unknown): CanonicalEvent[] {
    const out: CanonicalEvent[] = [];
    const usage = usageOf(result);
    if (usage) out.push(emit("usage", usage));

    const stopReasonRaw = isRecord(result) ? str(result["stopReason"]) : undefined;
    const stopReason =
      stopReasonRaw === "cancelled"
        ? ("cancelled" as const)
        : stopReasonRaw === "max_tokens" || stopReasonRaw === "maxTokens"
          ? ("max_tokens" as const)
          : ("end" as const);

    out.push(...finalize(stopReason));
    return out;
  }

  function finalize(stopReason: PayloadByType["done"]["stopReason"]): CanonicalEvent[] {
    if (finished) return [];
    finished = true;
    const out: CanonicalEvent[] = [];
    if (thoughtStarted) out.push(emit("thought", { phase: "end", text: "" }));
    if (messageStarted) out.push(emit("message_delta", { messageId, phase: "end", text: "" }));
    out.push(emit("done", { stopReason, durationMs: Math.max(0, now() - startedAt) }));
    return out;
  }

  function transportError(message: string, detail?: string): CanonicalEvent[] {
    if (finished) return [];
    finished = true;
    return [
      emit("error", {
        code: "runtime_crashed",
        message,
        ...(detail === undefined ? {} : { detail }),
        fatal: true,
      }),
    ];
  }

  return {
    handleSessionUpdate,
    handlePermissionRequest,
    handlePromptResult,
    finalize,
    transportError,
    toolCallKind: (callId) => toolCalls.get(callId)?.kind,
  };
}
