# 待修清单：7 条部分落地的需求

> 2026-10-28。来源：[`agentbot-17-requirements-audit.md`](agentbot-17-requirements-audit.md)（24 条需求逐条核对，17 条已对齐、7 条部分落地）。
> 本文只列**要改什么、改哪里、怎么验收**，不复述审计证据。每条都由独立复核员用代码或实跑验证过。
> 已完成项见 §8，不要重做。

## 0. 一句话

7 条待修，全为 medium，无高危。建议顺序：R8 → R3 → G7 → R5 → R5-c → G3 → R7。
前两条是「数字误导」和「承诺与实现不符」，用户会直接撞上；后五条是边界与体验缺口。

## 1. R8 · 缓存未上报被算成 0%

**问题**：供应商上报了 usage 但没给缓存字段时，用量页显示「0%」而不是「—」。这个 0 还会稀释合计命中率。

**改哪里**

| 文件 | 改什么 |
|---|---|
| `src/server/adapters/providers/openai-chat.ts:140-152` | `prompt_tokens_details.cached_tokens` 缺失时不要 `?? 0`，改为 `undefined` |
| `src/server/adapters/providers/anthropic.ts:199-200, 266-271` | `cache_read_input_tokens` / `cache_creation_input_tokens` 缺失时同上，不要补 0 |
| `src/server/core/db/schema.sql:234-237` | 加列 `cache_reported INTEGER NOT NULL DEFAULT 0` |
| `src/server/core/db/migrate.ts` | v4 迁移加该列；老数据回填 `cache_reported = 0`（历史行确实不知道有没有上报） |
| `src/server/core/usage/recorder.ts:229-249` | 写入时按「缓存字段是否真的出现过」置 `cache_reported`，不再靠 `model IS NOT NULL` 推断 |
| `src/server/core/usage/aggregate.ts:202, 233, 263` | `cache_reported_requests` 改用 `SUM(cache_reported)`，去掉 `model IS NOT NULL` |

**验收**

- [ ] 网关只回 `prompt_tokens/completion_tokens`（无 `prompt_tokens_details`）→ 用量页该行显示 `—`，副行不显示 `0 / 1000`
- [ ] 网关回 `cached_tokens: 0`（真实 0 命中）→ 显示 `0%`，不是 `—`
- [ ] 合计行不被「伪 0」行稀释
- [ ] 两种协议各一条单测；老库升级后历史行显示 `—`

**注意**：`reported`（用量是否上报）与 `cache_reported`（缓存字段是否上报）是两个概念，不要合并。

## 2. R3 · 群聊记忆没有跨 Bot 共享

**问题**：代码注释、schema 注释、UI 文案五处都写「群内所有 Bot 共享」，实现只做到「同 Bot 同渠道」。Bot A 写的群聊记忆，Bot B 读不到，记忆页也看不到。

**两条路，选一条**（需求锚点 `agentbot-11:49` 措辞有歧义，先定口径再改）

- **A. 改成真共享**（符合现有五处文案）：`listInjected` 对 `scope='channel'` 放开 `bot_id` 限制，只按 `channel_id` 过滤。
- **B. 改成不共享**（符合「记忆属于 Bot」的心智）：把五处文案改成「仅本 Bot 在此群聊内可见」。

建议 **A**：用户既然在群聊里协作，记忆共享才符合「一个群一个上下文」的预期；且改文案要动 UI 与 schema 注释，反而更多。

**改哪里（方案 A）**

| 文件 | 改什么 |
|---|---|
| `src/server/core/repo/memory.ts:120-140` | SQL 拆两段：`scope='bot'` 按 bot_id；`scope='channel'` 只按 channel_id（不限 bot）；`scope='session'` 按 source_session_id |
| `src/server/http/routes/memory.ts:93-99` | `listByBot` 增加「本 Bot 所在群聊的 channel 记忆」可见，否则用户在记忆页管理不到 |
| `src/web/pages/BotDetailPage.vue:204, 1523` | 文案已正确，确认与实际一致 |

