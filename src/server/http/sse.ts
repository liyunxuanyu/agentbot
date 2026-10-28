import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "../core/db/db.js";
import { config } from "../config.js";
import type { EventBus } from "../core/events/bus.js";
import type { EventRow } from "../core/events/model.js";
import * as eventsRepo from "../core/repo/events.js";

/**
 * SSE 推送（架构 §7）。
 *
 * 为什么是 SSE 而不是 WebSocket：事件严格单向（服务端→客户端），`EventSource`
 * 原生带 `Last-Event-ID` 重连，直接兑现 P0-04「从最后一条已落库事件继续」。
 *
 * 帧格式：`id: <events.id>\nevent: <type>\ndata: <json>\n\n`
 *   - `id` 用全局 AUTOINCREMENT 的 events.id，跨会话单调，重连无歧义；
 *   - `meta` 也推（前端靠它生成 Session 分隔条），只是不进渲染流；
 *   - 心跳是注释行 `: ping`，15s 一次。
 *
 * 鉴权：本文件不自己校验 token。路由必须注册在 `http/server.ts` 的鉴权钩子
 * 覆盖的范围内（`registerRoutes` 内部），钩子失败会先 401 并结束响应，
 * handler 根本不会执行，因此 SSE 不会建立。这是 P0-14 的落点。
 */

export interface SseDeps {
  db: DB;
  bus: EventBus;
  /**
   * 帧写出前的 payload 补全（M4：补 `botId`）。
   *
   * 为什么不在 ingest 补：M2 的 ingest 会把 payload 规整成「已知字段」，
   * 未声明的键会被丢掉（frozen）。而前端需要 `payload.botId` 才能在群聊里
   * 区分「主持人 ≠ 发言人」。所以在这一层补：帧与事件行语义一致，
   * 只是多带一个归属信息，不改库、不改核心事件模型。
   */
  enrichPayload?: (row: EventRow) => unknown;
  /** 心跳间隔，默认取 config.sse.heartbeatMs（15s）。 */
  heartbeatMs?: number;
  /** 单次重放上限，防止异常游标把整库倒出来。 */
  replayLimit?: number;
  /** 待写字节超过此值视为慢客户端，断开让其重连（重连会续推）。 */
  maxBufferedBytes?: number;
}

/** 推给前端的单条事件：EventRow 全量 + 便于前端直接用的字段。 */
export interface SseFrame {
  id: number;
  sessionId: string;
  messageId: string | null;
  turnId: string;
  type: string;
  seq: number;
  payload: unknown;
  raw: unknown | null;
  createdAt: number;
}

interface ActiveStream {
  sessionId: string;
  /** 所属实例：shutdown 时只关自己那份，测试多实例互不干扰。 */
  owner: FastifyInstance;
  close(reason: string): void;
}

/** 所有活跃连接：token 重置时要一次性断开（P0-14「10s 内断开所有已连接客户端」）。 */
const activeStreams = new Set<ActiveStream>();

/**
 * 断开连接。不传 `owner` 断开全部（token 重置）；传了只断开该实例（服务关闭）。
 * 返回被断开的连接数，供调用方记日志。
 */
export function closeAllStreams(reason = "token_reset", owner?: FastifyInstance): number {
  const targets = [...activeStreams].filter((s) => owner === undefined || s.owner === owner);
  for (const s of targets) {
    try {
      s.close(reason);
    } catch {
      // 单个连接关闭失败不影响其余
    }
    activeStreams.delete(s);
  }
  return targets.length;
}

export function activeStreamCount(): number {
  return activeStreams.size;
}

/**
 * 序列化一帧。
 *
 * `payloadOverride` 用于 M4 的 `botId` 补全：ingest 会把 payload 规整成已知字段
 * （未声明的键会被丢掉），而前端需要 `payload.botId` 在群聊里区分发言人。
 * 只在出帧时补，不改库、不改事件模型。
 */
