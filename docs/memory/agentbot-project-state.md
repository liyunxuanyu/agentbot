---
name: agentbot-project-state
description: agentbot（本地多 Bot 工作台）全流程走完并交付可用——10 页 Vue 3 前端 + Node/Fastify/SQLite 后端 + 五运行时适配；含 CLI 通道强制 worktree 安全裁定与几处实测契约坑
metadata:
  node_type: memory
  type: project
  originSessionId: session_b526ef72bb09d3babef30cecf1380d7c
---

`D:\workspace\Agent WorkSpace\agentbot` —— 用 product-forge 全流程（brief→prd→ux→ui→prototype→architecture→build→review）做完的**本地 Web 多 Bot 工作台**，2026-10-25 交付可试用。`.forge/state.json` 已 `phase: done`，八个 gate 全 approved。

**产品定位**：类 DS Bot / Grok Bot 的群聊式 Bot 工具，但底层驱动真实 agent 运行时（ZCode / Codex / Claude Code / Gemini / DSH）。Bot 有名字、人格、身份色、记忆、权限边界；运行时只是它当前绑定的"机器"。

**技术栈（架构 §1，用户明确要求 Vue）**：Node 22 + TypeScript ESM + Fastify 5 + better-sqlite3(WAL) + SSE；前端 Vue 3 + Pinia + Vue Router（history 模式）+ @tanstack/vue-virtual。核/adapters 物理分离，`check-boundaries.mjs` 强制：core 不得出现协议字符串、adapters 不得 import 数据库。

**启动方式**：`npm run build && npm run start:local`（`scripts/start-local.mjs` 自动把本机 ZCode 的 `zcode.cjs` 路径填进 `AGENTBOT_BIN_ZCODE`，否则 ZCode 显示"未安装"）。控制台打印带 token 的 URL。状态全在 `~/.agentbot`（db/token/wt/）。

**用户裁定的一条安全底线（重要）**：CLI 通道的运行时（ZCode/DSH，`permission.channel: none`）**强制在 git worktree 里跑**。原因是它们不发权限请求，产品层无法拦截——M10 实测时 ZCode 真的改了仓库 `package.json` 并新建了文件。实现：`core/permissions/worktree-guard.ts` + `core/process/session-cwd.ts`；worktree 未就绪返回 409 `worktree_not_ready`，**绝不静默降级 local**；用户可改回 local 但需 `confirmRisk: true` 二次确认。

**几处踩过的坑（改代码前先看这里）**：
- **虚拟列表不能用 `transform: translateY()` 定位行**——transform 给后代创建包含块，会把 `.turn-head` 的 `position: sticky` 关死在行内，表现为滚动到底时 Turn 头跑到正文下方。改用 `top` 定位。
- **CLI 通道的人格/记忆注入**：`newSession(h, opts.systemPrompt)` 的 systemPrompt 必须存下来并**前置拼进 prompt 文本**（ZCode 没有 system 参数）。丢掉它会让人格记忆完全失效。
- **CLI 每轮进程 exit 0 是正常的**，不能一律判 crashed。判据：`code === 0 && 无进行中 Turn` → `idle`；否则才是 crashed。判错会导致每轮新建 Session 且跳过上下文重建。
- **"有没有历史"要看 `messages` 表，不是 `runtime_session_id`**——CLI 的占位 id 一直在但上下文早没了；判错则第二轮模型不知道刚才说过什么。
- **`messages` 排序不能只靠 `created_at`**——user/assistant 常同毫秒插入，用 `ORDER BY created_at DESC, rowid DESC`（rowid 是 SQLite 隐式单调列，零 schema 变更）。
- **发送后必须立刻建 pending Turn**。只乐观插入用户消息的话，CLI 一轮 15–30s 期间界面完全静止，用户以为没发出去。pending 要带秒表 + 非流式等待文案 + 发送键变停止，首条事件用同一 turnId 合并。
- **最新一轮不要自动折叠**（`isCollapsed` 对 done 一律收起的规则要放过最新一条），否则用户等完 15s 答案立刻缩成一行摘要。

**本机运行时实测**：ZCode 0.17.0 ready（`D:/Program software/ZCode/resources/glm/zcode.cjs`，一轮 15–22s 非流式）；DSH 0.1.1 ready 但缺 `DEEPSEEK_API_KEY` 时 `exit 1`；Codex 0.163.0 协议可握手但本机未登录；Claude Code 的 `claude-code-acp` 桥未装；Gemini 未安装。

**已知遗留**：`permission_requests` 缺 `runtime_request_id` 列（用 `#n` 后缀绕）；`assignments` 缺 `source_message_id`（多任务回贴会落到同一 Session 末尾）；Codex 6 类事件只有 fixture 回放；群聊主持人决策 20s（PRD 已从 5s 改口径）、Assignment 并发 1（与架构原文 2 冲突已按 PRD 改）。

**Why**：这是当前主力在做的新产品，跨会话还会继续迭代；上面的坑全部是真机实测踩出来的，重复踩一遍要花几个小时。
**How to apply**：改这块代码前先看"几处踩过的坑"；跑验证用 `npm run build && npm run start:local`，真实对话用 ZCode（注意每轮 15–30s）。原型与视觉权威是 `.forge/agentbot-prototype-v2/index.html`（4691 行，UI 改动照它做）。验收报告在 `.forge/agentbot-07-review.md`。相关流程见 [[product-forge-plugin]]。