**验收**

- [ ] 同群聊 Bot A 写一条 channel 记忆 → Bot B 下一轮注入里出现
- [ ] Bot B 的记忆页能看到该条，并标明来源 Bot
- [ ] Bot A 在别的群聊写的 channel 记忆，Bot B 读不到
- [ ] 补一条跨 Bot 的单测（现有 `session-control.test.ts:220-246` 只用同一个 botId，覆盖不到）

## 3. G7 · 群聊写类工具没有串行

**问题**：显式 @ 多个 Bot 时走 `Promise.all`，两个 Bot 在同一 cwd 并发写同一文件，两次都成功、后者覆盖前者、无任何提示。

**改哪里**

| 文件 | 改什么 |
|---|---|
| 新建 `src/server/core/group/write-lock.ts` | 渠道级写锁：按 `channelId` 串行化写类工具调用（读不串）。用 Promise 链或简单队列，不要引第三方依赖 |
| `src/server/adapters/channels/builtin/driver.ts` 的 `askPermission` 或 loop 工具执行前 | 写/exec 类工具执行前先拿该渠道的写锁 |
| `src/server/http/routes/messages.ts:243` | 或在此处按渠道排队（粒度更粗但改动更小，二选一） |

**验收**

- [ ] 两个 Bot 并发写同一文件 → 串行执行，第二个看到第一个的结果
- [ ] 读类工具不被锁影响（并发读仍然并行）
- [ ] 单 Bot 会话不受影响（无额外延迟）
- [ ] 补一条测试：两个并发 write 断言执行区间不重叠

**顺带修文档**：`agentbot-15-change-log-session-control.md:51` 写的兜底依据「PRD 并发 1」作用域是 Assignment，不覆盖群聊并行派发，改掉这句；`agentbot-05-architecture.md:346` 承诺的「并发写风险」提示代码里不存在，要么实现要么删掉。

## 4. R5 · auto 档越界不弹卡

**问题**：需求写「auto 边界内自动批、越界弹卡」，实现是越界直接拒绝、不弹卡。

**先定口径**：现在这个行为有内部依据（`workflows/session-control-admin-bot.dwf.ts:336`「越界拒绝的优先级…仍在弹卡之前」），但那是实现指令，不是需求源头。两条路：

- **A. 改代码对齐需求**：auto 档越界也弹卡，让用户当场决定。
- **B. 改需求对齐代码**：把 R5 改成「auto 边界内自动批、越界直接拒绝（不打扰用户）」。

建议 **B**：越界写直接拒绝更符合「auto = 别烦我」的语义，弹卡等于退回 confirm。但这条要你拍板。

**若选 A，改哪里**：`src/server/core/permissions/resolver.ts:562-572` —— 把 `check.verdict === 'denied'` 时的 `rejectOutOfBoundary` 改为「落 pending 卡片」，full 档仍走绕过。同时改 `tests/unit/permission-modes.test.ts:193-203` 的固化断言。

**若选 B，改哪里**：`agentbot-11-requirements-align.md:51,66` 与 `agentbot-02-ux.md:307` 三处文案。

## 5. R5-c · MCP 工具在 plan 下没被裁掉

**问题**：内置写类工具在 plan 下裁掉了，MCP 工具在 `driver.ts:487-490` 被无条件拼进注册表，权限硬编码 `exec`。模型仍能看到 `mcp__*`，调用后才被拒。

**改哪里**

| 文件 | 改什么 |
|---|---|
| `src/server/adapters/channels/builtin/driver.ts:487-490` | MCP 工具也走 `isWriteLike(permission)` 过滤，plan 下裁掉 |
| `src/server/adapters/mcp/manager.ts:109-144` | `tools()` 接受可选 permissionMode，或把过滤放在 driver 侧（推荐后者，manager 不感知权限模式） |

**验收**

