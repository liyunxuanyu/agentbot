import { config } from "../../../../config.js";
import { scanSkills } from "../../skills.js";
import type { ToolDefinition, ToolResult } from "../registry.js";

/**
 * `list_skills`（N4 档 C）：返回**全部**技能名与一行描述。
 *
 * 与系统提示里的技能索引分工：
 *   - 索引是固定成本（≤800 字符、最多 12 条），只放模型「现在就该知道」的；
 *   - 本工具不进系统提示，模型需要发现长尾技能时调一次即可。
 *
 * 刻意**列出未启用的技能**：N4 验收要求「模型能通过 list_skills 发现未启用的
 * 技能，并能 read_skill 读取」。启用列表只影响系统提示索引（每轮的固定成本），
 * 不影响「能不能发现/读取」。输出里会标出哪些属于本 Bot 当前启用的。
 *
 * 只读，不经过权限裁决。
 */

export interface ListSkillsToolOptions {
  /** 技能目录（测试注入；生产用 ~/.agentbot/skills）。 */
  skillsDir?: string;
  /**
   * 本 Bot 当前启用的技能目录名；null = 全部启用。
   * 仅用于在结果里标注，不用于过滤。
   */
  enabledSkills?: () => readonly string[] | null;
}

export function createListSkillsTool(opts: ListSkillsToolOptions = {}): ToolDefinition {
  return {
    name: "list_skills",
    description:
      "列出全部可用技能（名称 + 一行描述），并标出哪些已在本会话启用。系统提示里只列了常用技能；需要更多能力时先调用它，再用 read_skill 读全文。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "可选：按名称或描述过滤（不区分大小写的子串匹配）",
        },
      },
    },
    permission: "read",
    source: "builtin",
    async execute(_ctx, args): Promise<ToolResult> {
      const started = Date.now();
      const dir = opts.skillsDir ?? config.skillsDir;
      const all = scanSkills(dir);
      const query = typeof args["query"] === "string" ? args["query"].trim().toLowerCase() : "";
      const enabled = opts.enabledSkills?.() ?? null;
      const enabledSet = enabled === null ? null : new Set(enabled);

      const matched = all.filter((s) => {
        if (query.length === 0) return true;
        return (
          s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
        );
      });

      if (matched.length === 0) {
        const message =
          query.length > 0
            ? `没有匹配「${query}」的技能。`
            : "还没有任何技能。技能目录里建一个 <name>/SKILL.md 后即可用。";
        return { ok: true, output: message, durationMs: Date.now() - started };
      }

      const lines = matched.map((s) => {
        const active = enabledSet === null || enabledSet.has(s.dirName);
        const tag = active ? "" : "（未启用：不在系统提示里，但可用 read_skill 读取）";
        const desc = s.description.length > 0 ? s.description : "（无描述）";
        return `- ${s.name}: ${desc}${tag}`;
      });
      const inactive = matched.filter(
        (s) => enabledSet !== null && !enabledSet.has(s.dirName),
      ).length;
      const tail =
        inactive > 0
          ? `\n\n其中 ${inactive} 个未在本 Bot 启用（不影响调用工具；如需常驻索引，请用户在 Bot 详情里启用）。`
          : "";
      return {
        ok: true,
        output: `共 ${matched.length} 个技能：\n${lines.join("\n")}${tail}`,
        durationMs: Date.now() - started,
      };
    },
  };
}
