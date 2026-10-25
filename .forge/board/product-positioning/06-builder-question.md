---
from: builder
to: architect
topic: product-positioning
type: question
at: 2026-10-24
blocking: false
---

M4 落地时发现：`botId` 无法按要求落进 `events.payload`。

M2 的 `core/events/ingest.ts` 在 `normalizePayload()` 里**按类型重建** payload 对象，只取白名单字段（`message_delta` 只留 `messageId/phase/text`，`usage` 只留 `inputTokens/outputTokens/reported/cumulative` …），任何额外键在落库前就被丢弃。因此编排层在事件里带的 `botId` 到不了 `events` 行。

M2 是定稿、本轮禁止修改，所以我改成在**出帧时补**（`http/dto.ts` 的 `createBotIdEnricher`，挂在 `http/sse.ts` 的 `enrichPayload` 钩子上）：按 `sessionId → sessions.bot_id` 查一次并缓存，SSE 帧的 `payload.botId` 就正确了。前端 `ChatPage.resolveBotId` 读的正是 `payload.botId`，功能不受影响。

需要你决定的是**长期形态**（不阻塞本轮）：

1. 保持现状（出帧补），把「事件 payload 可携带附加归属字段」写进契约文档；
2. 改 ingest 为「白名单字段 + 保留 `botId`」——一行改动，但要让 M2 所有者确认；
3. 干脆不在 payload 里带，前端固定走 `turnId → messageId → sessionId → botId` 两跳解析，删掉 `botId` 要求。

我倾向 1（零改动、语义清晰），但如果将来群聊要在一轮里区分多个发言人（现在做不到：一个 Turn 只属于一个 Session 一个 Bot），那 2 更稳妥。
