import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server.js";
import { config } from "../../config.js";
import { scanSkills } from "../../core/agent/skills.js";

/**
 * 技能端点（N5）。
 *
 *   GET  /api/skills          → 扫描 ~/.agentbot/skills 下的 SKILL.md
 *   POST /api/skills/rescan   → 重新扫描（前端「重扫」按钮）
 *
 * 扫描是纯文件操作，没有缓存：目录里通常只有几十个技能，读一遍足够快。
 */

export function registerSkillRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  const list = (): { skills: ReturnType<typeof scanSkills>; dir: string } => ({
    skills: scanSkills(config.skillsDir),
    dir: config.skillsDir,
  });

  app.get("/api/skills", async () => list());
  app.post("/api/skills/rescan", async () => list());
}
