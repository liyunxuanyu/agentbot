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
    expect(first.to).toBe(2);
    expect(first.applied).toHaveLength(1);
    const columns = db.prepare("PRAGMA table_info(bots)").all() as { name: string }[];
    expect(columns.some((c) => c.name === "provider_id")).toBe(true);

    const second = migrate(db);
    expect(second.applied).toHaveLength(0);
    db.close();
  });
});
