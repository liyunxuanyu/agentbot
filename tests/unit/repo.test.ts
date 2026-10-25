import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import * as messagesRepo from "../../src/server/core/repo/messages.js";
import * as eventsRepo from "../../src/server/core/repo/events.js";

/**
 * 仓储层测试：这些 SQL 是 P0-15「重启后会话完整恢复」的地基，
 * 用真实内存 SQLite 跑，不 mock。
 */

let db: DB;
const now = Date.now();

beforeEach(() => {
  db = openDb(":memory:");
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES ('ch1', 'dm', '私聊', '[]', NULL, ?)`,
  ).run(now);
  db.prepare(`INSERT INTO bots (id, name, persona, created_at, updated_at) VALUES ('b1', '小助', '', ?, ?)`).run(
    now,
    now,
  );
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, status, started_at) VALUES ('s1', 'b1', 'ch1', 'ready', ?)`,
  ).run(now);
});

afterEach(() => {
  db.close();
});

describe("messages repo", () => {
  it("create 默认空正文、streaming、版本 0", () => {
    const row = messagesRepo.create(db, {
      id: "m1",
      sessionId: "s1",
      channelId: "ch1",
      turnId: "t1",
      role: "assistant",
    });
    expect(row).toMatchObject({ content: "", contentVersion: 0, status: "streaming" });
  });

  it("appendContent 按版本号乐观并发：版本不符时拒绝写入", () => {
    messagesRepo.create(db, { id: "m1", sessionId: "s1", channelId: "ch1", turnId: "t1", role: "assistant" });

    const first = messagesRepo.appendContent(db, { id: "m1", delta: "第一段", expectedVersion: 0 });
    expect(first).toMatchObject({ ok: true, contentVersion: 1, content: "第一段" });

    // 用过期版本号再写：应被拒绝，正文保持不变
    const stale = messagesRepo.appendContent(db, { id: "m1", delta: "并发写", expectedVersion: 0 });
    expect(stale).toEqual({ ok: false, currentVersion: 1 });
    expect(messagesRepo.getById(db, "m1")?.content).toBe("第一段");

    // 用正确版本继续
    const second = messagesRepo.appendContent(db, { id: "m1", delta: "第二段", expectedVersion: 1 });
    expect(second).toMatchObject({ ok: true, contentVersion: 2, content: "第一段第二段" });
  });

  it("finalize 只改状态与用量，不动正文", () => {
    messagesRepo.create(db, { id: "m1", sessionId: "s1", channelId: "ch1", turnId: "t1", role: "assistant" });
    messagesRepo.appendContent(db, { id: "m1", delta: "内容" });

    expect(messagesRepo.finalize(db, { id: "m1", status: "done", tokensOut: 42 })).toBe(true);

    const row = messagesRepo.getById(db, "m1");
    expect(row).toMatchObject({ content: "内容", status: "done", tokensOut: 42 });
  });

  it("listByChannel 最新在前，before 游标可翻页", () => {
    for (let i = 0; i < 5; i += 1) {
      messagesRepo.create(db, {
        id: `m${i}`,
        sessionId: "s1",
        channelId: "ch1",
        turnId: "t1",
        role: "user",
        content: `第 ${i} 条`,
        createdAt: 1000 + i,
      });
    }

    const page1 = messagesRepo.listByChannel(db, "ch1", 2);
    expect(page1.map((m) => m.id)).toEqual(["m4", "m3"]);

    const page2 = messagesRepo.listByChannel(db, "ch1", 2, page1[1]?.createdAt);
    expect(page2.map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("同一毫秒写入的 user + assistant → 按插入顺序返回（不按随机 UUID 排）", () => {
    // 复现 critic 的实测：两行 created_at 完全相同，id 是随机 UUID。
    // 用 `ORDER BY created_at DESC, id DESC` 会按 UUID 排 —— 有一半概率把
    // assistant 排到 user 前面。改用 rowid 兜底后，顺序恒等于插入顺序。
    const same = 1_700_000_000_000;
    messagesRepo.create(db, {
      id: "msg_zzzz_user",
      sessionId: "s1",
      channelId: "ch1",
      turnId: "t1",
      role: "user",
      content: "你叫什么名字？",
      createdAt: same,
    });
    messagesRepo.create(db, {
      id: "msg_aaaa_assistant",
      sessionId: "s1",
      channelId: "ch1",
      turnId: "t1",
      role: "assistant",
      content: "我叫铁蛋。",
      createdAt: same,
    });

    // listByChannel 返回「最新在前」：assistant 在前、user 在后
    const rows = messagesRepo.listByChannel(db, "ch1", 10);
    expect(rows.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(rows.map((m) => m.content)).toEqual(["我叫铁蛋。", "你叫什么名字？"]);
  });

  it("同一毫秒跨多轮 → 全局插入顺序不被 UUID 打乱", () => {
    const same = 1_700_000_000_000;
    const ids = ["msg_ffff", "msg_0000", "msg_bbbb", "msg_3333"];
    const roles: ("user" | "assistant")[] = ["user", "assistant", "user", "assistant"];
    ids.forEach((id, i) => {
      messagesRepo.create(db, {
        id,
        sessionId: "s1",
        channelId: "ch1",
        turnId: `t${i}`,
        role: roles[i]!,
        content: `第 ${i} 条`,
        createdAt: same,
      });
    });

    // 最新在前 = 插入倒序
    const rows = messagesRepo.listByChannel(db, "ch1", 10);
    expect(rows.map((m) => m.content)).toEqual(["第 3 条", "第 2 条", "第 1 条", "第 0 条"]);
  });
});

describe("events repo", () => {
  function insert(type: "message_delta" | "meta", createdAt = now): void {
    eventsRepo.insert(db, {
      sessionId: "s1",
      messageId: "m1",
      turnId: "t1",
      type,
      payload:
        type === "meta"
          ? { kind: "compaction", data: null }
          : { messageId: "m1", phase: "delta", text: "x" },
      createdAt,
    });
  }

  it("seq 由 sessions.seq_counter 分配，会话内从 1 递增", () => {
    insert("message_delta");
    insert("meta");
    const rows = eventsRepo.listBySession(db, "s1");
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    // 计数器也落库了，重启后可继续
    const counter = db.prepare("SELECT seq_counter FROM sessions WHERE id = 's1'").get() as {
      seq_counter: number;
    };
    expect(counter.seq_counter).toBe(2);
  });

  it("listAfterId 按全局 id 游标升序取，不跨会话", () => {
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, status, started_at) VALUES ('s2', 'b1', 'ch1', 'ready', ?)`,
    ).run(now);

    insert("message_delta"); // id 1, s1
    eventsRepo.insert(db, {
      sessionId: "s2",
      messageId: null,
      turnId: "t2",
      type: "meta",
      payload: { kind: "compaction", data: null },
    }); // id 2, s2
    insert("message_delta"); // id 3, s1

    expect(eventsRepo.listAfterId(db, "s1", 0).map((r) => r.id)).toEqual([1, 3]);
    expect(eventsRepo.listAfterId(db, "s1", 1).map((r) => r.id)).toEqual([3]);
    expect(eventsRepo.listAfterId(db, "s1", 3)).toEqual([]);
  });

  it("payload 与 raw 按 JSON 往返，坏数据不炸读取", () => {
    const row = eventsRepo.insert(db, {
      sessionId: "s1",
      messageId: "m1",
      turnId: "t1",
      type: "tool_call",
      payload: { callId: "c1", name: "bash", status: "running" },
      raw: '{"oops":true}',
    });
    expect(row.payload).toEqual({ callId: "c1", name: "bash", status: "running" });
    expect(row.raw).toBe('{"oops":true}');
  });

  it("deleteOlderThan 只删过期批次，返回删除条数", () => {
    insert("message_delta", 1000);
    insert("message_delta", 2000);
    insert("message_delta", 9000);

    expect(eventsRepo.deleteOlderThan(db, 5000)).toBe(2);
    expect(eventsRepo.listBySession(db, "s1").map((r) => r.createdAt)).toEqual([9000]);
  });
});
