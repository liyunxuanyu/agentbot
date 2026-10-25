# 聊天页交互修复（3 项）

你是 product-forge 的 builder。项目根 `D:/workspace/Agent WorkSpace/agentbot`。

**只改 `src/web/pages/ChatPage.vue`、`src/web/components/chat/TurnItem.vue`、`src/web/lib/turnModel.ts`**（按需）。
**不要改 `src/web/styles/base.css`**（另一实例在改样式，你只能给元素加 class/属性）。不要碰 `src/server/**`。

## 背景
用户试用后报了三件事。我已用 Playwright 实测确认根因，照证据修。

## 必读
- `.forge/agentbot-01-prd.md` P0-04（私聊流式：发送后 2s 内 UI 出现首个流式 token / 结束后状态由「生成中」变「完成」）、P0-05
- `.forge/agentbot-02-ux.md` §5.1（单展开）、§6.1（发送与中断）
- `.forge/agentbot-prototype-v2/index.html`（视觉与交互权威）—— 搜 `.turn-summary-line`、`turnHtml`、`msg-name`、`runDmReply`，看原型怎么处理「生成中」Turn
- 现有代码：`src/web/pages/ChatPage.vue`（sendText / rows / turnViews）、`src/web/components/chat/TurnItem.vue`、`src/web/lib/turnModel.ts`

---

## 问题 1：折叠态「展开查看」点击没反应

### 实测证据
```js
// 点 Turn 头 → 有效
before: { turns: 5, collapsed: 5, bodies: [36,36,36,36,36] }
after head click: { turns: 5, collapsed: 4, bodies: [170,36,36,36,36] }

// 点摘要行「展开查看」→ 完全无效
after summary click: { turns: 5, collapsed: 4, bodies: [170,36,36,36,36] }
```
根因：`TurnItem.vue` 只有 `.turn-head` 有 `@click="emit('toggle', turn.turnId)"`；折叠态摘要行 `.turn-summary-line`（含「展开查看」四个字）是纯展示，没有 handler。

### 修法
- 折叠态摘要行整行可点 → 触发同一个 `emit('toggle', turn.turnId)`
- 加 `role="button"`、`tabindex="0"`、`:aria-expanded="!collapsed"`、Enter/Space 键支持（与 `.turn-head` 一致）
- 加 `cursor: pointer` 与 hover 反馈 —— **样式由另一实例的 base.css 负责**，你只加 class（如 `turn-summary-line--clickable`）并写进返回结果的「需要配合的样式」
- 点击「展开查看」文字本身也必须生效（整行可点即可覆盖）

---

## 问题 2：消息里的 Bot 头像/名字点击没反应

### 实测证据
用户截图圈出 Turn 体内 `.msg` 上的 24px 头像，点击无任何反应。
现状：`.msg` 内的 `BotAvatar` + `.msg-name` 是纯展示。Turn 头已有 `研 研究助手`，体内又重复一次，用户自然会去点它。

### 修法
让 `.msg` 的头像 + 名字成为该轮的折叠/展开入口（与 Turn 头一致）：
- 包一层可点区域（头像 + 名字），`@click` → `emit('toggle', turn.turnId)`
- 加 `title="折叠这一轮"` / `"展开这一轮"`（按当前态）
- `cursor: pointer` + hover 视觉（class 交给 base.css 实例）
- **不要**改变气泡本身的点击行为（气泡内的文字要能选中复制）
- 只在「消息属于某个 Turn」时生效；独立消息（无 Turn）不加

---

## 问题 3（最重要）：发送后 15–30s 内没有任何「正在处理」的反馈

### 实测证据
```js
BEFORE:      { users: 6, turns: 6, streamingTurns: 0, sendLabel: "发送" }
TYPED:       { sendDisabled: false }
t=400ms:     { users: 7, turns: 6, streamingTurns: 0, sendLabel: "发送" }   ← 用户消息出现了
t=1200ms:    { users: 7, turns: 6, streamingTurns: 0, sendLabel: "发送" }
t=3000ms:    { users: 7, turns: 6, streamingTurns: 0, sendLabel: "发送" }
t=8000ms:    { users: 7, turns: 6, streamingTurns: 0, sendLabel: "发送" }
t=20000ms:   { users: 7, turns: 6, streamingTurns: 0, sendLabel: "发送" }
```
DB 证实消息确实发了、模型也回了（`rowid 15/16`）。但**这 20 秒里 UI 完全静止**：没有 Turn、没有「生成中」、发送键还是「发送」。

ZCode 是 `streaming: false` 的 CLI 通道，一轮 15–30s 才整段返回。用户原话：「我都不知道有没有发送成功，或者模型正在回答中/思考中的任何提示」。

