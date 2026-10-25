import { spawn } from "node:child_process";
import type {
  AdapterDeclaration,
  CapabilitySet,
  ChannelDriver,
  HealthStatus,
  ProbeResult,
  Tri,
} from "./contract.js";
import {
  effectiveDetectCommand,
  effectiveLaunchCommand,
  resolveCommand,
  resolveLaunch,
} from "./launch.js";

/**
 * 能力探测与降级（架构 §3.8，C3 落地点）。
 *
 *   并发探测所有声明（互不阻塞，单项 3s 超时）
 *     ① detect：spawn versionArgs → 正则取版本 → semver 比较 minVersion
 *     ② health：通道 start + initialize（10s 超时）
 *          成功 → 能力合并 probed ?? declared ?? 'unknown'，source='probed'
 *          失败/超时 → healthStatus='unhealthy'，用声明值，source='declared'
 *
 * **探测失败 ≠ 不支持**：三态 `Tri` 把「没测出来」原样传给 UI 画虚线徽标。
 * 这是本文件最重要的一条不变量，任何「猜一个 false」的冲动都要抵制。
 *
 * 两层状态词表（不要混用）：
 *   - `ProbeResult.healthStatus`（契约层）：healthy | unhealthy | unprobed
 *   - `ProbeOutcome.availability`（展示层）：ready | missing | timeout | unhealthy | unprobed
 *   后者给 UI 用，能区分「没装」和「装了但初始化失败」——两者文案完全不同（P0-01/P0-02）。
 */

export interface ProbeInput {
  declaration: AdapterDeclaration;
  /** 通道驱动；缺省时只做 detect，健康态记 unprobed。 */
  driver?: ChannelDriver;
  /** 覆盖探测超时（测试用）。 */
  detectTimeoutMs?: number;
}

export interface VersionDetectResult {
  version: string | null;
  /** null 表示无法判断（没测出来，不是「版本不够」）。 */
  meetsMinVersion: boolean | null;
  /** 命令是否存在于 PATH（决定 UI 显示「未安装」还是「检测超时」）。 */
  found: boolean;
  timedOut: boolean;
  detail?: string;
}

/** 展示层可用性。前端 `RuntimeSummary.healthStatus` 用的就是这一套词。 */
export type RuntimeAvailability = "ready" | "missing" | "timeout" | "unhealthy" | "unprobed";

export interface ProbeOutcome extends ProbeResult {
  availability: RuntimeAvailability;
  /** 该声明是否满足最低版本要求；null = 无法判断。 */
  meetsMinVersion: boolean | null;
  /** 命中的可执行文件路径（用户要看「它到底跑的是哪个」）。 */
  executable: string | null;
}

const DEFAULT_DETECT_MS = 3000;

/** 只比 x.y.z 三段数字；预发布后缀忽略，够用且不引依赖。 */
function parseVersion(v: string): number[] | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 跑一次 `--version` 类命令并正则取版本；超时/非零退出都算「没测出来」。 */
export function detectVersion(
  decl: AdapterDeclaration,
  timeoutOverrideMs?: number,
): Promise<VersionDetectResult> {
  const command = effectiveDetectCommand(decl);
  const timeoutMs = timeoutOverrideMs ?? decl.detect.timeoutMs ?? DEFAULT_DETECT_MS;

  // 先判存在：区分「未安装」与「装了但跑不起来」，UI 文案不同
  const executable = resolveCommand(command);
  if (!executable) {
    return Promise.resolve({
      version: null,
      meetsMinVersion: null,
      found: false,
      timedOut: false,
      detail: `命令不存在：${command}`,
    });
  }

  return new Promise<VersionDetectResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (r: VersionDetectResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // .cmd 外壳与 .cjs 脚本不能直接 spawn（Windows 会 EINVAL），先解析成真实目标
    const launch = resolveLaunch(executable, decl.detect.versionArgs);

    let child;
    try {
      // shell:false + args 数组，永不拼接字符串（§8 命令注入）
      child = spawn(launch.command, launch.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        version: null,
        meetsMinVersion: null,
        found: true,
        timedOut: false,
        detail: `无法启动 ${command}：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({
        version: null,
        meetsMinVersion: null,
        found: true,
        timedOut: true,
        detail: `${timeoutMs}ms 内无响应`,
      });
    }, timeoutMs);
    timer.unref?.();

    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        version: null,
        meetsMinVersion: null,
        found: true,
        timedOut: false,
        detail: `启动失败：${err.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0 && out.trim() === "") {
        finish({
          version: null,
          meetsMinVersion: null,
          found: true,
          timedOut: false,
          detail: `退出码 ${String(code)}`,
        });
        return;
      }
      const re = new RegExp(decl.detect.versionPattern);
      const m = re.exec(out);
      const raw = m ? (m.groups?.["version"] ?? m[1] ?? m[0]) : null;
      if (!raw) {
        finish({
          version: null,
          meetsMinVersion: null,
          found: true,
          timedOut: false,
          detail: "版本号无法从输出中解析",
        });
        return;
      }
      const meets = decl.minVersion ? compareVersion(raw, decl.minVersion) >= 0 : true;
      finish({ version: raw, meetsMinVersion: meets, found: true, timedOut: false });
    });
  });
}

