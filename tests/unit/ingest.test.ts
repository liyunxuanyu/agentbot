import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import { isRenderableType } from "../../src/shared/events.js";
import type {
  CanonicalEvent,
  EventType,
  PayloadByType,
  StoredEventType,
} from "../../src/shared/events.js";
import { createIngest } from "../../src/server/core/events/ingest.js";
import type { IngestContext, IngestResult } from "../../src/server/core/events/model.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import * as eventsRepo from "../../src/server/core/repo/events.js";
import * as messagesRepo from "../../src/server/core/repo/messages.js";

/**
 * ingest 单元测试（P0-05 / P0-15 的核心不变量）。
 *
 * 用真实 SQLite 内存库，不 mock repo —— 这些断言要能挡住「改了 SQL 才坏」的问题。
 */

interface Fixture {
  db: DB;
  sessionId: string;
  channelId: string;
  messageId: string;
  turnId: string;
  ctx: IngestContext;
  ingest: (ctx: IngestContext, event: CanonicalEvent) => IngestResult;
  close: () => void;
}

const ALL_CAPABILITIES: EventType[] = [
  "message_delta",
  "thought",
  "tool_call",
  "tool_result",
  "plan",
  "permission_request",
  "usage",
  "done",
  "error",
];

function seedSession(db: DB, id: string): { sessionId: string; channelId: string } {
  const now = Date.now();
  const channelId = `chan_${id}`;
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', ?, '[]', NULL, ?)`,
  ).run(channelId, `频道 ${id}`, now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, created_at, updated_at)
     VALUES (?, ?, '', ?, ?)`,
  ).run(`bot_${id}`, `Bot ${id}`, now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
     VALUES (?, ?, ?, 'ready', ?)`,
  ).run(id, `bot_${id}`, channelId, now);
  return { sessionId: id, channelId };
}

function setup(capabilities: EventType[] = ALL_CAPABILITIES): Fixture {
  const db = openDb(":memory:");
  const sessionId = "sess_1";
  const { channelId } = seedSession(db, sessionId);
  const turnId = "turn_1";
  const messageId = "msg_assistant_1";

  messagesRepo.create(db, {
    id: messageId,
    sessionId,
    channelId,
    turnId,
    role: "assistant",
    status: "streaming",
  });

  const bus = createEventBus({ ringSize: 10 });
  const ingest = createIngest({ db, bus });

  return {
    db,
    sessionId,
    channelId,
    messageId,
    turnId,
    ctx: { sessionId, messageId, turnId, eventCapabilities: capabilities },
    ingest,
    close: () => db.close(),
  };
}

function event<T extends StoredEventType>(
  type: T,
  payload: PayloadByType[T],
  turnId = "turn_1",
): CanonicalEvent {
  return { type, turnId, ts: Date.now(), payload } as CanonicalEvent;
}

function countEvents(db: DB, sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
    .get(sessionId) as { n: number };
  return row.n;
}

let fx: Fixture;

beforeEach(() => {
  fx = setup();
});

afterEach(() => {
  fx.close();
  vi.restoreAllMocks();
});

