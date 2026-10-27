import { describe, expect, it } from "vitest";
import { dividerText } from "../../src/web/lib/turnModel";

/**
 * G3 / R7：分隔条文案要带上后端给的数字。
 *
 * 之前 `dividerText` 只收 kind，压掉 `payload.data`，于是「已压缩 N 条 → 摘要 M 字」
 * 与「已按计划模式拒绝 N 个挂起请求」永远退化成固定串。这里直接测纯函数。
 */

describe("dividerText（G3 / R7）", () => {
  it("compaction 带 removedMessages / summaryChars → 显示条数与字数", () => {
    expect(
      dividerText("compaction", { removedMessages: 12, summaryChars: 340, trigger: "auto" }),
    ).toBe("已压缩 12 条 → 摘要 340 字");
  });

  it("compaction 手动触发同样显示（trigger 不影响文案）", () => {
    expect(
      dividerText("compaction", { removedMessages: 3, summaryChars: 88, trigger: "manual" }),
    ).toBe("已压缩 3 条 → 摘要 88 字");
  });

  it("compaction 只有条数 / 完全没有数据 → 退回可读的降级文案", () => {
    expect(dividerText("compaction", { removedMessages: 5 })).toBe("已压缩 5 条消息");
    expect(dividerText("compaction")).toBe("上下文已压缩 · 更早的对话被摘要替代");
    expect(dividerText("compaction", { note: "运行时压缩了上下文" })).toBe(
      "上下文已压缩 · 更早的对话被摘要替代",
    );
  });

  it("切 plan 的 config_update → 显示拒绝数量", () => {
    expect(dividerText("config_update", { rejectedPending: 2, modeSwitchedTo: "plan" })).toBe(
      "已按计划模式拒绝 2 个挂起请求",
    );
  });

  it("普通 config_update（改模型/工作区/0 个拒绝）→ 不产生分隔条", () => {
    expect(dividerText("config_update", { model: "gpt-x" })).toBeNull();
    expect(dividerText("config_update", { rejectedPending: 0 })).toBeNull();
    expect(dividerText("config_update")).toBeNull();
  });

  it("session_rebuilt / session_resumed 文案不变", () => {
    expect(dividerText("session_rebuilt")).toContain("已重建上下文");
    expect(dividerText("session_resumed")).toContain("续接上一 Session");
  });

  it("未知 kind → null（命令/协议更新不插分隔条）", () => {
    expect(dividerText("commands_update")).toBeNull();
    expect(dividerText("unknown_protocol")).toBeNull();
  });
});
