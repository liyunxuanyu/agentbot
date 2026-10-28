# AgentBot 内置引擎变更日志

> 分支：`continue-dev`（未合并 main） · 日期：2026-10-26
> 基线：`8518494 feat: AgentBot 本地多 Bot 工作台（首个完整版本）`
> **历史文档**：本日志只记录内置引擎（N1–N6）那一轮。之后还有会话控制（2026-10-27）、
> 18 号 7 条缺口 + 19 号四条需求（2026-10-28）、登录页与持久 cookie（2026-10-28）；
> 当前状态以 README 为准。

## 提交序列

| commit | 内容 | 验证 |
|---|---|---|
| `9db2b0d` | N1 模型供应商层：Provider 契约、OpenAI/Anthropic 客户端、providers.json、`/api/providers` CRUD/test | tsc 0 错 |
| `6dc8ddc` | N3/N4/N5：工具注册表、路径安全、截断、8 个内置工具、MCP stdio 客户端/管理器/路由、技能扫描/路由 | tsc 0 错、boundaries 通过 |
| `6344cb5` | N2：builtin 驱动、builtin 运行时声明与注册、迁移 v2、Supervisor 传 providerId、Bot provider 绑定 | 全量 329 通过 / 7 基线失败（无新增） |
| `e0b54fe` | N6：web 类型/客户端、providers/mcp/skills stores、设置页三块、Bot 表单供应商选择 | vue-tsc 0 错、Vite 构建通过 |
| 待提交 | 测试与冒烟：7 个单测文件、`scripts/smoke-builtin.mjs`、README 内置引擎章节、change-spec/impact/review | 365 通过 / 7 基线失败；smoke 通过 |

## 实现要点

### N1 供应商层
- `core/agent/provider.ts` 只定义纯接口（ChatMessage / ToolCall / ProviderDelta / ProviderClient / ProviderError）。
- OpenAI 客户端支持流式 `tool_calls` 增量拼接、`reasoning_content`、usage、`[DONE]`。
- Anthropic 客户端支持 `content_block_delta`、`input_json_delta`、`tool_use`、`tool_result`、`message_delta.usage`。
- 429/5xx 退避 2 次（1s、3s）；4xx 不重试。
- providers.json 原子写 + 0600；接口只回 `sk-****abcd` 掩码。

### N2 内置驱动
- `pid: null`；不启动子进程；`initialize` 返回 healthy；`newSession` 装配人格/记忆 + 运行规则 + 技能索引。
- `prompt` 跑 agent loop；事件经 `onEvent` 交 ingest；权限经 `onPermission` 交 resolver。
- `cancel` abort 进行中的 provider 请求并拒绝挂起权限；`dispose` 丢历史。
- 迁移 v2 增加 `bots.provider_id`；Supervisor 把 botId/providerId 传给驱动。
- main 注册 builtin 运行时（不参与 PATH 探测），无供应商时 unhealthy，配置后 ready。

### N3 工具
- 路径安全：`resolveInside` 词法 + realpath + 最近存在祖先，挡 `..` 与符号链接逃逸。
- 截断：64KB / 2000 行，尾部注明省略量。
- 工具：read_file、write_file、edit_file（oldText 唯一）、list_dir、grep（跳过 .git/node_modules/dist）、run_shell（树杀/超时）、web_fetch（仅 http(s) GET）、read_skill。
- 权限映射：read/null 直执行；write/exec/network 先问。

### N4 MCP
- stdio JSON-RPC：initialize → notifications/initialized → tools/list → tools/call。
- 单 server 失败隔离；状态 connected/connecting/unavailable/disabled。
- 工具名 `mcp__<server>__<tool>`，默认权限 exec。
- `/api/mcp` CRUD + reconnect；配置 `~/.agentbot/mcp.json`。

### N5 技能
- `~/.agentbot/skills/<name>/SKILL.md`；frontmatter name/description；索引 ≤800 字符。
- `read_skill` 按需读全文；`/api/skills` + rescan。

### N6 前端
- 设置页新增「模型供应商 / MCP / 技能」三个分区，含加载/空/错误态、添加/编辑/删除/测试/设默认/重连/重扫。
  （2026-10-28 后设置页共八个分区：另加运行时 / 模型映射表 / 安全与 token / 数据与保留 / 权限审计。）
- Bot 新建表单在内置引擎下显示供应商下拉；Bot 详情显示当前供应商，改绑弹层可选供应商。

## 测试

- 新增 7 个测试文件、36 个测试：
  - `provider-store.test.ts`（5）
  - `provider-protocol.test.ts`（4）
  - `agent-loop.test.ts`（8）
  - `tools.test.ts`（10）
  - `builtin-driver.test.ts`（4）
  - `mcp.test.ts`（3）
  - `builtin-runtime.test.ts`（2）
- 全量：372 测试，365 通过，7 失败（与基线同一批 Windows 环境假设）。
- 端到端：`npm run smoke:builtin` 通过（假网关 → Bot → 消息 → 权限批准 → 工具落盘 → 事件链）。
- 构建：`build:web`、`build:server` 通过；boundaries 通过；tsc/vue-tsc 0 错。

## 本轮决定（记录在案，不阻塞）

1. **迁移 v2 直接执行**：用户要求「遇到需要决策的问题先记录继续推进」；迁移为可空列、不重写旧数据，风险可控。
2. **验收基线**：既有 7 个失败视为 Windows 环境假设，不属本轮回归；验收口径为「不新增失败」。
3. **真实 provider 验证**：未使用真实 API key；用本地假网关验证协议与全链路，避免密钥进日志/仓库。
4. **MCP 启动连接**：启动时并行连接，单 server 最多等 20s；后续可改为后台连接以缩短冷启动。

## 遗留

> **后续进展（2026-10-27 / 2026-10-28）**：两处 Windows 环境假失败已修（`%TEMP%` 祖先仓库、
> 8.3 短名路径比较，见 15 号变更日志 §4）；本机当前全量 **500 passed / 1 skipped / 0 failed**。
> 上下文窗口未配置时已用 `AGENTBOT_CONTEXT_WINDOW`（默认 128k）兜底。**仍未做**：MCP 的
> HTTP/SSE 传输、图片输入、真实模型 live smoke（仍只有假网关冒烟）。

- 既有 7 个 Windows 环境失败未修（路径大小写、taskkill、git 根判定）→ 2026-10-27 已修两处主要成因。
- 内置引擎未做真实模型 live smoke（无用户提供的 key）。
- MCP 仅 stdio；HTTP/SSE 传输未做。
- 图片输入未做。
- 上下文窗口未配置时不做 token 裁剪（与既有策略一致）→ 现在用 128k 默认窗口兜底。
- `/api/meta` 的 runtimes 是启动快照；设置页新增供应商后，BotsPage 已改用 `/api/runtimes` 实时列表，但其它读 meta 的地方仍需刷新页面。
