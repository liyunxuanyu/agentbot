import { describe, expect, it } from "vitest";
import {
  DIFF_MAX_LINES,
  renderUnifiedDiff,
  unifiedDiff,
} from "../../src/server/core/agent/tools/diff.js";

/**
 * 行级 diff（写类工具的 fileChange 用它生成）。
 *
 * 断言口径：只关心「改了什么」——新增/删除行数、变更行内容；
 * 上下文行数量与顺序不作为契约（LCS 可能有多种合法解）。
 */
describe("unifiedDiff", () => {
  it("新建文件：全部行都是新增", () => {
    const d = unifiedDiff("", "a\nb\n");
    expect(d.added).toBe(3); // "a" / "b" / "" （末尾换行产生的空行）
    expect(d.removed).toBe(0);
    expect(d.truncated).toBe(false);
  });

  it("单行替换：一加一删，未变更行保留为上下文", () => {
    const d = unifiedDiff("hello\n", "hello2\n");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines.filter((l) => l.kind === "+").map((l) => l.text)).toEqual(["hello2"]);
    expect(d.lines.filter((l) => l.kind === "-").map((l) => l.text)).toEqual(["hello"]);
  });

  it("插入一行：只增不删", () => {
    const d = unifiedDiff("a\nc\n", "a\nb\nc\n");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.lines.map((l) => `${l.kind}${l.text}`)).toContain("+b");
  });

  it("删除一行：只删不增", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nc\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(1);
  });

  it("内容完全相同时没有任何变更行", () => {
    const d = unifiedDiff("same\n", "same\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.kind === " ")).toBe(true);
  });

  it("超过行数上限时标 truncated，不把整个文件比完", () => {
    const big = Array.from({ length: DIFF_MAX_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    const d = unifiedDiff(big, `${big}\nextra`);
    expect(d.truncated).toBe(true);
  });

  it("renderUnifiedDiff 带 a/ b/ 头，且按上限截断", () => {
    const d = unifiedDiff("a\n", "b\n");
    const text = renderUnifiedDiff("src/x.ts", d);
    expect(text.startsWith("--- a/src/x.ts\n+++ b/src/x.ts\n")).toBe(true);
    expect(text).toContain("-a");
    expect(text).toContain("+b");
    const clipped = renderUnifiedDiff("src/x.ts", d, 20);
    expect(clipped.length).toBeLessThanOrEqual(20);
    expect(clipped.endsWith("…")).toBe(true);
  });
});
