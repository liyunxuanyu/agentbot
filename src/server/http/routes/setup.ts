import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server.js";
import { config } from "../../config.js";
import { listProviders } from "../../adapters/providers/store.js";
import { listRuntimes } from "../../adapters/probe.js";
import { countSkillDirs } from "../../core/agent/skills/install.js";

/**
 * 初始化引导的状态端点（N1）。
 *
 *   `GET /api/setup/state` → `{ needsSetup, completed, total, steps, skillCount }`
 *
 * 判据（每项独立、可重入，不写库）：
 *   1. 运行时     —— 至少一个运行时 `ready`（内置引擎也算，它的可用性随供应商变化）
 *   2. 模型供应商 —— 至少配置了一个（内置引擎没供应商就聊不起来）
 *   3. 管理员 Bot —— 存在 `role='admin'` 的 Bot
 *   4. 默认工作区 —— 至少一个 Bot 配了 `repo_path`（可选步骤，但完成后计入）
 *   5. 基础技能   —— 技能目录里至少有内置包（可选）
 *
 * 为什么由服务端算而不是前端拼：首启跳转要看它，设置页的「未完成 N/5」也要看它，
 * 两处各拼一次必然漂移；而且判断需要读 providers.json 与运行时缓存，前端拿不到。
 *
 * **`needsSetup` 只看前 3 项**（必需项）：工作区与技能是可选的，用户跳过它们
 * 不该每次启动都被拽回引导页。返回 `completed`（含可选步骤）供侧栏显示进度。
 */

export interface SetupStepState {
  key: "runtime" | "provider" | "admin" | "workspace" | "skills";
  label: string;
  /** 这一步是否已经满足。 */
  done: boolean;
  /** 可选步骤：跳过不影响「向导是否还需要打开」。 */
  optional: boolean;
  /** 为什么还没完成 / 已完成的证据（一行，给 UI 直接显示）。 */
  detail: string;
}

export interface SetupState {
  /** 打开就说明必需项没齐：无供应商 或 无运行时 或 无管理员 Bot。 */
  needsSetup: boolean;
  completed: number;
  total: number;
  steps: SetupStepState[];
  /** 技能目录里已有的技能数（含用户自己的）。 */
  skillCount: number;
  skillsDir: string;
}

export function computeSetupState(db: ServerContext["db"]): SetupState {
  const providers = listProviders();
  const runtimes = listRuntimes(db);
  const ready = runtimes.filter((r) => r.availability === "ready");

  const adminCount = (
    db.prepare("SELECT COUNT(*) AS n FROM bots WHERE role = 'admin' AND status = 'active'").get() as {
      n: number;
    }
  ).n;
  const activeBots = (
    db.prepare("SELECT COUNT(*) AS n FROM bots WHERE status = 'active'").get() as { n: number }
  ).n;
  const workspaceCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM bots WHERE status = 'active' AND repo_path IS NOT NULL AND repo_path <> ''",
      )
      .get() as { n: number }
  ).n;
  const skillCount = countSkillDirs(config.skillsDir);

  const steps: SetupStepState[] = [
    {
      key: "runtime",
      label: "探测运行时",
      done: ready.length > 0,
      optional: false,
      detail:
        ready.length > 0
          ? `${ready.map((r) => r.displayName).join("、")} 可用`
          : "没有可用的运行时（内置引擎也需要至少一个模型供应商）",
    },
    {
      key: "provider",
      label: "配置模型供应商",
      done: providers.length > 0,
      optional: false,
      detail:
        providers.length > 0
          ? `已配置 ${providers.length} 个供应商`
          : "还没有模型供应商：内置引擎不可用",
    },
    {
      key: "admin",
      label: "管理员 Bot",
      done: adminCount > 0,
      optional: false,
      detail:
        adminCount > 0
          ? `已有 ${adminCount} 个管理员`
          : activeBots > 0
            ? "有普通 Bot，但没有管理员（管理员可代你创建 Bot）"
            : "还没有任何 Bot",
    },
    {
      key: "workspace",
      label: "默认工作区",
      done: workspaceCount > 0,
      optional: true,
      detail:
        workspaceCount > 0
          ? `${workspaceCount} 个 Bot 配了默认工作区`
          : "可跳过：不设置时按会话 / 渠道回退",
    },
    {
      key: "skills",
      label: "基础技能",
      done: skillCount > 0,
      optional: true,
      detail:
        skillCount > 0 ? `技能目录里已有 ${skillCount} 个技能` : "可跳过：首次启动会自动安装基础技能包",
    },
  ];

  const required = steps.filter((s) => !s.optional);
  return {
    needsSetup: required.some((s) => !s.done),
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    steps,
    skillCount,
    skillsDir: config.skillsDir,
  };
}

export function registerSetupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/setup/state", async () => computeSetupState(ctx.db));
}