- [ ] plan 模式下发给模型的 tools 列表不含任何 `mcp__*` 写类工具
- [ ] plan 模式下读类 MCP 工具（如果声明为 read）仍然可用
- [ ] 补测试：构造一个 mcp stub + plan 模式，断言 tools 列表

## 6. G3 · 切 plan 的系统块刷新后消失

**问题**：「已按计划模式拒绝 N 个挂起请求」是前端本地插入的，只写内存不落库，刷新即失，其它标签页也看不到。

**改哪里**

| 文件 | 改什么 |
|---|---|
| `src/server/http/routes/sessions.ts:262-280` | 切 plan 时除了审计 meta，再写一条**持久 system 消息**（或让 `config_update` 的 meta 带上 `rejectedPending`） |
| `src/web/lib/turnModel.ts:615-626` | `dividerText` 对 `config_update` 返回带数量的文案（需要拿到 payload.data） |
| `src/web/stores/events.ts:116-128` | `pushMeta` 把 `payload.data` 传给 `dividerText`，不要只传 kind |
| `src/web/pages/ChatPage.vue:2006` | 去掉本地补丁，避免与流内块重复 |

**验收**

- [ ] 切 plan 后流里出现「已按计划模式拒绝 N 个挂起请求」
- [ ] 刷新页面后这条仍在
- [ ] 另一个标签页也能看到
- [ ] 不再出现重复两条

## 7. R7 · 压缩的条数/字数没进流

**问题**：分隔条文案是固定串，后端已经放进事件的 `removedMessages` / `summaryChars` 被前端丢弃。

**改哪里**

| 文件 | 改什么 |
|---|---|
| `src/web/lib/turnModel.ts:615-623` | `dividerText` 接受可选的 data 参数，compaction 分支输出「已压缩 N 条 → 摘要 M 字」 |
| `src/web/stores/events.ts:116-128` | 把 `payload.data` 传进去 |
| `src/web/pages/ChatPage.vue:1955-1956` | 去掉本地 toast 的重复提示（或保留 toast，但流内不再重复） |

**验收**

- [ ] 自动压缩后流里显示「已压缩 N 条 → 摘要 M 字」
- [ ] 手动压缩同样显示，且不出现两条
- [ ] 刷新后仍在（因为来自入库的 meta）

## 8. 已完成，不要重做

| 编号 | 内容 |
|---|---|
| R1 / R2 / R2-b / G8 | 工作区：创建去路径化、会话/渠道/回退链、群聊共用、校验不要求 git |
| G1 / G5 | 记忆回填 `scope='bot'`；压缩阈值 70% 按窗口占用比、摘要用会话模型 |
| R4 / G9 / R4-b | 会话级模型覆盖、每轮重读、跨协议提示 |
| R5-b / R6 / G4 | 权限胶囊与 Shift+Tab；管理员 Bot 与 `create_bot`；管理员不自动获得 full |
| X1 / X2 / X3 / X4 / X5 | 拉模型清单与能力带出；映射表可维护（内置 JSON + 用户覆盖，页面可编辑）；数据整理可勾选；默认不删用量；会话列表过滤归档 Bot |

## 9. 换设备开工

```bash
git clone https://github.com/liyunxuanyu/agentbot.git
cd agentbot && git checkout continue-dev
npm install && npm run build && npm run start:local
```

四条门禁（每次改完都跑）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.json --noEmit
node scripts/check-boundaries.mjs
node node_modules/vitest/vitest.mjs run
```

端到端：`node scripts/smoke-builtin.mjs`。

**注意**：vitest 偶发失败（契约测试时序），连跑三次确认；当前基线 421 passed。

## 10. 开工前要先拍板的两件事

1. **R3 走 A 还是 B**（群聊记忆共享 / 不共享）——建议 A。
2. **R5 走 A 还是 B**（auto 越界弹卡 / 直接拒绝）——建议 B。

这两条定了之后，7 条都可以独立开工，文件不重叠，可以并行。
