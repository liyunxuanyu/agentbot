# 前端修复批次 A（8 项）

你是 product-forge 的 builder。项目根 `D:/workspace/Agent WorkSpace/agentbot`。**只改 `src/web/**`**，后端已定稿不要碰。

## 背景
critic 验收不通过。后端已修完并新增端点。你负责前端修复，本批只做下面 8 项（其余另有实例负责，不要越界）。

## 必读
- `.forge/agentbot-01-prd.md` P0-03/04/05/06 验收与边界
- `.forge/agentbot-prototype-v2/index.html`（视觉权威，4691 行，已验收）
- `src/web/pages/ChatPage.vue`、`src/web/lib/turnModel.ts`、`src/web/net/client.ts`、`src/web/net/types.ts`、`src/web/net/stream.ts`
- 后端新端点（先读 `src/server/http/routes/events.ts` 确认请求/响应形状）：`GET /api/sessions/:id/events?afterSeq=0&limit=2000` 返回 `{events:[...], hasMore, lastEventId}`，events 含 meta 类型

## 本批 8 项

### 1. 刷新后事件全丢（P0-04/P0-05，阻断）
critic 实测：DB 有 2205 条事件（thought/plan/tool_call/tool_result/usage），刷新后 UI 0 块、Turn 头显示「完成 · 0/0」。根因：私聊首连游标取渠道最大 lastEventId 从不回放历史，且之前没有事件 REST 端点。

修法：ChatPage 首次进入某会话时，先用 `GET /api/sessions/:id/events?afterSeq=0&limit=5000` 分页拉全量历史事件（拉到 hasMore=false 为止），再建 SSE 连接用 `lastEventId` 续推。历史事件走 turnModel 同一条装配路径。正文仍以 `messages.content` 为权威（历史正文从 messages 拿，事件只补充思考/工具/计划/用量块）。刷新后 Turn 头的 token 用量要恢复。

### 2. 单轮 2000+ 事件虚拟滚动（P0-05，阻断）
critic 实测：2205 事件折叠态 turn-body 仍有 1103 个 DOM 子节点，虚拟化只做到 Turn 粒度。PRD：「单轮事件 >2000 条：虚拟滚动，仅渲染可视区 ±50 条」。

修法：Turn 展开态的事件列表用 `@tanstack/vue-virtual`（依赖已装）。折叠态只渲染摘要行、不虚拟化。先确认 Turn 体是独立滚动容器还是整页滚动，照原型 `.turn-body` 的 max-height 方案处理。验收判据：2000+ 事件时 turn-body 的 DOM 子节点数 ≤ 100。

### 3. 空回复「未返回内容」+ 重发（P0-04，阻断）
critic 实测：DB assistant 消息 `done` 且 content 长度 0，UI「未返回内容」0 处、重发 0 处，气泡整体不渲染。

修法：turnModel 里 assistant content 为空且 status=done 时渲染 muted 降级块「未返回内容」+ 重发按钮（样式照原型 muted 文案语言）。

### 4. 30s 无事件显示「无响应」（P0-05，阻断）
critic 实测：静默 40s 只有「生成中」+停止键。PRD：「连续 30s 无事件且未结束：显示『无响应』并提供停止」。

修法：Turn 处于生成中且 30s 无新事件 → Turn 头显示 warning 色「无响应」chip；事件恢复即消失；Turn 收口时清计时器。

### 5. 重发要新建一轮（P0-04）
critic 实测：重发只把上一条原文填进输入框。PRD：「『重发』以上一条用户消息原文新建一轮，原轮次不覆盖」。

修法：重发 = 直接以上一条用户消息原文调 `POST /api/messages`，原轮次不动。

### 6. @ Bot 选择器（P0-06）
critic 实测：composer「指定 Bot」按钮无 handler，`mentionBotIds` 只存在于类型定义。后端 M10 已实现「@ 必含且优先」，`POST /api/messages` body 已支持 `mentionBotIds`。

修法：群聊 composer 的 @ 按钮弹 Bot 选择浮层（照原型样式：白卡、overlay 阴影、头像 + 名字），选中后 mentionBotIds 随消息提交。

### 7. 空名单「指定 Bot 回复」按钮（P0-06）
critic 实测：主持人返回空名单时 UI 有「本轮无 Bot 发言」但没有「指定 Bot 回复」按钮。PRD：「返回空列表：显示『本轮无 Bot 发言』+『指定 Bot 回复』按钮」。

修法：系统块内加该按钮，点击打开第 6 项的选择器。

### 8. 主持人 JSON 气泡重复显示（P0-06）
critic 实测：主持人决策的原始 JSON（`{"speakers":[...]}`）作为 assistant 气泡显示，与「本轮发言人」系统块重复。

修法：主持人决策 Turn 的 assistant 消息（内容可解析为含 `speakers` 数组的 JSON）不渲染成普通气泡，折叠为「主持人正在决定发言人…」一行（照原型 host Turn 折叠样式）。

## 不要做
- 不改 `src/server/**`、`.forge/**`、tokens.css 令牌值
- 不改 BotsPage/ChatPage 已验收的视觉结构（只加逻辑与降级态）
- 其余 8 项前端问题（运行时禁用发送、删除 Bot、人格编辑、手动添加运行时、重探按钮、worktree 重试入口、记忆来源会话、plan 降级）**不要碰**，另一实例负责

## 验证标准（必须自己跑过，贴真实输出）
1. `npx vue-tsc --noEmit` 通过；`npm run build:web` 成功；`npx vitest run` 后端测试不回归
2. 起真实服务：
   ```bash
   npm run build:server
   TMPHOME=$(mktemp -d)
   AGENTBOT_HOME="$TMPHOME" AGENTBOT_PORT=8870 \
   AGENTBOT_BIN_ZCODE="D:/Program software/ZCode/resources/glm/zcode.cjs" \
   node dist/server.js
   ```
   token 在启动日志 URL 里。
3. Playwright（不要 npm install）：
   ```js
   import { chromium } from 'file:///D:/workspace/Agent%20WorkSpace/AI-Novel-Writing-Assistant/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
   const EXE='C:/Users/liyunxuanyu/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
   const b = await chromium.launch({ executablePath: EXE });
   ```
4. 实测项：
   - 造 Bot（worktree 模式需给真实 git 仓库路径，可 `mkdir` + `git init` + `git commit --allow-empty` 一个）+ 真实 ZCode 对话一轮（每轮 14–22s）→ **刷新页面** → 思考/工具/用量事件块与 Turn 头 token 用量恢复
   - 直接往临时 DB 的 events 表插 2000+ 条 → 展开轮 → turn-body DOM 子节点 ≤ 100
   - 空回复 → 降级块 + 重发可用
   - 群聊 @ 选择器可用、空名单按钮可用、主持人 JSON 折叠
   - 暗色（`document.documentElement.dataset.theme='dark'`）下新 UI 无白底、文字对比度 ≥4.5:1
   - 1440/1280/1024/768/375 五宽度无横向滚动（10 页回归）
5. **中文请求体用 node fetch 发，不要用 Git Bash 的 curl -d**（编码会坏）

## 返回结果
1. 改动文件清单（路径 + 行数 + 一句话职责）
2. 验证命令真实输出
3. 8 项逐条「现象 → 改法 → 实测证据」
4. 暗色与响应式回归结果
5. 待确认事项