describe("ingest · 能力掩码", () => {
  it("未声明类型被丢弃，且不落库", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx: IngestContext = { ...fx.ctx, eventCapabilities: ["message_delta", "done", "error"] };

    const result = fx.ingest(
      ctx,
      event("tool_call", { callId: "c1", name: "bash", status: "running" }),
    );

    expect(result.dropped).toBe(true);
    if (result.dropped) expect(result.reason).toBe("not_declared");
    expect(countEvents(fx.db, fx.sessionId)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("已声明类型正常落库，且按上报顺序分配 seq", () => {
    fx.ingest(fx.ctx, event("thought", { phase: "start", text: "先看目录" }));
    fx.ingest(fx.ctx, event("tool_call", { callId: "c1", name: "ls", status: "running" }));

    const rows = eventsRepo.listBySession(fx.db, fx.sessionId);
    expect(rows.map((r) => r.type)).toEqual(["thought", "tool_call"]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe("ingest · meta 特判", () => {
  it("meta 落库但不可渲染，且不受掩码限制", () => {
    // 掩码里一个事件类型都没有，meta 仍必须落库（否则重启后分隔条丢失）
    const ctx: IngestContext = { ...fx.ctx, eventCapabilities: [] };

    const result = fx.ingest(
      ctx,
      event("meta", { kind: "compaction", data: { before: 120, after: 40 } }),
    );

    expect(result.dropped).toBe(false);
    if (!result.dropped) {
      expect(result.row.type).toBe("meta");
      expect(isRenderableType(result.row.type)).toBe(false);
      expect(result.row.payload).toEqual({
        kind: "compaction",
        data: { before: 120, after: 40 },
      });
    }
    expect(countEvents(fx.db, fx.sessionId)).toBe(1);
  });

  it("meta 与其他事件共用同一会话 seq 序列", () => {
    fx.ingest(fx.ctx, event("meta", { kind: "session_rebuilt", data: { messages: 20 } }));
    fx.ingest(fx.ctx, event("message_delta", { messageId: fx.messageId, phase: "start", text: "好" }));

    const rows = eventsRepo.listBySession(fx.db, fx.sessionId);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe("ingest · 正文累积", () => {
  it("message_delta 三段累积后 messages.content 正确且状态为 done", () => {
    fx.ingest(
      fx.ctx,
      event("message_delta", { messageId: fx.messageId, phase: "start", text: "我来" }),
    );
    fx.ingest(
      fx.ctx,
      event("message_delta", { messageId: fx.messageId, phase: "delta", text: "看看" }),
    );
    fx.ingest(
      fx.ctx,
      event("message_delta", { messageId: fx.messageId, phase: "delta", text: "目录结构。" }),
    );
    fx.ingest(
      fx.ctx,
      event("message_delta", { messageId: fx.messageId, phase: "end", text: "" }),
    );

    const msg = messagesRepo.getById(fx.db, fx.messageId);
    expect(msg?.content).toBe("我来看看目录结构。");
    expect(msg?.status).toBe("done");
    // 三条增量各自落库，正文只以 messages.content 为准
    expect(msg?.contentVersion).toBe(3);
  });

  it("end 阶段携带的残余文本也会并入正文", () => {
    fx.ingest(
      fx.ctx,
      event("message_delta", { messageId: fx.messageId, phase: "delta", text: "前半" }),
    );
    fx.ingest(
      fx.ctx,
      event("message_delta", { messageId: fx.messageId, phase: "end", text: "后半" }),
    );

    const msg = messagesRepo.getById(fx.db, fx.messageId);
    expect(msg?.content).toBe("前半后半");
    expect(msg?.status).toBe("done");
  });

  it("消息行不存在时不丢事件，只记 warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx: IngestContext = { ...fx.ctx, messageId: null };

    const result = fx.ingest(
      ctx,
      event("message_delta", { messageId: "", phase: "delta", text: "孤儿文本" }),
    );

    expect(result.dropped).toBe(false);
    expect(countEvents(fx.db, fx.sessionId)).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("ingest · 字段校验降级", () => {
  it("payload 缺必填字段：不丢事件，raw 保留原始 JSON，payload 用安全默认值", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { status: "running" } as unknown as CanonicalEvent<"tool_call">["payload"];

    const result = fx.ingest(fx.ctx, {
      type: "tool_call",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: broken,
    });

    expect(result.dropped).toBe(false);
    if (result.dropped) return;

    expect(result.degraded).toBe(true);
    expect(result.row.raw).toEqual({ status: "running" });
    expect(result.row.payload).toMatchObject({
      callId: "",
      name: "未知工具",
      status: "running",
    });
    expect(result.warnings.join()).toContain("callId");
    expect(warn).toHaveBeenCalled();
    expect(countEvents(fx.db, fx.sessionId)).toBe(1);
  });

  it("通道显式提供的 raw 原样往返（字符串不被当成 JSON 再解析）", () => {
    const raw = '{"weird":true}';
    const result = fx.ingest(fx.ctx, {
      type: "tool_result",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: { callId: "c1", status: "ok", output: "ok" },
      raw,
    });

    if (result.dropped) throw new Error("不应被丢弃");
    expect(result.row.raw).toBe(raw);
  });

  it("通道提供的非 JSON raw 也原样保留，不因解析失败丢数据", () => {
    const result = fx.ingest(fx.ctx, {
      type: "error",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: { code: "parse_failed", message: "输出不是 JSON", fatal: false },
      raw: "line 12: unexpected token <",
    });

    if (result.dropped) throw new Error("不应被丢弃");
    expect(result.row.raw).toBe("line 12: unexpected token <");
  });

  it("usage 缺 reported 时按未上报处理（UI 显示 — 而非 0）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = fx.ingest(fx.ctx, {
      type: "usage",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: { inputTokens: 1200, outputTokens: 340 } as unknown as CanonicalEvent<"usage">["payload"],
    });

    if (result.dropped) throw new Error("不应被丢弃");
    expect(result.row.payload).toMatchObject({ reported: false, inputTokens: 1200 });
    expect(warn).toHaveBeenCalled();
  });
});

describe("ingest · plan 全量替换", () => {
  it("plan 落库带 replace:true，连续两次是整块覆盖而非追加", () => {
    const first = fx.ingest(fx.ctx, {
      type: "plan",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: {
        entries: [
          { content: "读代码", status: "in_progress" },
          { content: "改代码", status: "pending" },
        ],
      },
    });
    const second = fx.ingest(fx.ctx, {
      type: "plan",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: { entries: [{ content: "读代码", status: "done" }] },
    });

    if (first.dropped || second.dropped) throw new Error("plan 不应被丢弃");

    expect(first.row.payload).toMatchObject({ replace: true });
    expect((second.row.payload as { entries: unknown[] }).entries).toHaveLength(1);

    // 两行都在库里（事件不可变），前端取最后一行整块替换
    const rows = eventsRepo.listBySession(fx.db, fx.sessionId);
    expect(rows.map((r) => r.type)).toEqual(["plan", "plan"]);
    expect(rows[1]?.payload).toEqual({ entries: [{ content: "读代码", status: "done" }], replace: true });
  });

  it("plan 的 entries 缺失时降级为空列表而不是抛错", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = fx.ingest(fx.ctx, {
      type: "plan",
      turnId: fx.turnId,
      ts: Date.now(),
      payload: {} as unknown as CanonicalEvent<"plan">["payload"],
    });

    if (result.dropped) throw new Error("不应被丢弃");
    expect(result.row.payload).toEqual({ entries: [], replace: true });
    expect(result.degraded).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("ingest · seq 语义", () => {
  it("会话内单调递增，跨会话独立", () => {
    const other = seedSession(fx.db, "sess_2");

    fx.ingest(fx.ctx, event("thought", { phase: "delta", text: "a" }));
    fx.ingest(fx.ctx, event("thought", { phase: "delta", text: "b" }));
    fx.ingest(
      { ...fx.ctx, sessionId: other.sessionId, messageId: null, eventCapabilities: ALL_CAPABILITIES },
      event("thought", { phase: "delta", text: "c" }, "turn_other"),
    );
    fx.ingest(fx.ctx, event("thought", { phase: "delta", text: "d" }));

    const first = eventsRepo.listBySession(fx.db, fx.sessionId);
    const second = eventsRepo.listBySession(fx.db, other.sessionId);

    expect(first.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(second.map((r) => r.seq)).toEqual([1]);
    // id 是全局游标，跨会话单调
    const allIds = [...first, ...second].map((r) => r.id).sort((a, b) => a - b);
    expect(allIds).toEqual([...new Set(allIds)]);
  });

  it("会话不存在时抛错，不产生孤儿事件", () => {
    expect(() =>
      fx.ingest(
        { ...fx.ctx, sessionId: "sess_missing", messageId: null },
        event("thought", { phase: "delta", text: "x" }),
      ),
    ).toThrow(/会话不存在/);
  });
});

describe("ingest · 广播", () => {
  it("落库后按会话广播，其他会话收不到", () => {
    const bus = createEventBus({ ringSize: 10 });
    const ingest = createIngest({ db: fx.db, bus });
    const seen: number[] = [];
    const otherSeen: number[] = [];
    const off = bus.subscribe(fx.sessionId, (row) => seen.push(row.id));
    bus.subscribe("sess_other", (row) => otherSeen.push(row.id));

    ingest(fx.ctx, event("thought", { phase: "delta", text: "hello" }));
    off();

    expect(seen).toHaveLength(1);
    expect(otherSeen).toHaveLength(0);
    // 退订后不再收到
    ingest(fx.ctx, event("thought", { phase: "delta", text: "again" }));
    expect(seen).toHaveLength(1);
  });

  it("单个订阅者抛错不影响其他订阅者与落库", () => {
    const bus = createEventBus({ ringSize: 10 });
    const ingest = createIngest({ db: fx.db, bus });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const survived: number[] = [];

    bus.subscribe(fx.sessionId, () => {
      throw new Error("订阅者炸了");
    });
    bus.subscribe(fx.sessionId, (row) => survived.push(row.id));

    const result = ingest(fx.ctx, event("thought", { phase: "delta", text: "hi" }));

    expect(result.dropped).toBe(false);
    expect(countEvents(fx.db, fx.sessionId)).toBe(1);
    expect(survived).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});
