import type {
  AdapterDeclaration,
  PermissionChannel,
  ProtocolKind,
  ResumeStrategy,
} from "./contract.js";
import type { EventType } from "../../shared/events.js";

/**
 * 自定义运行时（P0-01「支持手动添加自定义启动命令」）。
 *
 * 内置运行时靠 `declarations/*.yaml` 声明；自定义运行时没有声明文件，由用户在
 * 设置页填「启动命令 + 参数 + 环境变量」生成一份**同形状**的声明，落进
 * `runtime_definitions.capabilities._declaration`（零 schema 变更）。
 *
 * 这里只做「参数 → 声明」的确定性翻译，不读库、不探测。默认值全部按**通道能力**
 * 推导，而不是猜产品语义：
 *
 *   - `permission.channel`：ACP 有反向请求、Codex 有 JSON-RPC 审批，其余（含未知协议）
 *     一律 `none` —— 判不准时按最严处理，Bot 会被强制跑在 worktree（安全底线）。
 *   - `eventCapabilities`：该通道的驱动实际能产出的类型。声明多了只会让驱动多吐
 *     几类（驱动不产出的类型根本不会出现），声明少了会让真实事件被 ingest 丢弃。
 *   - `capabilities`：全部 `unknown`。自定义运行时没有声明文件可兜底，探测拿到什么
 *     就是什么；拿不到就如实显示「未知」，不猜 `false`（C3：探测失败 ≠ 不支持）。
 */

/** 契约里的 5 种协议（`contract.ts` 的 ProtocolKind），顺序即前端下拉顺序。 */
export const PROTOCOL_KINDS: readonly ProtocolKind[] = [
  "acp",
  "codex-app-server",
  "opencode-http",
  "claude-sdk",
  "cli-stdio",
];

export function isProtocolKind(v: unknown): v is ProtocolKind {
  return typeof v === "string" && (PROTOCOL_KINDS as readonly string[]).includes(v);
}

/** 各通道驱动实际能稳定产出的可渲染事件类型。 */
const EVENT_MASK_BY_PROTOCOL: Record<ProtocolKind, EventType[]> = {
  // ACP 的 session/update 覆盖全部 9 类
  acp: [
    "message_delta",
    "thought",
    "tool_call",
    "tool_result",
    "plan",
    "permission_request",
    "usage",
    "done",
    "error",
  ],
  // app-server 没有 plan（与 codex.yaml 一致）
  "codex-app-server": [
    "message_delta",
    "thought",
    "tool_call",
    "tool_result",
    "permission_request",
    "usage",
    "done",
    "error",
  ],
  // CLI 兜底通道只认正文/用量/结束/错误（架构 §3.7）
  "cli-stdio": ["message_delta", "usage", "done", "error"],
  // 私有 HTTP / SDK 通道尚无驱动：按「正文 + 工具 + 用量」保守声明
  "opencode-http": ["message_delta", "tool_call", "tool_result", "usage", "done", "error"],
  "claude-sdk": ["message_delta", "tool_call", "tool_result", "usage", "done", "error"],
  // 内置引擎：九类全支持（工具、计划、权限都由我们自己的 loop 产出）
  builtin: [
    "message_delta",
    "thought",
    "tool_call",
    "tool_result",
    "plan",
    "permission_request",
    "usage",
    "done",
    "error",
  ],
};

const PERMISSION_CHANNEL_BY_PROTOCOL: Record<ProtocolKind, PermissionChannel> = {
  acp: "acp-reverse",
  "codex-app-server": "jsonrpc-approval",
  "opencode-http": "none",
  "claude-sdk": "none",
  "cli-stdio": "none",
  builtin: "internal",
};

const RESUME_STRATEGY_BY_PROTOCOL: Record<ProtocolKind, ResumeStrategy> = {
  acp: "acp",
  "codex-app-server": "native",
  "opencode-http": "none",
  "claude-sdk": "native",
  // 一次 prompt 一个进程，上下文不跨进程保留
  "cli-stdio": "process-lifetime",
  // 历史在我们自己的内存/数据库里，重启后走产品层重建
  builtin: "native",
};

/** 探测默认值：与内置声明保持一致，用户不填也能工作。 */
const DEFAULT_VERSION_ARGS = ["--version"];
const DEFAULT_VERSION_PATTERN = "(?<version>\\d+\\.\\d+\\.\\d+)";
const DEFAULT_DETECT_TIMEOUT_MS = 3000;

export interface CustomRuntimeInput {
  id: string;
  displayName: string;
  protocol: ProtocolKind;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  detect?:
    | {
        command?: string | undefined;
        versionArgs?: string[] | undefined;
        versionPattern?: string | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined;
}

/**
 * 生成声明。
 *
 * `cwd` 只写进 `launch.cwd`（声明字段），不参与探测——探测沿用调用方进程的 cwd，
 * 与内置运行时一致；否则一个不存在的 cwd 会让「添加」直接失败。
 */
export function buildCustomDeclaration(input: CustomRuntimeInput): AdapterDeclaration {
  const detect = input.detect ?? {};
  const versionArgs =
    detect.versionArgs !== undefined && detect.versionArgs.length > 0
      ? [...detect.versionArgs]
      : [...DEFAULT_VERSION_ARGS];
  const versionPattern =
    detect.versionPattern !== undefined && detect.versionPattern.length > 0
      ? detect.versionPattern
      : DEFAULT_VERSION_PATTERN;

  const declaration: AdapterDeclaration = {
    schemaVersion: 1,
    id: input.id,
    displayName: input.displayName,
    protocol: input.protocol,
    launch: {
      command: input.command,
      args: input.args ?? [],
      ...(input.env !== undefined ? { env: { ...input.env } } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    },
    detect: {
      ...(detect.command !== undefined ? { command: detect.command } : {}),
      versionArgs,
      versionPattern,
      timeoutMs: detect.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS,
    },
    capabilities: {
      plan: "unknown",
      permissionRequest: "unknown",
      resume: "unknown",
      images: "unknown",
      streaming: "unknown",
      contextWindow: null,
    },
    eventCapabilities: [...EVENT_MASK_BY_PROTOCOL[input.protocol]],
    permission: {
      channel: PERMISSION_CHANNEL_BY_PROTOCOL[input.protocol],
      defaultTimeoutPolicy: "reject",
    },
    resumeStrategy: RESUME_STRATEGY_BY_PROTOCOL[input.protocol],
    executionLocations: ["local", "worktree"],
  };

  return declaration;
}
