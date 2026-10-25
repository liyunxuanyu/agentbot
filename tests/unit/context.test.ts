import { describe, expect, it } from "vitest";
import { openDb } from "../../src/server/core/db/db.js";
import {
  buildBootstrapContext,
  buildRebuildContext,
  estimateTokens,
} from "../../src/server/core/orchestrator/context.js";

/**
 * 上下文重建（P0-15）：
 *   - 人格 + 记忆 + 最近 20 条消息
 *   - 超窗口 → 从最早消息丢弃至估算 token < 窗口 70%，并显示「已省略 N 条历史」
 *   - 运行时没上报 contextWindow → 不做窗口裁剪
 */

function seed(db: ReturnType<typeof openDb>, opts: { messages: number; persona?: string; memory?: string[] }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES ('ch_ctx', 'dm', '私聊', '[]', NULL, ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, created_at, updated_at) VALUES ('bot_ctx', '写手', ?, ?, ?)`,
  ).run(opts.persona ?? "", now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, status, started_at) VALUES ('sess_ctx', 'bot_ctx', 'ch_ctx', 'idle', ?)`,
  ).run(now);

  for (let i = 0; i < opts.messages; i += 1) {
    db.prepare(
      `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
       VALUES (?, 'sess_ctx', 'ch_ctx', ?, ?, ?, 'done', ?)`,
    ).run(
      `m${i}`,
      `t${Math.floor(i / 2)}`,
      i % 2 === 0 ? "user" : "assistant",
      `第 ${i + 1} 条消息：这是一段用来测试上下文窗口裁剪的历史内容。`,
      now + i,
    );
  }

  for (const [i, content] of (opts.memory ?? []).entries()) {
    db.prepare(
      `INSERT INTO memory_entries (id, bot_id, content, kind, injected, version, updated_at, created_at)
       VALUES (?, 'bot_ctx', ?, 'manual', 1, 1, ?, ?)`,
    ).run(`mem${i}`, content, now + i, now);
  }
}

describe("首轮上下文 · 只有人格 + 记忆（P0-10 每轮注入）", () => {
  it("带人格与记忆，且不含「继续此前对话」的引导语", () => {
    const db = openDb(":memory:");
    seed(db, {
      messages: 0,
      persona: "你的名字叫铁蛋，每句话都要以「嘎」结尾。",
      memory: ["秘密口令是紫罗兰-42"],
    });

    const res = buildBootstrapContext({ db, botId: "bot_ctx" });
    expect(res.systemPrompt).toContain("铁蛋");
    expect(res.systemPrompt).toContain("紫罗兰-42");
    expect(res.systemPrompt).not.toContain("你正在继续一段此前的对话");
    expect(res.includedMessages).toBe(0);
    expect(res.omittedMessages).toBe(0);
    db.close();
  });

  it("人格与记忆都为空 → 空串（调用方不传 systemPrompt，不留空段落）", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 0 });
    const res = buildBootstrapContext({ db, botId: "bot_ctx" });
    expect(res.systemPrompt).toBe("");
    db.close();
  });
});

describe("上下文重建 · 人格 + 记忆 + 最近消息", () => {
  it("拼装人格、记忆与最近 20 条消息，按时间正序", () => {
    const db = openDb(":memory:");
    seed(db, {
      messages: 30,
      persona: "你是资深前端工程师，回答简短。",
      memory: ["用户偏好 TypeScript", "项目使用 Vue 3"],
    });

    const res = buildRebuildContext({ db, botId: "bot_ctx", sessionId: "sess_ctx" });

    expect(res.systemPrompt).toContain("资深前端工程师");
    expect(res.systemPrompt).toContain("用户偏好 TypeScript");
    expect(res.systemPrompt).toContain("项目使用 Vue 3");
    // 只带最近 20 条：第 11 条（index 10）应该在，第 10 条（index 9）不在
    expect(res.systemPrompt).toContain("第 30 条消息");
    expect(res.systemPrompt).toContain("第 11 条消息");
    expect(res.systemPrompt).not.toContain("第 10 条消息");
    expect(res.includedMessages).toBe(20);
    expect(res.omittedMessages).toBe(0);
    expect(res.truncated).toBe(false);

    // 顺序：第 11 条在第 30 条之前
    const i11 = res.systemPrompt.indexOf("第 11 条消息");
    const i30 = res.systemPrompt.indexOf("第 30 条消息");
    expect(i11).toBeLessThan(i30);
    db.close();
  });

  it("人格为空且无记忆无消息 → systemPrompt 只有引导语（不为空串时才注入）", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 0 });
    const res = buildRebuildContext({ db, botId: "bot_ctx", sessionId: "sess_ctx" });
    expect(res.includedMessages).toBe(0);
    expect(res.omittedMessages).toBe(0);
    expect(res.systemPrompt.length).toBeGreaterThan(0);
    db.close();
  });

  it("记忆超出字符预算 → 按更新时间倒序截断，并注明省略条数", () => {
    const db = openDb(":memory:");
    seed(db, {
      messages: 0,
      memory: Array.from({ length: 10 }, (_, i) => `记忆条目 ${i} ${"x".repeat(200)}`),
    });
    const res = buildRebuildContext({
      db,
      botId: "bot_ctx",
      sessionId: "sess_ctx",
      memoryCharBudget: 700,
    });
    expect(res.systemPrompt).toContain("记忆超出预算，已省略");
    // 最新的（mem9）优先保留
    expect(res.systemPrompt).toContain("记忆条目 9");
    expect(res.systemPrompt).not.toContain("记忆条目 0");
    db.close();
  });
});

