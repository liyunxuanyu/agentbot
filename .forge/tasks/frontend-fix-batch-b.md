# 前端修复批次 B（8 项）

你是 product-forge 的 builder。项目根 `D:/workspace/Agent WorkSpace/agentbot`。**只改 `src/web/**`**，后端已定稿不要碰。

## 背景
critic 验收不通过。后端已修完并新增端点。你负责前端修复，本批只做下面 8 项（另一实例在做 ChatPage 相关的 8 项，**不要碰 ChatPage.vue 和 turnModel.ts**）。

## 必读
- `.forge/agentbot-01-prd.md` P0-01/02/03/10/13 验收与边界
- `.forge/agentbot-prototype-v2/index.html`（视觉权威，4691 行，已验收）
- `src/web/pages/{SettingsPage,BotDetailPage,SetupPage}.vue`、`src/web/net/client.ts`、`src/web/net/types.ts`
- 后端新端点（先读对应 routes 文件确认形状）：
  - `POST /api/runtimes` —— 手动添加自定义运行时；同一可执行文件重复 → 409 `{error:"already_exists", existingId:"..."}`
  - `POST /api/runtimes/:id/probe` —— 单运行时重探
  - `DELETE /api/bots/:id` body `{confirmName, mode:"cascade"|"archive"}` —— 名字不符 → 400 `{error:"name_mismatch"}`；cascade 删数据但保留 usage；archive 只置 status
  - `PATCH /api/bots/:id` —— 现在支持 `persona`（≤4000 字符）
  - `GET /api/runtimes` 的运行时 DTO 已含 `probeDetail`（如「需要 ≥ 0.20.0，当前 0.1.0」）与 `requiresWorktree`

## 本批 8 项

### 1. 运行时 unavailable 时发送未禁用（P0-02）
critic 实测：运行时 unhealthy 时 textarea 可输入、发送可点，点后才 toast「发送失败：409 runtime_unavailable」。PRD：「未安装或健康检查失败的运行时…发送按钮禁用并提示」。

修法：Bot 绑定的运行时 `availability !== "ready"` → Composer 禁用 + 明确提示「运行时不可用：<probeDetail 原文>」+「改绑」入口。注意 ChatPage 归另一实例，你只在 **Bot 详情页**与 store 层把状态暴露好；若 ChatPage 需要读该状态，把 selector/store API 准备好但别改 ChatPage 本体。

### 2. 最低版本原因未展示（P0-02）
critic 实测：运行时版本过低时 UI 只写「健康检查失败」，后端 `probeDetail` 明明有「需要 ≥ 0.20.0，当前 0.1.0」。PRD：「置灰 + 原因『需要 ≥ x.y』」。

修法：设置页与 Bot 详情的改绑下拉，不可用项的原因文本优先用 `probeDetail`。

### 3. 「重新探测」是假按钮 + 缺单行重试（P0-01）
critic 实测：设置页「重新探测」点击只 toast「重启服务即可重新探测」；PRD 要求「探测超时：该项显示『检测超时』+ 重试按钮」。

修法：每个运行时行加「重试」按钮 → `POST /api/runtimes/:id/probe` → 原地更新该行；全局「重新探测」循环调每个运行时的 probe，行级 loading 态。

### 4. 手动添加自定义运行时（P0-01）
critic 实测：`POST /api/runtimes` 之前 404，设置页无入口。PRD：「支持手动添加自定义启动命令」「重复添加同一可执行文件：提示『已存在』并跳转到该条目」。

修法：设置页「手动添加」按钮 → 弹层（名称 / 协议下拉 5 种：acp、codex-app-server、opencode-http、claude-sdk、cli-stdio / 启动命令 / 参数）→ `POST /api/runtimes`；409 `already_exists` 时 toast「已存在」并滚动高亮 `existingId` 那一行。弹层样式照原型 modal（r20、p24、max 560、overlay 阴影）。

### 5. 删除 Bot 全流程（P0-03，阻断）
critic 实测：`DELETE /api/bots/:id` 之前 404，UI 按钮 disabled 且自述「后端尚未提供删除端点」。PRD：「删除需输入 Bot 名称二次确认」「删除时需显式选择『一并删除会话/记忆/定时任务』或『归档保留』」。

