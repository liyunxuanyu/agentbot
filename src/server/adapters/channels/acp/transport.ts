import { spawn, type ChildProcess } from "node:child_process";

/**
 * stdio JSON-RPC 传输（ACP / Codex app-server 共用同一形状）。
 *
 * 三件事，都按「坏输入不能拖垮进程」写：
 *   ① 按行切分 stdout：`\r\n` 与 `\n` 都认，单行上限 4MB（超了丢弃并记一条，
 *      防止运行时吐出一整段二进制把内存吃穿）；
 *   ② stderr 只留末 8KB —— 崩溃原因通常在最后几行，全留会随长任务无限增长；
 *   ③ 传输层**不理解协议**：它只负责「收发一行文本 + 报告退出」。
 *      JSON-RPC 的 id 关联在上面的 `JsonRpcPeer`，协议语义在各自的 driver。
 *
 * 契约测试用 `Transport` 接口注入假实现（fixture 回放），因此这一层必须
 * 不依赖任何 spawn 细节。
 */

/** 单行上限：ACP 的 tool_result 可能很大，但不能无限。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** stderr 保留窗口（架构 §3.7：末 8KB 供错误详情）。 */
const STDERR_TAIL_BYTES = 8 * 1024;

export interface TransportExit {
  code: number | null;
  signal?: string;
}

export interface Transport {
  readonly pid: number | null;
  /** 末 8KB stderr，随时可读（退出后仍保留）。 */
  readonly stderrTail: string;
  /** 写一行（调用方保证是单行；本层补换行）。 */
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  onClose(cb: (info: TransportExit) => void): void;
  /** 已退出时是空操作。 */
  kill(signal?: NodeJS.Signals): void;
  readonly closed: boolean;
}

export interface SpawnTransportSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export function createStdioTransport(spec: SpawnTransportSpec): Transport {
  // shell:false —— 参数数组直接交给内核，永不拼接字符串（架构 §8）
  const child: ChildProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // POSIX 下自成进程组，M5 的 kill-tree 才能整组杀；Windows 无此概念
    detached: process.platform !== "win32",
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let closed = false;
  let exitInfo: TransportExit | null = null;

