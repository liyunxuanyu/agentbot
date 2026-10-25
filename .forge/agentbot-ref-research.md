# 共享调研笔记：多 Bot 外壳 × 多 Agent 运行时

> 本文件是后续所有阶段的**事实底座**。只放已核实的公开事实与由此得出的设计约束，不放方案结论。
> 调研日期：2026-10-23。所有来源均为公开网页/官方文档，**未参考本机任何已有项目代码**。

---

## 一、对标产品：它们到底在做什么

### 1. Grok Bot（xAI，2026-08 起 Early Beta）

来源：https://x.ai/bot 、https://www.datacamp.com/zh/blog/grok-bot 、https://meet.bnext.com.tw/articles/view/53532

- 定位：「一队永远在线的 AI 同事」。**不是聊天窗口，是持久存在的具名 Bot**。
- 每个 Bot 跑在**独立云端 Linux 虚拟机**里，有自己的电脑，能登录用户的网站/应用、操作浏览器、跑文件。
- Bot 有名字、职责描述、长期记忆，通过 **Routine（定时/常驻任务）** 在用户离线时继续工作。
- 交互模型：像跟同事沟通——私聊、委派、追问；用户可以实时看着它做、随时暂停。
- 关键取舍：**重**（云端 VM、账号代登录），强项是"不用你盯着也能干完"。

### 2. DS Bot（Fei2411/DeepSeek-Bot，Apache-2.0）

来源：https://github.com/Fei2411/DeepSeek-Bot 、多家媒体报道（新浪/腾讯/搜狐 2026-10-11）

- 形态：**DeepSeek Harness（DSH）的一个插件**，npm 包名 `ds-bot`。装上后 DSH 本身变成一个 Bot 聊天应用。
- 核心机制：首次启动自动配置一个高权限主 Bot「**Chief**」，由它通过**对话**帮你创建其他 Bot、配置群聊、管理团队。
- 群聊里设**管理员 Bot 默认回复**，由它决定是否调用其他 Bot —— 主要目的是**控制 token 消耗**（避免每句话所有 Bot 都回）。
- 其他：定时任务、Usage 用量页（按时间/Bot/模型）、GitHub connector。Web 端可用。

### 3. DeepSeekBot（BotHarness/DeepSeekBot，MIT，即 DSB）

来源：https://github.com/BotHarness/DeepSeekBot

- 形态：同样跑在 DSH 上的插件，侧栏出现「Bot 模式」。
- 与 DS Bot 的差异重心：
  - **记忆 = 每个 Bot 一个 Git 工作树**，能看 commit / diff / 分支，可推 GitHub 多机同步（"看得见的记忆"）。
  - **群聊 @ 谁谁回**，Bot 之间能读到彼此发言再接话；**Assignments** 把独立任务委派出去并保留报告。
  - **Bot 能以自己身份走出 DSH**：接入飞书/Lark、Slack、Discord、QQ、微信。
  - 定时任务（一句话让 Bot 自建）、Bot 市场（分享/安装）、像素头像、Bot 导入导出 zip。
  - 有 Orchestrator 角色负责整理收件箱和任务；审批可交给审核模型。
- 明确的架构启示：**Bot 的人格 + 核心记忆每轮都注入**；长对话用 `/compact` 与空闲压缩控制上下文。

### 三者的共同骨架（这是要复用的产品语言，不是代码）

| 维度 | 共同做法 |
|---|---|
| 主体 | Bot 是**持久实体**，有名字/人格/职责/头像，换会话还是同一个它 |
| 记忆 | 跨会话持久，可查看、可纠正 |
| 会话 | 私聊 + 群聊（多 Bot 同处一室） |
| 派活 | 从对话里委派子任务，完成后交回报告 |
| 时间 | 定时任务 / 常驻 Routine |
| 归属 | Bot 能"走出去"到 IM，或以自己的身份出现在别处 |
| 治理 | 有一个高权限管家角色负责建队与统筹；token 用量可见 |

### 三者的共同局限（这正是本产品的机会）

