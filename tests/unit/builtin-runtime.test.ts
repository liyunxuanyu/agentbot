import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/server/core/db/db.js";
import { migrate, currentSchemaVersion } from "../../src/server/core/db/migrate.js";
import { persistProbe, listRuntimes } from "../../src/server/adapters/probe.js";
import { builtinDeclaration } from "../../src/server/adapters/builtin-runtime.js";
import { requiresWorktree } from "../../src/server/core/permissions/worktree-guard.js";

describe("内置运行时注册", () => {
  it("persistProbe 写入 builtin 行：协议 builtin、权限通道 internal、不强制 worktree", () => {
    const db = openDb(":memory:");
    const decl = builtinDeclaration();
    persistProbe(
      db,
      decl,
      {
        capabilities: decl.capabilities,
        source: "declared",
        version: "0.1.0",
        healthStatus: "healthy",
        availability: "ready",
        meetsMinVersion: true,
        executable: null,
      },
      null,
      { source: "builtin" },
    );
    const row = listRuntimes(db).find((r) => r.id === "builtin");
    expect(row).toBeDefined();
    expect(row?.protocol).toBe("builtin");
    expect(row?.availability).toBe("ready");
    expect(row?.permissionChannel).toBe("internal");
    expect(row?.eventCapabilities).toHaveLength(9);
    expect(requiresWorktree({ permission: { channel: row?.permissionChannel ?? undefined } })).toBe(false);
    db.close();
  });
});

describe("迁移 v2", () => {
  it("v1 老库补 provider_id 列，且重复执行安全", () => {
    // 直接用 better-sqlite3：openDb 会自动迁移到最新版，模拟不了 v1 老库
    const db = new Database(":memory:");
    // 模拟一个 v1 库：只有版本行与没有 provider_id 的 bots 表
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('version', '1');
      CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);
    expect(currentSchemaVersion(db)).toBe(1);
    const first = migrate(db);
    // 迁移一路推进到当前版本（v1 库会连续执行 v2、v3 的增量）
    expect(first.to).toBe(currentSchemaVersion(db));
    expect(first.applied.length).toBeGreaterThanOrEqual(1);
    const columns = db.prepare("PRAGMA table_info(bots)").all() as { name: string }[];
    expect(columns.some((c) => c.name === "provider_id")).toBe(true);

    const second = migrate(db);
    expect(second.applied).toHaveLength(0);
    db.close();
  });
});

describe("迁移 v3", () => {
  it("v2 老库升 v3：数据不丢、新列默认值正确、记忆作用域回填为 bot", () => {
    const db = new Database(":memory:");
    // 模拟 v2 库：只建 v3 会 ALTER 的五张表（旧列形状）+ 版本行。
    // 迁移只按列增量推进，其它表不参与这一步。
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('version', '2');

      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT,
        repo_path TEXT
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        channel_id TEXT NOT NULL
      );
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session_id TEXT,
        kind TEXT NOT NULL DEFAULT 'manual',
        injected INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reported INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      INSERT INTO bots(id, name, provider_id, repo_path)
        VALUES ('bot_1', '老 Bot', 'prov_1', '/old/repo');
      INSERT INTO channels(id, name) VALUES ('ch_1', '老会话');
      INSERT INTO sessions(id, bot_id, channel_id) VALUES ('ses_1', 'bot_1', 'ch_1');
      INSERT INTO memory_entries(id, bot_id, content, source_session_id, kind, injected, version, updated_at, created_at)
        VALUES ('mem_1', 'bot_1', '历史记忆内容', 'ses_1', 'summary', 1, 1, 1000, 1000);
      INSERT INTO usage_records(id, input_tokens, output_tokens, reported, created_at)
        VALUES ('use_1', 10, 5, 1, 1000);
    `);

    const result = migrate(db);
    expect(result.from).toBe(2);
    expect(result.to).toBe(3);
    expect(result.applied).toHaveLength(1);

    // 数据不丢：行数与内容都在
    expect((db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number }).n).toBe(1);
    const mem = db
      .prepare("SELECT content, scope, channel_id FROM memory_entries WHERE id = 'mem_1'")
      .get() as { content: string; scope: string; channel_id: string | null };
    expect(mem.content).toBe("历史记忆内容");
    // 历史记忆回填为 bot 全局作用域（G1），不改内容
    expect(mem.scope).toBe("bot");
    expect(mem.channel_id).toBeNull();

    // 默认值：权限模式 confirm、角色 member、会话级覆盖为空
    const bot = db
      .prepare("SELECT role, permission_mode, provider_id, repo_path FROM bots WHERE id = 'bot_1'")
      .get() as {
      role: string;
      permission_mode: string;
      provider_id: string | null;
      repo_path: string | null;
    };
    expect(bot.role).toBe("member");
    expect(bot.permission_mode).toBe("confirm");
    expect(bot.provider_id).toBe("prov_1");
    expect(bot.repo_path).toBe("/old/repo");

    const ses = db
      .prepare(
        "SELECT workspace_path, provider_id, model, permission_mode FROM sessions WHERE id = 'ses_1'",
      )
      .get() as {
      workspace_path: string | null;
      provider_id: string | null;
      model: string | null;
      permission_mode: string;
    };
    expect(ses).toEqual({
      workspace_path: null,
      provider_id: null,
      model: null,
      permission_mode: "confirm",
    });

    const use = db
      .prepare(
        "SELECT cached_input_tokens, cache_write_tokens, model, input_tokens FROM usage_records WHERE id = 'use_1'",
      )
      .get() as {
      cached_input_tokens: number;
      cache_write_tokens: number;
      model: string | null;
      input_tokens: number;
    };
    expect(use).toEqual({
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      model: null,
      input_tokens: 10,
    });

    // 索引建在 memory_entries 上
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_scope'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_memory_scope");

    // 重复执行安全
    expect(migrate(db).applied).toHaveLength(0);
    db.close();
  });
});
