import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { config } from "../../config.js";
import { AGENT_LIMITS } from "./limits.js";
import { truncateText } from "./tools/truncate.js";

/**
 * 技能：`~/.agentbot/skills/<name>/SKILL.md`（与 ZCode 的目录约定一致）。
 *
 * 只把 `name + 一行描述` 放进系统提示（≤800 字符），完整内容由模型按需调用
 * `read_skill` 读取 —— 一次性塞满上下文会让每个技能都变成固定成本。
 */

export interface SkillInfo {
  name: string;
  description: string;
  /** 目录名（read_skill 用它定位）。 */
  dirName: string;
  path: string;
}

interface Frontmatter {
  name?: unknown;
  description?: unknown;
}

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: normalized };
  const raw = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  try {
    const parsed: unknown = parseYaml(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { meta: {}, body };
    }
    return { meta: parsed as Frontmatter, body };
  } catch {
    return { meta: {}, body };
  }
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  return line ?? "";
}

/** 扫描技能目录；目录不存在返回空数组（不是错误）。 */
export function scanSkills(dir: string = config.skillsDir): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  for (const dirName of entries) {
    const skillDir = join(dir, dirName);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const path = join(skillDir, "SKILL.md");
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const name = typeof meta.name === "string" && meta.name.trim().length > 0 ? meta.name.trim() : dirName;
    const description =
      typeof meta.description === "string" && meta.description.trim().length > 0
        ? meta.description.trim().replace(/\s+/g, " ")
        : firstLine(body).slice(0, 200);
    out.push({ name, description, dirName, path });
  }
  return out;
}

/** 生成系统提示里的技能索引；总量受 maxChars 限制。 */
export function buildSkillsIndex(
  skills: readonly SkillInfo[],
  maxChars: number = AGENT_LIMITS.maxSkillsIndexChars,
): string {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const skill of skills) {
    const desc = skill.description.length > 120 ? `${skill.description.slice(0, 117)}…` : skill.description;
    const line = `- ${skill.name}: ${desc.length > 0 ? desc : "（无描述）"}`;
    if (used + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) lines.push(`（另有 ${omitted} 个技能未列出，可用 read_skill 按名称读取）`);
  return lines.join("\n");
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ReadSkillResult =
  | { ok: true; name: string; content: string; truncated: boolean }
  | { ok: false; error: string };

export function readSkill(name: string, dir: string = config.skillsDir): ReadSkillResult {
  if (!NAME_PATTERN.test(name)) return { ok: false, error: "技能名只能包含字母、数字、点、下划线和短横线" };
  const skillDir = join(dir, name);
  const path = join(skillDir, "SKILL.md");
  if (!existsSync(path)) return { ok: false, error: `技能不存在：${name}` };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `读取技能失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const truncated = truncateText(text, { maxBytes: AGENT_LIMITS.maxFileReadBytes });
  return { ok: true, name, content: truncated.text, truncated: truncated.truncated };
}
