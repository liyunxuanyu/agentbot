import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { config } from "../../config.js";
import { AGENT_LIMITS } from "./limits.js";
import { isBuiltinSkillDir } from "./skills/install.js";
import { truncateText } from "./tools/truncate.js";

/**
 * 技能：`~/.agentbot/skills/<name>/SKILL.md`（与 ZCode 的目录约定一致）。
 *
 * 只把 `name + 一行描述` 放进系统提示（≤800 字符），完整内容由模型按需调用
 * `read_skill` 读取 —— 一次性塞满上下文会让每个技能都变成固定成本。
 *
 * N3-1 热插拔：扫描结果按「目录 mtime 签名」缓存，新建/删除/改文件后下一次
 * 扫描自动失效，不需要重启服务。
 */

export interface SkillInfo {
  name: string;
  description: string;
  /** 目录名（read_skill 用它定位）。 */
  dirName: string;
  path: string;
  /** 来自内置技能包（N2）：技能页显示「内置」徽标。 */
  builtin: boolean;
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

/**
 * 目录签名：目录 mtime + 每个技能目录名与 SKILL.md 的 mtime/size。
 *
 * 不逐字节读文件（技能目录可能很多），只用来判断「变没变」；判定为变了就重扫。
 * 技能是文件驱动的，这个签名改动少、读盘少，够用且没有失效窗口。
 */
function signatureOf(dir: string, entries: readonly string[]): string {
  const parts: string[] = [];
  try {
    parts.push(String(statSync(dir).mtimeMs));
  } catch {
    return "";
  }
  for (const dirName of entries) {
    const skillDir = join(dir, dirName);
    const path = join(skillDir, "SKILL.md");
    try {
      const st = statSync(path);
      parts.push(`${dirName}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${dirName}:missing`);
    }
  }
  return parts.join("|");
}

interface ScanCacheEntry {
  signature: string;
  skills: SkillInfo[];
}

/** 进程级扫描缓存（按目录分别记）。 */
const scanCache = new Map<string, ScanCacheEntry>();

/** 清缓存（测试用；生产路径靠签名自动失效）。 */
export function clearSkillsCache(): void {
  scanCache.clear();
}

/** 扫描技能目录；目录不存在返回空数组（不是错误）。 */
export function scanSkills(dir: string = config.skillsDir): SkillInfo[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  // 只关心看起来像技能目录的条目（目录本身；文件不参与签名）
  const dirEntries = entries.filter((dirName) => {
    try {
      return statSync(join(dir, dirName)).isDirectory();
    } catch {
      return false;
    }
  });
  const signature = signatureOf(dir, dirEntries);
  const cached = scanCache.get(dir);
  if (cached && cached.signature === signature) return cached.skills;

  const out: SkillInfo[] = [];
  for (const dirName of dirEntries) {
    const skillDir = join(dir, dirName);
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
    out.push({ name, description, dirName, path, builtin: isBuiltinSkillDir(skillDir) });
  }
  // 存一份不可变副本：调用方可能对它排序/过滤，不能污染缓存
  scanCache.set(dir, { signature, skills: out });
  return out;
}

/**
 * 生成系统提示里的技能索引；总量受 maxChars 限制，条数受 maxEntries 限制。
 *
 * N4：长尾技能不占上下文 —— 超出部分只给一句「还有 M 个，用 list_skills 查看」，
 * 模型知道存在、需要时自己发现。`maxEntries` 缺省 12（与验收口径一致）。
 */
export function buildSkillsIndex(
  skills: readonly SkillInfo[],
  maxChars: number = AGENT_LIMITS.maxSkillsIndexChars,
  maxEntries: number = AGENT_LIMITS.maxSkillsIndexEntries,
): string {
  if (skills.length === 0) return "";

  const noteOf = (omitted: number): string =>
    `（另有 ${omitted} 个技能未列出，可用 list_skills 查看全部）`;
  // 预留提示行的位置：不预留会让「再加一行提示」把总量顶过 800。
  // 被丢条数最多是 skills.length（提示长度随位数增长），按最坏情况留。
  const reserve = noteOf(skills.length).length + 1;
  const budget = Math.max(0, maxChars - reserve);

  const lines: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const desc = skill.description.length > 120 ? `${skill.description.slice(0, 117)}…` : skill.description;
    const line = `- ${skill.name}: ${desc.length > 0 ? desc : "（无描述）"}`;
    if (lines.length >= maxEntries || used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const omitted = skills.length - lines.length;
  if (omitted > 0) lines.push(noteOf(omitted));
  return lines.join("\n");
}

/**
 * 按 Bot 的启用列表过滤技能（N3-1 / N4）。
 *
 * - `null` / `undefined` = 全部启用（迁移前的老 Bot，保持原行为）；
 * - `[]` = 一个都不注入（档 A）；
 * - 其它 = 只保留列出的目录名（按目录名匹配，改 frontmatter 的 name 不会失效）。
 */
export function filterSkillsByEnabled(
  skills: readonly SkillInfo[],
  enabled: readonly string[] | null | undefined,
): SkillInfo[] {
  if (enabled === null || enabled === undefined) return [...skills];
  const allowed = new Set(enabled);
  return skills.filter((s) => allowed.has(s.dirName));
}

/** 解析 `bots.enabled_skills`（JSON 数组；损坏或非数组按 null = 全部启用）。 */
export function parseEnabledSkills(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
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