/** 实测优先，实测缺失退回声明值；两者都没有才是 unknown。 */
function mergeTri(probed: Tri | undefined, declared: Tri): Tri {
  if (probed !== undefined && probed !== "unknown") return probed;
  return declared;
}

function declaredCapabilities(decl: AdapterDeclaration): CapabilitySet {
  return { ...decl.capabilities };
}

/** 把实测能力合并到声明能力上；没有任何实测项时等价于声明值。 */
export function mergeCapabilities(
  decl: AdapterDeclaration,
  probed?: Partial<CapabilitySet> | null,
): CapabilitySet {
  const base = declaredCapabilities(decl);
  if (!probed) return base;
  return {
    plan: mergeTri(probed.plan, base.plan),
    permissionRequest: mergeTri(probed.permissionRequest, base.permissionRequest),
    resume: mergeTri(probed.resume, base.resume),
    images: mergeTri(probed.images, base.images),
    streaming: mergeTri(probed.streaming, base.streaming),
    contextWindow: probed.contextWindow ?? base.contextWindow,
  };
}

function healthToStatus(health: HealthStatus, meets: boolean | null): HealthStatus {
  if (meets === false) return "unhealthy";
  return health;
}

/**
 * 探测单个声明。
 *
 * 判定顺序（与 UI 文案一一对应）：
 *   命令不存在           → availability='missing'（「未安装」）
 *   版本检测超时         → availability='timeout'（「检测超时」+ 重试）
 *   版本低于 minVersion  → availability='unhealthy'（「需要 ≥ x.y」）
 *   无驱动               → availability='unprobed'（只探测到版本）
 *   驱动 initialize 失败 → availability='unhealthy'（「健康检查失败」）
 *   全部通过             → availability='ready'
 */
