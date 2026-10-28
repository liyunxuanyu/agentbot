import { randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";
import type { EventBus } from "../events/bus.js";
import { createIngest } from "../events/ingest.js";
import type { PermissionDecision, RuntimePermissionRequest } from "../../adapters/contract.js";
import type { BoundaryVerdict, PermissionAction, PermissionMode } from "../../../shared/events.js";
import { checkBoundary, readBoundary, type BoundarySnapshot } from "./boundary.js";
import * as grants from "./grants.js";
import {
  deadlinesOf,
  decideTimeoutPolicy,
  sweepExpired,
  type PermissionStatus,
  type SweepResult,
  type TimeoutPolicy,
  type TurnSource,
} from "./policy.js";

/**
 * 权限裁决（M6，架构 §6 的 ①②③④ 全流程）。
 *
 *   运行时抛出请求
 *     ① 归一化：action ∈ {write, read, exec, network}；target 解析为绝对路径
 *     ② 边界判定（用边界快照，不受后续修改影响）
 *          越界 → 直接 deny 应答运行时 + 写审计 + 推「超出 Bot 边界」（不弹卡、不占 120s）
 *     ③ 授权命中：preauth 且动作 ∈ 预授权集合 → 自动批准 + 审计
 *          或同 action_key 已有 grant（session/bot 域）→ 自动批准 + 审计
 *     ④ 生成卡片，按 timeout_policy 计时
 *
 * 两条纪律：
 *   ① **越界请求绝不转发运行时**（P0-09）：先写库、再 `respondPermission(reject)`，
 *      顺序不能反 —— 反了就可能出现「运行时已拒绝但库里没记录」的审计空洞。
 *   ② **审计以 `permission_requests` 为准**：它带 decision / decided_by / decided_at /
 *      boundary_snapshot / boundary_version，是唯一权威；events 里的
 *      `permission_request` 只负责「通知前端刷新」，不含决定（事件 payload 定稿为 4 字段）。
 *
 * 这个文件不 import 任何通道驱动：回传运行时的动作由装配层注入 `respond()`。
 */

export type DecideInput =
  | "approve"
  | "reject"
  | "remember_session"
  | "remember_bot";

export interface HandlePermissionInput {
  sessionId: string;
  botId: string;
  turnId: string;
  request: RuntimePermissionRequest;
  /** 触发来源：交互 / Assignment / 定时任务（决定三档超时）。 */
  source: TurnSource;
}

export interface DecisionResult {
  ok: boolean;
  /** 处理后的终态；`ok:false` 时无意义。 */
  status?: PermissionStatus;
  decision?: string;
  code?: "not_found" | "already_decided";
}

export interface PermissionResolverDeps {
  db: DB;
  bus?: EventBus;
  /** 会话进程是否还活着（hold 失效判定）。 */
  isSessionAlive(sessionId: string): boolean;
  /** 相对路径的解析基准（会话工作区优先，其次 Bot 的 repoPath / worktreePath）。 */
  sessionCwdOf(botId: string, sessionId?: string | null): string;
  /** 回传运行时；进程已不在返回 false。 */
  respond(sessionId: string, requestId: string, decision: PermissionDecision): Promise<boolean>;
  /** 挂起保活：hold 期间禁止空闲回收。 */
  setHeld(sessionId: string, held: boolean): void;
  /** 会话状态落库（waiting_permission / running）。 */
  setSessionStatus(sessionId: string, status: "waiting_permission" | "running" | "idle"): void;
  log?: (msg: string) => void;
  /** 测试注入：缩短 120s / 24h（默认取 config）。 */
  rejectTimeoutMs?: number;
  holdMaxMs?: number;
}

export interface PermissionRow {
  id: string;
  sessionId: string;
  botId: string;
  turnId: string;
  action: PermissionAction;
  target: string;
  boundaryVerdict: BoundaryVerdict;
  timeoutPolicy: TimeoutPolicy;
  status: PermissionStatus;
  heldSince: number | null;
  expiresAt: number | null;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

interface RawRow {
  id: string;
  session_id: string;
  bot_id: string;
  turn_id: string;
  action: string;
  target: string;
  boundary_snapshot: string;
  boundary_version: number;
  timeout_policy: string;
  status: string;
  held_since: number | null;
  expires_at: number | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}

export interface PermissionResolver {
  /** 驱动上报的权限请求入口（同步落库 + 立即裁决）。 */
  handle(input: HandlePermissionInput): Promise<void>;
  /** 用户决策。 */
  decide(requestId: string, decision: DecideInput, actor?: string): Promise<DecisionResult>;
  /** 会话内的权限记录（待批 + 已决，按创建时间升序）。 */
  listBySession(sessionId: string): PermissionRow[];
  /** 单个记录（路由层 404 判定）。 */
  get(requestId: string): PermissionRow | null;
  /** 进程退出：把该会话所有 pending 转「请求已失效」。 */
  invalidateSession(sessionId: string, reason: string): number;
  /**
   * 切到计划模式时，把该会话挂起的写类请求直接置为 rejected（G3）。
   * 返回被拒绝的条数；读类请求不动。
   */
  rejectPendingWrites(sessionId: string, reason: string): number;
  /**
   * 切到「完全访问」时，把该会话挂起的请求全部批准（2026-10-28 真机反馈）。
   *
   * 为什么必须处理：权限卡挂起期间运行时在等回传，会话锁一直被这一轮占着。
   * 用户改成「完全访问」后，**已经在等的那张卡不会自己消失** —— 旧实现要等
   * 120s 超时拒绝才放行，期间用户看到的是「界面一直转、命令很久才执行」，
   * 而且新消息只能排在锁后面。完全访问的语义是「全部自动批准」，那么已经
   * 挂起的请求也应当按同一口径批准，而不是让用户再点一次（卡片此时甚至可能
   * 因为前端切档而不再高亮）。
   *
   * 只动 `pending`；已决/已失效的审计不改写。返回被批准的条数。
   */
  approvePending(sessionId: string, reason: string): number;
  /** 扫一次过期（启动序 + 定时器）。 */
  sweep(): SweepResult;
  /** 清定时器（关服）。 */
  dispose(): void;
}

interface SnapshotPayload extends BoundarySnapshot {
  verdict: BoundaryVerdict;
  reason?: string;
  /**
   * 运行时侧的原始 requestId（回传时必须原样给它）。
   *
   * 为什么要单独存：驱动给的 requestId 只在**单个运行时进程内**唯一 ——
   * 每个新进程都从头计数（实测：进程回收重建后，第二张卡又是同一个数字）。
   * 而 `permission_requests.id` 是主键，直接用它当 id 会让第二张卡被当成
   * 「重复上报」静默丢掉 —— 用户看不到请求，运行时永远卡着。
   * 所以落库 id 重名时加后缀，回传用这里存的原始值。
   */
  runtimeRequestId?: string;
}

function parseSnapshot(json: string): SnapshotPayload {
  try {
    const v = JSON.parse(json) as Partial<SnapshotPayload>;
    return {
      allowDirs: Array.isArray(v.allowDirs) ? v.allowDirs.filter((d): d is string => typeof d === "string") : [],
      allowShell: v.allowShell === true,
      allowNetwork: v.allowNetwork === true,
      autoApproveWrite: v.autoApproveWrite === true,
      version: typeof v.version === "number" ? v.version : 0,
      verdict: v.verdict === "denied" ? "denied" : v.verdict === "allowed" ? "allowed" : "pending",
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
      ...(typeof v.runtimeRequestId === "string" ? { runtimeRequestId: v.runtimeRequestId } : {}),
    };
  } catch {
    // 快照坏了：按最严格的解释（越界）
    return {
      allowDirs: [],
      allowShell: false,
      allowNetwork: false,
      autoApproveWrite: false,
      version: 0,
      verdict: "denied",
      reason: "边界快照损坏，按拒绝处理",
    };
  }
}

function toRow(raw: RawRow): PermissionRow {
  const snap = parseSnapshot(raw.boundary_snapshot);
  const action: PermissionAction =
    raw.action === "write" ||
    raw.action === "exec" ||
    raw.action === "network" ||
    raw.action === "admin"
      ? raw.action
      : "read";
  const policy: TimeoutPolicy =
    raw.timeout_policy === "hold" ? "hold" : raw.timeout_policy === "preauth" ? "preauth" : "reject";
  return {
    id: raw.id,
    sessionId: raw.session_id,
    botId: raw.bot_id,
    turnId: raw.turn_id,
    action,
    target: raw.target,
    boundaryVerdict: snap.verdict,
    timeoutPolicy: policy,
    status: raw.status as PermissionStatus,
    heldSince: raw.held_since,
    expiresAt: raw.expires_at,
    decision: raw.decision,
    decidedBy: raw.decided_by,
    decidedAt: raw.decided_at,
    createdAt: raw.created_at,
  };
}

export function createPermissionResolver(deps: PermissionResolverDeps): PermissionResolver {
  const log = deps.log ?? ((msg: string) => console.warn(`[permissions] ${msg}`));
  const ingest = createIngest({ db: deps.db, ...(deps.bus ? { bus: deps.bus } : {}) });
  /** reject 型的内存定时器：120s 到点精确触发，不依赖 5min 扫描。 */
  const timers = new Map<string, NodeJS.Timeout>();
  /** 每会话 pending 计数：归零时解除保活。 */
  const pendingBySession = new Map<string, number>();
  let disposed = false;

  /** 落库 id 重名时加后缀（`1000` → `1000#2`）；不重名原样返回。 */
  function uniqueId(raw: string): string {
    if (!get(raw)) return raw;
    let n = 2;
    for (;;) {
      const candidate = `${raw}#${n}`;
      if (!get(candidate)) return candidate;
      n += 1;
    }
  }

  /**
   * 回传运行时用的 id：优先用快照里存的原始 requestId。
   *
   * 落库 id 可能是加了后缀的 `1000#2`，直接回传会让驱动找不到那个未决请求
   * （它只认自己发出的原始 id）。
   */
  function runtimeRequestIdOf(rowId: string): string {
    const raw = deps.db
      .prepare("SELECT boundary_snapshot FROM permission_requests WHERE id = ?")
      .get(rowId) as { boundary_snapshot: string } | undefined;
    if (!raw) return rowId;
    return parseSnapshot(raw.boundary_snapshot).runtimeRequestId ?? rowId;
  }

  // -------------------------------------------------------------------------
  // 落库与广播
  // -------------------------------------------------------------------------

  function insertRow(input: {
    id: string;
    sessionId: string;
    botId: string;
    turnId: string;
    action: PermissionAction;
    target: string;
    snapshot: SnapshotPayload;
    policy: TimeoutPolicy;
    status: PermissionStatus;
    heldSince: number | null;
    expiresAt: number | null;
    decision: string | null;
    decidedBy: string | null;
    decidedAt: number | null;
    now: number;
  }): void {
    deps.db
      .prepare(
        `INSERT INTO permission_requests
           (id, session_id, bot_id, turn_id, action, target, boundary_snapshot,
            boundary_version, timeout_policy, status, held_since, expires_at,
            decision, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.botId,
        input.turnId,
        input.action,
        input.target,
        JSON.stringify(input.snapshot),
        input.snapshot.version,
        input.policy,
        input.status,
        input.heldSince,
        input.expiresAt,
        input.decision,
        input.decidedBy,
        input.decidedAt,
        input.now,
      );
  }

  /**
   * 推一条 `permission_request` 事件。
   *
   * 为什么这里显式传 `['permission_request']` 作为能力掩码：这条事件是**核心生成的**，
   * 不是运行时上报的；即使运行时的声明里没有它（理论上不会 —— 没有就不该发请求），
   * 审计与卡片也必须出现在流里。
   */
  function emitEvent(
    row: { id: string; sessionId: string; turnId: string; action: PermissionAction; target: string },
    verdict: BoundaryVerdict,
  ): void {
    try {
      ingest(
        {
          sessionId: row.sessionId,
          messageId: null,
          turnId: row.turnId,
          eventCapabilities: ["permission_request"],
        },
        {
          type: "permission_request",
          turnId: row.turnId,
          ts: Date.now(),
          payload: {
            requestId: row.id,
            action: row.action,
            target: row.target,
            boundaryVerdict: verdict,
          },
        },
      );
    } catch (err) {
      log(`权限事件写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function countPending(sessionId: string): number {
    const row = deps.db
      .prepare("SELECT COUNT(*) AS n FROM permission_requests WHERE session_id = ? AND status = 'pending'")
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  function syncHold(sessionId: string): void {
    const n = countPending(sessionId);
    pendingBySession.set(sessionId, n);
    if (n > 0) {
      deps.setHeld(sessionId, true);
      deps.setSessionStatus(sessionId, "waiting_permission");
    } else {
      // 解除保活。**不要**在这里写 running：Turn 可能已经收口了（例如超时拒绝后
      // 运行时直接结束），硬写 running 会让会话永远停在「工作中」。
      // Supervisor 的 setHeld(false) 自己会按「有没有活跃 Turn」决定 running / idle。
      deps.setHeld(sessionId, false);
    }
  }

  function clearTimer(requestId: string): void {
    const t = timers.get(requestId);
    if (t) {
      clearTimeout(t);
      timers.delete(requestId);
    }
  }

  // -------------------------------------------------------------------------
  // 超时与失效
  // -------------------------------------------------------------------------

  function settleBySystem(
    row: { id: string; sessionId: string; turnId: string; action: PermissionAction; target: string },
    status: PermissionStatus,
    reason: string,
    opts: { respondReject: boolean },
  ): void {
    const now = Date.now();
    const decision = status === "invalidated" ? "invalidated" : "reject";
    const info = deps.db
      .prepare(
        `UPDATE permission_requests
            SET status = ?, decision = ?, decided_by = 'system', decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decision, now, row.id);
    if (info.changes === 0) return;

    clearTimer(row.id);
    emitEvent(row, "allowed");

    if (opts.respondReject) {
      void deps
        .respond(row.sessionId, runtimeRequestIdOf(row.id), { kind: "deny" })
        .catch(() => undefined);
    }
    log(`请求 ${row.id} → ${status}（${reason}）`);
    syncHold(row.sessionId);
  }

  function scheduleRejectTimer(row: PermissionRow): void {
    const ttl = deps.rejectTimeoutMs ?? (row.expiresAt === null ? 0 : row.expiresAt - Date.now());
    if (ttl <= 0) return;
    const timer = setTimeout(() => {
      timers.delete(row.id);
      const cur = get(row.id);
      if (!cur || cur.status !== "pending") return;
      settleBySystem(
        { id: cur.id, sessionId: cur.sessionId, turnId: cur.turnId, action: cur.action, target: cur.target },
        "denied_timeout",
        "超时自动拒绝",
        { respondReject: true },
      );
    }, ttl);
    timer.unref?.();
    timers.set(row.id, timer);
  }

  function get(requestId: string): PermissionRow | null {
    const raw = deps.db
      .prepare("SELECT * FROM permission_requests WHERE id = ?")
      .get(requestId) as RawRow | undefined;
    return raw ? toRow(raw) : null;
  }

  /**
   * 找「同一 Turn 内、原始 requestId 相同」的那条记录。
   *
   * 为什么不用 `get(rawId)`：原始 id 可能被别的 Turn 占用了（见 handle 里的说明），
   * 落库 id 带 `#n` 后缀，直接按 id 查会漏掉真正的重放。
   */
  function findByRuntimeId(rawId: string, turnId: string): PermissionRow | null {
    const rows = deps.db
      .prepare(
        `SELECT * FROM permission_requests
          WHERE turn_id = ? AND (id = ? OR id LIKE ?)
          ORDER BY created_at DESC`,
      )
      .all(turnId, rawId, `${rawId}#%`) as RawRow[];
    for (const raw of rows) {
      const snap = parseSnapshot(raw.boundary_snapshot);
      if ((snap.runtimeRequestId ?? raw.id) === rawId) return toRow(raw);
    }
    return null;
  }

  /** 会话级权限模式：`sessions.permission_mode` 是权威（创建时已从 Bot 默认值继承）。 */
  function permissionModeOf(sessionId: string): PermissionMode {
    const row = deps.db
      .prepare(
        `SELECT s.permission_mode AS session_mode, b.permission_mode AS bot_mode
           FROM sessions s LEFT JOIN bots b ON b.id = s.bot_id
          WHERE s.id = ?`,
      )
      .get(sessionId) as
      | { session_mode: string | null; bot_mode: string | null }
      | undefined;
    const mode = row?.session_mode ?? row?.bot_mode ?? "confirm";
    return mode === "auto" || mode === "plan" || mode === "full" ? mode : "confirm";
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------

  async function handle(input: HandlePermissionInput): Promise<void> {
    if (disposed) return;
    const { sessionId, botId, turnId, source } = input;
    const request = input.request;
    const now = Date.now();

    // 同一 Turn 内同 requestId 再次上报 = 驱动重放：只重推一次事件，不重复落库。
    // **不同 Turn 复用同一个 id 是正常的**（requestId 只在单个运行时进程内唯一，
    // 进程回收重建后第二张卡又是同一个数字）—— 那种情况必须落成新卡，
    // 否则用户看不到请求、运行时永远卡着。下面用 uniqueId 加后缀区分。
    const existing = findByRuntimeId(request.requestId, turnId);
    if (existing) {
      emitEvent(
        { id: existing.id, sessionId, turnId, action: existing.action, target: existing.target },
        existing.boundaryVerdict,
      );
      return;
    }
    // 落库 id：原始 id 已被占用就加后缀。原始 id 记进快照，回传运行时用它。
    const rowId = uniqueId(request.requestId);

    const boundary = readBoundary(deps.db, botId);
    if (!boundary) {
      log(`Bot 不存在，权限请求按越界拒绝：${botId}`);
      rejectOutOfBoundary(
        input,
        rowId,
        {
          allowDirs: [],
          allowShell: false,
          allowNetwork: false,
          autoApproveWrite: false,
          version: 0,
        },
        "Bot 不存在",
        now,
      );
      return;
    }

    // ① 归一化 + ② 边界判定
    //
    // 四档权限模式在边界之前裁决（R5 / Q17）：
    //   plan  → 写类动作直接拒绝（工具已被裁掉，这里兜底）
    //   full  → 绕过边界，全部批准并写审计
    //   auto  → 边界内写自动批，shell/network 仍问
    //   confirm → 既有「边界 → 授权 → 用户」流程
    const mode = permissionModeOf(sessionId);

    if (mode === "plan") {
      if (request.action === "read") {
        // 只读模式：读请求不该挂起等用户（挂起会让会话卡死，而读本来就不改变磁盘）
        autoApprove(
          { sessionId, botId, turnId, request },
          rowId,
          { ...boundary, verdict: "allowed", reason: "计划模式：只读请求自动批准", runtimeRequestId: request.requestId },
          "preauth",
          "mode:plan",
          now,
          "mode:plan",
        );
        return;
      }
      denyByMode(
        input,
        rowId,
        boundary,
        "计划模式（只读）：写操作已被拒绝",
        "mode:plan",
        now,
      );
      return;
    }

    const cwd = deps.sessionCwdOf(botId, sessionId);
    const check = checkBoundary(boundary, request.action, request.target, cwd);

    if (mode === "full") {
      const snapshot: SnapshotPayload = {
        ...boundary,
        verdict: "allowed",
        reason: "完全访问模式：绕过边界，自动批准并记审计",
        runtimeRequestId: request.requestId,
      };
      autoApprove(
        { sessionId, botId, turnId, request: { ...request, target: check.target } },
        rowId,
        snapshot,
        "preauth",
        "mode:full",
        now,
        "mode:full",
      );
      return;
    }

    const snapshot: SnapshotPayload = {
      ...boundary,
      verdict: check.verdict,
      runtimeRequestId: request.requestId,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
    };

    // 「还没配边界」和「明确配了边界但这次越界」要区别对待（2026-10-28 真机反馈）：
    //
    //   默认新建的 Bot `allow_dirs` 是空数组。旧实现把写请求直接判成
    //   denied_boundary、**不弹卡**，用户在手机上只看到 Bot 说「被拒绝了」，
    //   既没有确认框、也不知道要去配置边界 —— 这就是「权限弹窗不弹出」的根因。
    //
    //   confirm 模式下，**未配置允许目录**的写请求改为落 pending 卡片：
    //   边界判定仍记 `denied`（卡片与审计都提示「超出边界」），
    //   用户批准只放行这一次，不批按 120s 超时拒绝 —— 安全默认不变。
    //
    //   auto / full 不变：auto 直接拒绝（「别烦我」的语义），full 绕过边界。
    //   已经配置了允许目录、但目标不在其中的请求仍直接拒绝：那是**明确的**边界。
    const promptUnconfiguredWrite =
      check.verdict === "denied" &&
      mode === "confirm" &&
      request.action === "write" &&
      boundary.allowDirs.length === 0;

    if (check.verdict === "denied" && !promptUnconfiguredWrite) {
      rejectOutOfBoundary(
        input,
        rowId,
        boundary,
        check.reason ?? "超出 Bot 边界",
        now,
        check.target,
      );
      return;
    }

    if (promptUnconfiguredWrite) {
      log(`请求 ${rowId} 超出边界（未配置允许目录），confirm 模式转人工确认`);
    }

    // 自动模式（R5 口径 B，2026-10-28 定稿）：只自动批「边界内的写」；
    // shell/network/admin 仍然弹卡。auto 下的越界写已在上面直接拒绝（不弹卡）——
    // auto 的语义是「别烦我」，越界弹卡等于退回 confirm。
    if (mode === "auto" && request.action === "write" && check.verdict === "allowed") {
      const autoSnapshot: SnapshotPayload = {
        ...snapshot,
        reason: "自动模式：边界内写操作自动批准",
      };
      autoApprove(
        { sessionId, botId, turnId, request: { ...request, target: check.target } },
        rowId,
        autoSnapshot,
        "preauth",
        "mode:auto",
        now,
        "mode:auto",
      );
      return;
    }

    // ③ 授权命中（grant / preauth）
    const actionKey = grants.actionKeyOf(request.action, check.target);
    const policy = decideTimeoutPolicy({
      source,
      action: request.action,
      boundaryVerdict: check.verdict,
      autoApproveWrite: boundary.autoApproveWrite,
    });

    const grant = grants.findGrant(deps.db, { botId, sessionId, actionKey, now });
    if (grant) {
      autoApprove(
        { sessionId, botId, turnId, request: { ...request, target: check.target } },
        rowId,
        snapshot,
        policy,
        `grant:${grant.scope}`,
        now,
      );
      return;
    }
    if (policy === "preauth") {
      autoApprove(
        { sessionId, botId, turnId, request: { ...request, target: check.target } },
        rowId,
        snapshot,
        policy,
        "preauth",
        now,
      );
      return;
    }

    // ④ 生成卡片，按 timeout_policy 计时
    if (!deps.isSessionAlive(sessionId)) {
      // 进程已经没了：直接失效，不占 24h（P0-08 边界处理）
      insertRow({
        id: rowId,
        sessionId,
        botId,
        turnId,
        action: request.action,
        target: check.target,
        snapshot,
        policy,
        status: "invalidated",
        heldSince: null,
        expiresAt: null,
        decision: "invalidated",
        decidedBy: "system",
        decidedAt: now,
        now,
      });
      emitEvent(
        { id: rowId, sessionId, turnId, action: request.action, target: check.target },
        check.verdict,
      );
      return;
    }

    const deadlines = deadlinesOf(policy, now, {
      ...(deps.rejectTimeoutMs === undefined ? {} : { rejectMs: deps.rejectTimeoutMs }),
      ...(deps.holdMaxMs === undefined ? {} : { holdMaxMs: deps.holdMaxMs }),
    });

    insertRow({
      id: rowId,
      sessionId,
      botId,
      turnId,
      action: request.action,
      target: check.target,
      snapshot,
      policy,
      status: "pending",
      heldSince: deadlines.heldSince,
      expiresAt: deadlines.expiresAt,
      decision: null,
      decidedBy: null,
      decidedAt: null,
      now,
    });

    emitEvent(
      { id: rowId, sessionId, turnId, action: request.action, target: check.target },
      check.verdict,
    );
    syncHold(sessionId);

    if (policy === "reject") {
      scheduleRejectTimer({
        id: rowId,
        sessionId,
        botId,
        turnId,
        action: request.action,
        target: check.target,
        boundaryVerdict: check.verdict,
        timeoutPolicy: policy,
        status: "pending",
        heldSince: null,
        expiresAt: deadlines.expiresAt,
        decision: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: now,
      });
    }
  }

  /** 权限模式拒绝（plan）：落审计、回传拒绝、推事件，不弹卡。 */
  function denyByMode(
    input: HandlePermissionInput,
    rowId: string,
    boundary: BoundarySnapshot,
    reason: string,
    decidedBy: string,
    now: number,
  ): void {
    const snapshot: SnapshotPayload = {
      ...boundary,
      verdict: "denied",
      reason,
      runtimeRequestId: input.request.requestId,
    };
    insertRow({
      id: rowId,
      sessionId: input.sessionId,
      botId: input.botId,
      turnId: input.turnId,
      action: input.request.action,
      target: input.request.target,
      snapshot,
      policy: "reject",
      status: "denied_mode",
      heldSince: null,
      expiresAt: null,
      decision: "reject",
      decidedBy,
      decidedAt: now,
      now,
    });
    void deps
      .respond(input.sessionId, input.request.requestId, { kind: "deny" })
      .catch(() => undefined);
    emitEvent(
      {
        id: rowId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        action: input.request.action,
        target: input.request.target,
      },
      "denied",
    );
    log(`请求 ${rowId} 被权限模式拒绝（${reason}）`);
  }

  /** 越界：直接拒绝，不弹卡、不占 120s、不转发运行时。 */
  function rejectOutOfBoundary(
    input: HandlePermissionInput,
    rowId: string,
    boundary: BoundarySnapshot,
    reason: string,
    now: number,
    target?: string,
  ): void {
    const finalTarget = target ?? input.request.target;
    const snapshot: SnapshotPayload = {
      ...boundary,
      verdict: "denied",
      reason,
      runtimeRequestId: input.request.requestId,
    };
    // 越界请求的 timeout_policy 按来源记录（审计需要能回答「当时该等多久」）
    const policy = decideTimeoutPolicy({
      source: input.source,
      action: input.request.action,
      boundaryVerdict: "denied",
      autoApproveWrite: boundary.autoApproveWrite,
    });

    insertRow({
      id: rowId,
      sessionId: input.sessionId,
      botId: input.botId,
      turnId: input.turnId,
      action: input.request.action,
      target: finalTarget,
      snapshot,
      policy,
      status: "denied_boundary",
      heldSince: null,
      expiresAt: null,
      decision: "reject",
      decidedBy: "system",
      decidedAt: now,
      now,
    });

    // 先落库再回传：反了会出现「运行时已拒绝但库里没记录」的审计空洞
    void deps
      .respond(input.sessionId, input.request.requestId, { kind: "deny" })
      .catch(() => undefined);

    emitEvent(
      {
        id: rowId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        action: input.request.action,
        target: finalTarget,
      },
      "denied",
    );
    log(`请求 ${rowId} 超出边界（${reason}），已直接拒绝`);
  }

  /** 自动批准（grant / preauth / 权限模式）：只写审计，不弹卡。 */
  function autoApprove(
    input: {
      sessionId: string;
      botId: string;
      turnId: string;
      request: { requestId: string; action: PermissionAction; target: string };
    },
    rowId: string,
    snapshot: SnapshotPayload,
    policy: TimeoutPolicy,
    by: string,
    now: number,
    decidedBy = "system",
  ): void {
    insertRow({
      id: rowId,
      sessionId: input.sessionId,
      botId: input.botId,
      turnId: input.turnId,
      action: input.request.action,
      target: input.request.target,
      snapshot,
      policy,
      status: "decided",
      heldSince: null,
      expiresAt: null,
      decision: "approve",
      decidedBy,
      decidedAt: now,
      now,
    });
    void deps
      .respond(input.sessionId, input.request.requestId, { kind: "approve", scope: "once" })
      .catch(() => undefined);
    emitEvent(
      {
        id: rowId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        action: input.request.action,
        target: input.request.target,
      },
      snapshot.verdict,
    );
    log(`请求 ${input.request.requestId} 自动批准（${by}）`);
  }

  async function decide(
    requestId: string,
    decision: DecideInput,
    actor = "user",
  ): Promise<DecisionResult> {
    const row = get(requestId);
    if (!row) return { ok: false, code: "not_found" };
    if (row.status !== "pending") {
      return { ok: false, code: "already_decided", status: row.status };
    }

    const now = Date.now();
    const approve = decision !== "reject";

    // 记住：先写 grant，再落终态 —— 反过来的话中途崩溃会留下「已批准但没记住」
    if (decision === "remember_session" || decision === "remember_bot") {
      grants.createGrant(deps.db, {
        botId: row.botId,
        sessionId: row.sessionId,
        actionKey: grants.actionKeyOf(row.action, row.target),
        scope: decision === "remember_session" ? "session" : "bot",
        now,
      });
    }

    const delivered = await deps
      .respond(
        row.sessionId,
        runtimeRequestIdOf(requestId),
        approve ? { kind: "approve", scope: "once" } : { kind: "deny" },
      )
      .catch(() => false);

    // 运行时已退出：卡片必须如实转「请求已失效」，不能假装批准成功
    if (!delivered) {
      const info = deps.db
        .prepare(
          `UPDATE permission_requests
              SET status = 'invalidated', decision = 'invalidated',
                  decided_by = 'system', decided_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(now, requestId);
      clearTimer(requestId);
      if (info.changes > 0) {
        emitEvent(
          { id: row.id, sessionId: row.sessionId, turnId: row.turnId, action: row.action, target: row.target },
          row.boundaryVerdict,
        );
        syncHold(row.sessionId);
      }
      return { ok: true, status: "invalidated", decision: "invalidated" };
    }

    const decisionText = approve ? "approve" : "reject";
    const info = deps.db
      .prepare(
        `UPDATE permission_requests
            SET status = 'decided', decision = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(decisionText, actor, now, requestId);
    clearTimer(requestId);

    if (info.changes > 0) {
      emitEvent(
        { id: row.id, sessionId: row.sessionId, turnId: row.turnId, action: row.action, target: row.target },
        row.boundaryVerdict,
      );
      syncHold(row.sessionId);
    }

    return { ok: true, status: "decided", decision: decisionText };
  }

  function listBySession(sessionId: string): PermissionRow[] {
    const rows = deps.db
      .prepare(
        `SELECT * FROM permission_requests
          WHERE session_id = ?
          ORDER BY created_at ASC`,
      )
      .all(sessionId) as RawRow[];
    return rows.map(toRow);
  }

  /**
   * 切到 plan：挂起的写类请求直接拒绝（G3）。
   *
   * 为什么不是「等用户点拒绝」：计划模式的语义是「不能写」。挂着一张写权限卡
   * 会让用户以为批准后还能写，与胶囊显示的只读状态矛盾。
   */
  function rejectPendingWrites(sessionId: string, reason: string): number {
    const rows = deps.db
      .prepare(
        `SELECT id, session_id, turn_id, action, target FROM permission_requests
          WHERE session_id = ? AND status = 'pending'
            AND action IN ('write','exec','network','admin')`,
      )
      .all(sessionId) as {
      id: string;
      session_id: string;
      turn_id: string;
      action: string;
      target: string;
    }[];

    if (rows.length === 0) return 0;
    const now = Date.now();
    const update = deps.db.prepare(
      `UPDATE permission_requests
          SET status = 'denied_mode', decision = 'reject',
              decided_by = 'mode:plan', decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    let changed = 0;
    for (const row of rows) {
      if (update.run(now, row.id).changes === 0) continue;
      changed += 1;
      clearTimer(row.id);
      void deps
        .respond(sessionId, runtimeRequestIdOf(row.id), { kind: "deny" })
        .catch(() => undefined);
      emitEvent(
        {
          id: row.id,
          sessionId,
          turnId: row.turn_id,
          action: row.action as PermissionAction,
          target: row.target,
        },
        "denied",
      );
    }
    if (changed > 0) {
      log(`会话 ${sessionId} 切到计划模式：${changed} 个挂起写请求已拒绝（${reason}）`);
      pendingBySession.set(sessionId, countPending(sessionId));
      syncHold(sessionId);
    }
    return changed;
  }

  /**
   * 切到「完全访问」：挂起中的请求全部批准（见接口上的说明）。
   *
   * 实现刻意与 `rejectPendingWrites` 同构：逐条「先落终态、再回传运行时」，
   * 回传失败（进程已退出）不回滚 —— 审计以落库为准，`syncHold` 会解除保活。
   */
  function approvePending(sessionId: string, reason: string): number {
    const rows = deps.db
      .prepare(
        `SELECT id, session_id, turn_id, action, target FROM permission_requests
          WHERE session_id = ? AND status = 'pending'`,
      )
      .all(sessionId) as {
      id: string;
      session_id: string;
      turn_id: string;
      action: string;
      target: string;
    }[];

    if (rows.length === 0) return 0;
    const now = Date.now();
    const update = deps.db.prepare(
      `UPDATE permission_requests
          SET status = 'decided', decision = 'approve',
              decided_by = 'mode:full', decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    let changed = 0;
    for (const row of rows) {
      if (update.run(now, row.id).changes === 0) continue;
      changed += 1;
      clearTimer(row.id);
      void deps
        .respond(sessionId, runtimeRequestIdOf(row.id), { kind: "approve", scope: "once" })
        .catch(() => undefined);
      emitEvent(
        {
          id: row.id,
          sessionId,
          turnId: row.turn_id,
          action: row.action as PermissionAction,
          target: row.target,
        },
        "allowed",
      );
    }
    if (changed > 0) {
      log(`会话 ${sessionId} 切到完全访问：${changed} 个挂起请求已批准（${reason}）`);
      pendingBySession.set(sessionId, countPending(sessionId));
      syncHold(sessionId);
    }
    return changed;
  }

  function invalidateSession(sessionId: string, reason: string): number {
    const rows = deps.db
      .prepare(
        `SELECT id, session_id, turn_id, action, target FROM permission_requests
          WHERE session_id = ? AND status = 'pending'`,
      )
      .all(sessionId) as { id: string; session_id: string; turn_id: string; action: string; target: string }[];

    if (rows.length === 0) return 0;
    const now = Date.now();
    const update = deps.db.prepare(
      `UPDATE permission_requests
          SET status = 'invalidated', decision = 'invalidated',
              decided_by = 'system', decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    let changed = 0;
    for (const row of rows) {
      if (update.run(now, row.id).changes === 0) continue;
      changed += 1;
      clearTimer(row.id);
      emitEvent(
        {
          id: row.id,
          sessionId,
          turnId: row.turn_id,
          action: row.action as PermissionAction,
          target: row.target,
        },
        "allowed",
      );
    }
    if (changed > 0) {
      log(`会话 ${sessionId} 的 ${changed} 个待批请求已失效（${reason}）`);
      pendingBySession.set(sessionId, countPending(sessionId));
      deps.setHeld(sessionId, false);
    }
    return changed;
  }

  function sweep(): SweepResult {
    return sweepExpired({
      db: deps.db,
      isSessionAlive: deps.isSessionAlive,
      onSettled: (row, status, reason) => {
        clearTimer(row.id);
        emitEvent(
          {
            id: row.id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            action: row.action as PermissionAction,
            target: row.target,
          },
          "allowed",
        );
        // 超时/挤占都要回传拒绝：否则运行时永远等在这个请求上
        if (status === "denied_timeout" || status === "denied_hard_timeout" || status === "invalidated") {
          if (deps.isSessionAlive(row.session_id)) {
            void deps
              .respond(row.session_id, runtimeRequestIdOf(row.id), { kind: "deny" })
              .catch(() => undefined);
          }
        }
        syncHold(row.session_id);
        log(`请求 ${row.id} → ${status}（${reason}）`);
      },
    });
  }

  return {
    handle,
    decide,
    listBySession,
    get,
    invalidateSession,
    rejectPendingWrites,
    approvePending,
    sweep,
    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      pendingBySession.clear();
    },
  };
}

/** 生成一条新请求 id（通道没给 requestId 时用）。 */
export function newPermissionId(): string {
  return `perm_${randomUUID()}`;
}
