import { homedir } from "node:os";
import { join } from "node:path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 所有可变状态都落在 ~/.agentbot，便于用户备份/删除，也避免污染安装目录。
 */
export const AGENTBOT_HOME = process.env.AGENTBOT_HOME ?? join(homedir(), ".agentbot");

export const config = {
  home: AGENTBOT_HOME,
  dbPath: join(AGENTBOT_HOME, "agentbot.db"),
  tokenPath: join(AGENTBOT_HOME, "token"),
  secretsPath: join(AGENTBOT_HOME, "secrets.json"),
  /** 内置引擎的模型供应商（含 apiKey，文件权限 0600）。 */
  providersPath: join(AGENTBOT_HOME, "providers.json"),
  /** MCP server 配置（stdio 命令与参数）。 */
  mcpPath: join(AGENTBOT_HOME, "mcp.json"),
  /** 技能目录：<name>/SKILL.md，与 ZCode 的约定一致。 */
  skillsDir: join(AGENTBOT_HOME, "skills"),
  worktreeRoot: join(AGENTBOT_HOME, "wt"),

  http: {
    host: "127.0.0.1",
    port: envInt("AGENTBOT_PORT", 8787),
  },

  limits: {
    /** 空闲会话进程保留时长；到期杀进程但保留 runtimeSessionId。 */
    idleReapMs: envInt("AGENTBOT_IDLE_REAP_MS", 10 * 60 * 1000),
    /** 同时挂起的权限请求上限，超出则最老的转「已失效」。 */
    maxHeldPermissions: envInt("AGENTBOT_MAX_HELD", 5),
    /** 单会话单轮事件上限，超出拒绝写入以防内存/磁盘被刷爆。 */
    maxEventsPerTurn: 20_000,
    /** 单个 Assignment 超时。 */
    assignmentTimeoutMs: 30 * 60 * 1000,
    /** Assignment 队列上限。 */
    assignmentQueueLimit: 5,
    /** 同一 Bot 同时执行的 Assignment 上限。 */
    assignmentConcurrent: 2,
    /** 每轮注入记忆的字符预算。 */
    memoryCharBudget: 6000,
    /** Session 消息数达到该值时自动生成摘要（P0-10）。 */
    summaryMessageThreshold: 40,
    /** 摘要条目字符上限（P0-10：≤500 字符）。 */
    summaryCharLimit: 500,
    /** 重建上下文时携带的最近消息条数。 */
    rebuildMessageWindow: 20,
    /** 周期定时任务最小间隔（分钟）。 */
    minScheduleIntervalMinutes: 5,
    /** 周期任务连续失败多少次自动暂停。 */
    scheduleFailurePauseThreshold: 3,
    /**
     * 群聊主持人决策超时。
     *
     * PRD 写「5s 内输出发言人列表」，那是产品感知目标；真实 CLI 运行时一轮就要
     * 20s+（实测 ZCode），按 5s 截断会让主持人永远超时、每次都降级。
     * 默认 20s，可用 `AGENTBOT_GROUP_DECISION_MS` 调整。
     */
    groupDecisionMs: envInt("AGENTBOT_GROUP_DECISION_MS", 20_000),
  },

  timeouts: {
    detectMs: 3000,
    initializeMs: 10_000,
    /** 交互会话权限卡片超时（reject 策略）。 */
    permissionRejectMs: 120_000,
    /** 无人值守（hold 策略）最长挂起。 */
    permissionHoldMaxMs: 24 * 60 * 60 * 1000,
    /** 记住本会话/本 Bot 的授权有效期。 */
    grantTtlMs: 12 * 60 * 60 * 1000,
    /** 同动作在此窗口内重复时复用已记住的授权。 */
    grantReuseWindowMs: 60_000,
  },

  retention: {
    /** 用户可选的保留天数；0 = 永久。 */
    defaultMessageDays: 0,
    usageDays: 365,
    auditDays: 365,
    worktreeGraceDays: 7,
    sweepIntervalMs: 24 * 60 * 60 * 1000,
  },

  sse: {
    heartbeatMs: 15_000,
    /** 每会话内存环形缓冲，重连先命中它。 */
    ringSize: 500,
    /** assistant 正文 flush 阈值，避免逐 token 落库。 */
    flushMs: 250,
    flushBytes: 2048,
  },
} as const;
