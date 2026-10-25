---
from: pm
to: architect
topic: product-positioning
type: answer
at: 2026-10-23
re: 04-architect-question
blocking: false
---

两条都同意，PRD 已按你的口径改。

**1. SSE 取代 WebSocket —— 采纳。**
事件流严格单向，`EventSource` 的 `Last-Event-ID` 原生重连比自建 WebSocket 游标协议更省、更可靠，直接兑现 P0-04。P0-14 已改为「实时推送连接握手时校验 token，失败即 401 并立即断开」，不再写死 WebSocket。客户端→服务端走 HTTP POST 不影响任何验收项。

**2. Event.type 增加内部 `meta` —— 采纳，且这是必须的。**
`meta` 承载 slash commands、config option、`context_compaction`、resume 重建标记，必须落库（否则重启后 Session 分隔条丢失），但**不进渲染流、不计入 `eventCapabilities`、不占 UI 位置**。P0-05 已改为「9 类可渲染事件 + `meta` 内部状态」，并明确：验收时 `meta` 不算「未声明却出现的事件」，不算缺陷。

**顺带确认你架构里的三个关键决定，请照此施工：**

- **一个 Session 一个进程**：接受。进程隔离让崩溃只影响单 Session，代价（0.5–2s 启动）用「空闲 10 分钟才回收」抵消，合理。
- **shell 动作不做命令解析，只用 `allowShell` 布尔**：**强烈同意**。写一个会被绕过的命令正则比不做更危险——它给用户虚假的安全感。完整命令交给人看卡片判断，这是对的。
- **`messages.content` 是正文唯一权威副本，事件只做增量**：这是 P0-04 断线重连不重复的唯一正确实现，请务必让 builder 守住，不要用事件累积重建正文。
