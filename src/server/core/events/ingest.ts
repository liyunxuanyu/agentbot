import type { DB } from "../db/db.js";
import { getDb } from "../db/db.js";
import { isRenderableType } from "../../../shared/events.js";
import type {
  CanonicalEvent,
  FileChangePayload,
  StoredEventType,
} from "../../../shared/events.js";
import * as eventsRepo from "../repo/events.js";
import * as messagesRepo from "../repo/messages.js";
import { eventBus, type EventBus } from "./bus.js";
import type { IngestContext, IngestResult, StoredPayload } from "./model.js";

/**
 * 事件入库的唯一入口。
 *
 * 顺序固定，不能调换：
 *   ① 能力掩码过滤：未声明的可渲染类型直接丢弃，**不落库**（P0-05：不出现空块）
 *   ② meta 特判：不受掩码约束，必须落库（重启后 Session 分隔条要能恢复）
 *   ③ 字段校验降级：缺字段不丢事件，填安全默认值 + 保留原始 JSON + 记 warning
 *   ④ 正文累积：`messages.content` 是正文唯一权威副本，事件只是增量通知
 *   ⑤ 落库 → 广播：先写库再推流，断线重连永远能补到
 *
 * `plan` 是全量替换：落库仍是独立事件行，但 payload 带 `replace:true` 让前端整块覆盖。
 */

export interface IngestDeps {
  db: DB;
  /** 不传则只落库不广播（单元测试、批量导入）。 */
  bus?: EventBus;
}

/**
 * 入口：`ingestEvent(ctx, event)`。
 *
 * 第三个参数可省略：省略时用进程级单例（`getDb()` + `eventBus`），
 * M4/M5 装配时直接 `ingestEvent(ctx, ev)` 即可；单元测试传内存库与独立总线。
 */
export function ingestEvent(
  ctx: IngestContext,
  event: CanonicalEvent,
  deps?: IngestDeps,
): IngestResult {
  const resolved: IngestDeps = deps ?? { db: getDb(), bus: eventBus };
  return ingestWith(resolved, ctx, event);
}

/** 绑定依赖的工厂，避免热路径上反复判空。 */
export function createIngest(deps: IngestDeps): (ctx: IngestContext, event: CanonicalEvent) => IngestResult {
  return (ctx, event) => ingestWith(deps, ctx, event);
}

function ingestWith(deps: IngestDeps, ctx: IngestContext, event: CanonicalEvent): IngestResult {
  const { db } = deps;
  const type = event.type as StoredEventType;

  // ① 掩码过滤（meta 永不过滤）
  if (isRenderableType(type) && !ctx.eventCapabilities.includes(type)) {
    return { dropped: true, reason: "not_declared" };
  }

  const warnings: string[] = [];

  // ②③ 字段校验与降级
  const normalized = normalizePayload(type, event.payload, event.raw);
  warnings.push(...normalized.warnings);

  // ④⑤ 正文累积 + 落库放在同一事务里：
  //     否则崩溃可能留下「正文追加了但事件没落库」或反之的半截状态（P0-15）。
  const messageId = resolveMessageId(ctx, type, normalized.payload);

  const row = db.transaction(() => {
    if (type === "message_delta") {
      applyMessageDelta(db, messageId, normalized.payload, warnings);
    }
    return eventsRepo.insert(db, {
      sessionId: ctx.sessionId,
      messageId,
      turnId: event.turnId,
      type,
      payload: normalized.payload,
      raw: normalized.raw,
      createdAt: event.ts,
    });
  })();

  for (const w of warnings) {
    console.warn(`[events] ${ctx.sessionId}/${event.turnId} ${type}: ${w}`);
  }

  // ⑥ 广播：事务提交之后才推，订阅者读到的库状态一定是已落库的
  if (deps.bus) {
    deps.bus.publish(ctx.sessionId, row);
  }

  return { dropped: false, row, degraded: normalized.degraded, warnings };
}

/**
 * 事件挂哪条消息：
 *   - `message_delta` 以 payload.messageId 为准（同一轮可能有多条助手消息）；
 *   - 其余类型挂在 ctx.messageId（当前轮的助手消息）下。
 */
