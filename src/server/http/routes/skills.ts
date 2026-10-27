import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server.js";
import { config } from "../../config.js";
import { scanSkills } from "../../core/agent/skills.js";
import { installBuiltinSkills } from "../../core/agent/skills/install.js";

/**
 * 技能端点（N5 / N2 / N3-1）。
 *
 *   GET  /api/skills          → 扫描 ~/.agentbot/skills 下的 SKILL.md（带 builtin 标记）
 *   POST /api/skills/rescan   → 补装缺失的内置技能并重新扫描（前端「重扫」按钮）
 *
 * 扫描结果按目录 mtime 签名缓存（`skills.ts`）：新建/删除/改文件后下一次读取
 * 自动失效，**保存后下一轮对话即生效**，不需要重启（N3-1 的「立即生效」）。
 * 「重扫」端点额外补装被删掉的内置技能，让用户能一键恢复（N2 验收）。
 */

export function registerSkillRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  const list = (): {
    skills: ReturnType<typeof scanSkills>;
    dir: string;
  } => ({
    skills: scanSkills(config.skillsDir),
    dir: config.skillsDir,
  });

  app.get("/api/skills", async () => list());
  app.post("/api/skills/rescan", async () => {
    // 补装内置技能：已存在的不覆盖（用户改过的 SKILL.md 保持原样）
    const install = installBuiltinSkills();
    return { ...list(), installed: install.installed };
  });
}
