import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { createUsageRecorder } from "../../src/server/core/usage/recorder.js";
import { aggregate } from "../../src/server/core/usage/aggregate.js";

/**
 * R8：缓存未上报 → 用量页显示 —，不稀释合计。
 *
 * 三条验收：
 *   ① 只回 prompt/completion（无缓存字段）→ 该行 cacheHitRate=null、cachedInputTokens=null；
 *   ② 回 cached_tokens: 0（真实 0 命中）→ cacheHitRate=0，不是 null；
 *   ③ 合计命中率不被「伪 0」行稀释（分母只算缓存字段真的上报了的行）。
 */

const NOW = Date.now();

function setup(): DB {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO bots (id, name, persona, created_at, updated_at)
     VALUES ('b1', '小助', '', ?, ?)`,
  ).run(NOW, NOW);
  return db;
}

describe("用量缓存上报（R8）", () => {
  it("无缓存字段 → cache_reported=0，行显示 —", () => {
    const db = setup();
    const recorder = createUsageRecorder({ db, log: () => undefined });
    const result = recorder.record({
      botId: "b1",
      runtimeId: "builtin",
      sessionId: "s1",
      mode: "interactive",
      samples: [{ inputTokens: 100, outputTokens: 20, reported: true }],
    });

    expect(result.cacheReported).toBe(false);
    const row = db
      .prepare("SELECT cache_reported, cached_input_tokens FROM usage_records WHERE id = ?")
      .get(result.id) as { cache_reported: number; cached_input_tokens: number };
    expect(row.cache_reported).toBe(0);

    const agg = aggregate(db, { range: "all" }, {});
    expect(agg.rows).toHaveLength(1);
    expect(agg.rows[0]?.cacheHitRate).toBeNull();
    expect(agg.rows[0]?.cachedInputTokens).toBeNull();
    // token 仍然有数（用量上报与缓存上报是两个概念）
    expect(agg.rows[0]?.inputTokens).toBe(100);
    expect(agg.totals.cacheHitRate).toBeNull();
    db.close();
  });

  it("cached_tokens: 0 → cache_reported=1，显示 0%（不是 —）", () => {
    const db = setup();
    const recorder = createUsageRecorder({ db, log: () => undefined });
    const result = recorder.record({
      botId: "b1",
      runtimeId: "builtin",
      sessionId: "s1",
      mode: "interactive",
      samples: [{ inputTokens: 100, outputTokens: 20, reported: true, cachedInputTokens: 0 }],
    });

    expect(result.cacheReported).toBe(true);
    const agg = aggregate(db, { range: "all" }, {});
    expect(agg.rows[0]?.cacheHitRate).toBe(0);
    expect(agg.rows[0]?.cachedInputTokens).toBe(0);
    db.close();
  });

  it("合计命中率不被伪 0 行稀释：只有上报了缓存的那行进分母", () => {
    const db = setup();
    const recorder = createUsageRecorder({ db, log: () => undefined });
    // 行 A：1000 输入，缓存上报 500 命中 → 命中率 50%
    recorder.record({
      botId: "b1",
      runtimeId: "builtin",
      sessionId: "s1",
      mode: "interactive",
      samples: [{ inputTokens: 500, outputTokens: 10, reported: true, cachedInputTokens: 500 }],
    });
    // 行 B：9000 输入，缓存未上报 → 不应进命中率分母
    recorder.record({
      botId: "b1",
      runtimeId: "builtin",
      sessionId: "s2",
      mode: "interactive",
      samples: [{ inputTokens: 9000, outputTokens: 10, reported: true }],
    });

    const agg = aggregate(db, { range: "all" }, {});
    // 两行在同一 Bot×运行时×模式下聚合成一行；命中率 = 500 / (500 + 500) = 50%
    expect(agg.rows).toHaveLength(1);
    expect(agg.rows[0]?.cacheHitRate).toBe(50);
    expect(agg.totals.cacheHitRate).toBe(50);
    db.close();
  });

  it("老库升级后历史行 cache_reported=0 → 显示 —", () => {
    // 模拟升级前的历史记录：列是 v4 迁移补的，默认 0
    const db = setup();
    db.prepare(
      `INSERT INTO usage_records
         (id, bot_id, runtime_id, session_id, mode, input_tokens, output_tokens,
          cached_input_tokens, cache_write_tokens, model, reported, created_at)
       VALUES ('use_old', 'b1', 'builtin', 's1', 'interactive', 800, 100, 0, 0, 'gpt-x', 1, ?)`,
    ).run(NOW);
    const agg = aggregate(db, { range: "all" }, {});
    expect(agg.rows[0]?.cacheHitRate).toBeNull();
    expect(agg.rows[0]?.cachedInputTokens).toBeNull();
    db.close();
  });
});