export function formatFrame(row: EventRow, payloadOverride?: unknown): string {
  const frame: SseFrame = {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    turnId: row.turnId,
    type: row.type,
    seq: row.seq,
    payload: payloadOverride === undefined ? row.payload : payloadOverride,
    raw: row.raw,
    createdAt: row.createdAt,
  };
  return `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

interface StreamQuery {
  sessionId?: string;
  /**
   * 首连游标（可选）：REST 拉完历史到建立连接之间的空隙，用它补上。
   * 重连时 `EventSource` 会自动带 `Last-Event-ID`，优先于它。
   */
  lastEventId?: string;
}

function parseCursor(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 注册 `GET /api/stream?sessionId=<id>`。
 *
 * M1 在 `http/routes/index.ts` 的 `registerRoutes` 里调用一次即可继承鉴权钩子：
 *   registerSseRoutes(app, { db: ctx.db, bus: eventBus });
 */
export function registerSseRoutes(app: FastifyInstance, deps: SseDeps): void {
  const heartbeatMs = deps.heartbeatMs ?? config.sse.heartbeatMs;
  const replayLimit = deps.replayLimit ?? 5000;
  const maxBufferedBytes = deps.maxBufferedBytes ?? 1_000_000;

  app.get("/api/stream", (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as StreamQuery;
    const sessionId = query.sessionId;

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      reply.code(400).header("content-type", "application/json; charset=utf-8").send({
        error: "session_id_required",
      });
      return;
    }

    // 会话不存在就不必建立长连接；前端拿到 404 会走错误态
    const exists = deps.db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(sessionId);
    if (!exists) {
      reply.code(404).header("content-type", "application/json; charset=utf-8").send({
        error: "session_not_found",
      });
      return;
    }

    const headerCursor = parseCursor(req.headers["last-event-id"]);
    const queryCursor = parseCursor(query.lastEventId);
    const cursor = headerCursor ?? queryCursor ?? null;

    openStream(app, req, reply, sessionId, cursor, {
      bus: deps.bus,
      db: deps.db,
      heartbeatMs,
      replayLimit,
      maxBufferedBytes,
      ...(deps.enrichPayload === undefined ? {} : { enrichPayload: deps.enrichPayload }),
    });
  });

  // 服务关闭时先断开自己名下的长连接，否则 app.close() 会一直等 socket
  app.addHook("onClose", (_instance, done) => {
    closeAllStreams("server_close", app);
    done();
  });
}

interface OpenOptions {
  db: DB;
  bus: EventBus;
  heartbeatMs: number;
  replayLimit: number;
  maxBufferedBytes: number;
  enrichPayload?: (row: EventRow) => unknown;
}

function openStream(
  owner: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  cursor: number | null,
  opts: OpenOptions,
): void {
  // 接管响应：之后由我们自己写 socket，Fastify 不再插手
  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // 反向代理场景下禁止缓冲，否则流式会变成一次性吐
    "x-accel-buffering": "no",
  });
  raw.flushHeaders?.();
  // 立刻写一帧注释：反向代理（cloudflared / nginx）在收到首块响应体之前
  // 不会把响应头交给客户端，EventSource 的 `open` 就会一直等 —— 实测手机通过
  // cloudflared 隧道时，没有这一行要等 15s（第一次心跳）才连上，期间界面停在
  // 「正在连接运行时…」、权限卡也不出现。注释帧不是事件，不影响 Last-Event-ID。
  raw.write(": connected\n\n");

  let lastSentId = cursor ?? 0;
  /** 重放期间到达的实时事件先攒着，重放完再按 id 顺序补发，避免乱序。 */
  const pending: EventRow[] = [];
  let replaying = cursor !== null;
  let closed = false;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream: ActiveStream = {
    sessionId,
    owner,
    close(reason: string) {
      if (closed) return;
      writeComment(`关闭推送：${reason}`);
      cleanup();
      try {
        raw.end();
      } catch {
        // socket 可能已断开
      }
    },
  };

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
    activeStreams.delete(stream);
  }

  function write(chunk: string): void {
    if (closed) return;
    // 慢客户端：缓冲堆积过多就断开，重连后按 Last-Event-ID 续推，不会丢
    if (raw.writableLength > opts.maxBufferedBytes) {
      cleanup();
      raw.destroy();
      return;
    }
    raw.write(chunk);
  }

  function writeComment(text: string): void {
    write(`: ${text}\n\n`);
  }

  function send(row: EventRow): void {
    // 去重：重放与实时推送可能重叠，按 id 单调推进
    if (row.id <= lastSentId) return;
    lastSentId = row.id;
    write(formatFrame(row, opts.enrichPayload?.(row)));
  }

  // 先订阅再重放：订阅与重放之间到达的事件进 pending，不会漏
  unsubscribe = opts.bus.subscribe(sessionId, (row) => {
    if (replaying) {
      pending.push(row);
      return;
    }
    send(row);
  });

  heartbeat = setInterval(() => writeComment("ping"), opts.heartbeatMs);
  heartbeat.unref?.();

  activeStreams.add(stream);

  const onClose = (): void => cleanup();
  req.raw.on("close", onClose);
  req.raw.on("error", onClose);
  raw.on("error", onClose);

  // ---- 重放 ----
  if (cursor !== null) {
    const truncated = replay(sessionId, cursor, opts, send);
    if (truncated) {
      // 不带 id 行：不能污染 Last-Event-ID。客户端收到后应走 REST 补齐缺口。
      write(
        `event: replay_truncated\ndata: ${JSON.stringify({
          lastEventId: lastSentId,
          hint: "回放超过上限，请用 REST 拉取历史事件补齐",
        })}\n\n`,
      );
    }
    replaying = false;
    for (const row of pending) send(row);
    pending.length = 0;
  }
}

/** 返回 true 表示因上限被截断，客户端需要走 REST 补齐。 */
function replay(
  sessionId: string,
  cursor: number,
  opts: OpenOptions,
  send: (row: EventRow) => void,
): boolean {
  // ① 先查内存环形缓冲（覆盖绝大多数短断线），命中即不用碰库
  const cached = opts.bus.recent(sessionId, cursor);
  if (cached !== null && cached.length <= opts.replayLimit) {
    for (const row of cached) send(row);
    return false;
  }

  // ② 未命中回退数据库，按全局 id 游标分批读，避免一次拉爆内存
  let after = cursor;
  let sent = 0;
  while (sent < opts.replayLimit) {
    const batch = Math.min(200, opts.replayLimit - sent);
    const rows = eventsRepo.listAfterId(opts.db, sessionId, after, batch);
    if (rows.length === 0) return false;
    for (const row of rows) {
      send(row);
      after = row.id;
      sent += 1;
    }
    if (rows.length < batch) return false;
  }

  // 刚好用满上限：可能还有剩余，需要客户端补齐
  return eventsRepo.listAfterId(opts.db, sessionId, after, 1).length > 0;
}
