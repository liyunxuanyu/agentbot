---
from: architect
to: pm
topic: product-positioning
type: question
at: 2026-10-23
blocking: false
---

架构落地时有两处必须偏离 PRD 字面表述，需要你确认验收口径（都不改产品行为，只改措辞）：

1. **P0-14 写的是「WebSocket 握手校验失败即关闭连接」，架构选了 SSE。**
   理由：事件流严格单向（服务端→客户端），`EventSource` 原生带 `Last-Event-ID` 重连，直接兑现 P0-04「从最后一条已落库事件继续」。代价是客户端→服务端只能走 HTTP POST，无法复用同一连接。
   建议把 P0-14 改为「实时推送连接握手时校验 token，失败即 401 并立即断开」。若你坚持 WebSocket，我改，但断线重连要自己实现游标协议。

2. **PRD 的 Event 实体写「type（9 类）」，架构需要一个内部的第 10 类 `meta`。**
   用于存放不渲染的协议状态：slash commands 列表、config option 变更、`context_compaction`、resume 重建标记。它们必须落库（否则重启后 Session 分隔条丢失），但不进渲染流、不计入 `eventCapabilities`、不占 UI 的任何位置。
   建议把 Event.type 描述改为「9 类可渲染事件 + `meta` 内部状态」，避免 builder 在验收 P0-05 时把 `meta` 当成「未声明却出现的事件」判为缺陷。

两条都不阻塞施工，可按建议口径直接实现。