修法：Bot 详情「危险区」：
- 「删除这个 Bot」→ 弹层：输入 Bot 名称（名字不符 → 内联报错「名称不一致」）+ 单选「一并删除会话、记忆与定时任务」/「归档保留（不再显示但数据保留）」
- cascade 成功 → 跳回 /bots；archive → 列表消失
- 弹层里说明「worktree 不会被自动删除」（P0-13）

### 6. 人格编辑（P0-03）
critic 实测：`PATCH /api/bots/:id {persona}` 之前后端不生效，UI 写「本轮详情页只读展示」。后端已支持。

修法：Bot 详情「人格」卡片加「编辑」→ textarea + 保存/取消 → `PATCH {persona}` → 成功后显示「已生效，下一条消息使用新人格」。≤4000 字符校验。

### 7. worktree 未就绪无重试入口（P0-13）
critic 实测：发送被 409 `worktree_not_ready` 阻止，但提示是原始错误码「发送失败：409 worktree_not_ready」，且 Bot 详情只写「发送会被阻止」。PRD：「Bot 可保存但标『worktree 未就绪』，发送时阻止并给重试」。

注意：**ChatPage.vue 归另一实例**，你只做 Bot 详情侧：执行位置区显示 `worktreeState`（ready/failed/missing），failed 时显示原因 + 「重新创建 worktree」按钮（调 PATCH 保存同值触发后端重建，或读后端 docs 确认触发方式——若需要新端点写进「待确认」，不要自己加后端）。`src/web/net/client.ts` 的 `ApiError` 增加 `.bodyMessage`（取响应 body 的 message 字段），供 ChatPage 后续使用。

### 8. 记忆列表缺「来源会话」（P0-10）
critic 实测：记忆条目只有「来源 手写/自动摘要」+ 时间 + 注入开关，PRD 要求「记忆页列出条目（内容、**来源会话**、更新时间、是否注入）」。

修法：记忆条目显示 `sourceSessionId`（有则显示短 id，点击跳转该会话只读视图；无则「—」）。后端 DTO 已有该字段（`GET /api/bots/:id/memory` 的 entry 里有 `sourceSessionId`）。

## 不要做
- 不改 `src/server/**`、`.forge/**`、tokens.css 令牌值
- **不要碰 `ChatPage.vue`、`turnModel.ts`、`StreamRowItem.vue`、`TurnItem.vue`**（另一实例在改）
- 不改 SetupPage 的三步向导结构
- 颜色只用 `var(--...)`，不写裸 hex

## 验证标准（必须自己跑过，贴真实输出）
1. `npx vue-tsc --noEmit` 通过；`npm run build:web` 成功；`npx vitest run` 后端测试不回归
2. 起真实服务：
   ```bash
   npm run build:server
   TMPHOME=$(mktemp -d)
   AGENTBOT_HOME="$TMPHOME" AGENTBOT_PORT=8880 \
   AGENTBOT_BIN_ZCODE="D:/Program software/ZCode/resources/glm/zcode.cjs" \
   node dist/server.js
   ```
3. Playwright（不要 npm install）：
   ```js
   import { chromium } from 'file:///D:/workspace/Agent%20WorkSpace/AI-Novel-Writing-Assistant/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
   const EXE='C:/Users/liyunxuanyu/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
   const b = await chromium.launch({ executablePath: EXE });
   ```
4. 实测项：
   - 设置页「重试」单行重探 + 全局「重新探测」循环
   - 「手动添加」弹层 → 添加一个假运行时 → 重复添加 → 409 处理（toast + 高亮）
   - 删除 Bot：名字错 → 内联报错；archive → 列表消失；cascade → 数据真删（查 DB 确认 usage 保留）
   - 人格编辑保存后 GET 读到新值
   - Bot 详情执行位置区 worktreeState 展示
   - 记忆条目显示来源会话
   - 暗色下新 UI 无白底、对比度 ≥4.5:1
   - 1440/1280/1024/768/375 五宽度无横向滚动（10 页回归）
5. 中文请求体用 node fetch 发，不要用 Git Bash 的 curl -d（编码会坏）

## 返回结果
1. 改动文件清单（路径 + 行数 + 一句话职责）
2. 验证命令真实输出
3. 8 项逐条「现象 → 改法 → 实测证据」
4. 暗色与响应式回归结果
5. 待确认事项
