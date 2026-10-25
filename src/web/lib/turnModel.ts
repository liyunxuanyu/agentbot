/**
 * Turn 渲染模型 —— 纯函数，把「事件流 + messages 表」合成 UI 需要的结构。
 *
 * 为什么单独一层：
 *   - store 只负责收帧与去重（高频路径，必须轻）；
 *   - 组件只负责画（不该知道 message_delta 的 phase 语义）；
 *   - 合成逻辑是纯函数，便于单元测试与后续 M5 复用。
 *
 * 两条硬规则（架构 §7 / PRD P0-04、P0-15）：
 *   ① 正文以 `messages.content` 为准：`message_delta` 的累积文本只用于「正在流式」
 *      的即时显示；一旦 messages 表里有这条消息，就用它的 content 覆盖。
 *   ② `meta` 不进渲染流：这里根本不接收 meta 帧（由 store 单独处理）。
 */

import type {
  EventType,
  MetaEventKind,
  PermissionAction,
  PlanEntry,
} from "@shared/events";
import type { MessageDto, MessageStatus } from "../net/types";

/** 工具结果视图：payload 的 tool_result 是扁平结构，这里只取展示需要的字段。 */
export interface ToolResultView {
  status: "ok" | "error";
  output: string;
  exitCode: number | null;
  truncated: boolean;
}

/** 计划条目与 shared 的 PlanEntry 同形（全量替换语义由 replace 标记表达）。 */
export type PlanEntryLike = PlanEntry;