### 修法（P0-04 的硬要求）
`POST /api/messages` 返回 `{messageId, turnId, sessionId}` 后，**立刻在 UI 里创建一个 pending Turn**，不要等 SSE 第一条事件：

1. **pending Turn 的形状**（复用 `TurnView`，新增或标记 `status: "pending"`）：
   - `turnId` / `botId` 来自 POST 响应（`botId` 用本轮实际执行的 Bot；群聊取 `speakers[0]`，DM 取唯一参与者）
   - `startedAt = Date.now()`，`status = "pending"`
   - Turn 头状态 chip 显示「生成中」（`working` 态），右侧显示已用秒数（每秒更新）
   - **Turn 体给明确文案**：
     - 运行时 `streaming === false`（CLI 通道）→「等待运行时返回完整结果 · 已 Ns」，并附「预计 30–60s」（可从 Bot 的 runtime 拿，拿不到就写「通常 15–30 秒」）
     - 运行时 `streaming === true` →「正在连接运行时…」（首个事件到达后自动消失）
2. **发送键立刻变「停止」**（`.comp-send` 的 `is-stop` 态已有，只要 `streamingTurn` 能识别 pending Turn 即可）
3. **第一条 SSE 事件到达** → pending Turn 升级为真实 Turn（用同一 turnId 合并，**不要出现两个 Turn**）
4. **收口**（`done`/`error`）→ 恢复正常 Turn
5. **失败要说话**：
   - `POST` 返回非 2xx → 用户消息标失败（红条 + 重发），并 toast 具体原因（用 `ApiError.bodyMessage`）
   - `POST` 成功但 30s 内无任何事件 → 该 Turn 显示「无响应」（已有 `stalled` 机制，确认对 pending Turn 也生效）
   - `POST` 成功但运行时崩溃 → 该 Turn 标失败（已有 `error` 事件路径）
6. **不要在页面刷新后残留 pending Turn**：pending 只存在于「本次发送到首个事件之间」，刷新后以服务端数据为准

### 关键约束
- pending Turn 必须能被 `rows` 装配逻辑正确排序（用 `startedAt`）
- 同一时刻只允许一个 pending（单展开）
- 不要重复插入：如果 SSE 先到了（比 POST 响应快），要以 turnId 去重
- 群聊：POST 响应带 `speakers`，pending Turn 只给**第一个**发言人建；其余等各自 Session 的首个事件

---

## 绝对不要做
- 不改 `src/server/**`（后端已定稿；`POST /api/messages` 已返回 turnId/sessionId）
- 不改 `src/web/styles/base.css`（另一实例在改；你只加 class/属性，并在返回结果里列出「需要 base.css 配合的样式」）
- 不改 tokens.css 令牌值
- 不改已验收的视觉结构（BotsPage、Turn 头布局、气泡样式）
- 不擅自加需求

## 验证（必须自己跑，贴真实输出）
1. `npx vue-tsc --noEmit` 通过、`npm run build:web` 成功、`npx vitest run` 不回归
2. 起真实服务（**用临时 home，不要动用户数据**）：
   ```bash
   npm run build:server
   TMPHOME=$(mktemp -d)
   AGENTBOT_HOME="$TMPHOME" AGENTBOT_PORT=8901 \
   AGENTBOT_BIN_ZCODE="D:/Program software/ZCode/resources/glm/zcode.cjs" \
   node dist/server.js
   ```
   造 Bot（worktree 模式需真实 git 仓库：`mkdir` + `git init` + `git commit --allow-empty`）+ 会话，然后 Playwright 实测。
3. 必须给的证据：
   - **问题 1**：点摘要行前后 `collapsed` 计数与 body 高度变化
   - **问题 2**：点消息头像前后 `collapsed` 变化；且**气泡内文字仍可选中**（`window.getSelection()` 非空）
   - **问题 3**：发送后 t=400ms / 2s / 5s / 10s 的 `{turns, streamingTurns, sendLabel, turnHeadText}` 时间序列，证明「立刻有生成中 + 秒数在涨 + 发送键变停止」；再给收口后的终态；以及一条失败路径（如把 runtime 改成不可用后发送）的实测
   - 暗色下 pending Turn 与摘要行可读（无白底、对比度 ≥4.5:1）
   - 1440/1280/1024/768/375 五宽度无横向滚动
4. **中文请求体用 node fetch 发，不要用 Git Bash 的 curl -d**

## 返回结果
1. 改动文件清单（路径 + 行数 + 一句话职责）
2. 验证命令真实输出
3. 三项逐条「实测前 → 改法 → 实测后」
4. **需要 base.css 配合的 class/样式清单**（交给另一实例）
5. 待确认事项
