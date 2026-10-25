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

export const SCHEMA_VERSION = 1;

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

const STEPS: MigrationStep[] = [
  {
    version: 1,
    name: "v1 初始 schema（12 张主表 + permission_grants）",
    run: (db) => {
      db.exec(loadSchemaSql());
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
