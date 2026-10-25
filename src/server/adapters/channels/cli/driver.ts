import type { CanonicalEvent } from "../../../../shared/events.js";
import type {
  AdapterDeclaration,
  CapabilitySet,
  ChannelDriver,
  ExitInfo,
  PermissionDecision,
  ProbeResult,
  RuntimePermissionRequest,
  SessionHandle,
  SpawnContext,
} from "../../contract.js";
import { effectiveLaunch } from "../../launch.js";
import { getTurnContext } from "../../turn-context.js";
import { createStdioTransport, type Transport } from "../acp/transport.js";

/**
 * CLI 兜底通道（架构 §3.7，首版参考实现是 ZCode）。
 *
 * 这个通道的全部价值是「诚实降级」：没有公开 schema 的 CLI，只能按行猜。
 *
 *   ① stdout 首行以 `{` 开头 → JSON 模式：整段缓冲，退出时整体解析；
 *      命中已知字段（response / message.content / usage / sessionId）就结构化映射，
 *      解析失败则把缓冲原样当正文（一行都不丢）。
 *   ② 否则 → 文本模式：逐行当 `message_delta.text` 累积。
 *   ③ stderr 留末 8KB，作为 error 的 detail。
 *   ④ exit 0 → `done`；非 0 → `error(fatal)`；被 cancel → `done(cancelled)`。
 *
 * 能力掩码在这里落地：本通道只产出 message_delta / usage / done / error 四类
 * （声明里写了哪些就是哪些），其余类型根本不会出现，UI 也就不会画空块。
 *
 * 进程模型：**一次 prompt 一个进程**（ZCode / DSH 的 headless 都是「跑完即退」）。
 * 因此上下文不跨轮保留（`resumeStrategy: process-lifetime`），由产品层重建（§5）。
 *
 * **人格与记忆的注入方式（已知限制，必须如实记录）**：
 * CLI 没有 system 参数（`--json -p <text>` 只有一段用户输入），契约里的
 * `systemPrompt` 无处安放。本驱动的做法是把系统提示**前置拼进 prompt 文本**：
 *
 *     <systemPrompt>
 *     （空行）
 *     <用户消息原文>
 *
 * 代价是模型可能把这段当成「用户说过的话」的一部分（例如被问「谁说的」时会
 * 指向用户），而不是真正的系统指令。这是 CLI 兜底通道的诚实降级：
 * ACP 通道有真正的 `_meta.systemPrompt` 字段，原生通道有 `developerInstructions`，
 * 只有这里必须牺牲语义纯度换取「人格与记忆至少能到模型手里」。
 * 系统提示为空时**不拼**，也不留空段落（P0-10「不注入空段落」）。
 */

interface CliState {
  decl: AdapterDeclaration;
  cwd: string;
  /**
   * `newSession` 收到的系统提示（人格 + 记忆 + 重建的历史）。
   * CLI 每个进程只跑一次 prompt，所以只能在这里存下来，prompt 时前置拼进文本。
   */
  systemPrompt: string | null;
  env: Record<string, string> | undefined;
  transport: Transport | null;
  runtimeSessionId: string | null;
  cancelled: boolean;
  running: boolean;
  eventCbs: ((e: CanonicalEvent) => void)[];
  permissionCbs: ((req: RuntimePermissionRequest) => void)[];
  exitCbs: ((info: ExitInfo) => void)[];
  disposed: boolean;
}

const states = new WeakMap<SessionHandle, CliState>();

/** 单次 prompt 的缓冲上限：超过就截断并标注，不让内存被无限输出拖垮。 */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function stateOf(h: SessionHandle): CliState {
  const s = states.get(h);
  if (!s) throw new Error("CLI 句柄无效（未经 start 创建或已释放）");
  return s;
}