function resolveMessageId(
  ctx: IngestContext,
  type: StoredEventType,
  payload: StoredPayload,
): string | null {
  if (type === "message_delta") {
    const id = (payload as { messageId?: unknown }).messageId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return ctx.messageId;
}

/**
 * 正文累积：
 *   start / delta → 追加到 messages.content（权威副本）
 *   end           → 追加残余文本（若有）并把 status 置 done
 *
 * 不用事件累积重建正文，也不在这里读事件表——重连时前端拿 content 整体覆盖。
 */
function applyMessageDelta(
  db: DB,
  messageId: string | null,
  payload: StoredPayload,
  warnings: string[],
): void {
  const p = payload as { phase: "start" | "delta" | "end"; text: string };

  if (!messageId) {
    warnings.push("message_delta 缺少 messageId，正文未写入（事件仍已落库）");
    return;
  }

  const message = messagesRepo.getById(db, messageId);
  if (!message) {
    // 消息行由编排层在建 Turn 时创建；这里找不到说明装配顺序有误，
    // 事件照常落库，正文留给前端以「未返回内容」降级展示。
    warnings.push(`message_delta 找不到消息 ${messageId}，正文未写入`);
    return;
  }

  if (p.phase === "start" || p.phase === "delta") {
    if (p.text.length > 0) {
      const appended = messagesRepo.appendContent(db, { id: messageId, delta: p.text });
      if (!appended.ok) {
        warnings.push(`正文版本冲突（当前 v${appended.currentVersion}），增量未写入`);
      }
    }
    return;
  }

  // phase === 'end'：收口
  if (p.text.length > 0) {
    const appended = messagesRepo.appendContent(db, { id: messageId, delta: p.text });
    if (!appended.ok) {
      warnings.push(`正文版本冲突（当前 v${appended.currentVersion}），收口增量未写入`);
    }
  }
  messagesRepo.finalize(db, { id: messageId, status: "done" });
}

// ---------------------------------------------------------------------------
// 字段校验：缺字段填安全默认值，绝不抛错、绝不丢事件
// ---------------------------------------------------------------------------

interface Normalized {
  payload: StoredPayload;
  raw: unknown;
  degraded: boolean;
  warnings: string[];
}

type Missing = string[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback: string, field: string, missing: Missing): string {
  if (typeof v === "string") return v;
  missing.push(field);
  return fallback;
}

function asNumber(v: unknown, fallback: number, field: string, missing: Missing): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  missing.push(field);
  return fallback;
}

function asBoolean(v: unknown, fallback: boolean, field: string, missing: Missing): boolean {
  if (typeof v === "boolean") return v;
  missing.push(field);
  return fallback;
}

function asEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  missing: Missing,
): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  missing.push(field);
  return fallback;
}

/**
 * 校验写类工具附带的 `fileChange`。
 *
 * 只认「有 path 且 before/after 是字符串」的形状：diff 是展示用的，
 * 形状不对就当没有（返回 null），而不是让整条 tool_result 降级成未知事件。
 */
function normalizeFileChange(
  v: unknown,
  missing: Missing,
): FileChangePayload | null {
  if (!isRecord(v)) return null;
  if (typeof v["path"] !== "string" || v["path"].length === 0) return null;
  const before = typeof v["before"] === "string" ? v["before"] : "";
  const after = typeof v["after"] === "string" ? v["after"] : "";
  return {
    path: v["path"],
    before,
    after,
    added: typeof v["added"] === "number" && Number.isFinite(v["added"]) ? v["added"] : 0,
    removed: typeof v["removed"] === "number" && Number.isFinite(v["removed"]) ? v["removed"] : 0,
    diff: typeof v["diff"] === "string" ? v["diff"] : "",
    ...(v["truncated"] === true ? { truncated: true } : {}),
  };
}

const PHASES = ["start", "delta", "end"] as const;

