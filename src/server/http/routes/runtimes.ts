import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerContext } from "../server.js";
import type { AdapterDeclaration } from "../../adapters/contract.js";
import {
  insertCustomRuntime,
  listRuntimes,
  persistProbe,
  probeDeclaration,
  readCustomDeclaration,
  type RuntimeRecord,
} from "../../adapters/probe.js";
import { buildCustomDeclaration, isProtocolKind, PROTOCOL_KINDS } from "../../adapters/custom.js";
import { createDriverFor } from "../../adapters/factory.js";
import { effectiveDetectCommand, resolveCommand } from "../../adapters/launch.js";
import { toRuntimeDto } from "../dto.js";

/**
 * 运行时端点（P0-01）。
 *
 *   `GET  /api/runtimes`            → `{ runtimes: RuntimeDto[] }`（只读探测缓存）
 *   `POST /api/runtimes`            → 手动添加自定义启动命令（添加后立即探测一次）
 *   `POST /api/runtimes/:id/probe`  → 单运行时重探（「检测超时」旁边的重试按钮）
 *
 * 三条纪律：
 *   ① **渲染不探测**：列表只读 `runtime_definitions` 缓存（架构 §3.8）。
 *      只有这两个 POST 会真的起进程 —— 用户点「重试」才付 3–10s 的代价。
 *   ② **只重探一个**：`/probe` 不碰其他行，页面上其他运行时的状态不会跟着闪。
 *   ③ **重复判定按可执行文件**：同一 exe 已存在时回 `409 already_exists` 并带
 *      `existingId`，前端据此跳到该条目（PRD P0-01 边界）。
 *
 * 自定义运行时没有 YAML 声明：整份声明存进 `runtime_definitions.capabilities` 的
 * `_declaration` 保留键（零 schema 变更），重启后由 `readCustomDeclarations` 恢复。
 */

interface CreateRuntimeBody {
  id?: unknown;
  displayName?: unknown;
  protocol?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  detect?: unknown;
}

interface FieldError {
  field: string;
  code: string;
  message: string;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

/** 运行时 id：只允许字母数字与 `-` `_`，避免拼进 URL / 环境变量名时出问题。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 可执行文件的比较键。
 *
 * 能解析成绝对路径就按解析结果比（`codex` 与 `C:\...\codex.cmd` 是同一个东西）；
 * 解析不到就按用户输入原样比。Windows 下大小写不敏感，统一小写。
 */
function executableKey(command: string): string {
  const resolved = resolveCommand(command);
  const base = resolved ?? command.trim();
  return process.platform === "win32" ? base.toLowerCase() : base;
}

/** 只接受字符串数组；有非字符串项就报错（不静默过滤，用户要知道自己填错了）。 */
function readStringArray(
  raw: unknown,
  field: string,
  fields: FieldError[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    fields.push({ field, code: "not_array", message: `${field} 必须是字符串数组` });
    return undefined;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      fields.push({ field, code: "not_string", message: `${field} 的每一项都必须是字符串` });
      return undefined;
    }
    out.push(item);
  }
  return out;
}

/** `env` 只收 string→string（值不回显给前端以外的任何地方）。 */
function readEnv(raw: unknown, fields: FieldError[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fields.push({ field: "env", code: "not_object", message: "env 必须是键值对象" });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      fields.push({ field: "env", code: "not_string", message: `env.${key} 必须是字符串` });
      return undefined;
    }
    out[key] = value;
  }
  return out;
}

interface DetectInput {
  command?: string;
  versionArgs?: string[];
  versionPattern?: string;
  timeoutMs?: number;
}