  const lineListeners: ((line: string) => void)[] = [];
  const stderrListeners: ((text: string) => void)[] = [];
  const closeListeners: ((info: TransportExit) => void)[] = [];

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx >= 0) {
      const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length > 0) emitLine(line);
      idx = stdoutBuf.indexOf("\n");
    }
    // 无换行的超长行：丢弃并留痕，避免把内存拖爆
    if (stdoutBuf.length > MAX_LINE_BYTES) {
      const dropped = stdoutBuf.length;
      stdoutBuf = "";
      console.warn(`[transport] 单行超过 ${MAX_LINE_BYTES} 字节，已丢弃 ${dropped} 字节`);
    }
  });

  child.stderr?.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_TAIL_BYTES);
    for (const cb of stderrListeners) {
      try {
        cb(chunk);
      } catch {
        // 监听者出错不影响传输
      }
    }
  });

  // spawn 失败（命令不存在）没有 exit 事件，只有 error
  child.on("error", (err) => {
    stderrBuf = (stderrBuf + `\n[transport] spawn 失败：${err.message}`).slice(-STDERR_TAIL_BYTES);
    finish({ code: null, signal: undefined });
  });

  child.on("close", (code, signal) => {
    // 残留的最后一行（没有换行结尾）也要交出去
    const rest = stdoutBuf.trim();
    stdoutBuf = "";
    if (rest.length > 0) emitLine(rest);
    finish({ code, signal: signal ?? undefined });
  });

  function emitLine(line: string): void {
    for (const cb of lineListeners) {
      try {
        cb(line);
      } catch (err) {
        console.warn(
          `[transport] 行监听者抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  function finish(info: TransportExit): void {
    if (closed) return;
    closed = true;
    exitInfo = info;
    for (const cb of closeListeners) {
      try {
        cb(info);
      } catch {
        // 同上
      }
    }
  }

  return {
    get pid() {
      return child.pid ?? null;
    },
    get stderrTail() {
      return stderrBuf;
    },
    get closed() {
      return closed;
    },
    send(line) {
      if (closed || !child.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(`${line}\n`);
      } catch {
        // 进程刚退出时写 stdin 会 EPIPE，属于正常竞态
      }
    },
    onLine(cb) {
      lineListeners.push(cb);
    },
    onStderr(cb) {
      stderrListeners.push(cb);
    },
    onClose(cb) {
      if (exitInfo) {
        cb(exitInfo);
        return;
      }
      closeListeners.push(cb);
    },
    kill(signal = "SIGTERM") {
      if (closed) return;
      try {
        child.kill(signal);
      } catch {
        // 已退出
      }
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: JsonRpcErrorShape,
  ) {
    super(`${method} 失败（${rpcError.code}）：${rpcError.message}`);
    this.name = "JsonRpcError";
  }
}

type Pending = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
};

export interface PeerHooks {
  onNotification?: (method: string, params: unknown) => void;
  /** 反向请求（ACP 的 session/request_permission）：由 driver 决定怎么答。 */
  onRequest?: (method: string, params: unknown, id: string | number) => void;
}

export interface JsonRpcPeer {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, error: JsonRpcErrorShape): void;
  /** 拒掉所有未决请求（进程退出时调，避免 await 永远挂着）。 */
  failAll(reason: string): void;
  readonly pendingCount: number;
}

/**
 * 请求/响应 id 关联。
 *
 * 坏行一律吞掉（记 warning 不进业务）：运行时可能往 stdout 混打印日志，
 * 「未知协议行不抛致命错误」是 PRD 的硬要求（§7 可靠性）。
 */
export function createJsonRpcPeer(
  transport: Transport,
  hooks: PeerHooks = {},
  defaultTimeoutMs = 60_000,
): JsonRpcPeer {
  let nextId = 1;
  const pending = new Map<string, Pending>();

  transport.onLine((line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // 非 JSON 行：ACP 下是噪声（CLI 通道自己按行启发式处理），忽略即可
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const rec = msg as Record<string, unknown>;
    const id = rec["id"];
    const method = rec["method"];

    // ① 响应（有 id、无 method）
    if (typeof method !== "string" && id !== undefined) {
      const key = String(id);
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      const err = rec["error"];
      if (isRpcError(err)) {
        entry.reject(new JsonRpcError(entry.method, err));
        return;
      }
      entry.resolve(rec["result"]);
      return;
    }

    if (typeof method !== "string") return;

    // ② 反向请求（有 method、有 id）
    if (id !== undefined && (typeof id === "string" || typeof id === "number")) {
      if (hooks.onRequest) {
        try {
          hooks.onRequest(method, rec["params"], id);
        } catch (err) {
          // driver 处理反向请求失败：回一个错误响应，别让运行时干等
          transport.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: err instanceof Error ? err.message : "内部错误" },
            }),
          );
        }
      } else {
        transport.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `不支持的方法：${method}` },
          }),
        );
      }
      return;
    }

    // ③ 通知（有 method、无 id）
    if (hooks.onNotification) {
      try {
        hooks.onNotification(method, rec["params"]);
      } catch (err) {
        console.warn(
          `[jsonrpc] 通知处理失败（${method}）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  transport.onClose((info) => {
    failAll(
      info.code === null
        ? "运行时进程已退出"
        : `运行时进程已退出（exit ${String(info.code)}）`,
    );
  });

  function failAll(reason: string): void {
    for (const [key, entry] of pending) {
      pending.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method}：${reason}`));
    }
  }

  return {
    request(method, params, timeoutMs = defaultTimeoutMs) {
      if (transport.closed) {
        return Promise.reject(new Error(`${method}：运行时进程已退出`));
      }
      const id = nextId++;
      const key = String(id);
      return new Promise<unknown>((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(key);
                reject(new Error(`${method}：${timeoutMs}ms 超时`));
              }, timeoutMs)
            : null;
        timer?.unref?.();
        pending.set(key, { method, resolve, reject, timer });
        transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },

    notify(method, params) {
      if (transport.closed) return;
      transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },

    respond(id, result) {
      transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },

    respondError(id, error) {
      transport.send(JSON.stringify({ jsonrpc: "2.0", id, error }));
    },

    failAll,

    get pendingCount() {
      return pending.size;
    },
  };
}

function isRpcError(v: unknown): v is JsonRpcErrorShape {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { code?: unknown }).code === "number" &&
    typeof (v as { message?: unknown }).message === "string"
  );
}
