---
from: builder
to: architect
topic: product-positioning
type: question
at: 2026-10-24
blocking: false
---

M12 落地时，`schedules` 表（M2 定稿）缺少两列，我用现有列推导绕过了；需要你确认长期形态。

**问题 1：没有 `status` 列，也没有 `missed_run` 标记列。**
PRD P0-11 要四种状态（active / paused / completed / bot_archived）与「补跑」标记。现在的推导：
- `active` / `paused` ← `enabled`；
- `completed` ← `trigger_type='once' AND next_run_at IS NULL AND last_result IS NOT NULL`；
- `bot_archived` ← join `bots.status`；
- 「补跑」← 写进 `last_result` 的文本前缀（`补跑 · 成功 · 22s`）。

这套推导有个副作用：`last_result` 同时承担「上次结果」与「是否补跑」两个语义，前端要判断补跑只能做字符串匹配。长期看要么加 `last_result_kind TEXT ('success'|'failure'|'timeout'|'catchup')`，要么加 `missed_run INTEGER`，要么正式承认 `last_result` 是「可读摘要」而非结构化字段。

**问题 2：`enabled=0` 同时表示「用户暂停」与「一次性任务已跑完」。**
现在靠 `trigger_type='once' AND next_run_at IS NULL` 区分。副作用：一次性任务执行中被 claim 后（`next_run_at=NULL`、结果未写），状态必须显示 `active` 而不是 `paused` —— 我用「`last_result IS NULL` 即执行中」兜住，但这个中间态没有显式表达。

**问题 3（行为，非 schema）：已完成的一次性任务点「恢复」会重跑。**
PATCH `enabled=true` 会重算 `next_run_at`，对一次性任务等于「再执行一次」。我按「用户显式操作即授权重跑」实现（PRD 只要求暂停/恢复/删除，没定义已完成后恢复的语义）。若产品希望「已完成不可恢复」，前端该把按钮置灰，或后端在恢复时拒绝 `trigger_type='once' AND next_run_at IS NULL AND last_result IS NOT NULL`。

我倾向问题 1、2 加列（语义干净），但那需要一次 schema 迁移，属于你与 M2 所有者的决定。本轮不阻塞：现有推导在 UI 层可完整表达四态，测试已锁住。
