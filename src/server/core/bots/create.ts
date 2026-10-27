import { randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";
import {
  ensureWorktreeForBot,
  validateRepoPath,
  validateWorkingDir,
} from "../assignment/worktree.js";

/**
 * Bot 创建的唯一实现（R6 / M3）。
 *
 * `POST /api/bots` 与管理员工具 `create_bot` 共用这里，避免「工具能建出路由建不出的
 * Bot」或两套校验漂移。本文件不 import adapters：运行时与供应商是否存在由调用方
 * 以 `lookup` 注入（core 不依赖具体存储实现）。
 *
 * 规则（与既有路由一致）：
 *   - 名称必填、≤32 字符、全库唯一（含已归档：归档 Bot 还占着名字）；
 *   - 人格 ≤4000 字符；
 *   - 运行时无权限通道 → 强制 worktree 且仓库路径必填（安全底线，本轮不改）；
 *   - 内置引擎这类有权限通道的运行时：执行位置默认 local，工作区可空（R1）。
 */

export interface BotCreateLookup {
  runtimeExists(id: string): boolean;
  runtimeRequiresWorktree(id: string): boolean;
  runtimeDisplayName(id: string): string;
  providerExists(id: string): boolean;
}

export interface BotCreateInput {
  name: unknown;
  persona?: unknown;
  avatar?: unknown;
  runtimeId?: unknown;
  providerId?: unknown;
  executionLocation?: unknown;
  /** 工作区 / 仓库根路径；内置引擎可空（R1）。 */
  workspacePath?: unknown;
  /** 仅种子使用；路由与工具都创建普通成员。 */
  role?: "member" | "admin";
}

export interface BotCreateFieldError {
  field: "name" | "persona" | "runtimeId" | "providerId" | "executionLocation" | "repoPath";
  code: string;
  message: string;
}

export type BotCreateOutcome =
  | { ok: true; botId: string; name: string }
  | { ok: false; fields: BotCreateFieldError[] };

export interface BotCreateResult {
  outcome: BotCreateOutcome;
  /** 实际保存的执行位置（worktree 时调用方可能需要回报）。 */
  executionLocation?: "local" | "worktree";
  /** worktree 创建失败时的原因（保存仍然成功）。 */
  worktreeError?: string;
}

export function createBot(
  db: DB,
  input: BotCreateInput,
  lookup: BotCreateLookup,
): BotCreateResult {
  const fields: BotCreateFieldError[] = [];

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    fields.push({ field: "name", code: "required", message: "名称不能为空" });
  } else if (name.length > 32) {
    fields.push({ field: "name", code: "too_long", message: "名称最多 32 个字符" });
  } else {
    const dup = db.prepare("SELECT id FROM bots WHERE name = ?").get(name) as
      | { id: string }
      | undefined;
    if (dup) fields.push({ field: "name", code: "duplicate", message: `名称已被占用：${name}` });
  }

  const persona = typeof input.persona === "string" ? input.persona : "";
  if (persona.length > 4000) {
    fields.push({ field: "persona", code: "too_long", message: "人格最多 4000 个字符" });
  }

  let runtimeId: string | null = null;
  if (typeof input.runtimeId === "string" && input.runtimeId.length > 0) {
    if (!lookup.runtimeExists(input.runtimeId)) {
      fields.push({ field: "runtimeId", code: "not_found", message: "运行时不存在" });
    } else {
      runtimeId = input.runtimeId;
    }
  }

  let providerId: string | null = null;
  if (input.providerId !== undefined && input.providerId !== null && input.providerId !== "") {
    if (typeof input.providerId !== "string") {
      fields.push({ field: "providerId", code: "invalid_value", message: "供应商 id 无效" });
    } else if (!lookup.providerExists(input.providerId)) {
      fields.push({ field: "providerId", code: "not_found", message: "模型供应商不存在" });
    } else {
      providerId = input.providerId;
    }
  }

  let requestedLocation: "local" | "worktree" = "local";
  if (input.executionLocation !== undefined) {
    if (input.executionLocation !== "local" && input.executionLocation !== "worktree") {
      fields.push({
        field: "executionLocation",
        code: "invalid_value",
        message: "执行位置只能是 local 或 worktree",
      });
    } else {
      requestedLocation = input.executionLocation;
    }
  }

  let workspacePath = typeof input.workspacePath === "string" ? input.workspacePath.trim() : "";

  // 安全底线：没有权限通道的运行时强制 worktree（本轮不动，见范围边界）
  const mustWorktree = runtimeId !== null && lookup.runtimeRequiresWorktree(runtimeId);
  const executionLocation: "local" | "worktree" =
    mustWorktree || requestedLocation === "worktree" ? "worktree" : "local";

  if (executionLocation === "worktree") {
    if (workspacePath.length === 0) {
      fields.push({
        field: "repoPath",
        code: "required",
        message: mustWorktree
          ? `该运行时（${runtimeId === null ? "该运行时" : lookup.runtimeDisplayName(runtimeId)}）不提供权限请求，必须使用 worktree，请填写仓库根路径`
          : "选 worktree 时必须填仓库根路径",
      });
    } else {
      const validation = validateRepoPath(workspacePath);
      if (!validation.ok) {
        fields.push({
          field: "repoPath",
          code: validation.code ?? "invalid",
          message: validation.message ?? "仓库路径不可用",
        });
      } else {
        workspacePath = validation.repoRoot ?? workspacePath;
      }
    }
  } else if (workspacePath.length > 0) {
    // local：只要求「是个能用的目录」，不要求 git —— 内置引擎不用 worktree（G8）
    const validation = validateWorkingDir(workspacePath);
    if (!validation.ok) {
      fields.push({
        field: "repoPath",
        code: validation.code ?? "invalid",
        message: validation.message ?? "工作目录不可用",
      });
    } else {
      workspacePath = validation.dir ?? workspacePath;
    }
  }

  if (fields.length > 0) return { outcome: { ok: false, fields } };

  const id = `bot_${randomUUID()}`;
  const now = Date.now();
  const avatar = typeof input.avatar === "string" ? input.avatar : null;
  const role = input.role === "admin" ? "admin" : "member";

  db.prepare(
    `INSERT INTO bots
       (id, name, persona, avatar, default_runtime_id, provider_id, role, execution_location, repo_path,
        status, allow_dirs, allow_shell, allow_network, auto_approve_write,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', 0, 0, 0, ?, ?)`,
  ).run(
    id,
    name,
    persona,
    avatar,
    runtimeId,
    providerId,
    role,
    executionLocation,
    workspacePath.length > 0 ? workspacePath : null,
    now,
    now,
  );

  // 保存后立刻尝试建 worktree：失败不回滚保存，Bot 标「未就绪」
  let worktreeError: string | undefined;
  if (executionLocation === "worktree") {
    const result = ensureWorktreeForBot(db, id);
    if (!result.ok) worktreeError = result.message ?? result.code ?? "worktree 未就绪";
  }

  return {
    outcome: { ok: true, botId: id, name },
    executionLocation,
    ...(worktreeError === undefined ? {} : { worktreeError }),
  };
}

/** 把字段级错误合并成一句话（工具回执用）。 */
export function fieldErrorsText(fields: readonly BotCreateFieldError[]): string {
  return fields.map((f) => `${f.field}: ${f.message}`).join("；");
}
