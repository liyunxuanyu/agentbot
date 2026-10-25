import { spawn } from "node:child_process";
import { AGENT_LIMITS } from "../../limits.js";
import type { ToolDefinition, ToolResult } from "../registry.js";
import { killTree } from "../../../process/kill-tree.js";
import { truncateText } from "../truncate.js";

function appendLimited(current: string, chunk: Buffer, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(current, "utf8") >= limit) return { text: current, truncated: true };
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= limit) return { text: next, truncated: false };
  return { text: next.slice(0, limit), truncated: true };
}

export const runShellTool: ToolDefinition = {
  name: "run_shell",
  description:
    "在工作目录内执行 shell 命令。默认超时 120 秒，输出上限 64KB；取消或超时会杀掉整个进程树。执行命令需要用户批准。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      timeoutMs: { type: "number", description: "超时毫秒数，缺省 120000，最大 600000" },
    },
    required: ["command"],
  },
  permission: "exec",
  source: "builtin",
  async execute(ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const command = typeof args["command"] === "string" ? args["command"].trim() : "";
    if (command.length === 0) {
      const message = "command 不能为空";
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
    const requested = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : AGENT_LIMITS.shellTimeoutMs;
    const timeoutMs = Math.min(Math.max(requested, 1000), 600_000);

    return new Promise<ToolResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let outTruncated = false;
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const child =
        process.platform === "win32"
          ? spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", command], {
              cwd: ctx.cwd,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn("/bin/sh", ["-c", command], {
              cwd: ctx.cwd,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            });

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) void killTree(child.pid).catch(() => undefined);
        // 兜底：树杀后 close 可能不触发（孙进程脱离），2s 后强制收口
        setTimeout(() => finish(null, null), 2000).unref?.();
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        if (child.pid !== undefined) void killTree(child.pid).catch(() => undefined);
        setTimeout(() => finish(null, null), 2000).unref?.();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        const appended = appendLimited(stdout, chunk, AGENT_LIMITS.maxToolOutputBytes);
        stdout = appended.text;
        outTruncated ||= appended.truncated;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const appended = appendLimited(stderr, chunk, AGENT_LIMITS.maxToolOutputBytes);
        stderr = appended.text;
        outTruncated ||= appended.truncated;
      });

      const finish = (code: number | null, signal: string | null, errorMessage?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);

        const parts: string[] = [];
        if (stdout.trim().length > 0) parts.push(stdout.trimEnd());
        if (stderr.trim().length > 0) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        parts.push(
          timedOut
            ? `[超时 ${timeoutMs}ms，进程已终止]`
            : aborted
              ? "[已取消，进程已终止]"
              : `[exit ${code ?? "null"}${signal ? ` signal ${signal}` : ""}]`,
        );
        const combined = parts.join("\n");
        const truncated = truncateText(combined);
        const ok = !timedOut && !aborted && code === 0 && errorMessage === undefined;
        const message = errorMessage ?? (timedOut ? "命令超时" : aborted ? "命令已取消" : `exit ${String(code)}`);
        resolve({
          ok,
          output: truncated.text,
          ...(ok ? {} : { error: message }),
          ...(truncated.truncated || outTruncated ? { truncated: true } : {}),
          durationMs: Date.now() - started,
        });
      };

      child.on("error", (err) => finish(null, null, `启动失败：${err.message}`));
      child.on("close", (code, signal) => finish(code, signal));
    });
  },
};
