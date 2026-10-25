import type { CanonicalEvent, EventType, MetaEventKind } from "../../shared/events.js";

/** 三态：探测失败不等于不支持。UI 用实线/实线灰/虚线三态区分。 */
export type Tri = boolean | "unknown";

export type ProtocolKind =
  | "acp"
  | "codex-app-server"
  | "opencode-http"
  | "claude-sdk"
  | "cli-stdio"
  | "builtin";

export type ExecutionLocation = "local" | "worktree";

export type TimeoutPolicy = "reject" | "hold" | "preauth";

export type PermissionChannel = "acp-reverse" | "jsonrpc-approval" | "none" | "internal";

export type ResumeStrategy = "acp" | "native" | "process-lifetime" | "none";

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface DetectSpec {
  command?: string;
  versionArgs: string[];
  /** 具名捕获组 `version` 或第一个数字组。 */
  versionPattern: string;
  timeoutMs?: number;
}

export interface CapabilitySet {
  plan: Tri;
  permissionRequest: Tri;
  resume: Tri;
  images: Tri;
  streaming: Tri;
  contextWindow: number | null;
}

export interface PermissionSpec {
  channel: PermissionChannel;
  defaultTimeoutPolicy: Exclude<TimeoutPolicy, "preauth">;
}

export interface AdapterModes {
  headless: boolean;
  /** headless 模式的配额倍率提示（[CC] 社区实测约 3×），只用于用量页标注。 */
  multiplierHint?: number;
}

/**
 * Adapter 声明：只填参数，不含逻辑。
 * 新增一个原生 ACP 运行时 = 新增一个这样的文件，零核心改动。
 */
export interface AdapterDeclaration {
  schemaVersion: 1;
  id: string;
  displayName: string;
  protocol: ProtocolKind;
  launch: LaunchSpec;
  detect: DetectSpec;
  minVersion?: string;
  capabilities: CapabilitySet;
  /** 该运行时实际能稳定产出的事件类型。未声明的类型在 ingest 处直接丢弃。 */
  eventCapabilities: EventType[];
  permission: PermissionSpec;
  resumeStrategy: ResumeStrategy;
  executionLocations: ExecutionLocation[];
  modes?: AdapterModes;
  /** 通道私有配置，核心不解读，原样透传给驱动。 */
  protocolOptions?: Record<string, unknown>;
}

export type HealthStatus = "healthy" | "unhealthy" | "unprobed";

export interface ProbeResult {
  capabilities: CapabilitySet;
  /** 能力值的来源：实测优先，实测失败退回声明值。 */
  source: "probed" | "declared";
  version: string | null;
  healthStatus: HealthStatus;
  detail?: string;
}

export interface SpawnContext {
  cwd: string;
  /** 每次 spawn 唯一，用于日志与进程追踪。 */
  sessionId: string;
  /** 会话归属的 Bot；内置引擎据此选供应商（其它通道不需要）。 */
  botId?: string;
  /** Bot 绑定的模型供应商 id；null/缺省时用默认供应商。 */
  providerId?: string | null;
  env?: Record<string, string>;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly runtimeSessionId: string | null;
}

export interface RuntimePermissionRequest {
  requestId: string;
  /** 通道层尽力归一，核心会再做一次绝对路径解析。 */
  action: "write" | "read" | "exec" | "network";
  target: string;
  detail?: unknown;
}

export interface ExitInfo {
  code: number | null;
  signal?: string;
  stderrTail: string;
}

export type PermissionDecision =
  | { kind: "approve"; scope: "once" | "session" | "bot" }
  | { kind: "deny" };

/**
 * 三个通道各实现一次。核心只调这些方法，永远不知道底下说的是哪种协议。
 */
export interface ChannelDriver {
  readonly protocol: ProtocolKind;

  start(decl: AdapterDeclaration, ctx: SpawnContext): Promise<SessionHandle>;
  /** 失败不致命：退化为使用声明里的能力值。 */
  initialize(h: SessionHandle): Promise<ProbeResult>;
  newSession(h: SessionHandle, opts: { cwd: string; systemPrompt?: string }): Promise<{ runtimeSessionId: string }>;
  resumeSession(h: SessionHandle, runtimeSessionId: string): Promise<{ ok: boolean; reason?: string }>;
  prompt(h: SessionHandle, input: { text: string }): Promise<void>;
  cancel(h: SessionHandle): Promise<void>;
  respondPermission(h: SessionHandle, requestId: string, decision: PermissionDecision): Promise<void>;

  onEvent(h: SessionHandle, cb: (e: CanonicalEvent) => void): void;
  onPermission(h: SessionHandle, cb: (req: RuntimePermissionRequest) => void): void;
  onExit(h: SessionHandle, cb: (info: ExitInfo) => void): void;

  dispose(h: SessionHandle): Promise<void>;
}

/** 通道驱动内部用的 meta 事件构造器，避免每个通道重复写样板。 */
export function metaEvent(turnId: string, kind: MetaEventKind, data?: unknown): CanonicalEvent<"meta"> {
  return { type: "meta", turnId, ts: Date.now(), payload: { kind, data } };
}
