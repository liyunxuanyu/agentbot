import type { DB } from "../db/db.js";
import { isProcessAlive, killTreeSync, readProcessStartMs } from "./kill-tree.js";

/**
 * 进程登记表 + 启动清扫（架构 §5「Windows 进程治理」）。
 *
 * 两件事：
 *   ① **内存登记**：本进程 spawn 出来的所有 pid。`SIGINT/SIGTERM/exit` 时统一清扫，
 *      否则 node 会等子进程退出，服务看起来「关不掉」。
 *   ② **启动清扫**：上一轮服务如果被强杀（任务管理器 / 断电），`sessions.process_pid`
 *      里会留下僵尸 pid。启动时逐个校验，死了就清字段，活着且创建时间对得上就杀掉。
 *
 * 为什么必须比创建时间：pid 会被系统复用。只按数字 taskkill，可能杀掉用户
 * 自己的编辑器或数据库。**验证不了就不杀**（宁可留一个孤儿，不误杀）。
 *
 * 这个文件不 import 任何通道驱动：它只处理 pid，与协议无关。
 */

export type RegistryKillReason = "shutdown" | "idle" | "crash" | "cancel";

export interface RegisteredProcess {
  pid: number;
  sessionId: string;
  startedAt: number;
}

export interface PidRegistry {
  /** 登记一个新进程；同一 sessionId 的旧登记会被替换（一个 Session 一个进程）。 */
  register(sessionId: string, pid: number): void;
  /** 注销（正常退出 / 已被杀）。 */
  unregister(sessionId: string): void;
  /** 查某 Session 当前登记的 pid。 */
  pidOf(sessionId: string): number | null;
  /** 全部登记项（关服清扫用）。 */
  entries(): RegisteredProcess[];
  /** 同步杀掉所有登记进程（只能在退出路径用）。 */
  killAllSync(): number;
}

export function createPidRegistry(): PidRegistry {
  const bySession = new Map<string, RegisteredProcess>();

  return {
    register(sessionId, pid) {
      if (!Number.isFinite(pid) || pid <= 0) return;
      bySession.set(sessionId, { pid, sessionId, startedAt: Date.now() });
    },
    unregister(sessionId) {
      bySession.delete(sessionId);
    },
    pidOf(sessionId) {
      return bySession.get(sessionId)?.pid ?? null;
    },
    entries() {
      return [...bySession.values()];
    },
    killAllSync() {
      let killed = 0;
      for (const entry of bySession.values()) {
        const res = killTreeSync(entry.pid);
        if (!res.alreadyGone) killed += 1;
      }
      bySession.clear();
      return killed;
    },
  };
}

/**
 * 安装退出钩子。
 *
 * **进程级只装一次**：多个 Supervisor 实例（测试里很常见）不能各自往
 * `process` 上挂一套监听，否则会触发 MaxListenersExceededWarning，而且退出时
 * 同一个 pid 会被扫多遍。这里用模块级集合维护「要清扫的登记表」，监听只挂一次。
 */
const hookedRegistries = new Set<PidRegistry>();
let hooksInstalled = false;

export function installExitHooks(registry: PidRegistry): void {
  hookedRegistries.add(registry);
  if (hooksInstalled) return;

  const sweep = (): void => {
    let count = 0;
    for (const reg of hookedRegistries) count += reg.killAllSync();
    if (count > 0) console.warn(`[process] 退出清扫：已终止 ${count} 个残留运行时进程`);
  };

  process.on("exit", sweep);
  // 不在这里 process.exit：让 main.ts 的优雅退出走完；钩子只保证子进程被带走
  process.on("SIGINT", sweep);
  process.on("SIGTERM", sweep);
  hooksInstalled = true;
}

/** 测试用：是否已装（不影响生产语义）。 */
export function exitHooksInstalled(): boolean {
  return hooksInstalled;
}

// ---------------------------------------------------------------------------
// 启动清扫
// ---------------------------------------------------------------------------

export interface ZombieSweepResult {
  /** 扫描到的「有 pid 的 Session」数量。 */
  scanned: number;
  /** pid 已不存在：清空字段（含 status 置 failed）。 */
  dead: number;
  /** pid 活着但创建时间不匹配（PID 被复用）：只清字段，绝不杀。 */
  reused: number;
  /** pid 活着且时间匹配：确实是我们上次留下的进程，杀掉。 */
  killed: number;
  /** 无法验证创建时间：不杀，只清字段并记日志。 */
  unverifiable: number;
}

/**
 * 启动时清扫上一轮残留。
 *
 * 同时做两件相关的事（都在这里，因为它们共用一次 `sessions` 扫描）：
 *   ① 僵尸进程处理（本文件职责）；
 *   ② `running/waiting_permission/starting/ready` 的 Session 置 `failed` ——
 *      进程没了，这些状态是谎话（架构 §5「服务重启」那一行）。
 *
 * `toleranceMs` 是创建时间比对容差：Windows 上 wmic 精度到秒，
 * 我们记录的是 spawn 返回后的时刻，两者可能差几百毫秒。
 */
export function sweepZombies(
  db: DB,
  opts: { toleranceMs?: number; log?: (msg: string) => void } = {},
): ZombieSweepResult {
  const tolerance = opts.toleranceMs ?? 5000;
  const log = opts.log ?? ((msg: string) => console.warn(`[process] ${msg}`));

  const rows = db
    .prepare(
      `SELECT id, process_pid, process_started_at, status FROM sessions
        WHERE process_pid IS NOT NULL`,
    )
    .all() as {
    id: string;
    process_pid: number;
    process_started_at: number | null;
    status: string;
  }[];

  const result: ZombieSweepResult = {
    scanned: rows.length,
    dead: 0,
    reused: 0,
    killed: 0,
    unverifiable: 0,
  };

  const clearPid = db.prepare(
    "UPDATE sessions SET process_pid = NULL, process_started_at = NULL WHERE id = ?",
  );

  for (const row of rows) {
    const pid = row.process_pid;
    if (!isProcessAlive(pid)) {
      clearPid.run(row.id);
      result.dead += 1;
      continue;
    }

    const actualStart = readProcessStartMs(pid);
    const recordedStart = row.process_started_at;

    if (actualStart === null || recordedStart === null) {
      // 验证不了：不杀。清字段，让下一轮重新 spawn
      clearPid.run(row.id);
      result.unverifiable += 1;
      log(`Session ${row.id} 的 pid ${pid} 无法验证创建时间，保留进程不杀（避免误杀）`);
      continue;
    }

    if (Math.abs(actualStart - recordedStart) > tolerance) {
      clearPid.run(row.id);
      result.reused += 1;
      log(`Session ${row.id} 的 pid ${pid} 已被复用（创建时间不符），不杀，仅清字段`);
      continue;
    }

    const res = killTreeSync(pid);
    clearPid.run(row.id);
    if (res.gone) {
      result.killed += 1;
      log(`Session ${row.id} 的残留进程 ${pid} 已终止`);
    } else {
      result.unverifiable += 1;
      log(`Session ${row.id} 的残留进程 ${pid} 终止失败${res.error ? `：${res.error}` : ""}`);
    }
  }

  // ② 状态修正：进程已不在，这些状态必须落下
  const fixed = db
    .prepare(
      `UPDATE sessions
          SET status = 'failed', ended_at = COALESCE(ended_at, ?)
        WHERE status IN ('running','waiting_permission','starting','ready')
          AND process_pid IS NULL`,
    )
    .run(Date.now());

  if (fixed.changes > 0) {
    log(`已将 ${fixed.changes} 个进程已不存在的 Session 置为 failed`);
  }

  return result;
}
