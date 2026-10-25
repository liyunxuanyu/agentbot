import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../../config.js";
import { migrate, type MigrationResult } from "./migrate.js";

export type DB = Database.Database;

let db: DB | null = null;

/**
 * 只建连接与设 PRAGMA，不做 schema 变更。
 * 建表/版本推进交给 migrate，启动序里两步是分开的。
 */
function openRaw(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  // WAL：读写不互相阻塞；busy_timeout 容忍短暂写锁竞争
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  conn.pragma("synchronous = NORMAL");
  return conn;
}

/** 打开连接并推进到最新 schema 版本（迁移幂等）。 */
export function openDb(path: string = config.dbPath): DB {
  const conn = openRaw(path);
  migrate(conn);
  return conn;
}

/** 启动序用：返回迁移结果供启动日志打印。 */
export function initDb(path: string = config.dbPath): { db: DB; migration: MigrationResult } {
  db?.close();
  const conn = openRaw(path);
  const migration = migrate(conn);
  db = conn;
  return { db: conn, migration };
}

export function getDb(): DB {
  if (!db) db = openDb();
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/** 测试用：换成内存库。 */
export function useTestDb(): DB {
  db?.close();
  db = openDb(":memory:");
  return db;
}

export function tx<T>(fn: (d: DB) => T): T {
  const d = getDb();
  const wrapped = d.transaction(fn);
  return wrapped(d);
}

export function now(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}
