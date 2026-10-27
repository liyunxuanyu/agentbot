import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "./db.js";

/**
 * schema 版本化迁移。
 *
 * 约定：`schema_meta` 里的 `version` 是已应用到的版本号；缺表/缺行视为 0。
 * 每一步只做「上一个版本 → 这个版本」的增量，且必须幂等（schema.sql 全是
 * `CREATE TABLE IF NOT EXISTS`，首次执行与重复执行都安全）。
 */

export const SCHEMA_VERSION = 4;

export interface MigrationResult {
  /** 迁移前版本。 */
  from: number;
  /** 迁移后版本。 */
  to: number;
  /** 本次实际执行的步骤名，空数组表示已是最新。 */
  applied: string[];
}

/** 打包后 schema.sql 可能与产物同目录；开发态在 src 下；最后兜底按 cwd 找。 */
function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "schema.sql"),
    join(here, "../../../src/server/core/db/schema.sql"),
    join(process.cwd(), "src/server/core/db/schema.sql"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error(`schema.sql 未找到，已尝试：\n${candidates.join("\n")}`);
}

function tableExists(db: DB, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

export function currentSchemaVersion(db: DB): number {
  if (!tableExists(db, "schema_meta")) return 0;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  if (!row) return 0;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
}

function setSchemaVersion(db: DB, version: number): void {
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

interface MigrationStep {
  version: number;
  name: string;
  run: (db: DB) => void;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((c) => c.name === column);
}

/**
 * 幂等加列：全新库（schema.sql 已含）跳过，老库执行 ALTER。
 *
 * 表不存在时也跳过：迁移单测会用「只有 schema_meta + bots」的最小库模拟老版本，
 * 真实老库不会缺表；为一张不存在的表 ALTER 只会让整个迁移失败。
 */
function addColumn(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const STEPS: MigrationStep[] = [
  {
    version: 1,
    name: "v1 初始 schema（12 张主表 + permission_grants）",
    run: (db) => {
      db.exec(loadSchemaSql());
    },
  },
  {
    version: 2,
    name: "v2 内置引擎：bots.provider_id",
    run: (db) => {
      // 全新库的 schema.sql 已包含该列；只有 v1 老库需要 ALTER。
      addColumn(db, "bots", "provider_id", "TEXT");
    },
  },
  {
    version: 3,
    name: "v3 会话控制：工作区 / 会话级模型与权限模式 / 管理员 / 记忆作用域 / 缓存用量",
    run: (db) => {
      // 全部可空或带默认值：历史行行为不变（记忆回填 scope='bot' 由默认值覆盖）
      addColumn(db, "channels", "workspace_path", "TEXT");
      addColumn(db, "sessions", "workspace_path", "TEXT");
      addColumn(db, "sessions", "provider_id", "TEXT");
      addColumn(db, "sessions", "model", "TEXT");
      addColumn(
        db,
        "sessions",
        "permission_mode",
        "TEXT NOT NULL DEFAULT 'confirm' CHECK (permission_mode IN ('confirm','auto','plan','full'))",
      );
      addColumn(
        db,
        "bots",
        "role",
        "TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin'))",
      );
      addColumn(
        db,
        "bots",
        "permission_mode",
        "TEXT NOT NULL DEFAULT 'confirm' CHECK (permission_mode IN ('confirm','auto','plan','full'))",
      );
      addColumn(
        db,
        "memory_entries",
        "scope",
        "TEXT NOT NULL DEFAULT 'bot' CHECK (scope IN ('bot','channel','session'))",
      );
      addColumn(db, "memory_entries", "channel_id", "TEXT");
      // 索引同样要防「表不存在」：最小模拟库只有 bots，直接建索引会让整个迁移失败。
      if (tableExists(db, "memory_entries")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_memory_scope
             ON memory_entries(scope, channel_id, injected, updated_at DESC)`,
        );
      }
      addColumn(db, "usage_records", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "usage_records", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "usage_records", "model", "TEXT");
    },
  },
  {
    version: 4,
    name: "v4 缓存上报标记（R8）+ Bot 技能开关（N4）",
    run: (db) => {
      // R8：缓存字段是否真的上报。历史行回填 0 —— 升级前确实不知道有没有上报，
      // 宁可显示「—」也不要把未知当成 0% 命中。
      addColumn(db, "usage_records", "cache_reported", "INTEGER NOT NULL DEFAULT 0");
      // N4：Bot 启用的技能（JSON 数组，NULL = 默认集合）。历史 Bot 回填 NULL
      // 表示「保持原行为」（全部技能都注入），不改变现有 Bot 的表现。
      addColumn(db, "bots", "enabled_skills", "TEXT");
    },
  },
];

/**
 * 增量推进到 SCHEMA_VERSION。每一步与版本号写入在同一事务里，
 * 中途失败不会留下「表建了但版本没升」的半截状态。
 */
export function migrate(db: DB): MigrationResult {
  const from = currentSchemaVersion(db);
  const applied: string[] = [];

  for (const step of STEPS) {
    if (step.version <= from) continue;
    db.transaction(() => {
      step.run(db);
      setSchemaVersion(db, step.version);
    })();
    applied.push(step.name);
  }

  // 全新库：schema.sql 已建 schema_meta 但可能没有行，这里补一次确保版本落库
  if (applied.length === 0 && currentSchemaVersion(db) === 0) {
    setSchemaVersion(db, SCHEMA_VERSION);
  }

  return { from, to: currentSchemaVersion(db), applied };
}
