import { AGENT_LIMITS } from "./limits.js";
import { buildSkillsIndex, type SkillInfo } from "./skills.js";

/**
 * 系统提示装配。
 *
 * 人格与记忆由编排层（`core/orchestrator/context.ts` → `memory/assembler.ts`）
 * 已经拼好并通过 `newSession(systemPrompt)` 交下来；本模块只补内置引擎自己的
 * 运行规则与技能索引，避免把「人格」这件事实现两遍。
 */

export interface PromptInput {
  /** 编排层给的人格 + 记忆（可能为空）。 */
  baseSystemPrompt?: string;
  cwd: string;
  /** 已按 Bot 的启用列表过滤过（调用方负责，见 N3-1）。 */
  skills: readonly SkillInfo[];
  providerName?: string;
  /**
   * 技能目录里一共有多少个（N4）。大于 `skills.length` 时加一句提示，
   * 让模型知道「还有没列出来的，可以用 list_skills 查看」。
   */
  totalSkills?: number;
}

const MAX_RULES_CHARS = 500;

export function buildSystemPrompt(input: PromptInput): string {
  const sections: string[] = [];
  const base = input.baseSystemPrompt?.trim() ?? "";
  if (base.length > 0) sections.push(base);

  const rules = [
    "## 运行规则",
    `- 工作目录：${input.cwd}`,
    "- 所有文件读写必须在该目录内；越界请求会被拒绝。",
    "- 写文件、执行命令、访问网络需要用户批准；被拒绝时不要重复同一调用，换做法或说明需要什么权限。",
    "- 需要事实时先用工具确认，不要臆测文件内容或命令结果。",
    `- 回答使用用户提问的语言。${input.providerName ? `当前模型供应商：${input.providerName}。` : ""}`,
  ]
    .join("\n")
    .slice(0, MAX_RULES_CHARS);
  sections.push(rules);

  const index = buildSkillsIndex(input.skills, AGENT_LIMITS.maxSkillsIndexChars);
  if (index.length > 0) {
    // 与 buildSkillsIndex 的「另有 M 个未列出」（索引超限）是两件事：
    // 这里是「目录里有、但不在本 Bot 的启用列表里」。两种提示可以同时出现。
    const unlisted = Math.max(0, (input.totalSkills ?? input.skills.length) - input.skills.length);
    const note =
      unlisted > 0
        ? `\n（技能目录里还有 ${unlisted} 个技能未在本 Bot 启用，可调用 list_skills 查看。）`
        : "";
    sections.push(
      `## 可用技能\n需要细节时调用 read_skill 读取完整内容：\n${index}${note}`,
    );
  } else if ((input.totalSkills ?? 0) > 0) {
    // 一个都没启用（N4 档 A）：不塞索引，但要告诉模型「有技能可以找」
    sections.push(
      `## 可用技能\n本 Bot 未启用任何技能索引。需要额外能力时调用 list_skills 查看全部技能，再用 read_skill 读取全文。`,
    );
  }

  return sections.join("\n\n");
}
