import { describe, expect, it } from "vitest";
import { inferModelMeta, defaultWindowFor } from "../../src/server/adapters/providers/models.js";

/**
 * 模型能力推断（供应商表单「带出上下文窗口 / 最大输出」的数据来源）。
 *
 * 这些断言挡的是「默认值明显错」：窗口比输出上限还小、认不出自家模型、
 * 未知模型瞎编数字。真实数值以供应商文档为准，用户可手改。
 */
describe("模型能力推断", () => {
  it("命中内置对照表：标记 known 且窗口大于输出上限", () => {
    for (const id of [
      "gpt-4o-mini",
      "deepseek-v4.1-flash",
      "gemini-2.5-pro",
      "qwen-max",
      "glm-4.5",
    ]) {
      const meta = inferModelMeta(id);
      expect(meta.known, `${id} 应命中对照表`).toBe(true);
      expect(meta.contextWindow, `${id} 应有窗口`).not.toBeNull();
      expect(meta.maxOutputTokens, `${id} 应有输出上限`).not.toBeNull();
      expect(meta.maxOutputTokens!, `${id} 输出上限应小于窗口`).toBeLessThan(meta.contextWindow!);
    }
  });

  it("命名里带 32k/128k 的未知模型：按名字推断窗口", () => {
    const meta = inferModelMeta("some-vendor-model-32k");
    expect(meta.known).toBe(false);
    expect(meta.contextWindow).toBe(32 * 1024);
    expect(meta.maxOutputTokens).toBeGreaterThan(0);
  });

  it("完全认不出的模型：不给假数字，返回 null", () => {
    const meta = inferModelMeta("internal-model-x");
    expect(meta.known).toBe(false);
    expect(meta.contextWindow).toBeNull();
    expect(meta.maxOutputTokens).toBeNull();
  });

  it("label 缺省时等于 id；给了就保留", () => {
    expect(inferModelMeta("gpt-4o").label).toBe("gpt-4o");
    expect(inferModelMeta("gpt-4o", "GPT-4o").label).toBe("GPT-4o");
  });

  it("协议兜底窗口：Anthropic 比 [OI] 大", () => {
    expect(defaultWindowFor("anthropic-messages")).toBeGreaterThan(defaultWindowFor("openai-chat"));
  });
});