export async function probeDeclaration(input: ProbeInput): Promise<ProbeOutcome> {
  const { declaration, driver } = input;
  const detected = await detectVersion(declaration, input.detectTimeoutMs);
  const version = detected.version;
  const executable = resolveCommand(effectiveDetectCommand(declaration));

  const base: ProbeOutcome = {
    capabilities: mergeCapabilities(declaration),
    source: "declared",
    version,
    healthStatus: "unprobed",
    availability: "unprobed",
    meetsMinVersion: detected.meetsMinVersion,
    executable,
    ...(detected.detail === undefined ? {} : { detail: detected.detail }),
  };

  // ① 没装：最确定的一种，直接返回（不再做健康检查，省 10s）
  if (!detected.found) {
    return { ...base, availability: "missing" };
  }

  // ② 检测超时：如实标 timeout，不猜
  if (detected.timedOut) {
    return { ...base, availability: "timeout" };
  }

  // ③ 版本低于下限：置灰并给出「需要 ≥ x.y」（P0-02）
  if (detected.meetsMinVersion === false) {
    return {
      ...base,
      availability: "unhealthy",
      healthStatus: "unhealthy",
      detail: `需要 ≥ ${declaration.minVersion ?? "?"}，当前 ${version ?? "未知"}`,
    };
  }

  // ④ 启动命令不存在：版本命令可能是另一支（如 claude-code 的 ACP 桥接包），
  //    这种「能测到版本但根本起不来」的状态必须如实说 missing，而不是 unhealthy。
  //    否则用户看到「版本 2.1.302 · 健康检查失败」，猜不到是桥接包没装。
  const launchCommand = effectiveLaunchCommand(declaration);
  if (resolveCommand(launchCommand) === null) {
    return {
      ...base,
      availability: "missing",
      healthStatus: "unhealthy",
      detail: `启动命令不存在：${launchCommand}（需先安装；或用 AGENTBOT_BIN_${declaration.id
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")} 指定路径）`,
    };
  }

  // ⑤ 驱动未接入：只做 detect，健康态如实留 unprobed
  if (!driver) {
    return base;
  }

  // ⑥ health：start + initialize，10s 超时；失败不致命
  let started;
  try {
    started = await withTimeout(
      driver.start(declaration, { cwd: process.cwd(), sessionId: `probe_${declaration.id}` }),
      10_000,
      "启动超时",
    );
  } catch (err) {
    return {
      ...base,
      availability: "unhealthy",
      healthStatus: "unhealthy",
      detail: err instanceof Error ? err.message : "启动失败",
    };
  }

  try {
    const probed = await withTimeout(driver.initialize(started), 10_000, "initialize 超时");
    const merged = mergeCapabilities(declaration, probed.capabilities);
    const healthy = probed.healthStatus === "healthy";
    return {
      capabilities: merged,
      // 只有真正拿到实测结果才标 probed；声明兜底必须诚实标 declared
      source: probed.source === "probed" ? "probed" : "declared",
      version,
      healthStatus: healthToStatus(probed.healthStatus, detected.meetsMinVersion),
      availability: healthy ? "ready" : "unhealthy",
      meetsMinVersion: detected.meetsMinVersion,
      executable,
      ...(probed.detail === undefined ? {} : { detail: probed.detail }),
    };
  } catch (err) {
    return {
      ...base,
      availability: "unhealthy",
      healthStatus: "unhealthy",
      detail: err instanceof Error ? err.message : "初始化失败",
    };
  } finally {
    await driver.dispose(started).catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 并发探测所有声明，结果按声明 id 索引；单个失败不影响其他项（P0-01）。 */
export async function probeAll(inputs: ProbeInput[]): Promise<Map<string, ProbeOutcome>> {
  const results = await Promise.all(
    inputs.map(async (input) => {
      try {
        const r = await probeDeclaration(input);
        return [input.declaration.id, r] as const;
      } catch (err) {
        // 兜底：探测本身抛错也不能让整页空掉
        const r: ProbeOutcome = {
          capabilities: mergeCapabilities(input.declaration),
          source: "declared",
          version: null,
          healthStatus: "unhealthy",
          availability: "unhealthy",
          meetsMinVersion: null,
          executable: null,
          detail: err instanceof Error ? err.message : "探测失败",
        };
        return [input.declaration.id, r] as const;
      }
    }),
  );
  return new Map(results);
}

// ---------------------------------------------------------------------------
// 缓存（架构 §3.8：探测结果写 runtime_definitions，渲染只读缓存）
// ---------------------------------------------------------------------------

/**
 * 只用到 prepare 的最小 SQL 句柄。
 *
 * 为什么不直接 import core/db 的 DB 类型：`scripts/check-boundaries.mjs` 明确禁止
 * adapters/ 依赖 core/db（通道驱动不访问数据库）。探测缓存是 adapter 侧的产物，
 * 但落库动作本身由装配层传进来一个连接即可 —— 依赖方向仍然是 core → adapters。
 */
export interface SqlHandle {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

export interface RuntimeRecord {
  id: string;
  adapterName: string;
  displayName: string;
  source: "builtin" | "custom";
  version: string | null;
  command: string;
  protocol: string;
  capabilities: CapabilitySet;
  eventCapabilities: string[];
  minVersion: string | null;
  healthStatus: string;
  probeDetail: string | null;
  lastProbeAt: number | null;
  availability: RuntimeAvailability;
  executable: string | null;
  meetsMinVersion: boolean | null;
  /** 能力值的真实来源：实测 or 声明兜底（渲染徽标时要说清楚）。 */
  capabilitiesSource: "probed" | "declared";
  /**
   * 权限请求通道（声明的 `permission.channel`）。
   *
   * 存在 `capabilities._probe` 保留键里（与 availability 等展示字段同一处），
   * 因此不需要改 schema。`'none'` 意味着产品层收不到授权请求 —— 该运行时的
   * Bot 必须跑在 worktree（见 core/permissions/worktree-guard.ts）。
   */
  permissionChannel: string | null;
}

/**
 * 把探测结果写进 `runtime_definitions`（幂等 upsert）。
 *
 * 为什么缓存：渲染时探测会让页面每刷一次就等 3–10s（P0-01 要求 5s 内列出）。
 * 缓存里同时存 availability / executable / meetsMinVersion（放在 capabilities JSON 的
 * 一个保留键 `_probe` 下），避免为展示字段加 schema 变更 —— 架构要求零 schema 变更。
 *
 * `opts.source === 'custom'` 时把整份声明也塞进 capabilities JSON 的 `_declaration`
 * 保留键：自定义运行时没有 YAML 文件，重启后要靠它恢复声明（否则 Bot 绑着它却
 * 发不出消息）。`source` 列本身不在 DO UPDATE 里 —— 已存在的行是内置还是自定义，
 * 由创建它的那次写入决定，探测不该改写这个身份。
 */
export function persistProbe(
  db: SqlHandle,
  decl: AdapterDeclaration,
  outcome: ProbeOutcome,
  executablePath: string | null,
  opts: { source?: "builtin" | "custom" } = {},
): void {
  const now = Date.now();
  const source = opts.source ?? "builtin";
  const capabilities = {
    ...outcome.capabilities,
    // 保留键：不属于 CapabilitySet，读回时剥掉
    _probe: {
      availability: outcome.availability,
      executable: executablePath,
      meetsMinVersion: outcome.meetsMinVersion,
      source: outcome.source,
      // 权限通道也是声明参数：缓存里带一份，列表查询不必再读声明文件
      permissionChannel: decl.permission.channel,
    },
    // 自定义运行时：声明本身也缓存一份（重启后恢复用，见 readCustomDeclarations）
    ...(source === "custom" ? { _declaration: decl } : {}),
  };

  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, version, command, protocol,
        capabilities, event_capabilities, min_version, health_status, probe_detail,
        last_probe_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(adapter_name) DO UPDATE SET
       display_name = excluded.display_name,
       version = excluded.version,
       command = excluded.command,
       protocol = excluded.protocol,
       capabilities = excluded.capabilities,
       event_capabilities = excluded.event_capabilities,
       min_version = excluded.min_version,
       health_status = excluded.health_status,
       probe_detail = excluded.probe_detail,
       last_probe_at = excluded.last_probe_at`,
  ).run(
    decl.id,
    decl.id,
    decl.displayName,
    source,
    outcome.version,
    decl.launch.command,
    decl.protocol,
    JSON.stringify(capabilities),
    JSON.stringify(decl.eventCapabilities),
    decl.minVersion ?? null,
    outcome.availability,
    outcome.detail ?? null,
    now,
    now,
  );
}

/**
 * 新增一个自定义运行时（尚未探测）。
 *
 * 先落一行 `health_status='unprobed'` 再探测：探测函数按 id 从库里读声明，
 * 且「添加失败但行已存在」比「探测完成才发现写不进去」更容易恢复 ——
 * 用户重试一次就够。
 */
export function insertCustomRuntime(db: SqlHandle, decl: AdapterDeclaration): void {
  const now = Date.now();
  const capabilities = {
    ...decl.capabilities,
    _probe: {
      availability: "unprobed",
      executable: null,
      meetsMinVersion: null,
      source: "declared",
      permissionChannel: decl.permission.channel,
    },
    _declaration: decl,
  };

  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, version, command, protocol,
        capabilities, event_capabilities, min_version, health_status, probe_detail,
        last_probe_at, created_at)
     VALUES (?, ?, ?, 'custom', NULL, ?, ?, ?, ?, NULL, 'unprobed', NULL, NULL, ?)`,
  ).run(
    decl.id,
    decl.id,
    decl.displayName,
    decl.launch.command,
    decl.protocol,
    JSON.stringify(capabilities),
    JSON.stringify(decl.eventCapabilities),
    now,
  );
}

/**
 * 读回自定义运行时的声明（启动装配 / 单运行时重探用）。
 *
 * 只读 `source='custom'` 的行，且要求 `_declaration` 结构可辨认；损坏的行跳过
 * （一个坏行不该让整页运行时列表空掉）。
 */
export function readCustomDeclarations(db: SqlHandle): AdapterDeclaration[] {
  const rows = db
    .prepare(
      `SELECT id, capabilities FROM runtime_definitions
        WHERE source = 'custom' ORDER BY created_at ASC`,
    )
    .all() as { id: string; capabilities: string }[];

  const out: AdapterDeclaration[] = [];
  for (const row of rows) {
    const decl = declarationFromRow(row.id, row.capabilities);
    if (decl) out.push(decl);
  }
  return out;
}

/** 按 id 读一个自定义运行时的声明；不存在或损坏返回 null。 */
export function readCustomDeclaration(db: SqlHandle, runtimeId: string): AdapterDeclaration | null {
  const row = db
    .prepare(
      `SELECT id, capabilities FROM runtime_definitions
        WHERE id = ? AND source = 'custom'`,
    )
    .get(runtimeId) as { id: string; capabilities: string } | undefined;
  if (!row) return null;
  return declarationFromRow(row.id, row.capabilities);
}

function declarationFromRow(id: string, capabilitiesJson: string): AdapterDeclaration | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(capabilitiesJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = parsed["_declaration"];
  if (typeof raw !== "object" || raw === null) return null;
  const decl = raw as Partial<AdapterDeclaration>;
  // 只校验「驱动能否跑起来」必需的字段；其余按声明原样使用
  if (typeof decl.displayName !== "string" || decl.displayName.length === 0) return null;
  if (typeof decl.protocol !== "string") return null;
  if (typeof decl.launch?.command !== "string" || decl.launch.command.length === 0) return null;
  if (typeof decl.detect?.versionPattern !== "string") return null;
  if (!Array.isArray(decl.detect.versionArgs)) return null;
  if (!Array.isArray(decl.eventCapabilities)) return null;
  if (typeof decl.permission?.channel !== "string") return null;
  // id 以行主键为准：库里那一列才是身份
  return { ...(decl as AdapterDeclaration), id };
}

/** 读缓存：渲染路径只走这里，绝不在渲染时探测。 */
export function listRuntimes(db: SqlHandle): RuntimeRecord[] {
  const rows = db
    .prepare(
      `SELECT id, adapter_name, display_name, source, version, command, protocol,
              capabilities, event_capabilities, min_version, health_status,
              probe_detail, last_probe_at
         FROM runtime_definitions
        ORDER BY display_name ASC`,
    )
    .all() as {
    id: string;
    adapter_name: string;
    display_name: string;
    source: string;
    version: string | null;
    command: string;
    protocol: string;
    capabilities: string;
    event_capabilities: string;
    min_version: string | null;
    health_status: string;
    probe_detail: string | null;
    last_probe_at: number | null;
  }[];

  return rows.map((row) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(row.capabilities) as Record<string, unknown>;
    } catch {
      // 缓存坏了不能拖垮整页：退回「全部未知」
    }
    const probe = (parsed["_probe"] ?? {}) as Record<string, unknown>;
    const capabilities: CapabilitySet = {
      plan: triOf(parsed["plan"]),
      permissionRequest: triOf(parsed["permissionRequest"]),
      resume: triOf(parsed["resume"]),
      images: triOf(parsed["images"]),
      streaming: triOf(parsed["streaming"]),
      contextWindow: typeof parsed["contextWindow"] === "number" ? parsed["contextWindow"] : null,
    };
    let eventCapabilities: string[] = [];
    try {
      const list: unknown = JSON.parse(row.event_capabilities);
      if (Array.isArray(list)) eventCapabilities = list.filter((x): x is string => typeof x === "string");
    } catch {
      // 同上
    }

    return {
      id: row.id,
      adapterName: row.adapter_name,
      displayName: row.display_name,
      source: row.source === "custom" ? "custom" : "builtin",
      version: row.version,
      command: row.command,
      protocol: row.protocol,
      capabilities,
      eventCapabilities,
      minVersion: row.min_version,
      healthStatus: row.health_status,
      probeDetail: row.probe_detail,
      lastProbeAt: row.last_probe_at,
      availability: availabilityOf(row.health_status),
      executable: typeof probe["executable"] === "string" ? probe["executable"] : null,
      meetsMinVersion:
        typeof probe["meetsMinVersion"] === "boolean" ? probe["meetsMinVersion"] : null,
      capabilitiesSource: probe["source"] === "probed" ? "probed" : "declared",
      permissionChannel:
        typeof probe["permissionChannel"] === "string" ? probe["permissionChannel"] : null,
    };
  });
}

function triOf(v: unknown): Tri {
  return typeof v === "boolean" ? v : "unknown";
}

function availabilityOf(status: string): RuntimeAvailability {
  switch (status) {
    case "ready":
    case "missing":
    case "timeout":
    case "unhealthy":
    case "unprobed":
      return status;
    case "healthy":
      return "ready";
    default:
      return "unprobed";
  }
}
