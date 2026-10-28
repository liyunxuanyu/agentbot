import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SKILL_NAMES,
  builtinSkillsSourceDir,
  DEFAULT_BOT_SKILLS,
  installBuiltinSkills,
  isBuiltinSkillDir,
  listBuiltinSkills,
} from "../../src/server/core/agent/skills/install.js";
import {
  buildSkillsIndex,
  clearSkillsCache,
  filterSkillsByEnabled,
  parseEnabledSkills,
  scanSkills,
} from "../../src/server/core/agent/skills.js";
import { buildSystemPrompt } from "../../src/server/core/agent/prompt.js";
import { AGENT_LIMITS } from "../../src/server/core/agent/limits.js";

/**
 * N2 / N3-1 / N4：基础技能包的安装、热插拔缓存、按 Bot 启用过滤。
 *
 * 全部用真实临时目录：这一块的风险都在「文件实际长什么样」（覆盖用户改动、
 * mtime 缓存失效、目录被删后重装），mock 掉就测不到。
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-skills-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  clearSkillsCache();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

describe("基础技能包（N2）", () => {
  it("源码目录里有 4 份 SKILL.md，frontmatter 带 name 与 description", () => {
    const source = builtinSkillsSourceDir();
    expect(source).not.toBeNull();
    const skills = listBuiltinSkills(source);
    expect(skills.map((s) => s.dirName)).toEqual([...BUILTIN_SKILL_NAMES]);
    for (const skill of skills) {
      expect(skill.content).toContain("---");
      expect(skill.content).toMatch(/name:\s*(file|shell|search|web|browser)-basics/);
      expect(skill.content).toMatch(/description:\s*\S/);
    }
  });

  it("首次安装：4 个目录 + 内置标记；默认启用列表就是这 4 个", () => {
    const target = join(tempDir(), "skills");
    const result = installBuiltinSkills(target);
    expect(result.installed.sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
    expect(result.skipped).toEqual([]);
    for (const name of BUILTIN_SKILL_NAMES) {
      expect(existsSync(join(target, name, "SKILL.md"))).toBe(true);
      expect(isBuiltinSkillDir(join(target, name))).toBe(true);
    }
    expect([...DEFAULT_BOT_SKILLS].sort()).toEqual([...BUILTIN_SKILL_NAMES].sort());
  });

  it("用户改过的 SKILL.md 重启后不被覆盖", () => {
    const target = join(tempDir(), "skills");
    installBuiltinSkills(target);
    const path = join(target, "file-basics", "SKILL.md");
    writeFileSync(path, "---\nname: file-basics\ndescription: 我改过的\n---\n\n自定义内容\n", "utf8");

    const second = installBuiltinSkills(target);
    expect(second.installed).toEqual([]);
    expect(second.skipped).toContain("file-basics");
    expect(readFileSync(path, "utf8")).toContain("自定义内容");
  });

  it("删掉某个内置技能目录后重装会补回来（可恢复）", () => {
    const target = join(tempDir(), "skills");
    installBuiltinSkills(target);
    rmSync(join(target, "web-basics"), { recursive: true, force: true });

    const second = installBuiltinSkills(target);
    expect(second.installed).toEqual(["web-basics"]);
    expect(existsSync(join(target, "web-basics", "SKILL.md"))).toBe(true);
  });

  it("不碰用户自己的技能目录", () => {
    const target = join(tempDir(), "skills");
    mkdirSync(join(target, "my-own"), { recursive: true });
    writeFileSync(join(target, "my-own", "SKILL.md"), "---\nname: my-own\n---\n", "utf8");
    installBuiltinSkills(target);
    expect(readFileSync(join(target, "my-own", "SKILL.md"), "utf8")).toContain("my-own");
    expect(isBuiltinSkillDir(join(target, "my-own"))).toBe(false);
    // 老版本装过的内置目录（没有标记）会补上标记，但仍不覆盖内容
    expect(scanSkills(target).find((s) => s.dirName === "my-own")?.builtin).toBe(false);
  });
});

describe("技能热插拔（N3-1）", () => {
  it("扫描结果按 mtime 缓存：文件不变走缓存，新增目录立刻可见", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\n", "utf8");
    expect(scanSkills(dir)).toHaveLength(1);

    // 缓存命中路径：再扫一次结果一致
    expect(scanSkills(dir)).toHaveLength(1);

    // 新增技能目录 → 下一次扫描立刻出现（不需要重启 / 手动清缓存）
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "SKILL.md"), "---\nname: b\ndescription: B\n---\n", "utf8");
    expect(scanSkills(dir).map((s) => s.dirName).sort()).toEqual(["a", "b"]);
  });

  it("改 SKILL.md 内容 → 描述立刻更新（mtime/size 变化使缓存失效）", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "a"));
    const path = join(dir, "a", "SKILL.md");
    writeFileSync(path, "---\nname: a\ndescription: 旧描述\n---\n", "utf8");
    expect(scanSkills(dir)[0]?.description).toBe("旧描述");

    writeFileSync(path, "---\nname: a\ndescription: 新描述（更长一些）\n---\n", "utf8");
    expect(scanSkills(dir)[0]?.description).toBe("新描述（更长一些）");
  });

  it("删除技能目录 → 下一次扫描不再出现", () => {
    const dir = tempDir();
    for (const name of ["keep", "gone"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    }
    expect(scanSkills(dir)).toHaveLength(2);
    rmSync(join(dir, "gone"), { recursive: true, force: true });
    expect(scanSkills(dir).map((s) => s.dirName)).toEqual(["keep"]);
  });
});

describe("技能按 Bot 启用（N4 / N3-1）", () => {
  const skill = (dirName: string) => ({
    name: dirName,
    description: `${dirName} 描述`,
    dirName,
    path: `/x/${dirName}/SKILL.md`,
    builtin: false,
  });

  it("null = 全部启用（老 Bot 行为不变）；[] = 一个都不启用；其它 = 白名单", () => {
    const all = [skill("a"), skill("b"), skill("c")];
    expect(filterSkillsByEnabled(all, null)).toHaveLength(3);
    expect(filterSkillsByEnabled(all, undefined)).toHaveLength(3);
    expect(filterSkillsByEnabled(all, [])).toEqual([]);
    expect(filterSkillsByEnabled(all, ["a", "c"]).map((s) => s.dirName)).toEqual(["a", "c"]);
    // 启用列表里有不存在的目录名：忽略，不报错
    expect(filterSkillsByEnabled(all, ["nope"]).map((s) => s.dirName)).toEqual([]);
  });

  it("parseEnabledSkills：NULL/损坏 → null；数组只留字符串", () => {
    expect(parseEnabledSkills(null)).toBeNull();
    expect(parseEnabledSkills(undefined)).toBeNull();
    expect(parseEnabledSkills("not json")).toBeNull();
    expect(parseEnabledSkills('{"a":1}')).toBeNull();
    expect(parseEnabledSkills('["a","b"]')).toEqual(["a", "b"]);
    expect(parseEnabledSkills('["a",1,null,"b"]')).toEqual(["a", "b"]);
    expect(parseEnabledSkills("[]")).toEqual([]);
  });

  it("索引超过 12 条或 800 字符时给出「还有 M 个」提示", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`skill-${i}`));
    const index = buildSkillsIndex(many);
    expect(index.length).toBeLessThanOrEqual(AGENT_LIMITS.maxSkillsIndexChars + 40);
    const listed = index.split("\n").filter((line) => line.startsWith("- ")).length;
    expect(listed).toBeLessThanOrEqual(AGENT_LIMITS.maxSkillsIndexEntries);
    expect(index).toMatch(/另有 \d+ 个技能未列出/);

    // 字符上限：8 条长描述（每条约 130 字符）装不下 800
    const long = Array.from({ length: 8 }, (_, i) => ({
      ...skill(`long-${i}`),
      description: "很长的描述".repeat(40),
    }));
    const longIndex = buildSkillsIndex(long);
    expect(longIndex).toContain("另有");
    // 含提示行在内仍在 800 以内
    expect(longIndex.length).toBeLessThanOrEqual(AGENT_LIMITS.maxSkillsIndexChars);
  });

  it("系统提示：只列启用的技能，并提示未启用的可用 list_skills 查看", () => {
    const enabled = [skill("file-basics")];
    const prompt = buildSystemPrompt({
      cwd: "/tmp",
      skills: enabled,
      totalSkills: 6,
    });
    expect(prompt).toContain("- file-basics: file-basics 描述");
    expect(prompt).toContain("还有 5 个技能未在本 Bot 启用");
    expect(prompt).toContain("list_skills");
  });

  it("系统提示：一个都没启用时仍告诉模型可以 list_skills 发现", () => {
    const prompt = buildSystemPrompt({ cwd: "/tmp", skills: [], totalSkills: 4 });
    expect(prompt).toContain("未启用任何技能");
    expect(prompt).toContain("list_skills");
    // 不输出空的技能索引壳
    expect(prompt).not.toContain("## 可用技能\n需要细节时调用 read_skill 读取完整内容：\n（另有");
  });
});

// ---------------------------------------------------------------------------
// list_skills（N4 档 C）
// ---------------------------------------------------------------------------

describe("list_skills 工具（N4）", () => {
  it("列出全部技能（包括未启用的），并标注启用状态", async () => {
    const { createListSkillsTool } = await import(
      "../../src/server/core/agent/tools/builtin/list_skills.js"
    );
    const dir = tempDir();
    const names = ["file-basics", "shell-basics", "extra-one"];
    for (const name of names) {
      mkdirSync(join(dir, name));
      writeFileSync(
        join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} 的说明\n---\n`,
        "utf8",
      );
    }
    const tool = createListSkillsTool({
      skillsDir: dir,
      enabledSkills: () => ["file-basics", "shell-basics"],
    });
    const result = await tool.execute(
      { cwd: dir, signal: new AbortController().signal, permissionMode: "plan", botRole: "member", askPermission: async () => true },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("file-basics");
    expect(result.output).toContain("shell-basics");
    // 未启用的也要能发现（N4 验收：list_skills 发现 → read_skill 读取）
    expect(result.output).toContain("extra-one");
    expect(result.output).toContain("未启用");
    expect(result.output).toContain("1 个未在本 Bot 启用");
    // list_skills 是只读工具：计划模式下仍可用
    expect(tool.permission).toBe("read");
  });

  it("query 过滤；无匹配给可读结果而不是空串", async () => {
    const { createListSkillsTool } = await import(
      "../../src/server/core/agent/tools/builtin/list_skills.js"
    );
    const dir = tempDir();
    mkdirSync(join(dir, "web-basics"));
    writeFileSync(
      join(dir, "web-basics", "SKILL.md"),
      "---\nname: web-basics\ndescription: 抓取网页正文\n---\n",
      "utf8",
    );
    const tool = createListSkillsTool({ skillsDir: dir });
    const hit = await tool.execute(
      { cwd: dir, signal: new AbortController().signal, permissionMode: "confirm", botRole: "member", askPermission: async () => true },
      { query: "网页" },
    );
    expect(hit.output).toContain("web-basics");

    const miss = await tool.execute(
      { cwd: dir, signal: new AbortController().signal, permissionMode: "confirm", botRole: "member", askPermission: async () => true },
      { query: "数据库" },
    );
    expect(miss.ok).toBe(true);
    expect(miss.output).toContain("没有匹配");
  });
});
