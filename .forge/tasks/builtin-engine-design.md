# 内置引擎设计任务书（给 architect）

项目根 `D:/workspace/Agent WorkSpace/agentbot`。产物写到 `.forge/agentbot-06-builtin-engine.md`。

## 背景与用户裁定

用户提出：不要再把 Bot 绑死在外部 agent CLI（ZCode/Codex/Claude Code）上，产品自己实现一个 agent 内核。经评估后用户明确选择：

1. **并存**：新增「内置引擎」作为又一种 runtime，外部运行时全部保留
2. **内置引擎要自带能力**：常用工具 + MCP + 技能（skills），脱离其它 agent 也能用
3. **provider 支持所有协议**：OpenAI chat-completions 与 Anthropic messages 都要支持
4. 用他本机已配的 `pix-deepseek` 供应商做联调

## 我已经实测的事实（直接采信，不用重复验证）

### 动机（为什么值得做）

| 指标 | ZCode CLI（现状） | pix-deepseek 直连（实测） |
|---|---|---|
| 一轮耗时 | 13–16s（整段返回，无流式） | 非流式 4.2s；流式首 token 4.4s / 总 5.5s |
| prompt token | 68,104（ZCode 自己的系统提示） | 324 |
| 权限拦截 | **无**（`permission.channel: none`） | 我们自己控制每个工具调用 |
| 执行位置 | 被迫强制 worktree | 有真实门禁，local 可安全使用 |

### provider 能力（已实测 pix-deepseek）

- 协议：`openai-chat-completions`，baseUrl `https://api.ai-pixel.online/v1`
- 模型：`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`
- **tool calling 支持**：返回标准 `tool_calls`（`finish_reason: "tool_calls"`，arguments 是 JSON 字符串）
- **流式支持**：SSE，`data: {...}` 逐块，首 token 4.4s，142 chunks
- usage 字段：`prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens` 等

**已知坑（来自历史记录，必须设计容错）**：pix 网关会掐掉过长的流式请求。流中断时不能把半截当完成——要能降级（重试非流式，或标记「已中断，可重发」）。

### 现有架构的可用口子

- `ChannelDriver` 契约（`src/server/adapters/contract.ts`）：`start / initialize / newSession / resumeSession / prompt / cancel / respondPermission / onEvent / onPermission / onExit / dispose`
- `SessionHandle.pid` 类型是 `number | null`，`supervisor.ts` 里是 `if (pid !== null)` 才注册进程 → **无进程的驱动直接可接**
- `core/permissions/resolver.ts` 已有完整裁决链：边界判定 → grants 命中 → pending → 用户决策 → `respondPermission` 回传。内置引擎只要在**每个工具执行前**调它，就能得到真正的权限卡片
- `core/events/ingest.ts` 已实现 9 类事件 + meta + 掩码过滤 + 字段校验降级，内置引擎只需产出 `CanonicalEvent`
- `core/memory/assembler.ts` 已实现 6000 字符预算的人格+记忆装配
- `core/orchestrator/context.ts` 已实现会话重建（人格+记忆+最近 20 条 + 窗口裁剪）
- `core/usage/recorder.ts` 已实现用量落库（只信上报）
- 分离铁律（`scripts/check-boundaries.mjs`）：`core/` 禁止协议字符串（`session/update`、`--output-format`、`jsonrpc`、`codex-app-server`、`acp`）；`adapters/` 禁止 import `core/db` 或 `better-sqlite3`

## 你要产出的设计（必须可实施，不是综述）

### 1. 模块边界与依赖方向

明确每个新文件的路径、职责、依赖。至少覆盖：

- **provider 层**：放 `adapters/`（它讲的是线上协议）还是 `core/`？给出判断与理由。必须能同时支持 openai-chat-completions 与 anthropic-messages，且新增第三家不改核心
- **agent loop**：放 `core/agent/`。它只依赖一个 `ProviderClient` 接口（由 provider 层实现），不出现任何 HTTP/协议细节
- **工具注册表**：`core/agent/tools/`。工具 = JSON Schema + execute(ctx,args)。内置工具与 MCP 工具走同一个注册表
- **builtin 通道驱动**：`adapters/channels/builtin/driver.ts`，实现 `ChannelDriver`
- **MCP 客户端**：stdio 连接、`initialize` / `tools/list` / `tools/call`。放 `adapters/`（讲协议）
- **技能加载**：`core/agent/skills/`（读文件、解析 frontmatter、生成索引）

**关键**：`core/` 不能出现 provider 的协议字符串。provider 接口定义在 core，实现在 adapters，靠依赖注入。

### 2. 关键类型定义（写出来，builder 照抄）