/** 一帧 SSE 事件（与 sse.ts 的 SseFrame 同形，前端本地别名）。 */
export interface RawEvent {
  id: number;
  sessionId: string;
  messageId: string | null;
  turnId: string;
  type: EventType | "meta";
  seq: number;
  payload: unknown;
  raw: unknown | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 展示用事件
// ---------------------------------------------------------------------------

export interface ThoughtEvent {
  kind: "thought";
  seq: number;
  ts: number;
  text: string;
  /** 是否还在流式（phase !== 'end'）。 */
  streaming: boolean;
}

export interface ToolCallEvent {
  kind: "tool_call";
  seq: number;
  ts: number;
  callId: string;
  name: string;
  input: unknown;
  status: "pending" | "running";
  /** 已挂上的结果；null 表示还没回来。 */
  result: ToolResultView | null;
}

export interface PlanEvent {
  kind: "plan";
  seq: number;
  ts: number;
  entries: PlanEntryLike[];
}

export interface PermissionEvent {
  kind: "permission";
  seq: number;
  ts: number;
  requestId: string;
  action: PermissionAction;
  target: string;
  boundaryVerdict: "allowed" | "denied" | "pending";
  /** payload 里没带，靠 /api/permissions 补；store 里另存权威状态。 */
  degraded: boolean;
}

export interface UsageEvent {
  kind: "usage";
  seq: number;
  ts: number;
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
}

export interface DoneEvent {
  kind: "done";
  seq: number;
  ts: number;
  stopReason: "end" | "cancelled" | "max_tokens" | "error";
  durationMs: number;
}

export interface ErrorEvent {
  kind: "error";
  seq: number;
  ts: number;
  code: string;
  message: string;
  detail: string | null;
  fatal: boolean;
}

/** 已声明类型但字段缺失：降级为「未知事件」，保留原始 JSON（P0-05）。 */
export interface UnknownEvent {
  kind: "unknown";
  seq: number;
  ts: number;
  /** 原始事件类型名（用于展示 `runtime.xyz` 这类信息）。 */
  typeName: string;
  /** 缺失的字段名，用于说明「为什么是未知」。 */
  missing: string[];
  raw: unknown;
}

export type DisplayEvent =
  | ThoughtEvent
  | ToolCallEvent
  | PlanEvent
  | PermissionEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent
  | UnknownEvent;

export interface MessageView {
  kind: "message";
  messageId: string;
  /** 正文权威副本（messages.content 优先）。 */
  text: string;
  status: MessageStatus;
  streaming: boolean;
  ts: number;
  /** 该消息的第一条 message_delta 的 seq，用于和事件排序。 */
  seq: number;
}

export type TurnItem = MessageView | DisplayEvent;

export type TurnStatus = "pending" | "streaming" | "waiting" | "done" | "failed" | "interrupted";

export interface TurnView {
  turnId: string;
  botId: string;
  items: TurnItem[];
  status: TurnStatus;
  usage: UsageEvent | null;
  done: DoneEvent | null;
  error: ErrorEvent | null;
  startedAt: number;
  endedAt: number | null;
  /**
   * 最后一条事件的到达时间（没有事件时退到消息创建时间 / Turn 开始时间）。
   *
   * P0-05 边界「连续 30s 无事件且未结束 → 显示『无响应』」的计时基准：
   * 不能用心跳（服务端 15s 一次的 `: ping` 不代表运行时在产出），必须看真实事件。
   */
  lastEventAt: number;
  /** 有阻断型权限请求时为 true：Turn 头要 sticky 到输入框上方（原型 .turn--perm-block）。 */
  hasBlockingPermission: boolean;
  /** 供折叠摘要：`完成 · 1.2k/0.4k`。 */
  summary: string;
  /**
   * pending Turn 的额外信息（只存在于「POST 已返回、首个 SSE 事件尚未到达」之间）。
   *
   * 非 pending 的 TurnView 没有这个字段。UI 靠 `streamingRuntime` 决定等待文案：
   * 非流式运行时不能画假光标（UX §6.1），只能说「等待完整结果」。
   */
  pending?: { streamingRuntime: boolean };
}

/**
 * 构造 pending Turn（P0-04：发送后立刻有「正在处理」的反馈）。
 *
 * 为什么 pending 也做成 TurnView：rows 装配、单展开、折叠判定、秒表全都只认
 * `TurnView`。单独造一种「占位行」会让这四条逻辑各多一个分支，而且很容易在
 * 「首个事件到达」时出现两个 Turn（实测过的失败模式）。
 *
 * 合并规则（调用方负责）：pending 的 turnId 必须与 POST 响应的 turnId 相同；
 * 首个 SSE 事件到达后，该 turnId 会出现在事件表里，pending 直接不再渲染即可 ——
 * 同一个 turnId 在 `turnIds` 里只会出现一次，所以不会出现两个 Turn。
 */
export function buildPendingTurnView(input: {
  turnId: string;
  botId: string;
  startedAt: number;
  /** 运行时是否逐 token 流式（Bot 绑定运行时的 capabilities.streaming）。 */
  streamingRuntime: boolean;
}): TurnView {
  return {
    turnId: input.turnId,
    botId: input.botId,
    items: [],
    status: "pending",
    usage: null,
    done: null,
    error: null,
    startedAt: input.startedAt,
    endedAt: null,
    lastEventAt: input.startedAt,
    hasBlockingPermission: false,
    summary: "",
    pending: { streamingRuntime: input.streamingRuntime },
  };
}

// ---------------------------------------------------------------------------
// 字段校验（与后端 ingest 的降级判定同口径）
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 事件类型 → 必填字段。缺任何一项即降级为「未知事件」。 */
const REQUIRED: Partial<Record<EventType, readonly string[]>> = {
  thought: ["text"],
  tool_call: ["name"],
  tool_result: ["callId", "status"],
  plan: ["entries"],
  permission_request: ["requestId", "action"],
  usage: ["inputTokens", "outputTokens"],
  done: ["stopReason"],
  error: ["message"],
};

/** 缺字段 → 返回缺失列表；不缺返回 null。 */
function missingFields(type: EventType, payload: Record<string, unknown>): string[] | null {
  const required = REQUIRED[type];
  if (!required) return null;
  const miss = required.filter((k) => {
    const v = payload[k];
    return v === undefined || v === null || v === "";
  });
  return miss.length > 0 ? miss : null;
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

export interface BuildTurnInput {
  turnId: string;
  botId: string;
  /** 该 Turn 的全部事件（已按 seq 升序；message_delta 也在内）。 */
  events: readonly RawEvent[];
  /** 该 Turn 的 assistant 消息（来自 messages 表，权威正文）。 */
  messages: readonly MessageDto[];
  /** 流式文本（尚未落库的部分），messageId → 文本。 */
  streamingText: Readonly<Record<string, string>>;
  /** 有阻断型待批权限的 turnId 集合。 */
  blockingTurnIds: ReadonlySet<string>;
  /**
   * REST 端点不可用时的降级：用事件累积重建正文。
   *
   * 默认 false —— `messages.content` 是唯一权威副本，正常路径绝不靠事件重建（P0-04）。
   * 只有 `/api/channels/:id` 还没落地（M3 阶段）或请求失败时，才没有权威副本可取；
   * 此时若什么都不显示，用户看到的是「有事件但没正文」的空壳，比降级更糟。
   * 调用方必须同时向用户明示这一点（页面上的降级提示条）。
   */
  fallbackRebuild?: boolean;
}

export function buildTurnView(input: BuildTurnInput): TurnView {
  const { turnId, botId, events, messages, streamingText, blockingTurnIds } = input;
  const fallbackRebuild = input.fallbackRebuild === true;

  const display: DisplayEvent[] = [];
  /** callId → 已生成的下标，用于把 tool_result 挂到 tool_call 上。 */
  const callIndex = new Map<string, number>();
  /** messageId → 首帧 seq（决定气泡插在哪条事件前）。 */
  const msgSeq = new Map<string, number>();
  /** messageId → 末帧时间。 */
  const msgTs = new Map<string, number>();
  /** 降级重建用的正文累积（仅在 fallbackRebuild 时使用）。 */
  const rebuiltText = new Map<string, string>();
  /** 累积中的思考文本（thought 是多帧 delta）。 */
  let thought: ThoughtEvent | null = null;
  /** 最新计划（全量替换）。 */
  let plan: PlanEvent | null = null;

  let usage: UsageEvent | null = null;
  let done: DoneEvent | null = null;
  let error: ErrorEvent | null = null;
  let startedAt = 0;
  let lastEventAt = 0;
  let endedAt: number | null = null;

  for (const ev of events) {
    if (startedAt === 0) startedAt = ev.createdAt;
    if (ev.createdAt > lastEventAt) lastEventAt = ev.createdAt;
    const p = isRecord(ev.payload) ? ev.payload : {};

    switch (ev.type) {
      case "message_delta": {
        const mid = str(p["messageId"]) ?? ev.messageId ?? "";
        if (!mid) break;
        if (!msgSeq.has(mid)) msgSeq.set(mid, ev.seq);
        msgTs.set(mid, ev.createdAt);
        // 降级路径：没有 messages 表可读时，只能靠事件累积拼正文（调用方必须明示）
        if (fallbackRebuild) {
          const text = str(p["text"]) ?? "";
          const phase = str(p["phase"]) ?? "delta";
          if (phase === "start") rebuiltText.set(mid, text);
          else if (text.length > 0) rebuiltText.set(mid, (rebuiltText.get(mid) ?? "") + text);
        }
        break;
      }

      case "thought": {
        const phase = str(p["phase"]) ?? "delta";
        const text = str(p["text"]) ?? "";
        if (!thought) {
          thought = { kind: "thought", seq: ev.seq, ts: ev.createdAt, text, streaming: true };
          display.push(thought);
        } else {
          thought.text += text;
        }
        if (phase === "end") {
          thought.streaming = false;
          endedAt = ev.createdAt;
        }
        break;
      }

      case "tool_call": {
        const miss = missingFields("tool_call", p);
        if (miss) {
          display.push(unknown(ev, miss));
          break;
        }
        const callId = str(p["callId"]) ?? "";
        const item: ToolCallEvent = {
          kind: "tool_call",
          seq: ev.seq,
          ts: ev.createdAt,
          callId,
          name: str(p["name"]) ?? "未知工具",
          input: p["input"] ?? null,
          status: p["status"] === "running" ? "running" : "pending",
          result: null,
        };
        callIndex.set(callId, display.length);
        display.push(item);
        break;
      }

      case "tool_result": {
        const miss = missingFields("tool_result", p);
        if (miss) {
          display.push(unknown(ev, miss));
          break;
        }
        const callId = str(p["callId"]) ?? "";
        const result: ToolResultView = {
          status: p["status"] === "ok" ? "ok" : "error",
          output: typeof p["output"] === "string" ? p["output"] : "",
          exitCode: typeof p["exitCode"] === "number" ? p["exitCode"] : null,
          truncated: p["truncated"] === true,
        };
        const idx = callIndex.get(callId);
        const target = idx === undefined ? undefined : display[idx];
        if (target && target.kind === "tool_call") {
          target.result = result;
        } else {
          // 挂不回调用：降级为未知事件，保留原始 JSON（P0-05 明确要求不丢弃）
          display.push({
            kind: "unknown",
            seq: ev.seq,
            ts: ev.createdAt,
            typeName: "tool_result",
            missing: [`callId=${callId || "空"} 无法挂回调用`],
            raw: ev.raw ?? ev.payload,
          });
        }
        break;
      }

      case "plan": {
        const miss = missingFields("plan", p);
        if (miss) {
          display.push(unknown(ev, miss));
          break;
        }
        const entries = Array.isArray(p["entries"]) ? (p["entries"] as PlanEntryLike[]) : [];
        if (plan) {
          // 全量替换：原型里计划是一行，展开看清单，所以更新同一行而不是追加
          plan.entries = entries;
          plan.seq = ev.seq;
        } else {
          plan = { kind: "plan", seq: ev.seq, ts: ev.createdAt, entries };
          display.push(plan);
        }
        break;
      }

      case "permission_request": {
        const miss = missingFields("permission_request", p);
        if (miss) {
          display.push(unknown(ev, miss));
          break;
        }
        const action = p["action"];
        display.push({
          kind: "permission",
          seq: ev.seq,
          ts: ev.createdAt,
          requestId: str(p["requestId"]) ?? "",
          action:
            action === "write" || action === "read" || action === "exec" || action === "network"
              ? action
              : "read",
          target: str(p["target"]) ?? "",
          boundaryVerdict:
            p["boundaryVerdict"] === "denied"
              ? "denied"
              : p["boundaryVerdict"] === "allowed"
                ? "allowed"
                : "pending",
          degraded: ev.raw !== null,
        });
        break;
      }

      case "usage": {
        const view: UsageEvent = {
          kind: "usage",
          seq: ev.seq,
          ts: ev.createdAt,
          inputTokens: numOr(p["inputTokens"], 0),
          outputTokens: numOr(p["outputTokens"], 0),
          reported: p["reported"] === true,
        };
        usage = view;
        // 用量行要出现在流里的原位置（Turn 尾），所以同时进 display
        display.push(view);
        break;
      }

      case "done": {
        const view: DoneEvent = {
          kind: "done",
          seq: ev.seq,
          ts: ev.createdAt,
          stopReason:
            p["stopReason"] === "cancelled"
              ? "cancelled"
              : p["stopReason"] === "max_tokens"
                ? "max_tokens"
                : p["stopReason"] === "error"
                  ? "error"
                  : "end",
          durationMs: numOr(p["durationMs"], ev.createdAt - (startedAt || ev.createdAt)),
        };
        done = view;
        display.push(view);
        endedAt = ev.createdAt;
        break;
      }

      case "error": {
        const view: ErrorEvent = {
          kind: "error",
          seq: ev.seq,
          ts: ev.createdAt,
          code: str(p["code"]) ?? "unknown_error",
          message: str(p["message"]) ?? "运行时返回了无法解析的错误",
          detail: str(p["detail"]),
          fatal: p["fatal"] !== false,
        };
        error = view;
        // 错误是主权重事件（UX §5 权重表），必须常显在流里
        display.push(view);
        if (view.fatal) endedAt = ev.createdAt;
        break;
      }

      case "meta":
        // store 不该把 meta 传进来；万一传了也绝不渲染
        break;
    }
  }

  // ---- 消息气泡：以 messages 表为准，缺的用流式累积 ----
  const byId = new Map<string, MessageDto>();
  for (const m of messages) byId.set(m.id, m);

  const messageViews: MessageView[] = [];
  const ids = new Set<string>([...byId.keys(), ...msgSeq.keys()]);
  for (const mid of ids) {
    const row = byId.get(mid);
    const live = streamingText[mid];
    const rebuilt = rebuiltText.get(mid);
    const streaming = row ? row.status === "streaming" : live !== undefined;
    // 权威副本优先；没有行（例如消息行尚未建）才用流式累积；
    // 再退一步才是事件累积（仅 fallbackRebuild，调用方必须明示）
    const text = row ? row.content : (live ?? rebuilt ?? "");
    // 空正文不生成空气泡：`message_delta` 只带 end 相位（正文全在 messages 表里）
    // 而 REST 又不可用时，画一个空气泡比不画更糟 —— 用户会以为运行时返回了空。
    // 真正的空回复（消息行存在但 content 为空）仍会渲染，由气泡内的
    // 「未返回内容」占位 + 重发入口兜底（PRD P0-04 边界）。
    if (text.length === 0 && !row) continue;
    const ts = row?.createdAt ?? msgTs.get(mid) ?? startedAt;
    if (ts > lastEventAt) lastEventAt = ts;
    messageViews.push({
      kind: "message",
      messageId: mid,
      text,
      status: row?.status ?? (streaming ? "streaming" : "done"),
      streaming,
      ts,
      seq: msgSeq.get(mid) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  messageViews.sort((a, b) => a.seq - b.seq || a.ts - b.ts);

  // ---- 合并顺序：按 seq ----
  const items: TurnItem[] = [...messageViews, ...display];
  items.sort((a, b) => {
    const sa = a.kind === "message" ? a.seq : a.seq;
    const sb = b.kind === "message" ? b.seq : b.seq;
    if (sa !== sb) return sa - sb;
    // 同 seq 时消息在前（气泡是正文，事件是旁注）
    return a.kind === "message" ? -1 : 1;
  });

  // ---- 状态 ----
  //
  // 「消息行已落库且状态是 failed」也算终态：运行时崩溃时编排层把助手消息标成
  // failed，但**不一定**再补一条 error 事件。不认这一条，这个 Turn 会永远显示
  // 「生成中」—— 用户看到一个转圈的空壳，实际那一轮早就结束了（实测踩到）。
  const failedMessage = messageViews.some((m) => m.status === "failed");
  let status: TurnStatus;
  if (error && error.fatal) status = "failed";
  else if (done) status = done.stopReason === "cancelled" ? "interrupted" : "done";
  else if (failedMessage) status = "failed";
  else if (messageViews.some((m) => m.streaming) || display.some((d) => d.kind === "thought" && d.streaming)) {
    status = "streaming";
  } else if (messageViews.length > 0 && messageViews.every((m) => m.status !== "streaming")) {
    // 消息都已落库且没有 done 事件（进程被杀 / 连接中断）：按完成处理，
    // 不能让「已经结束但没收到收口事件」永远停在生成中。
    status = "done";
  } else if (events.length > 0) {
    // 没有 done/error 也没在流式：多半在等权限或运行时静默
    status = "waiting";
  } else {
    status = "streaming";
  }

  const usageIn = usage?.inputTokens ?? 0;
  const usageOut = usage?.outputTokens ?? 0;
  const summary =
    status === "done" || status === "failed" || status === "interrupted"
      ? `${status === "done" ? "完成" : status === "failed" ? "失败" : "已中断"} · ${short(usageIn)}/${short(usageOut)}`
      : "";

  return {
    turnId,
    botId,
    items,
    status,
    usage,
    done,
    error,
    startedAt: startedAt || lastEventAt || Date.now(),
    endedAt,
    lastEventAt: lastEventAt || startedAt || Date.now(),
    hasBlockingPermission: blockingTurnIds.has(turnId),
    summary,
  };
}

function unknown(ev: RawEvent, missing: string[]): UnknownEvent {
  return {
    kind: "unknown",
    seq: ev.seq,
    ts: ev.createdAt,
    typeName: ev.type,
    missing,
    raw: ev.raw ?? ev.payload,
  };
}

function short(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** meta 事件 → Session 分隔条文案（UX §2.3：只在变化时显形）。 */
export function dividerText(kind: MetaEventKind): string | null {
  switch (kind) {
    case "session_rebuilt":
      return "新 Session · 已重建上下文（人格 + 记忆 + 最近 20 条）";
    case "session_resumed":
      return "续接上一 Session · 人格 + 记忆 + 最近 20 条";
    case "compaction":
      return "上下文已压缩 · 更早的对话被摘要替代";
    default:
      // commands_update / config_update / unknown_protocol 不产生分隔条
      return null;
  }
}
