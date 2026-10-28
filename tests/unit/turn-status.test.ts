import { describe, expect, it } from "vitest";
import { buildTurnView, type RawEvent } from "../../src/web/lib/turnModel";
import type { MessageDto } from "../../src/web/net/types";

/**
 * Turn 状态推导（纯函数）。
 *
 * 这一组用例锁住一条真机踩过的规则：**收口信息优先于「思考还在流式」**。
 * 服务重启 / 连接中断时 thought 的 end 帧永远不会到，若按「思考还在流式」
 * 判 streaming，那一轮会永远停在生成中 —— 发送键卡在「停止」、输入框发不出
 * 消息（手机端刷新后整个会话都发不出去）。
 */

const NOW = 1_700_000_000_000;

function ev(seq: number, type: string, payload: unknown): RawEvent {
  return {
    id: seq,
    sessionId: "s1",
    messageId: null,
    turnId: "t1",
    type: type as RawEvent["type"],
    seq,
    payload,
    raw: null,
    createdAt: NOW + seq,
  };
}

function msg(id: string, status: MessageDto["status"], content: string): MessageDto {
  return {
    id,
    sessionId: "s1",
    channelId: "c1",
    turnId: "t1",
    role: "assistant",
    content,
    contentVersion: 0,
    status,
    tokensIn: null,
    tokensOut: null,
    createdAt: NOW,
  };
}

function build(events: RawEvent[], messages: MessageDto[] = []): ReturnType<typeof buildTurnView> {
  return buildTurnView({
    turnId: "t1",
    botId: "b1",
    events,
    messages,
    streamingText: {},
    blockingTurnIds: new Set(),
  });
}

describe("buildTurnView · 状态推导", () => {
  it("有 done → done", () => {
    const v = build([ev(1, "done", { stopReason: "end", durationMs: 10 })], [msg("m1", "done", "hi")]);
    expect(v.status).toBe("done");
  });

  it("done 的 stopReason=cancelled → interrupted", () => {
    const v = build([ev(1, "done", { stopReason: "cancelled", durationMs: 10 })]);
    expect(v.status).toBe("interrupted");
  });

  it("fatal error → failed", () => {
    const v = build([ev(1, "error", { message: "崩了", fatal: true })]);
    expect(v.status).toBe("failed");
  });

  it("消息行 status=failed → failed（即使没有 error 事件）", () => {
    const v = build([], [msg("m1", "failed", "")]);
    expect(v.status).toBe("failed");
  });

  it("消息都落库、思考停在流式中（缺 end 帧）→ done，不能卡在生成中", () => {
    // 真机场景：服务重启后，历史里只有 thought start/delta，没有 end。
    const v = build(
      [
        ev(1, "thought", { phase: "start", text: "" }),
        ev(2, "thought", { phase: "delta", text: "想想" }),
      ],
      [msg("m1", "done", "答案")],
    );
    expect(v.status).toBe("done");
  });

  it("消息还在流式 → streaming", () => {
    const v = build([ev(1, "message_delta", { messageId: "m1", phase: "start", text: "" })], [
      msg("m1", "streaming", "半截"),
    ]);
    expect(v.status).toBe("streaming");
  });

  it("没有消息、只有思考且仍在流式 → streaming", () => {
    const v = build([ev(1, "thought", { phase: "start", text: "" })]);
    expect(v.status).toBe("streaming");
  });

  it("有事件、没有消息、也没有流式标记 → waiting（等权限或运行时静默）", () => {
    const v = build([ev(1, "tool_call", { callId: "c1", name: "read_file", status: "running" })]);
    expect(v.status).toBe("waiting");
  });
});

/**
 * 同一 requestId 的多帧 permission_request（2026-10-28 真机截图）。
 *
 * 驱动会重放、REST 轮询与 SSE 会重叠、resolver 在裁决后还会再推一条
 * 「状态已变」的通知 —— 它们代表**同一张卡**。旧实现每帧都 push 一个
 * permission item，批准一次后界面上出现两条「已批准 · 你」的审计行。
 */
describe("buildTurnView · 权限请求去重", () => {
  function perm(seq: number, requestId: string, verdict = "allowed"): RawEvent {
    return ev(seq, "permission_request", {
      requestId,
      action: "write",
      target: "/tmp/a.txt",
      boundaryVerdict: verdict,
    });
  }

  it("同一 requestId 的多帧只渲染一张卡", () => {
    const v = build([perm(1, "builtin_perm_3"), perm(2, "builtin_perm_3"), perm(3, "builtin_perm_3")]);
    const perms = v.items.filter((i) => i.kind === "permission");
    expect(perms).toHaveLength(1);
    // 保留第一帧的 seq：卡片应该出现在「请求发生」的位置，而不是最后一次通知的位置
    expect(perms[0]?.seq).toBe(1);
  });

  it("不同 requestId 各自保留", () => {
    const v = build([perm(1, "p1"), perm(2, "p2"), perm(3, "p1")]);
    const ids = v.items.filter((i) => i.kind === "permission").map((i) => (i.kind === "permission" ? i.requestId : ""));
    expect(ids).toEqual(["p1", "p2"]);
  });
});
