import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInside } from "../../src/server/core/agent/tools/paths.js";
import { truncateText } from "../../src/server/core/agent/tools/truncate.js";
import { readFileTool } from "../../src/server/core/agent/tools/builtin/read_file.js";
import { writeFileTool } from "../../src/server/core/agent/tools/builtin/write_file.js";
import { editFileTool } from "../../src/server/core/agent/tools/builtin/edit_file.js";
import { listDirTool } from "../../src/server/core/agent/tools/builtin/list_dir.js";
import { grepTool } from "../../src/server/core/agent/tools/builtin/grep.js";
import { readSkill, scanSkills, buildSkillsIndex } from "../../src/server/core/agent/skills.js";
import type { ToolContext } from "../../src/server/core/agent/tools/registry.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-tools-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄占用
    }
  }
});

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    permissionMode: "confirm",
    botRole: "member",
    askPermission: async () => true,
  };
}

describe("路径安全", () => {
  it("允许 cwd 内的相对路径与绝对路径", () => {
    const cwd = tempDir();
    expect(resolveInside(cwd, "a.txt").ok).toBe(true);
    expect(resolveInside(cwd, join(cwd, "sub", "b.txt")).ok).toBe(true);
  });

  it("拒绝 .. 逃逸与外部绝对路径", () => {
    const cwd = tempDir();
    expect(resolveInside(cwd, "../x").ok).toBe(false);
    expect(resolveInside(cwd, "/etc/passwd").ok).toBe(false);
  });

  it("拒绝符号链接指向 cwd 外", () => {
    const cwd = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    try {
      symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
    } catch {
      return; // 无权限创建符号链接（Windows 非管理员）时跳过
    }
    expect(resolveInside(cwd, "link.txt").ok).toBe(false);
  });
});

describe("截断", () => {
  it("按行截断并注明省略量", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateText(text, { maxLines: 10, maxBytes: 10_000 });
    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBe(20);
    expect(result.text).toContain("已截断");
    expect(result.text.split("\n").length).toBeLessThan(15);
  });

  it("按字节截断不切坏多字节字符", () => {
    const result = truncateText("你好世界你好世界", { maxBytes: 7, maxLines: 100 });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
  });
});

describe("文件工具", () => {
  it("write_file → read_file → edit_file 闭环", async () => {
    const cwd = tempDir();
    const c = ctx(cwd);
    const write = await writeFileTool.execute(c, { path: "notes/a.md", content: "hello world" });
    expect(write.ok).toBe(true);
    const read = await readFileTool.execute(c, { path: "notes/a.md" });
    expect(read.output).toBe("hello world");
    const edit = await editFileTool.execute(c, {
      path: "notes/a.md",
      oldText: "world",
      newText: "agent",
    });
    expect(edit.ok).toBe(true);
    const after = await readFileTool.execute(c, { path: "notes/a.md" });
    expect(after.output).toBe("hello agent");
  });

  it("edit_file 要求 oldText 唯一", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "dup.txt"), "x x", "utf8");
    const result = await editFileTool.execute(ctx(cwd), {
      path: "dup.txt",
      oldText: "x",
      newText: "y",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不唯一");
  });

  it("write_file 拒绝越界路径", async () => {
    const cwd = tempDir();
    const result = await writeFileTool.execute(ctx(cwd), { path: "../evil.txt", content: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("越出工作目录");
  });

  it("list_dir 与 grep", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "const answer = 42;\n", "utf8");
    writeFileSync(join(cwd, "src", "b.ts"), "const other = 1;\n", "utf8");
    const list = await listDirTool.execute(ctx(cwd), { path: "src" });
    expect(list.output).toContain("a.ts");
    const root = await listDirTool.execute(ctx(cwd), { path: "." });
    expect(root.output).toContain("[dir] src");
    const grep = await grepTool.execute(ctx(cwd), { pattern: "answer\\s*=\\s*42" });
    expect(grep.output).toContain("src/a.ts:1");
  });
});

describe("技能扫描", () => {
  it("解析 frontmatter、生成索引、按名读取", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "demo"));
    writeFileSync(
      join(dir, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: 一个演示技能\n---\n\n# Demo\n正文\n",
      "utf8",
    );
    const skills = scanSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "demo", description: "一个演示技能", dirName: "demo" });
    const index = buildSkillsIndex(skills);
    expect(index).toContain("- demo: 一个演示技能");
    const full = readSkill("demo", dir);
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.content).toContain("# Demo");
    expect(readSkill("../etc", dir).ok).toBe(false);
  });
});