- `ProviderConfig`：id / 协议（openai-chat | anthropic-messages）/ baseUrl / apiKey / model / contextWindow / supportsTools / supportsStreaming / 额外 headers
- `ChatMessage`：role(system|user|assistant|tool) + content + toolCalls + toolCallId
- `ProviderClient`：`stream(req): AsyncIterable<ProviderDelta>`，`complete(req): Promise<ProviderResult>`
- `ProviderDelta`：text / reasoning / toolCallDelta / usage / finish
- `ToolDefinition`：name / description / parameters(JSON Schema) / source('builtin'|'mcp') / requiresPermission('write'|'exec'|'network'|'read'|null)
- `ToolResult`：ok / output / error / truncated / durationMs
- `AgentLoopOptions`：maxIterations / maxToolCalls / signal / onEvent / onPermission / onToolStart / onToolEnd

### 3. 工具集清单（每个给 JSON Schema 要点与安全约束）

必备：`read_file`、`write_file`、`edit_file`（字符串替换，要求 oldText 唯一）、`list_dir`、`grep`（优先用 ripgrep，没有则降级遍历）、`run_shell`、`web_fetch`。

每个工具必须写清：
- 参数 schema
- 路径解析规则（相对 cwd 解析、禁止逃出 cwd、符号链接处理）
- 权限类别（read / write / exec / network）
- 输出上限（截断策略，比如 64KB / 2000 行）
- 失败语义（返回给模型的可读错误，不是抛异常中断）

### 4. 权限门禁的接线点（这是本次的核心价值）

写清时序：

```
模型返回 tool_calls
  → 对每个 call：tool.requiresPermission
      → null（只读）        : 直接执行
      → write/exec/network  : resolver.handle({botId, action, target, source})
          → allowed  : 执行
          → denied   : 不执行，把「超出边界/已拒绝」作为 tool_result 回给模型
          → pending  : 发 permission_request 事件 → 等用户决策（复用现有三档超时）
                        → 用户批准：执行；拒绝：回 denied 给模型
```

必须回答：模型在等待权限时，这一轮怎么表示「挂起」？超时（reject/hold）怎么落？用户拒绝后模型应该收到什么文本（让它能换个做法而不是死循环）？

### 5. MCP 与技能的接入方式

- MCP：配置存哪（建议 `~/.agentbot/mcp.json`）、怎么启动/健康检查/重启、工具名如何命名空间化（建议 `mcp__<server>__<tool>`）、MCP 工具默认权限类别（建议 `exec`，即默认要问）
- 技能：目录约定（建议 `~/.agentbot/skills/<name>/SKILL.md`）、frontmatter 字段（name/description）、索引怎么进系统提示（只放 name + 一行描述，控制 token）、完整内容怎么按需读取（给模型一个 `read_skill` 工具）

### 6. 上下文与成本

- 系统提示的组成与预算（人格 + 记忆 + 技能索引 + 工具说明，给一个总预算，建议 ≤4k token）
- 历史消息如何裁剪（沿用现有「窗口 70%」策略还是另定）
- 工具结果如何截断（这是最容易爆上下文的地方）
- 用量上报：一次 Turn 可能有多轮 provider 调用，`usage` 事件怎么合并（累加还是每次一条）

### 7. 失败与边界

逐条给行为：
- 流中断（pix 掐流）→ 怎么办
- provider 返回 429/5xx → 重试策略（次数、退避）
- 模型返回坏 JSON 的 tool arguments → 怎么降级
- 工具执行抛异常 → 怎么回给模型
- 达到 maxIterations → 怎么收口（标失败还是「已达上限」）
- 用户点停止 → AbortController + 已生成内容保留
- 同一 Session 并发发送 → 沿用现有 session-lock
- 上下文溢出（provider 报 context_length_exceeded）→ 自动裁剪重试还是报错

### 8. 模块拆分与实施顺序

按可并行、依赖清晰拆成 N1–N6，每个模块给：负责文件、对外接口、验收命令。明确指出哪些可并行、哪些必须串行。

### 9. 与现有文档的冲突

PRD 的 P0-01/P0-02 把「运行时」定义为外部 agent CLI。内置引擎引入后这两条语义要扩展。给出建议的 PRD 修订文字（只写要改的句子，不要重写整份 PRD）。

## 硬约束

- 不改 `src/server/core/db/schema.sql`（如需新表/列，写进「待确认」并给出迁移 SQL 建议）
- 不破坏现有 adapter（`acp` / `cli` / `native` 三条通道保持原样）
- 遵守分离铁律
- provider 的 apiKey 必须落在 `~/.agentbot/` 下、权限收紧（现有 `auth.ts` 有 icacls 的做法可参考），**不得写进日志**
- 设计里不要出现真实密钥

## 返回

设计文档本体（`.forge/agentbot-06-builtin-engine.md`），以及返回结果里给出：
1. 文件清单（路径 + 一句话职责 + 预估行数）
2. 模块依赖图（文字版即可）
3. N1–N6 的并行/串行关系
4. 待确认事项（需要用户或我裁定的）