function normalizePayload(type: StoredEventType, payload: unknown, adapterRaw: unknown): Normalized {
  const missing: Missing = [];
  const p = isRecord(payload) ? payload : {};
  let out: StoredPayload;

  switch (type) {
    case "message_delta":
      out = {
        messageId: asString(p["messageId"], "", "messageId", missing),
        phase: asEnum(p["phase"], PHASES, "delta", "phase", missing),
        text: asString(p["text"], "", "text", missing),
      };
      break;

    case "thought":
      out = {
        phase: asEnum(p["phase"], PHASES, "delta", "phase", missing),
        text: asString(p["text"], "", "text", missing),
      };
      break;

    case "tool_call":
      out = {
        callId: asString(p["callId"], "", "callId", missing),
        name: asString(p["name"], "未知工具", "name", missing),
        kind: typeof p["kind"] === "string" ? p["kind"] : undefined,
        input: p["input"],
        status: asEnum(p["status"], ["pending", "running"] as const, "pending", "status", missing),
      };
      break;

    case "tool_result":
      out = {
        callId: asString(p["callId"], "", "callId", missing),
        status: asEnum(p["status"], ["ok", "error"] as const, "error", "status", missing),
        output: asString(p["output"], "", "output", missing),
        exitCode: typeof p["exitCode"] === "number" ? p["exitCode"] : undefined,
        truncated: typeof p["truncated"] === "boolean" ? p["truncated"] : undefined,
        // 写类工具附带的改动（diff 块的数据源）。缺字段的旧事件没有它，
        // 前端据此决定是否显示「查看 diff」；形状不对就当没有，绝不丢整条事件。
        ...(() => {
          const fc = normalizeFileChange(p["fileChange"], missing);
          return fc === null ? {} : { fileChange: fc };
        })(),
      };
      break;

    case "plan": {
      const rawEntries = p["entries"];
      if (!Array.isArray(rawEntries)) missing.push("entries");
      const entries = (Array.isArray(rawEntries) ? rawEntries : []).map((e) => {
        const rec = isRecord(e) ? e : {};
        return {
          content: asString(rec["content"], "", "entries[].content", missing),
          status: asEnum(
            rec["status"],
            ["pending", "in_progress", "done"] as const,
            "pending",
            "entries[].status",
            missing,
          ),
        };
      });
      // replace:true —— 前端据此整块替换，不做追加
      out = { entries, replace: true };
      break;
    }

    case "permission_request":
      out = {
        requestId: asString(p["requestId"], "", "requestId", missing),
        action: asEnum(
          p["action"],
          ["write", "read", "exec", "network", "admin"] as const,
          "read",
          "action",
          missing,
        ),
        target: asString(p["target"], "", "target", missing),
        boundaryVerdict: asEnum(
          p["boundaryVerdict"],
          ["allowed", "denied", "pending"] as const,
          "pending",
          "boundaryVerdict",
          missing,
        ),
      };
      break;

    case "usage":
      out = {
        inputTokens: asNumber(p["inputTokens"], 0, "inputTokens", missing),
        outputTokens: asNumber(p["outputTokens"], 0, "outputTokens", missing),
        // 缺上报标记时按「未上报」处理，UI 显示 — 而不是 0
        reported: asBoolean(p["reported"], false, "reported", missing),
        cumulative: typeof p["cumulative"] === "boolean" ? p["cumulative"] : undefined,
        // 缓存口径与模型：缺省不填（不伪造 0），前端显示「未上报」
        ...(typeof p["cachedInputTokens"] === "number"
          ? { cachedInputTokens: p["cachedInputTokens"] }
          : {}),
        ...(typeof p["cacheWriteTokens"] === "number"
          ? { cacheWriteTokens: p["cacheWriteTokens"] }
          : {}),
        ...(typeof p["model"] === "string" && p["model"].length > 0 ? { model: p["model"] } : {}),
      };
      break;

    case "done":
      out = {
        stopReason: asEnum(
          p["stopReason"],
          ["end", "cancelled", "max_tokens", "error"] as const,
          "end",
          "stopReason",
          missing,
        ),
        durationMs: asNumber(p["durationMs"], 0, "durationMs", missing),
      };
      break;

    case "error":
      out = {
        code: asString(p["code"], "unknown_error", "code", missing),
        message: asString(p["message"], "运行时返回了无法解析的错误", "message", missing),
        detail: typeof p["detail"] === "string" ? p["detail"] : undefined,
        fatal: asBoolean(p["fatal"], true, "fatal", missing),
      };
      break;

    case "meta":
      out = {
        kind: asEnum(
          p["kind"],
          [
            "compaction",
            "session_rebuilt",
            "session_resumed",
            "commands_update",
            "config_update",
            "unknown_protocol",
          ] as const,
          "unknown_protocol",
          "kind",
          missing,
        ),
        data: p["data"],
      };
      break;
  }

  // degraded 只描述「字段校验降级」；raw 另算——通道主动附带原始数据（如 CLI 的
  // 原始 stdout）也会填 raw，但那不代表 payload 缺字段。
  const degraded = missing.length > 0;

  // 原始 JSON：通道主动给了就用它（已声明但解析失败），否则降级时存收到的原始 payload
  let raw: unknown = null;
  if (adapterRaw !== undefined) raw = adapterRaw;
  else if (missing.length > 0) raw = payload ?? null;

  const warnings = missing.length > 0 ? [`字段缺失已降级（${missing.join(", ")}）`] : [];

  return { payload: out, raw, degraded, warnings };
}