1. **都绑死在一个宿主上**：DS Bot / DSB 是 DSH 插件，离开 DSH 不存在；Grok Bot 绑死 xAI 云。
2. **Bot 的"能力"由宿主决定**：宿主有什么工具/MCP/Skills，Bot 就只有什么，用户无法按 Bot 分配不同的执行后端。
3. **无法混用**：不能让"研究员 Bot 用 Codex、工程师 Bot 用 Claude Code、审稿 Bot 用本地模型"。
4. **执行环境与用户本机割裂**（Grok Bot 在云 VM）或**完全绑定本机**（DSH 插件），没有中间态。

---

## 二、可用的统一接入层：ACP 是事实标准

来源：https://agentclientprotocol.com/protocol/v2/overview 、https://zed.dev/acp 、https://www.morphllm.com/agent-client-protocol

**Agent Client Protocol (ACP)**：JSON-RPC 2.0，用于「客户端（编辑器/任意 UI）」↔「编码 agent」通信。由 Zed 发起，JetBrains 已跟进互操作。

### 协议骨架（v2）

```
初始化：  initialize  → 协商版本与 capabilities
          auth/login  （仅当 agent 声明了 authMethods）
会话：    session/new | session/resume | session/list | session/close
对话：    session/prompt        （客户端 → agent，发用户消息）
          session/prompt 响应   （agent 接受后立即返回）
          session/update        （agent → 客户端，流式通知，单向）
          session/cancel        （客户端 → agent，单向）
          session/request_permission （agent → 客户端，请求授权）
```

`session/update` 覆盖的事件类型很全：消息增量、tool call 及其内容增量、终端输出、**plan（agent 的计划）**、可用 slash commands、config option 变更、**context compaction**、面向用户的 notice。

### 关键约束

- 所有文件路径**必须是绝对路径**，行号 1-based。
- 属性名 camelCase；discriminator 值用 snake_case；`_` 前缀保留给实现私有扩展（`_meta` 字段、`_` 开头的方法名）。
- Agent 通常是客户端的**子进程**，走 stdio；也支持远程传输。

### 生态现状（决定 adapter 策略）

| 接入方式 | Agent |
|---|---|
| **原生 ACP** | Gemini CLI、GitHub Copilot CLI、Goose、Cline、OpenHands、Mistral Vibe、Auggie、Blackbox AI、Qwen Code |
| **经 adapter 支持** | Claude Code（`claude-code-acp`）、Codex CLI（`codex-acp`） |
| **自有协议** | Codex app-server（JSON-RPC over stdio）、OpenCode（HTTP + SSE）、ZCode（headless stdio）、DSH（Cordis 插件 + `dsh web`） |

已有第三方验证这条路可行：`@openacp/cli`（自称桥接 28+ agent 到 Telegram/Discord/Slack）、`acp-bridge`（并行派发到 Codex/Claude/Gemini）、VSCode 的 ACP Client 扩展（预置 11 个 agent）。

**结论：ACP 应当作为本产品的「一等公民协议」，而不是唯一协议。**

---

## 三、各运行时的接入细节（首版候选）

### Claude Code（Anthropic）
- 无头模式：`claude -p`，配 `--input-format stream-json --output-format stream-json` 可做双向流式（已有第三方 `clide` 这样实现）。
- 官方 **Claude Agent SDK**（TypeScript / Python）：复用同一套 agent loop、工具与上下文管理，适合脚本与 CI。
- 有 ACP adapter：`claude-code-acp`。
- 注意：headless/SDK 的单位 token 配额消耗高于交互模式（社区实测约 3×），设计用量页时要区分。

### Codex CLI（OpenAI）
- `codex exec`：非交互一次性执行，确定性退出码，适合脚本/流水线。
- **Codex App Server**：Codex CLI 自带的 JSON-RPC 2.0 over stdio（JSONL）双向服务，暴露流式进度、工具调用、**审批（approvals）**、diff。这是 Codex 各前端共用的底座。
- 有 ACP adapter：`codex-acp`。

### OpenCode
- `opencode serve`：无头 HTTP 服务器，暴露 OpenAPI（`/doc`）+ 事件流（SSE）。会话、prompt、文件、事件都是一等 API。
- 天然适合远程/多客户端。

### DeepSeek Harness (DSH)
- `dsh` CLI；「everything is a plugin」，底层是 **Cordis** 插件内核：模型适配器、工具、会话服务、执行后端、权限、**连 Web UI 本身**都是插件。
- `dsh web` 起 Web 端；桌面端有插件市场式安装（如 `deepseekbot@1.4.1`）。
- 对第三方而言：既可以**当运行时被驱动**（CLI/headless），也可以**当宿主被挂载**（写 Cordis 插件）。DS Bot / DSB 走的是后者。