function emitAll(state: CliState, events: CanonicalEvent[]): void {
  for (const e of events) {
    for (const cb of state.eventCbs) {
      try {
        cb(e);
      } catch (err) {
        console.warn(
          `[cli] 事件回调抛错（已忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 已知字段的正文抽取：不同 CLI 的 JSON 外壳差异很大，这里只认最常见的三种。 */
function extractText(obj: Record<string, unknown>): string | null {
  const direct = str(obj["response"]) ?? str(obj["result"]) ?? str(obj["text"]);
  if (direct !== undefined) return direct;

  // Claude 风格：{ type:'assistant', message:{ content:[{type:'text',text}] } }
  const message = obj["message"];
  if (isRecord(message)) {
    const content = message["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter(isRecord)
        .filter((c) => c["type"] === "text" || c["type"] === undefined)
        .map((c) => str(c["text"]) ?? "")
        .filter((s) => s.length > 0);
      if (parts.length > 0) return parts.join("");
    }
  }
  return null;
}

function extractUsage(obj: Record<string, unknown>): { inputTokens: number; outputTokens: number } | null {
  const usage = obj["usage"];
  if (!isRecord(usage)) return null;
  const input = usage["inputTokens"] ?? usage["input_tokens"] ?? usage["prompt_tokens"];
  const output = usage["outputTokens"] ?? usage["output_tokens"] ?? usage["completion_tokens"];
  if (typeof input !== "number" && typeof output !== "number") return null;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
}

function extractSessionId(obj: Record<string, unknown>): string | null {
  return str(obj["sessionId"]) ?? str(obj["session_id"]) ?? null;
}

export interface CliDriverOptions {
  /** 测试注入：用假传输替代 spawn（fixture 回放）。每次 prompt 调一次。 */
  transportFactory?: (spec: { command: string; args: string[]; cwd: string }) => Transport;
}

export function createCliDriver(opts: CliDriverOptions = {}): ChannelDriver {
  return {
    protocol: "cli-stdio",

    async start(decl: AdapterDeclaration, ctx: SpawnContext): Promise<SessionHandle> {
      const state: CliState = {
        decl,
        cwd: ctx.cwd,
        systemPrompt: null,
        env: ctx.env,
        transport: null,
        runtimeSessionId: null,
        cancelled: false,
        running: false,
        eventCbs: [],
        permissionCbs: [],
        exitCbs: [],
        disposed: false,
      };
      const handle: SessionHandle = {
        sessionId: ctx.sessionId,
        pid: null,
        get runtimeSessionId() {
          return state.runtimeSessionId;
        },
      };
      states.set(handle, state);
      return handle;
    },

    /**
     * 健康检查：真起一次 `--version` 类命令。
     * 比「命令存在」强一点：能区分「装了但一跑就崩」和「装了能用」。
     */
    async initialize(h: SessionHandle): Promise<ProbeResult> {
      const state = stateOf(h);
      const decl = state.decl;
      const launch = effectiveLaunch(decl);
      const emptyCaps: CapabilitySet = {
        plan: "unknown",
        permissionRequest: "unknown",
        resume: "unknown",
        images: "unknown",
        streaming: "unknown",
        contextWindow: null,
      };

      const ok = await new Promise<{ ok: boolean; detail?: string }>((resolve) => {
        const transport = createStdioTransport({
          command: launch.command,
          // 用探测参数做健康检查：CLI 的 launch 参数通常需要一个 prompt，不适合探活
          args: [...decl.detect.versionArgs],
          cwd: state.cwd,
        });
        let settled = false;
        const done = (v: { ok: boolean; detail?: string }): void => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        const timer = setTimeout(() => {
          transport.kill();
          done({ ok: false, detail: "健康检查超时" });
        }, decl.detect.timeoutMs ?? 3000);
        timer.unref?.();
        transport.onClose((info) => {
          clearTimeout(timer);
          done(
            info.code === 0
              ? { ok: true }
              : { ok: false, detail: `退出码 ${String(info.code)}` },
          );
        });
      });

      if (!ok.ok) {
        return {
          capabilities: emptyCaps,
          source: "declared",
          version: null,
          healthStatus: "unhealthy",
          ...(ok.detail === undefined ? {} : { detail: ok.detail }),
        };
      }
      // CLI 通道不提供结构化的能力上报：如实说 unknown，让声明值兜底
      return {
        capabilities: emptyCaps,
        source: "declared",
        version: null,
        healthStatus: "healthy",
      };
    },

    async newSession(h, opts) {
      // 一次 prompt 一个进程：没有可复用的运行时会话，给个稳定占位 id。
      // 但 `opts` 不能丢 —— systemPrompt 是人格 + 记忆 + 重建历史的唯一载体，
      // CLI 没有 system 参数，只能由本驱动在 prompt 时前置拼进文本（见文件头）。
      const state = stateOf(h);
      state.cwd = opts.cwd;
      const systemPrompt = opts.systemPrompt?.trim() ?? "";
      state.systemPrompt = systemPrompt.length > 0 ? systemPrompt : null;
      return { runtimeSessionId: `cli_${Date.now().toString(36)}` };
    },

    async resumeSession() {
      // process-lifetime：进程已退出就无从续接，如实返回失败让核心走重建
      return { ok: false, reason: "CLI 通道不支持跨进程 resume" };
    },

    async prompt(h, input) {
      const state = stateOf(h);
      if (state.running) throw new Error("上一轮尚未结束");
      const launch = effectiveLaunch(state.decl);
      if (launch.note) console.warn(`[cli] ${state.decl.id}: ${launch.note}`);

      state.cancelled = false;
      state.running = true;
      // 本轮真实耗时（PRD P0-04「结束后显示本轮 token 用量」同一处也显示耗时）。
      // 之前 done 事件硬写 durationMs: 0，UI 上就是「完成 · 0.0s」—— 用户等了
      // 15 秒却看到 0.0s，会以为产品在骗他/坏了。CLI 通道一轮就是一个进程，
      // 从 spawn 到 exit 的墙钟时间就是用户实际等待的时间。
      const promptStartedAt = Date.now();

      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? `turn_${Date.now().toString(36)}`;
      const messageId = ctx?.messageId ?? "assistant";

      // 系统提示（人格 + 记忆 + 重建历史）以「前置块」形式混入 prompt：
      // CLI 没有 system 参数，这是唯一能把它们送到模型手里的路径。
      // 中间留一个空行做分隔；系统提示为空时只用用户原文（不留空段落）。
      const promptText =
        state.systemPrompt === null || state.systemPrompt.length === 0
          ? input.text
          : `${state.systemPrompt}\n\n${input.text}`;

      // 提示词作为最后一个位置参数传入（`cmd -p "text"` / `cmd --profile headless "text"`）
      const args = [...launch.args, promptText];
      const transport =
        opts.transportFactory?.({ command: launch.command, args, cwd: state.cwd }) ??
        createStdioTransport({
          command: launch.command,
          args,
          cwd: state.cwd,
          env: { ...state.decl.launch.env, ...state.env },
        });
      state.transport = transport;

      let started = false;
      let jsonMode = false;
      let raw = "";
      let truncated = false;
      let lineCount = 0;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let runtimeSessionId: string | null = null;

      const emit = (events: CanonicalEvent[]): void => emitAll(state, events);

      const ensureStart = (): void => {
        if (started) return;
        started = true;
        emit([{ type: "message_delta", turnId, ts: Date.now(), payload: { messageId, phase: "start", text: "" } }]);
      };

      const appendText = (text: string): void => {
        if (text.length === 0) return;
        ensureStart();
        emit([{ type: "message_delta", turnId, ts: Date.now(), payload: { messageId, phase: "delta", text } }]);
      };

      /**
       * JSON 模式收口：整段解析 → 逐行 JSONL → 实在不行当正文。
       *
       * 两条规则，都是实测踩出来的：
       *   ① **收口字段优先**：有顶层 `response`/`result` 就只取它；
       *      stream-json 类输出里中间的 `assistant` 消息与末尾 `result` 携带同一段
       *      正文，全拼会让正文重复一遍。
       *   ② **去重**：中间多条消息文本相同（重试/分片）只保留一次。
       */
      const flushJson = (): void => {
        const body = raw.trim();
        if (body.length === 0) return;

        let finalText: string | null = null;
        const parts: string[] = [];
        let recognized = false;

        const consume = (obj: Record<string, unknown>): void => {
          const closing = str(obj["response"]) ?? str(obj["result"]);
          if (closing !== undefined) {
            finalText = closing;
            recognized = true;
          } else {
            const text = extractText(obj);
            if (text !== null) {
              // 同文本重复出现（result 回显 assistant）只算一次
              if (parts[parts.length - 1] !== text) parts.push(text);
              recognized = true;
            }
          }
          usage = extractUsage(obj) ?? usage;
          runtimeSessionId = extractSessionId(obj) ?? runtimeSessionId;
        };

        // ① 整段是一个 JSON 对象 / 数组（pretty-print 的 --json 输出）
        try {
          const parsed: unknown = JSON.parse(body);
          if (isRecord(parsed)) {
            consume(parsed);
          } else if (Array.isArray(parsed)) {
            for (const item of parsed) if (isRecord(item)) consume(item);
          }
        } catch {
          // 继续尝试 JSONL
        }

        // ② 每行一个 JSON（stream-json）
        if (!recognized) {
          const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
          let allJson = lines.length > 0;
          for (const line of lines) {
            try {
              const v: unknown = JSON.parse(line);
              if (!isRecord(v)) {
                allJson = false;
                break;
              }
              consume(v);
            } catch {
              allJson = false;
              break;
            }
          }
          if (!allJson) {
            parts.length = 0;
            finalText = null;
          }
        }

        // 合并规则：中间累积已经覆盖收口文本就只发累积（避免重复一遍）；
        // 收口文本更长（运行时会补全/改写）就以它为准；两者都没就发收口文本。
        const joined = parts.join("");
        let text: string | null = null;
        if (joined.length > 0 && finalText !== null) {
          text = joined.endsWith(finalText) || joined.includes(finalText) ? joined : finalText;
        } else if (joined.length > 0) {
          text = joined;
        } else if (finalText !== null) {
          text = finalText;
        }
        if (text !== null) {
          appendText(text);
          return;
        }

        // ③ 认不出任何正文：原样当正文，一行不丢（P0-05「未知行不崩、不丢」）
        appendText(body);
      };

      transport.onLine((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        if (lineCount === 0 && trimmed.startsWith("{")) jsonMode = true;
        lineCount += 1;

        if (jsonMode) {
          if (raw.length + line.length + 1 > MAX_CAPTURE_BYTES) {
            truncated = true;
            return;
          }
          raw += `${line}\n`;
          return;
        }

        // 文本模式：逐行即时出字（首 token 延迟最低）。
        // 行间保留换行 —— 少一个 \n 会把整段话粘成一行（实测 zcode 纯文本就是多行）。
        appendText(lineCount === 1 ? trimmed : `\n${trimmed}`);
      });

      await new Promise<void>((resolve) => {
        transport.onClose((info) => {
          state.running = false;
          state.transport = null;

          if (jsonMode) flushJson();

          const events: CanonicalEvent[] = [];
          if (usage) {
            events.push({
              type: "usage",
              turnId,
              ts: Date.now(),
              payload: { ...usage, reported: true },
            });
          }

          const tail = transport.stderrTail.trim();

          if (state.cancelled) {
            // 已生成内容保留（PRD P0-04），只补收口
            if (started) {
              events.push({ type: "message_delta", turnId, ts: Date.now(), payload: { messageId, phase: "end", text: "" } });
            }
            events.push({
              type: "done",
              turnId,
              ts: Date.now(),
              payload: { stopReason: "cancelled", durationMs: Math.max(0, Date.now() - promptStartedAt) },
            });
          } else if (info.code === 0) {
            if (!started && tail.length > 0) {
              // 退出码 0、stdout 空、stderr 有内容：典型是「没登录 / 缺凭据」
              // （实测 dsh 未配 API key 时就是这样）。这是可诊断的失败，
              // 不能当成「空回复」让用户猜。fatal 为 true：这一轮确实没产出。
              events.push({
                type: "error",
                turnId,
                ts: Date.now(),
                payload: {
                  code: "runtime_no_output",
                  message: "运行时没有返回任何内容",
                  detail: tail.slice(-2000),
                  fatal: true,
                },
              });
            } else {
              if (started) {
                events.push({ type: "message_delta", turnId, ts: Date.now(), payload: { messageId, phase: "end", text: "" } });
              }
              // 完全静默的空回复：只有 done，由 UI 显示「未返回内容」（P0-04 边界）
              events.push({
                type: "done",
                turnId,
                ts: Date.now(),
                payload: { stopReason: "end", durationMs: Math.max(0, Date.now() - promptStartedAt) },
              });
            }
          } else {
            events.push({
              type: "error",
              turnId,
              ts: Date.now(),
              payload: {
                code: "runtime_crashed",
                message:
                  info.code === null
                    ? "运行时进程异常退出"
                    : `运行时进程退出了（exit ${String(info.code)}）`,
                ...(tail.length > 0 ? { detail: tail.slice(-2000) } : {}),
                fatal: true,
              },
            });
          }

          emit(events);

          const exit: ExitInfo = {
            code: info.code,
            ...(info.signal === undefined ? {} : { signal: info.signal }),
            stderrTail: transport.stderrTail,
          };
          for (const cb of state.exitCbs) {
            try {
              cb(exit);
            } catch {
              // 忽略
            }
          }
          resolve();
        });
      });

      if (truncated) {
        console.warn(`[cli] ${state.decl.id}: 输出超过 ${MAX_CAPTURE_BYTES} 字节，已截断`);
      }
      if (runtimeSessionId) {
        state.runtimeSessionId = runtimeSessionId;
        console.debug(`[cli] ${state.decl.id}: 运行时会话 ${runtimeSessionId}`);
      }
    },

    async cancel(h) {
      const state = stateOf(h);
      state.cancelled = true;
      state.transport?.kill();
    },

    async respondPermission(_h: SessionHandle, requestId: string, _decision: PermissionDecision) {
      // CLI 通道没有权限回传（permission.channel = none）：如实报错，别假装成功
      throw new Error(`CLI 通道不支持权限应答：${requestId}`);
    },

    onEvent(h, cb) {
      stateOf(h).eventCbs.push(cb);
    },
    onPermission(h, cb) {
      stateOf(h).permissionCbs.push(cb);
    },
    onExit(h, cb) {
      stateOf(h).exitCbs.push(cb);
    },

    async dispose(h) {
      const state = states.get(h);
      if (!state || state.disposed) return;
      state.disposed = true;
      state.transport?.kill();
      state.transport = null;
      states.delete(h);
    },
  };
}