describe("上下文重建 · 窗口裁剪（估算 token < 窗口 70%）", () => {
  it("超窗口 → 从最早消息丢弃，直到低于 70%，并写明「已省略 N 条历史」", () => {
    const db = openDb(":memory:");
    seed(db, {
      messages: 20,
      persona: "你是测试助手。",
      memory: ["记住：用户只接受中文回答。"],
    });

    // 一个很小的窗口，必然触发裁剪
    const window = 300;
    const res = buildRebuildContext({
      db,
      botId: "bot_ctx",
      sessionId: "sess_ctx",
      contextWindow: window,
      budgetRatio: 0.7,
    });

    expect(res.truncated).toBe(true);
    expect(res.omittedMessages).toBeGreaterThan(0);
    expect(res.estimatedTokens).toBeLessThan(window * 0.7);
    expect(res.systemPrompt).toContain(`已省略 ${res.omittedMessages} 条更早的历史`);
    // 最新的消息一定保留
    expect(res.systemPrompt).toContain("第 20 条消息");
    // 最早的一定被丢掉
    expect(res.systemPrompt).not.toContain("第 1 条消息：");
    db.close();
  });

  it("窗口足够大 → 不裁剪，omittedMessages=0", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 4, persona: "你是测试助手。" });
    const res = buildRebuildContext({
      db,
      botId: "bot_ctx",
      sessionId: "sess_ctx",
      contextWindow: 100_000,
    });
    expect(res.truncated).toBe(false);
    expect(res.omittedMessages).toBe(0);
    expect(res.includedMessages).toBe(4);
    db.close();
  });

  it("contextWindow 为 null（未上报）→ 不按窗口裁剪，只按 20 条窗口", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 50, persona: "你是测试助手。" });
    const res = buildRebuildContext({
      db,
      botId: "bot_ctx",
      sessionId: "sess_ctx",
      contextWindow: null,
    });
    expect(res.truncated).toBe(false);
    expect(res.includedMessages).toBe(20);
    db.close();
  });

  it("excludeTurnId → 本轮自己的用户消息不进历史（避免同一句话出现两遍）", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 2, persona: "你是测试助手。" });
    // seed 的两条消息 turn_id 都是 t0；再造一条「本轮」的消息
    db.prepare(
      `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
       VALUES ('m_now', 'sess_ctx', 'ch_ctx', 't_now', 'user', '这一轮的问题', 'done', ?)`,
    ).run(Date.now() + 100);

    const res = buildRebuildContext({
      db,
      botId: "bot_ctx",
      sessionId: "sess_ctx",
      excludeTurnId: "t_now",
    });
    expect(res.systemPrompt).toContain("第 1 条消息");
    expect(res.systemPrompt).not.toContain("这一轮的问题");
    expect(res.includedMessages).toBe(2);
    db.close();
  });

  it("同一毫秒的历史消息按插入顺序渲染（rowid 兜底，不按随机 UUID）", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 0, persona: "你是测试助手。" });
    const same = Date.now();
    // id 故意让 UUID 排序与插入顺序相反
    db.prepare(
      `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
       VALUES ('m_zzz', 'sess_ctx', 'ch_ctx', 't1', 'user', '提问在前', 'done', ?)`,
    ).run(same);
    db.prepare(
      `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
       VALUES ('m_aaa', 'sess_ctx', 'ch_ctx', 't1', 'assistant', '回答在后', 'done', ?)`,
    ).run(same);

    const res = buildRebuildContext({ db, botId: "bot_ctx", sessionId: "sess_ctx" });
    expect(res.systemPrompt.indexOf("提问在前")).toBeLessThan(
      res.systemPrompt.indexOf("回答在后"),
    );
    db.close();
  });

  it("窗口极小到连最新一条都放不下 → 全部丢弃但不崩，prompt 仍非空", () => {
    const db = openDb(":memory:");
    seed(db, { messages: 5, persona: "你是一个很长很长的人格描述".repeat(20) });
    const res = buildRebuildContext({
      db,
      botId: "bot_ctx",
      sessionId: "sess_ctx",
      contextWindow: 50,
    });
    expect(res.includedMessages).toBe(0);
    expect(res.omittedMessages).toBe(5);
    expect(res.systemPrompt.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("token 估算", () => {
  it("空串为 0；中英混排按 2 字符 ≈ 1 token（保守高估）", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("你好世界")).toBe(2);
  });
});
