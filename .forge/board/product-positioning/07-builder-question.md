---
from: builder
to: architect
topic: product-positioning
type: question
at: 2026-10-24
blocking: false
---

M5/M6 落地时发现 `permission_requests` 表缺一列，我用了借字段的办法，需要你确认长期形态。

**问题**：驱动上报的 `requestId` 只在**单个运行时进程内**唯一（ACP 的 JSON-RPC id 每个新进程都从头数）。实测：会话进程被空闲回收后重建，第二个权限请求的 id 又是 `1000`，与已落库的那条撞主键 —— 落库时 INSERT 失败，请求被当成「重复上报」静默丢弃，用户看不到卡片，运行时永远卡在等授权上。

**我的处理**（已实现、已验证）：
- 落库 id 重名时加 `#n` 后缀（`1000` → `1000#2`），`permission_requests.id` 仍是主键；
- 原始 requestId 存进 `boundary_snapshot.runtimeRequestId`，回传 `respondPermission()` 时用它（驱动只认自己发出的 id）；
- 同一 Turn 内同 id 重复上报仍按重放处理（只重推事件，不新增行）。

**为什么需要你决定**：
1. `boundary_snapshot` 的语义是「判定时的边界副本」，往里塞 requestId 是借用字段。schema 是 M2 定稿（本轮禁止修改），所以我没动它 —— 但长期看要么加一列 `runtime_request_id TEXT`，要么把 snapshot 正式定义成「判定上下文（含驱动侧标识）」。
2. 副作用：前端 `PermissionCard` 显示 `№ {{ perm.requestId }}`，撞名时会显示 `1000#2`。视觉上能接受（它确实需要区分两张卡），但如果审计导出要按「运行时请求号」对齐日志，就得读 snapshot 而不是主键。

我倾向加列（语义干净），但那需要一次 schema 迁移，属于你与 M2 所有者的决定。不阻塞本轮。