/** 探测参数：全可选，缺省值在 `buildCustomDeclaration` 里给。 */
function readDetect(raw: unknown, fields: FieldError[]): DetectInput | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fields.push({ field: "detect", code: "not_object", message: "detect 必须是对象" });
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const out: DetectInput = {};

  if (rec["command"] !== undefined) {
    if (typeof rec["command"] !== "string" || rec["command"].trim().length === 0) {
      fields.push({ field: "detect.command", code: "invalid_value", message: "探测命令不能为空" });
    } else {
      out.command = rec["command"].trim();
    }
  }

  const versionArgs = readStringArray(rec["versionArgs"], "detect.versionArgs", fields);
  if (versionArgs !== undefined) out.versionArgs = versionArgs;

  if (rec["versionPattern"] !== undefined) {
    if (typeof rec["versionPattern"] !== "string" || rec["versionPattern"].length === 0) {
      fields.push({
        field: "detect.versionPattern",
        code: "invalid_value",
        message: "版本正则不能为空",
      });
    } else {
      try {
        // 提前编译：坏正则在探测时才炸会让用户看到「添加失败」却不知原因
        new RegExp(rec["versionPattern"]);
        out.versionPattern = rec["versionPattern"];
      } catch (err) {
        fields.push({
          field: "detect.versionPattern",
          code: "invalid_regex",
          message: `版本正则无效：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (rec["timeoutMs"] !== undefined) {
    const n = rec["timeoutMs"];
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      fields.push({
        field: "detect.timeoutMs",
        code: "invalid_value",
        message: "探测超时必须是正整数毫秒",
      });
    } else {
      out.timeoutMs = n;
    }
  }

  return out;
}

/** 探测并回写缓存，返回更新后的行。 */
async function probeAndPersist(
  ctx: ServerContext,
  decl: AdapterDeclaration,
  source: "builtin" | "custom",
): Promise<RuntimeRecord | null> {
  const outcome = await probeDeclaration({
    declaration: decl,
    driver: createDriverFor(decl),
  });
  persistProbe(ctx.db, decl, outcome, resolveCommand(effectiveDetectCommand(decl)), { source });
  return listRuntimes(ctx.db).find((r) => r.id === decl.id) ?? null;
}

/**
 * 解析某个运行时 id 对应的声明。
 *
 * 顺序：装配层注入的声明表（内置 YAML）→ 库里的 `_declaration`（自定义）。
 * 两者都没有说明这一行是「声明文件被删了」的历史缓存，如实回 409，
 * 不假装探测成功。
 */
function resolveDeclaration(ctx: ServerContext, runtimeId: string): AdapterDeclaration | null {
  const fromRegistry = ctx.declarations?.get(runtimeId);
  if (fromRegistry) return fromRegistry;
  return readCustomDeclaration(ctx.db, runtimeId);
}

export function registerRuntimeRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/runtimes", async () => {
    return { runtimes: listRuntimes(ctx.db).map(toRuntimeDto) };
  });

  /**
   * 手动添加自定义启动命令（P0-01）。
   *
   * 落库顺序：先插入 `unprobed` 行 → 探测 → upsert 探测结果。先插行而不是
   * 「探测成功才插」：探测可能超时（3s + 10s），用户不该等 13s 才知道「加没加上」；
   * 而且探测失败本身也是有效结果（「命令不存在」），必须能显示出来。
   */
  app.post<{ Body: CreateRuntimeBody }>("/api/runtimes", async (req, reply: FastifyReply) => {
    const body = req.body ?? {};
    const fields: FieldError[] = [];

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id.length === 0) {
      fields.push({ field: "id", code: "required", message: "id 不能为空" });
    } else if (!ID_PATTERN.test(id)) {
      fields.push({
        field: "id",
        code: "invalid_format",
        message: "id 只能用字母、数字、- 和 _，且以字母或数字开头（≤64 字符）",
      });
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (displayName.length === 0) {
      fields.push({ field: "displayName", code: "required", message: "显示名称不能为空" });
    } else if (displayName.length > 64) {
      fields.push({ field: "displayName", code: "too_long", message: "显示名称最多 64 个字符" });
    }

    const protocol = body.protocol;
    if (!isProtocolKind(protocol)) {
      fields.push({
        field: "protocol",
        code: "invalid_value",
        message: `协议必须是以下之一：${PROTOCOL_KINDS.join("、")}`,
      });
    }

    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (command.length === 0) {
      fields.push({ field: "command", code: "required", message: "启动命令不能为空" });
    }

    const args = readStringArray(body.args, "args", fields);
    const env = readEnv(body.env, fields);
    const detect = readDetect(body.detect, fields);

    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string" || body.cwd.trim().length === 0) {
        fields.push({ field: "cwd", code: "invalid_value", message: "工作目录不能为空" });
      } else {
        cwd = body.cwd.trim();
      }
    }

    if (fields.length > 0) return json(reply, 400, { error: "invalid_runtime", fields });

    // ---- 重复判定：同一 id / 同一可执行文件 / 同一显示名 ----
    //
    // 三种都回 `already_exists` + `existingId`：前端只需一个分支「跳过去」。
    // `reason` 让前端能说清是撞了什么，但不参与跳转逻辑。
    const candidates = listRuntimes(ctx.db);

    const existingById = candidates.find((r) => r.id === id);
    if (existingById) {
      return json(reply, 409, {
        error: "already_exists",
        existingId: existingById.id,
        reason: "id",
        message: `运行时 id 已存在：${id}`,
      });
    }

    const key = executableKey(command);
    const sameExecutable = candidates.find((r) => executableKey(r.command) === key);
    if (sameExecutable) {
      return json(reply, 409, {
        error: "already_exists",
        existingId: sameExecutable.id,
        reason: "executable",
        message: `该可执行文件已存在：${sameExecutable.displayName}（${sameExecutable.command}）`,
      });
    }

    const sameName = candidates.find((r) => r.displayName === displayName);
    if (sameName) {
      return json(reply, 409, {
        error: "already_exists",
        existingId: sameName.id,
        reason: "displayName",
        message: `显示名称已存在：${displayName}`,
      });
    }

    const declaration = buildCustomDeclaration({
      id,
      displayName,
      protocol: protocol as AdapterDeclaration["protocol"],
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(detect === undefined ? {} : { detect }),
    });

    try {
      insertCustomRuntime(ctx.db, declaration);
    } catch (err) {      // 并发添加同一 id：唯一约束兜底，仍按「已存在」返回
      const dup = ctx.db
        .prepare("SELECT id FROM runtime_definitions WHERE id = ? OR adapter_name = ?")
        .get(id, id) as { id: string } | undefined;
      if (dup) {
        return json(reply, 409, {
          error: "already_exists",
          existingId: dup.id,
          reason: "id",
          message: `运行时 id 已存在：${id}`,
        });
      }
      throw err;
    }

    let runtime: RuntimeRecord | null;
    try {
      runtime = await probeAndPersist(ctx, declaration, "custom");
    } catch (err) {
      // 探测抛错不能把「添加」回滚成失败：行已经在了，用户能点重试
      console.warn(
        `[http] 自定义运行时 ${id} 探测失败：${err instanceof Error ? err.message : String(err)}`,
      );
      runtime = listRuntimes(ctx.db).find((r) => r.id === id) ?? null;
    }

    return json(reply, 201, { runtime: runtime ? toRuntimeDto(runtime) : null });
  });

  /**
   * 单运行时重探（P0-01「检测超时」+ 重试按钮）。
   *
   * 只探测这一个：其他运行时的 `lastProbeAt` 不变，前端不必整页刷新。
   */
  app.post<{ Params: { id: string } }>(
    "/api/runtimes/:id/probe",
    async (req, reply: FastifyReply) => {
      const runtimeId = req.params.id;
      const row = ctx.db
        .prepare("SELECT id, source FROM runtime_definitions WHERE id = ?")
        .get(runtimeId) as { id: string; source: string } | undefined;
      if (!row) return json(reply, 404, { error: "runtime_not_found" });

      const declaration = resolveDeclaration(ctx, runtimeId);
      if (!declaration) {
        return json(reply, 409, {
          error: "declaration_missing",
          message: `找不到运行时 ${runtimeId} 的声明（声明文件可能已被移除），无法探测`,
        });
      }

      const source = row.source === "custom" ? "custom" : "builtin";
      let runtime: RuntimeRecord | null;
      try {
        runtime = await probeAndPersist(ctx, declaration, source);
      } catch (err) {
        return json(reply, 500, {
          error: "probe_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!runtime) return json(reply, 404, { error: "runtime_not_found" });
      return { runtime: toRuntimeDto(runtime) };
    },
  );
}
