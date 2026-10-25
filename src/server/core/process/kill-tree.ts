import { spawn, spawnSync } from "node:child_process";

/**
 * 进程树杀（架构 §5「Windows 进程治理」）。
 *
 * 为什么不能只 `child.kill()`：
 *   - 运行时 CLI 往往会再拉子进程（语言服务、MCP 子进程、包管理器）。
 *     只杀父进程会留下孤儿，占着内存与文件句柄，下一轮 spawn 还可能撞锁。
 *   - **Windows 没有进程组**，POSIX 的 `kill(-pid)` 在 Windows 上会抛 EINVAL。
 *     所以 Windows 必须走 `taskkill /T /F`（/T = 整棵树，/F = 强制）。
 *   - POSIX 侧由通道驱动以 `detached:true` 启动（自成进程组），这里 `kill(-pid)`
 *     一次带走整组；万一没有独立进程组（测试或第三方 spawn），退回 `kill(pid)`。
 *
 * 这个文件是**唯一**允许出现平台杀进程命令的地方：supervisor 只管「什么时候杀」。
 */

const WIN = process.platform === "win32";

/** taskkill 自身超时：它偶尔会卡在被杀的进程上，不能让关服流程挂住。 */
const TASKKILL_TIMEOUT_MS = 5000;
/** 等待进程真正消失的默认时长（`/F` 之后通常几十毫秒）。 */
const DEFAULT_VERIFY_MS = 1500;

export type KillMethod = "taskkill" | "group" | "pid" | "none";

export interface KillResult {
  pid: number;
  /** 调用结束后进程是否已不存在（true = 杀成功或本来就没了）。 */
  gone: boolean;
  /** 本来就已经不存在，没有执行任何杀动作。 */
  alreadyGone: boolean;
  method: KillMethod;
  /** taskkill / kill 的失败原因（不抛错，交给调用方记日志）。 */
  error?: string;
}

/** 进程是否还活着。`EPERM` 表示存在但无权信号 → 仍算活着。 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** 轮询到进程消失或超时。Windows 上 taskkill 是异步生效的，必须等。 */
async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(25);
  }
  return !isProcessAlive(pid);
}

function runTaskkill(pid: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve(error === undefined ? { ok } : { ok, error });
    };

    const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(false, "taskkill 超时");
    }, TASKKILL_TIMEOUT_MS);
    timer.unref?.();

    child.on("error", (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 128 = 进程已不存在；0 = 成功。其余视为失败但仍会做消失校验
      finish(code === 0 || code === 128, code === 0 || code === 128 ? undefined : `taskkill exit ${String(code)}`);
    });
  });
}

/**
 * 杀掉 pid 及其所有子孙进程。
 *
 * 永不抛错：它处在崩溃/关服路径上，抛出去会变成未捕获 rejection。
 */
export async function killTree(pid: number, opts: { verifyMs?: number } = {}): Promise<KillResult> {
  if (!isProcessAlive(pid)) {
    return { pid, gone: true, alreadyGone: true, method: "none" };
  }

  const verifyMs = opts.verifyMs ?? DEFAULT_VERIFY_MS;
  let method: KillMethod = WIN ? "taskkill" : "group";
  let error: string | undefined;

  if (WIN) {
    const res = await runTaskkill(pid);
    if (!res.ok) error = res.error;
  } else {
    try {
      // 负 pid = 整个进程组；驱动以 detached:true 启动才有组
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      method = "pid";
      try {
        process.kill(pid, "SIGKILL");
      } catch (inner) {
        const code = (inner as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") error = (inner as Error).message;
      }
      void err;
    }
  }

  const gone = await waitGone(pid, verifyMs);
  const result: KillResult = { pid, gone, alreadyGone: false, method };
  if (error !== undefined) result.error = error;
  return result;
}

/**
 * 同步版本，只给进程退出钩子用（`process.on('exit')` 里不能 await）。
 *
 * Windows：`spawnSync taskkill`；POSIX：先整组再单体。整体包在 try 里，
 * 退出路径上任何异常都会让 node 带着非零码退出。
 */
export function killTreeSync(pid: number): KillResult {
  if (!isProcessAlive(pid)) {
    return { pid, gone: true, alreadyGone: true, method: "none" };
  }
  try {
    if (WIN) {
      const res = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: TASKKILL_TIMEOUT_MS,
      });
      return {
        pid,
        gone: !isProcessAlive(pid),
        alreadyGone: false,
        method: "taskkill",
        ...(res.error ? { error: res.error.message } : {}),
      };
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
    return { pid, gone: !isProcessAlive(pid), alreadyGone: false, method: "group" };
  } catch (err) {
    return {
      pid,
      gone: !isProcessAlive(pid),
      alreadyGone: false,
      method: WIN ? "taskkill" : "pid",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 读取进程创建时间（epoch ms），读不到返回 null。
 *
 * 用途只有一个：**启动时判断 PID 是否被复用**（架构 §5「避免 PID 复用误杀」）。
 * 上一轮服务崩溃后，`sessions.process_pid` 里的数字可能已经被系统分配给
 * 一个完全无关的进程 —— 这时候 taskkill 会杀掉用户的其它程序。
 *
 * 读不到就返回 null，调用方按「无法验证 → 不杀」处理（宁可留孤儿，不误杀）。
 */
export function readProcessStartMs(pid: number): number | null {
  if (!isProcessAlive(pid)) return null;
  try {
    if (WIN) {
      const wmic = spawnSync(
        "wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      );
      const text = wmic.stdout ?? "";
      const m = /CreationDate=(\d{14})\.(\d{6})([+-]\d{3})?/.exec(text);
      if (m) return parseWmicCreation(m[1] ?? "", m[3]);

      // Win11 部分版本已移除 wmic：退回 PowerShell（慢但可靠）
      const ps = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
            `if($p){[int64](($p.StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)}`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
      const n = Number.parseInt((ps.stdout ?? "").trim(), 10);
      return Number.isFinite(n) ? n : null;
    }

    // POSIX：etimes = 已运行秒数，换算成起始时刻，够做「是否同一个进程」的判断
    const ps = spawnSync("ps", ["-o", "etimes=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    });
    const sec = Number.parseInt((ps.stdout ?? "").trim(), 10);
    if (!Number.isFinite(sec)) return null;
    return Date.now() - sec * 1000;
  } catch {
    return null;
  }
}

/** `20261024120000.123456+480` → epoch ms（偏移量单位是分钟）。 */
function parseWmicCreation(stamp: string, offset: string | undefined): number | null {
  if (stamp.length < 14) return null;
  const y = Number(stamp.slice(0, 4));
  const mo = Number(stamp.slice(4, 6));
  const d = Number(stamp.slice(6, 8));
  const h = Number(stamp.slice(8, 10));
  const mi = Number(stamp.slice(10, 12));
  const s = Number(stamp.slice(12, 14));
  if (![y, mo, d, h, mi, s].every((n) => Number.isFinite(n))) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMinutes = offset === undefined ? 0 : Number.parseInt(offset, 10);
  const adjusted = Number.isFinite(offsetMinutes) ? utc - offsetMinutes * 60_000 : utc;
  return Number.isFinite(adjusted) ? adjusted : null;
}
