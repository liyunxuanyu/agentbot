import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import { createEventBus, type EventBus } from "../../src/server/core/events/bus.js";
import { createIngest } from "../../src/server/core/events/ingest.js";
import type { IngestContext } from "../../src/server/core/events/model.js";
import * as messagesRepo from "../../src/server/core/repo/messages.js";
import {
  activeStreamCount,
  closeAllStreams,
  formatFrame,
  registerSseRoutes,
} from "../../src/server/http/sse.js";
import type { CanonicalEvent, EventType } from "../../src/shared/events.js";
import { listenEphemeral } from "./http-listen.js";

/**
 * SSE 行为测试（P0-04 断线重连 / P0-14 握手鉴权）。
 *
 * 起真实 Fastify 实例打真 socket：SSE 的问题几乎都出在握手与断开时序上，
 * 用 mock 的 reply 测不出来。
 */

const CAPS: EventType[] = ["message_delta", "done", "error"];

interface Ctx {
  db: DB;
  bus: EventBus;
  app: FastifyInstance;
  base: string;
  sessionId: string;
  ingest: (ctx: IngestContext, e: CanonicalEvent) => unknown;
  pushDelta: (text: string, phase?: "start" | "delta" | "end") => void;
  close: () => Promise<void>;
}

async function boot(opts: { auth?: boolean } = {}): Promise<Ctx> {
  const db = openDb(":memory:");
  const now = Date.now();
  const sessionId = "sess_sse";
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES ('ch_sse', 'dm', '私聊', '[]', NULL, ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, created_at, updated_at) VALUES ('bot_sse', '小助', '', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
     VALUES (?, 'bot_sse', 'ch_sse', 'ready', ?)`,
  ).run(sessionId, now);
  messagesRepo.create(db, {
    id: "msg_sse",
    sessionId,
    channelId: "ch_sse",
    turnId: "turn_sse",
    role: "assistant",
    status: "streaming",
  });

  const bus = createEventBus({ ringSize: 5 });
  const ingest = createIngest({ db, bus });
  const ctx: IngestContext = { sessionId, messageId: "msg_sse", turnId: "turn_sse", eventCapabilities: CAPS };

  const pushDelta = (text: string, phase: "start" | "delta" | "end" = "delta"): void => {
    ingest(ctx, {
      type: "message_delta",
      turnId: "turn_sse",
      ts: Date.now(),
      payload: { messageId: "msg_sse", phase, text },
    } as CanonicalEvent);
  };

  const app = Fastify({ logger: false });
  if (opts.auth !== false) {
    // 模拟 M1 的鉴权钩子：失败即 401，handler 不会执行
    app.addHook("onRequest", (req, reply, done) => {
      const q = req.query as Record<string, unknown>;
      if (q["t"] !== "good") {
        reply.code(401).header("content-type", "application/json").send({ error: "unauthorized" });
        return done();
      }
      done();
    });
  }
  registerSseRoutes(app, { db, bus, heartbeatMs: 120, replayLimit: 100 });
  const base = await listenEphemeral(app);

  return {
    db,
    bus,
    app,
    base,
    sessionId,
    ingest,
    pushDelta,
    close: async () => {
      closeAllStreams("test_teardown");
      // undici 的 abort 不保证立刻销毁底层 socket，关服务前先强制断连，
      // 否则 app.close() 要等 keep-alive 超时（纯测试耗时，不是产品问题）
      app.server.closeAllConnections?.();
      await app.close();
      db.close();
    },  };
}

interface Collected {
  status: number;
  body: string;
  contentType: string | null;
}

/** 读一小段流后主动断开，模拟浏览器离开。 */
function readStream(url: string, headers: Record<string, string>, ms: number): Promise<Collected> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    fetch(url, { headers, signal: controller.signal })
      .then(async (res) => {
        const contentType = res.headers.get("content-type");
        if (res.status !== 200) {
          clearTimeout(timer);
          resolve({ status: res.status, body: await res.text(), contentType });
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          clearTimeout(timer);
          resolve({ status: res.status, body: "", contentType });
          return;
        }
        const decoder = new TextDecoder();
        let body = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            body += decoder.decode(value);
          }
        } catch {
          // 被 abort 或服务端断开
        }
        clearTimeout(timer);
        resolve({ status: res.status, body, contentType });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ status: -1, body: "", contentType: null });
      });
  });
}

function frameIds(body: string): number[] {
  return [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number.parseInt(m[1] ?? "0", 10));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let ctx: Ctx;

beforeEach(async () => {
  ctx = await boot();
});

afterEach(async () => {
  await ctx.close();
});

describe("SSE · 握手与鉴权", () => {
  it("无 token 返回 401，且不建立事件流", async () => {
    const res = await readStream(`${ctx.base}/api/stream?sessionId=${ctx.sessionId}`, {}, 400);
    expect(res.status).toBe(401);
    expect(res.body).toBe('{"error":"unauthorized"}');
    expect(res.contentType).toContain("application/json");
  });

  it("缺 sessionId 返回 400，未知会话返回 404", async () => {
    const missing = await readStream(`${ctx.base}/api/stream?t=good`, {}, 400);
    expect(missing.status).toBe(400);

    const unknown = await readStream(`${ctx.base}/api/stream?t=good&sessionId=nope`, {}, 400);
    expect(unknown.status).toBe(404);
  });

  it("鉴权通过后返回 text/event-stream", async () => {
    const res = await readStream(`${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`, {}, 300);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/event-stream");
  });
});

describe("SSE · 推送与重连", () => {
  it("实时事件按 id 推送，帧格式含 id/event/data", async () => {
    const pending = readStream(`${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`, {}, 700);
    await wait(150);
    ctx.pushDelta("你好");

    const res = await pending;
    expect(frameIds(res.body)).toEqual([1]);
    expect(res.body).toContain("event: message_delta");
    expect(res.body).toContain('"text":"你好"');
    expect(res.body).toMatch(/^data: \{.*"sessionId":"sess_sse".*\}$/m);
  });

  it("meta 事件也推送（前端靠它生成 Session 分隔条）", async () => {
    const pending = readStream(`${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`, {}, 700);
    await wait(150);
    ctx.ingest(
      { sessionId: ctx.sessionId, messageId: null, turnId: "turn_sse", eventCapabilities: CAPS },
      {
        type: "meta",
        turnId: "turn_sse",
        ts: Date.now(),
        payload: { kind: "compaction", data: { dropped: 12 } },
      } as CanonicalEvent,
    );

    const res = await pending;
    expect(res.body).toContain("event: meta");
    expect(res.body).toContain('"kind":"compaction"');
  });

  it("Last-Event-ID 续推：不重放已收到的，也不漏掉之后的", async () => {
    ctx.pushDelta("一");
    ctx.pushDelta("二");
    ctx.pushDelta("三");

    // 客户端说「我收到 2 了」，只应拿到 3
    const res = await readStream(
      `${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`,
      { "last-event-id": "2" },
      500,
    );
    expect(frameIds(res.body)).toEqual([3]);
  });

  it("从 0 重连时完整重放，顺序与 seq 一致", async () => {
    ctx.pushDelta("一", "start");
    ctx.pushDelta("二");
    ctx.pushDelta("", "end");

    const res = await readStream(
      `${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`,
      { "last-event-id": "0" },
      500,
    );
    expect(frameIds(res.body)).toEqual([1, 2, 3]);
    expect(res.body.indexOf('"text":"一"')).toBeLessThan(res.body.indexOf('"text":"二"'));
  });

  it("游标已是最新时不重放任何事件", async () => {
    ctx.pushDelta("一");
    const res = await readStream(
      `${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`,
      { "last-event-id": "1" },
      400,
    );
    expect(frameIds(res.body)).toEqual([]);
  });

  it("心跳以注释行发出，不占用 id", async () => {
    const res = await readStream(`${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`, {}, 500);
    expect(res.body).toContain(": ping");
    expect(frameIds(res.body)).toEqual([]);
  });
});

describe("SSE · 连接生命周期", () => {
  it("客户端断开后自动退订，不留内存", async () => {
    await readStream(`${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`, {}, 300);
    await wait(250);
    expect(activeStreamCount()).toBe(0);
    expect(ctx.bus.subscriberCount(ctx.sessionId)).toBe(0);
  });

  it("closeAllStreams 断开所有连接并通知客户端（token 重置场景）", async () => {
    const pending = readStream(`${ctx.base}/api/stream?t=good&sessionId=${ctx.sessionId}`, {}, 2000);
    await wait(200);
    expect(activeStreamCount()).toBe(1);

    closeAllStreams("token_reset");
    const res = await pending;

    expect(res.body).toContain("token_reset");
    expect(activeStreamCount()).toBe(0);
    expect(ctx.bus.subscriberCount(ctx.sessionId)).toBe(0);
  });
});

describe("SSE · 帧序列化", () => {
  it("formatFrame 输出标准三行 + 空行", () => {
    const frame = formatFrame({
      id: 42,
      sessionId: "s1",
      messageId: "m1",
      turnId: "t1",
      type: "done",
      seq: 7,
      payload: { stopReason: "end", durationMs: 1200 },
      raw: null,
      createdAt: 1700000000000,
    });
    expect(frame.startsWith("id: 42\nevent: done\ndata: {")).toBe(true);
    expect(frame.endsWith("}\n\n")).toBe(true);
  });
});
