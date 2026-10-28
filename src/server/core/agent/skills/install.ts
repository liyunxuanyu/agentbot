import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../../config.js";

/**
 * 基础技能包（N2）：4 份 SKILL.md 随代码分发，首次启动装进 `~/.agentbot/skills/`。
 *
 * 为什么是安装而不是从只读目录直接扫描：技能目录是用户的，`read_skill` 与技能页
 * 都从这个目录读；同时用户要能改（说明书比工具描述更值得按自己的项目调整）。
 *
 * 四条纪律：
 *   ① **已存在就跳过**：用户改过的 SKILL.md 绝不被覆盖（这是「可维护的说明书」的前提）。
 *   ② **删了会重装**：目录被删后下次启动补回来，不至于「删一次永远没了」。
 *   ③ **内置标记**：安装时写 `.agentbot-builtin` 标记文件，技能页据此显示「内置」徽标；
 *      用户改内容不会丢标记（标记与内容分开）。
 *   ④ **不碰用户自己的技能**：只处理内置包里的目录名，其它目录一个字节都不动。
 */

/** 内置技能包的目录名（也是安装后的目录名）。 */
export const BUILTIN_SKILL_NAMES = [
  "file-basics",
  "shell-basics",
  "search-basics",
  "web-basics",
  // 浏览器控制（Playwright MCP）：说明怎么用 mcp__playwright__* 那组工具
  "browser-basics",
] as const;

/** 新建 Bot 默认启用的技能（N4 档 B：只装基础包，长尾按需发现）。 */
export const DEFAULT_BOT_SKILLS: readonly string[] = BUILTIN_SKILL_NAMES;

/** 内置标记文件名：存在即表示「这个目录来自内置包」。 */
export const BUILTIN_MARKER = ".agentbot-builtin";

export interface BuiltinSkill {
  dirName: string;
  content: string;
}

export interface InstallSkillsResult {
  /** 本次新装（或补装）的技能目录名。 */
  installed: string[];
  /** 已存在、跳过的目录名。 */
  skipped: string[];
  /** 内置包源目录；找不到时为空（不阻断启动）。 */
  sourceDir: string | null;
}

/** 打包后与源码两种布局都要能找到内置技能目录。 */
export function builtinSkillsSourceDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // tsup 复制到 dist/skills/builtin（见 tsup.config.ts）
    join(here, "skills", "builtin"),
    // 开发态：src/server/core/agent/skills/builtin
    join(here, "builtin"),
    // 兜底：按 cwd 找源码目录
    join(process.cwd(), "src", "server", "core", "agent", "skills", "builtin"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** 读取内置包内容（源目录缺失时返回空数组）。 */
export function listBuiltinSkills(sourceDir: string | null = builtinSkillsSourceDir()): BuiltinSkill[] {
  if (!sourceDir) return [];
  const out: BuiltinSkill[] = [];
  for (const dirName of BUILTIN_SKILL_NAMES) {
    const path = join(sourceDir, dirName, "SKILL.md");
    try {
      out.push({ dirName, content: readFileSync(path, "utf8") });
    } catch {
      // 包里缺某个技能：跳过，不阻断其它技能安装
    }
  }
  return out;
}

/**
 * 安装到目标目录（默认 `~/.agentbot/skills`）。
 *
 * 幂等：目录已存在就跳过；重复启动不会产生重复目录、也不会覆盖用户改动。
 */
export function installBuiltinSkills(
  targetDir: string = config.skillsDir,
  sourceDir: string | null = builtinSkillsSourceDir(),
): InstallSkillsResult {
  const skills = listBuiltinSkills(sourceDir);
  const result: InstallSkillsResult = { installed: [], skipped: [], sourceDir };

  if (skills.length === 0) return result;
  mkdirSync(targetDir, { recursive: true });

  for (const skill of skills) {
    const dir = join(targetDir, skill.dirName);
    if (existsSync(dir)) {
      result.skipped.push(skill.dirName);
      // 老版本装过（没有标记）：补一个标记，让技能页能显示「内置」
      ensureMarker(dir);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill.content, "utf8");
    ensureMarker(dir);
    result.installed.push(skill.dirName);
  }
  return result;
}

function ensureMarker(dir: string): void {
  const marker = join(dir, BUILTIN_MARKER);
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, "installed by AgentBot builtin skill pack\n", "utf8");
  } catch {
    // 标记写不进去不影响技能本身
  }
}

/** 某个技能目录是否来自内置包（供技能页显示「内置」徽标）。 */
export function isBuiltinSkillDir(dir: string): boolean {
  return existsSync(join(dir, BUILTIN_MARKER));
}

/** 供引导/设置页展示：目标目录里已有的技能数（含用户自己的）。 */
export function countSkillDirs(dir: string = config.skillsDir): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}
