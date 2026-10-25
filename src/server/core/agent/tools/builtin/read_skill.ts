import { config } from "../../../../config.js";
import { readSkill } from "../../skills.js";
import type { ToolDefinition, ToolResult } from "../registry.js";

export const readSkillTool: ToolDefinition = {
  name: "read_skill",
  description: "按名称读取技能的完整 SKILL.md 内容。技能索引已在系统提示里，需要细节时再调用。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能目录名（见系统提示的技能索引）" },
    },
    required: ["name"],
  },
  permission: "read",
  source: "builtin",
  async execute(_ctx, args): Promise<ToolResult> {
    const started = Date.now();
    const name = typeof args["name"] === "string" ? args["name"].trim() : "";
    if (name.length === 0) {
      const message = "name 不能为空";
      return { ok: false, output: message, error: message, durationMs: Date.now() - started };
    }
    const result = readSkill(name, config.skillsDir);
    if (!result.ok) {
      return { ok: false, output: result.error, error: result.error, durationMs: Date.now() - started };
    }
    return {
      ok: true,
      output: result.content,
      ...(result.truncated ? { truncated: true } : {}),
      durationMs: Date.now() - started,
    };
  },
};
