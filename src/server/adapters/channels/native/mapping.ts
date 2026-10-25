import type { CanonicalEvent, EventType, PayloadByType } from "../../../../shared/events.js";
import { metaEvent } from "../../contract.js";

/**
 * Codex app-server（JSONL / JSON-RPC）→ 统一事件（架构 §3.6 映射表）。
 *
 * 协议事实来源：本机 codex-cli 0.163.0 的
 * `codex app-server generate-json-schema` 产物 + 真实 app-server 会话录制。
 * 0.163.0 的方法名是斜杠式（`item/started`、`turn/completed`、
 * `thread/tokenUsage/updated`），架构 §3.6 表里写的是同一批通知的早期名字
 * （`item.started`、`exec_approval_request` 等），所以审批请求两种名字都认。
 *
 * 映射（左侧是通知 / 反向请求，右侧是统一事件）：
 *
 *   item/started|item/completed  (reasoning)          → thought（start/delta/end）
 *   item/started|item/completed  (commandExecution)   → tool_call + tool_result
 *   item/started|item/completed  (fileChange)         → tool_call + tool_result
 *   item/started|item/completed  (mcpToolCall)        → tool_call + tool_result
 *   item/started|item/completed  (agentMessage)       → message_delta（start/delta/end）
 *   item/agentMessage/delta                           → message_delta(delta)
 *   item/reasoning/textDelta|summaryTextDelta         → thought(delta)
 *   turn/plan/updated                                 → plan（全量替换）
 *   thread/tokenUsage/updated                         → usage（缓冲到轮末发一条）
 *   turn/completed                                    → done
 *   item/`*`/requestApproval、execCommandApproval 等     → permission_request
 *
 * 三条不可动摇的规则（与 ACP mapper 同构）：
 *   ① 认不出的 `item/…`、`turn/…` 通知 → `meta.unknown_protocol`，绝不抛错；
 *      其余协议噪声（account/*、remoteControl/*、mcpServer/* …）静默忽略 ——
 *      它们与渲染无关，落库只会让 events 表变脏。
 *   ② `userMessage` item 丢弃：用户消息由产品层写入，回显会造成重复气泡。
 *   ③ 正文权威副本是 `messages.content`（ingest 累积），这里只发增量。
 */

/** 单条工具输出上限：超过就截断并标 `truncated`，避免一次落库几十 MB。 */
const MAX_TOOL_OUTPUT = 64 * 1024;

/** 审批类反向请求的方法名：新协议 + §3.6 / 旧版名字。 */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "exec_approval_request",
  "apply_patch_approval_request",
]);

export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}

/** 本轮结束通知：0.163.0 的 `turn/completed` 与早期版本的 `turn.completed`。 */
export function isTurnCompleted(method: string): boolean {
  return method === "turn/completed" || method === "turn.completed";
}

export interface CodexMapperOptions {
  turnId: string;
  /** 本轮助手消息 id（由编排层注入）。 */
  messageId: string;
  now?: () => number;
}

/** 单个 Turn 的 Codex 事件映射器：持有 phase / 工具调用 / 用量状态。 */
export interface CodexMapper {
  /** 服务端通知 → 事件（可能 0 条）。 */
  handleNotification(method: string, params: unknown): CanonicalEvent[];
  /**
   * 审批反向请求 → permission_request 事件。
   * 通道层只上报，**不自行应答**；核心裁决后由 driver 调 `respondPermission`。
   */
  handleApprovalRequest(method: string, params: unknown, rpcId: string | number): CanonicalEvent[];
  /** `turn/completed` → usage + 收口（done / error）。 */
  handleTurnCompleted(params: unknown): CanonicalEvent[];
  /** 收口：补齐未结束的 phase 并产出 done。 */
  finalize(stopReason: PayloadByType["done"]["stopReason"]): CanonicalEvent[];
  /** 传输 / 进程错误 → fatal error；已收口时返回空数组（幂等）。 */
  transportError(message: string, detail?: string): CanonicalEvent[];
}