### ZCode（Z.AI）
- TypeScript monorepo：desktop / web / server / UI / CLI。
- 暴露 **headless stdio 协议**，可被守护进程驱动；社区已有 headless 用法整理。
- 无公开 ACP adapter（截至调研时）。

---

## 四、由此得出的设计约束（供 brief / prd / architecture 使用）

### C1. 协议分层，而不是适配 N 个工具
不要为每个工具写一套逻辑。分三层：
1. **ACP 通道**：任何原生或 adapter 支持的 agent 直接接，零成本扩展。
2. **原生协议通道**：Codex app-server、OpenCode HTTP/SSE、Claude Agent SDK 这类有正式 API 的，做薄适配器。
3. **通用 CLI/PTY 通道**：只有交互式 CLI 的（ZCode、DSH 首版），用子进程 + 行流解析兜底。

新增一个 agent = 写一个 adapter 声明（启动命令、协议、能力位、事件映射），**不改核心**。

### C2. Bot ≠ Agent 进程
Bot 是产品层的持久实体（人格、记忆、权限、日程）；Agent 运行时是可替换的**执行后端**。同一个 Bot 可以换后端；同一后端可以承载多个 Bot（不同 session）。
这是与 DS Bot / DSB 最本质的区别——它们把 Bot 焊在宿主上。

### C3. 能力发现而非能力硬编码
每个 adapter 启动时通过 `initialize` / 能力探测上报：支持哪些工具、是否支持 plan、是否支持权限请求、是否支持 session resume、上下文窗口、是否支持图片输入等。UI 据此**动态**渲染，而不是假设所有 agent 一样。

### C4. 权限必须在产品层可见
agent 自身有权限模型（ACP 的 `session/request_permission`、Codex 的 approvals、[CC] 的 permission prompt）。本产品**不重新发明权限**，而是：
- 把运行时抛上来的授权请求**转成产品内可审的卡片**（批准/拒绝/记住）
- 额外加一层**Bot 级边界**（这个 Bot 只能碰哪些目录、能不能跑 shell、能不能联网）
- 全程留审计日志

### C5. 流式事件必须归一
各运行时的事件形态不同（ACP 的 session/update、Codex 的 JSONL、OpenCode 的 SSE、CLI 的 stdout 行）。需要一个**统一事件模型**（message delta / thought / tool_call / tool_result / plan / permission_request / usage / done / error），UI 只认这一套。

### C6. 长会话成本是真问题
多 agent 上下文爆炸（业界数据：多 agent 系统 token 消耗约为普通对话 15×）。必须内建：上下文压缩（ACP 已有 `context compaction` 事件）、按 Bot 的用量统计、群聊默认不全员回复。

### C7. 本机执行 vs 隔离执行是显式选择
Grok Bot 选云端 VM（隔离、但重）；DSH 插件选本机（轻、但污染）。本产品应把**执行位置**作为 adapter 的属性暴露给用户：`local` / `worktree` / `container` / `remote`，首版至少支持 local 与 git worktree。

---

## 五、明确不做什么（避免滑向已有产品）

- 不做自己的 agent loop、不接管模型调用、不做 prompt 编排框架 —— 那是运行时的事。
- 不做云 VM 托管（首版）。
- 不做通用 IM 平台（首版），只留 webhook 出站口。
- 不做 Bot 市场（首版）。
- 不做多租户账号体系（首版）。

---

## 六、待验证的开放问题

1. ZCode 的 headless stdio 协议是否有稳定 schema？还是只能按行猜？→ 影响 CLI 通道的可靠性。
2. DSH 首版走 CLI 驱动还是写 Cordis 插件？前者通用但拿不到结构化事件，后者深度但锁宿主。
3. ACP 的 `session/resume` 在各 adapter 上的一致性如何？不一致时"持久会话"要靠本产品自己 replay。
4. Windows 上 PTY 支持（ConPTY）与各 CLI 的兼容性。
5. 群聊多 Bot 并发时，同一工作区文件冲突如何处理（worktree 隔离 vs 串行化）。