/** 审批应答体：通道层不解释语义，只按协议要求的形状回填。 */
export function buildApprovalResponse(
  method: string,
  params: unknown,
  decision: { kind: "approve"; scope: "once" | "session" | "bot" } | { kind: "deny" },
): unknown {
  const approve = decision.kind === "approve";
  const sessionScope = approve && decision.scope !== "once";

  if (method === "item/permissions/requestApproval") {
    // 权限档案类请求：批准就把请求的档案原样授予；拒绝就授予空档案（等于不授予）
    const requested = isRecord(params) ? params["permissions"] : undefined;
    return {
      permissions: approve ? (isRecord(requested) ? requested : {}) : {},
      scope: sessionScope ? "session" : "turn",
    };
  }

  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    // 新版：accept / acceptForSession / decline / cancel。
    // 拒绝用 decline 而不是 cancel —— cancel 会立刻中断整轮，产品语义是「不做这件事」。
    return { decision: approve ? (sessionScope ? "acceptForSession" : "accept") : "decline" };
  }

  // 旧版 execCommandApproval / applyPatchApproval（§3.6 的 exec_approval_request 同形）
  return {
    decision: approve
      ? sessionScope
        ? "approved_for_session"
        : "approved"
      : { denied: { rejection: "用户拒绝了该操作" } },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function record(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function textList(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v.filter((x): x is string => typeof x === "string").join("\n");
}

/** 工具输出截断：保留头部，尾部标注省略量（用户要看的是开头）。 */
function clampOutput(text: string): { output: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_OUTPUT) return { output: text, truncated: false };
  return {
    output: `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（已截断 ${text.length - MAX_TOOL_OUTPUT} 字符）`,
    truncated: true,
  };
}

/** 一轮内某条 item 的渲染状态。 */
interface ItemState {
  kind: "message" | "thought";
  started: boolean;
  sawDelta: boolean;
  ended: boolean;
}

export function createCodexMapper(opts: CodexMapperOptions): CodexMapper {
  const now = opts.now ?? (() => Date.now());
  const turnId = opts.turnId;
  const messageId = opts.messageId;
  const startedAt = now();

  const items = new Map<string, ItemState>();
  const toolResults = new Set<string>();
  /** fileChange itemId → 首个改动路径（审批请求只带 itemId，边界判定需要路径）。 */
  const fileChangeTargets = new Map<string, string>();
  /** 轮末统一发一条 usage：协议会多次推送累计用量，逐条发会让 UI 出现多行。 */
  let bufferedUsage: PayloadByType["usage"] | null = null;
  let finished = false;

  function emit<T extends EventType>(type: T, payload: PayloadByType[T]): CanonicalEvent<T> {
    return { type, turnId, ts: now(), payload };
  }

  function unknown(method: string, params: unknown): CanonicalEvent[] {
    return [metaEvent(turnId, "unknown_protocol", { kind: method, params })];
  }

  // -------------------------------------------------------------------------
  // 正文 / 思考（按 itemId 独立跟踪 phase）
  // -------------------------------------------------------------------------

  function itemState(itemId: string, kind: "message" | "thought"): ItemState {
    const existing = items.get(itemId);
    if (existing) return existing;
    const created: ItemState = { kind, started: false, sawDelta: false, ended: false };
    items.set(itemId, created);
    return created;
  }

  function openPhase(itemId: string, kind: "message" | "thought"): CanonicalEvent[] {
    const s = itemState(itemId, kind);
    if (s.started) return [];
    s.started = true;
    return kind === "message"
      ? [emit("message_delta", { messageId, phase: "start", text: "" })]
      : [emit("thought", { phase: "start", text: "" })];
  }

  function closePhase(itemId: string, kind: "message" | "thought"): CanonicalEvent[] {
    const s = itemState(itemId, kind);
    if (s.ended) return [];
    s.ended = true;
    return kind === "message"
      ? [emit("message_delta", { messageId, phase: "end", text: "" })]
      : [emit("thought", { phase: "end", text: "" })];
  }

  function textDelta(itemId: string, kind: "message" | "thought", text: string): CanonicalEvent[] {
    if (text.length === 0) return [];
    const out = openPhase(itemId, kind);
    const s = itemState(itemId, kind);
    s.sawDelta = true;
    out.push(
      kind === "message"
        ? emit("message_delta", { messageId, phase: "delta", text })
        : emit("thought", { phase: "delta", text }),
    );
    return out;
  }

  // -------------------------------------------------------------------------
  // 工具调用
  // -------------------------------------------------------------------------

  function toolStarted(
    callId: string,
    name: string,
    kind: string,
    input: unknown,
  ): CanonicalEvent[] {
    return [emit("tool_call", { callId, name, kind, input, status: "running" })];
  }

  function toolFinished(
    callId: string,
    status: "ok" | "error",
    output: string,
    exitCode?: number,
  ): CanonicalEvent[] {
    if (toolResults.has(callId)) return [];
    toolResults.add(callId);
    const clamped = clampOutput(output);
    return [
      emit("tool_result", {
        callId,
        status,
        output: clamped.output,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(clamped.truncated ? { truncated: true } : {}),
      }),
    ];
  }

  function commandTool(item: Record<string, unknown>, phase: "start" | "end"): CanonicalEvent[] {
    const callId = str(item["id"]) ?? "";
    const command = str(item["command"]) ?? "";
    const cwd = str(item["cwd"]);
    if (phase === "start") {
      return toolStarted(callId, "运行命令", "execute", {
        command,
        ...(cwd === undefined ? {} : { cwd }),
      });
    }
    const status = str(item["status"]);
    const exitCode = num(item["exitCode"]);
    const ok = status === "completed" && (exitCode === undefined || exitCode === 0);
    const output =
      str(item["aggregatedOutput"]) ??
      (status === "declined" ? "已拒绝执行" : status === "failed" ? "命令执行失败" : "");
    return toolFinished(callId, ok ? "ok" : "error", output, exitCode);
  }

  function fileChangeTool(item: Record<string, unknown>, phase: "start" | "end"): CanonicalEvent[] {
    const callId = str(item["id"]) ?? "";
    const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
    const paths: string[] = [];
    for (const c of changes) {
      const p = str(record(c)["path"]);
      if (p !== undefined) paths.push(p);
    }
    const first = paths[0];
    if (first !== undefined) fileChangeTargets.set(callId, first);

    if (phase === "start") {
      return toolStarted(callId, "应用补丁", "edit", {
        ...(first === undefined ? {} : { path: first }),
        files: paths,
      });
    }
    const status = str(item["status"]);
    const ok = status === "completed";
    const output =
      paths.length > 0
        ? paths.join("\n")
        : status === "declined"
          ? "已拒绝写入"
          : status === "failed"
            ? "补丁应用失败"
            : "已应用";
    return toolFinished(callId, ok ? "ok" : "error", output);
  }

  function mcpTool(item: Record<string, unknown>, phase: "start" | "end"): CanonicalEvent[] {
    const callId = str(item["id"]) ?? "";
    const server = str(item["server"]) ?? "mcp";
    const tool = str(item["tool"]) ?? "tool";
    const name = `${server}/${tool}`;
    if (phase === "start") {
      return toolStarted(callId, name, "mcp", item["arguments"]);
    }
    const status = str(item["status"]);
    const error = record(item["error"]);
    const result = record(item["result"]);
    const content = Array.isArray(result["content"]) ? result["content"] : [];
    const output =
      str(error["message"]) ??
      content
        .map((c) => {
          const rec = record(c);
          return str(rec["text"]) ?? str(rec["data"]) ?? JSON.stringify(rec);
        })
        .filter((s) => s.length > 0)
        .join("\n");
    return toolFinished(callId, status === "completed" ? "ok" : "error", output);
  }

  // -------------------------------------------------------------------------
  // item 分发
  // -------------------------------------------------------------------------

  function handleItem(itemRaw: unknown, phase: "start" | "end"): CanonicalEvent[] {
    if (!isRecord(itemRaw)) return unknown("item", itemRaw);
    const type = str(itemRaw["type"]);
    const id = str(itemRaw["id"]) ?? "";

    switch (type) {
      case "reasoning": {
        const text = textList(itemRaw["content"]) || textList(itemRaw["summary"]);
        if (phase === "start") {
          const out = openPhase(id, "thought");
          if (text.length > 0) out.push(...textDelta(id, "thought", text));
          return out;
        }
        // 有的模型不发 delta，只在 completed 里给全文
        const out = items.get(id)?.sawDelta === true || text.length === 0 ? [] : textDelta(id, "thought", text);
        out.push(...closePhase(id, "thought"));
        return out;
      }

      case "agentMessage": {
        const text = str(itemRaw["text"]) ?? "";
        if (phase === "start") {
          const out = openPhase(id, "message");
          if (text.length > 0) out.push(...textDelta(id, "message", text));
          return out;
        }
        const out = items.get(id)?.sawDelta === true || text.length === 0 ? [] : textDelta(id, "message", text);
        out.push(...closePhase(id, "message"));
        return out;
      }

      case "commandExecution":
        return commandTool(itemRaw, phase);
      case "fileChange":
        return fileChangeTool(itemRaw, phase);
      case "mcpToolCall":
        return mcpTool(itemRaw, phase);

      case "userMessage":
        // 用户消息由产品层写入；回显会造成重复气泡
        return [];

      case "contextCompaction":
        return phase === "end" ? [metaEvent(turnId, "compaction", { note: "运行时压缩了上下文" })] : [];

      // 已知但不渲染的 item（协议里有，产品流里没有对应位置）
      case "hookPrompt":
      case "plan":
      case "functionCallOutput":
      case "dynamicToolCall":
      case "collabAgentToolCall":
      case "subAgentActivity":
      case "webSearch":
      case "imageView":
      case "sleep":
      case "imageGeneration":
      case "enteredReviewMode":
      case "exitedReviewMode":
        return [];

      default:
        return unknown(`item/${String(type ?? "unknown")}`, itemRaw);
    }
  }

  // -------------------------------------------------------------------------
  // 通知分发
  // -------------------------------------------------------------------------

  function handleNotification(method: string, paramsRaw: unknown): CanonicalEvent[] {
    const params = record(paramsRaw);

    switch (method) {
      // 斜杠式是 0.163.0 的实际名字；点式是架构 §3.6 表里的写法（早期版本）。
      // 两种都认，版本换了也不用改映射表。
      case "item/started":
      case "item.started":
        return handleItem(params["item"], "start");

      case "item/completed":
      case "item.completed":
        return handleItem(params["item"], "end");

      case "item/agentMessage/delta": {
        const itemId = str(params["itemId"]) ?? "";
        return textDelta(itemId, "message", str(params["delta"]) ?? "");
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = str(params["itemId"]) ?? "";
        return textDelta(itemId, "thought", str(params["delta"]) ?? "");
      }

      case "thread/tokenUsage/updated":
      case "token_count": {
        // 0.163.0 用 `thread/tokenUsage/updated`（tokenUsage.last/total）；
        // 早期版本用 `token_count`（info.last_token_usage / total_token_usage）。
        // 两者语义相同，都取「本轮」那一份，避免跨轮重复计数。
        const usage = record(params["tokenUsage"]);
        const last = record(usage["last"]);
        const info = record(params["info"]);
        const legacyLast = record(info["last_token_usage"]);
        const pick = (key: string): number | undefined =>
          num(last[key]) ?? num(legacyLast[key]);
        const input = pick("inputTokens") ?? num(legacyLast["input_tokens"]);
        const output = pick("outputTokens") ?? num(legacyLast["output_tokens"]);
        if (input === undefined && output === undefined) return [];
        bufferedUsage = {
          inputTokens: input ?? 0,
          outputTokens: output ?? 0,
          reported: true,
        };
        return [];
      }

      case "turn/completed":
      case "turn.completed":
        return handleTurnCompleted(paramsRaw);

      case "thread/compacted":
        return [metaEvent(turnId, "compaction", { note: "运行时压缩了上下文" })];

      case "error": {
        // 运行时自报错误：willRetry=true 是重试提示（可恢复），false 才是致命
        const error = record(params["error"]);
        const willRetry = params["willRetry"] === true;
        const detail = str(error["additionalDetails"]);
        return [
          emit("error", {
            code: willRetry ? "runtime_retrying" : "runtime_error",
            message: str(error["message"]) ?? "运行时返回了错误",
            ...(detail === undefined ? {} : { detail }),
            fatal: !willRetry,
          }),
        ];
      }

      case "warning": {
        const message = str(params["message"]) ?? "运行时警告";
        return [emit("error", { code: "runtime_warning", message, fatal: false })];
      }

      // 与渲染无关的协议状态：静默忽略（不落库，避免 events 表被噪声填满）
      case "turn/started":
      case "thread/started":
      case "thread/status/changed":
      case "thread/name/updated":
      case "thread/goal/updated":
      case "thread/queue/changed":
      case "thread/settings/updated":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
      case "item/commandExecution/terminalInteraction":
      case "item/mcpToolCall/progress":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "serverRequest/resolved":
      case "turn/diff/updated":
      case "turn/moderationMetadata":
      // `turn/plan/updated` 确实存在（协议 schema 有），但 §3.6 的 Codex 映射表
      // 没把 plan 纳入事件掩码，本通道也就不产出 plan —— 未声明的类型会在 ingest
      // 处被丢弃，在这里显式忽略比让它落成 meta.unknown_protocol 更诚实。
      case "turn/plan/updated":
      case "hook/started":
      case "hook/completed":
      case "model/rerouted":
      case "configWarning":
      case "deprecationNotice":
      case "guardianWarning":
      case "remoteControl/status/changed":
      case "account/updated":
      case "account/rateLimits/updated":
      case "skills/changed":
      case "mcpServer/startupStatus/updated":
      case "fs/changed":
      case "project/changed":
        return [];

      default:
        // 只对「我们依赖的命名空间」报未知：其它（account/*、app/* …）与渲染无关
        if (method.startsWith("item/") || method.startsWith("turn/")) {
          return unknown(method, paramsRaw);
        }
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // 审批
  // -------------------------------------------------------------------------

  function approvalActionTarget(
    method: string,
    params: Record<string, unknown>,
  ): { action: "write" | "read" | "exec" | "network"; target: string } {
    if (method === "item/commandExecution/requestApproval") {
      // 网络类审批（networkApprovalContext）单列，边界里对应 allowNetwork
      const network = params["networkApprovalContext"] !== undefined && params["networkApprovalContext"] !== null;
      const command = str(params["command"]);
      return {
        action: network ? "network" : "exec",
        target: command ?? str(params["itemId"]) ?? "",
      };
    }
    if (method === "execCommandApproval" || method === "exec_approval_request") {
      const cmd = Array.isArray(params["command"]) ? params["command"] : [];
      const joined = cmd.filter((c): c is string => typeof c === "string").join(" ");
      return { action: "exec", target: joined.length > 0 ? joined : str(params["callId"]) ?? "" };
    }
    if (method === "item/fileChange/requestApproval") {
      const itemId = str(params["itemId"]) ?? "";
      return {
        action: "write",
        // 请求本身不带路径：用 item/started 时记下的首个改动路径
        target: fileChangeTargets.get(itemId) ?? str(params["grantRoot"]) ?? str(params["reason"]) ?? itemId,
      };
    }
    if (method === "applyPatchApproval" || method === "apply_patch_approval_request") {
      const changes = record(params["fileChanges"]);
      const first = Object.keys(changes)[0];
      return { action: "write", target: first ?? str(params["callId"]) ?? "" };
    }
    // item/permissions/requestApproval：按请求的档案猜动作（只用于图标与边界粗判）
    const perms = record(params["permissions"]);
    const fs = record(perms["fileSystem"]);
    const write = Array.isArray(fs["write"]) ? fs["write"].filter((x): x is string => typeof x === "string") : [];
    const network = record(perms["network"]);
    const firstWrite = write[0];
    if (firstWrite !== undefined) return { action: "write", target: firstWrite };
    if (network["enabled"] === true) {
      return { action: "network", target: str(params["cwd"]) ?? "" };
    }
    return { action: "read", target: str(params["cwd"]) ?? str(params["itemId"]) ?? "" };
  }

  function handleApprovalRequest(
    method: string,
    paramsRaw: unknown,
    rpcId: string | number,
  ): CanonicalEvent[] {
    const params = record(paramsRaw);
    const { action, target } = approvalActionTarget(method, params);
    return [
      emit("permission_request", {
        // 用 JSON-RPC id 作为 requestId：应答时必须原样回它
        requestId: String(rpcId),
        action,
        target,
        // 边界裁决归核心（M6）；通道层只如实说「还没判」
        boundaryVerdict: "pending",
      }),
    ];
  }

  // -------------------------------------------------------------------------
  // 收口
  // -------------------------------------------------------------------------

  function finalize(stopReason: PayloadByType["done"]["stopReason"]): CanonicalEvent[] {
    if (finished) return [];
    finished = true;
    const out: CanonicalEvent[] = [];

    if (bufferedUsage) {
      out.push(emit("usage", bufferedUsage));
      bufferedUsage = null;
    }
    // 把仍未收口的 phase 补 end，否则 UI 永远显示「生成中」
    for (const [itemId, s] of items) {
      if (s.ended) continue;
      out.push(...closePhase(itemId, s.kind));
    }
    out.push(emit("done", { stopReason, durationMs: Math.max(0, now() - startedAt) }));
    return out;
  }

  function handleTurnCompleted(paramsRaw: unknown): CanonicalEvent[] {
    if (finished) return [];
    const params = record(paramsRaw);
    const turn = record(params["turn"]);
    const status = str(turn["status"]);

    if (status === "failed") {
      const error = record(turn["error"]);
      finished = true;
      // 失败：先把已上报的用量交出去（token 确实消耗了），再报致命错误。
      // 不补 done —— 编排层收到 fatal error 即收口为失败，多一条 done 会被丢弃，
      // 与 ACP 通道的崩溃分支保持同一形状。
      const events: CanonicalEvent[] = [];
      if (bufferedUsage) {
        events.push(emit("usage", bufferedUsage));
        bufferedUsage = null;
      }
      events.push(
        emit("error", {
          code: "runtime_error",
          message: str(error["message"]) ?? "这一轮没有完成",
          ...(str(error["additionalDetails"]) === undefined
            ? {}
            : { detail: str(error["additionalDetails"]) }),
          fatal: true,
        }),
      );
      return events;
    }

    return finalize(status === "interrupted" ? "cancelled" : "end");
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
    handleNotification,
    handleApprovalRequest,
    handleTurnCompleted,
    finalize,
    transportError,
  };
}
