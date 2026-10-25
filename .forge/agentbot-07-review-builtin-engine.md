# AgentBot 内置引擎验收报告

> 范围：`.forge/agentbot-09-change-spec.md` 的 15 条 P0 · 分支 `continue-dev`
> 方式：自动化测试 + 端到端冒烟 + 代码走查（**主流程自检，非独立 critic 实例**；独立 critic 子智能体本轮多次异常中断，未能在时限内完成）
> 结论：**通过**。15 条 P0 全部有实现与证据；新增 36 测试全绿；端到端冒烟通过；无新增回归。

## 1. P0 验收矩阵

| 编号 | 结论 | 证据 |
|---|---|---|
| B-P0-01 供应商配置 | 通过 | `adapters/providers/store.ts`（providers.json 读写/0600/掩码）、`http/routes/providers.ts`、`tests/unit/provider-store.test.ts` |
| B-P0-02 连通性测试 | 通过 | `POST /api/providers/:id/test`（`routes/providers.ts`）、`provider-protocol.test.ts` 验证两种协议请求/响应 |
| B-P0-03 运行时注册 | 通过 | `adapters/builtin-runtime.ts`、`main.ts:97` 注册、`main.ts:134` 按供应商刷新；`builtin-runtime.test.ts` 验证 builtin 行/权限通道/不强制 worktree |
| B-P0-04 Bot 绑定 | 通过 | `routes/bots.ts` 创建/更新校验 `providerId`；`dto.ts` 输出 `providerId`；冒烟脚本创建 Bot 时绑定 `fake` 并校验 |
| B-P0-05 Agent loop | 通过 | `core/agent/loop.ts:80`；`agent-loop.test.ts` 覆盖工具回灌、拒绝、未知工具、非法 JSON、轮数/工具上限、usage |
| B-P0-06 内置工具 | 通过 | `core/agent/tools/builtin/*`（8 个）；`tools.test.ts` 覆盖文件闭环、edit 唯一、list/grep、技能读取 |
| B-P0-07 路径安全 | 通过 | `core/agent/tools/paths.ts:49`；`tools.test.ts` 覆盖 `..`、外部绝对路径、符号链接逃逸；`run_shell` cwd 固定会话 cwd |
| B-P0-08 权限门禁 | 通过 | `adapters/channels/builtin/driver.ts:87` + `askPermission`；`builtin-driver.test.ts` 批准/拒绝两条路径；只读不弹卡由 loop 测试覆盖 |
| B-P0-09 权限复用 | 通过 | 驱动走现有 `onPermission → resolver → respondPermission`；未改 `permissions/*`；冒烟脚本真实创建 pending 卡并批准 |
| B-P0-10 MCP | 通过 | `adapters/mcp/{client,config,manager}.ts`；`mcp.test.ts` 用假 stdio server 验证 initialize/list/call、失败隔离、`mcp__server__tool` 命名与 exec 权限 |
| B-P0-11 技能 | 通过 | `core/agent/skills.ts`；`tools.test.ts` 验证 frontmatter、索引、read_skill、越界名拒绝 |
| B-P0-12 设置页 | 通过 | `SettingsPage.vue:50-52` 三个 tab、`:904` 供应商分区、MCP/技能分区；vue-tsc + Vite 构建通过 |
| B-P0-13 Bot 表单 | 通过 | `BotsPage.vue` 内置引擎时显示供应商下拉；`BotDetailPage.vue` 显示当前供应商、改绑弹层可选供应商；vue-tsc 通过 |
| B-P0-14 失败处理 | 通过 | loop 流中断降级、429/5xx 退避（`providers/http.ts`）、非法 JSON 回灌、上下文溢出裁剪、上限非致命 error + done；相关分支有单测/代码走查 |
| B-P0-15 回归 | 通过 | 全量 372 测试 365 通过 / 7 失败，7 个与基线完全一致；ACP/CLI/native 契约、HTTP、SSE、权限、worktree guard 未改语义；boundaries 通过 |

## 2. 自动化证据

```
tsc --noEmit                      0 错
vue-tsc --noEmit                  0 错
check-boundaries.mjs              通过
vitest run                        365 passed / 7 failed（基线 329/7，新增 36 全绿）
build:web                         通过
build:server                      通过
smoke:builtin                     通过
```

冒烟实际输出：

```
builtin 运行时已注册且 ready
Bot 已创建并授权目录
权限卡出现：write /tmp/agentbot-smoke-*/hello.txt
已批准
助手回复：已写入 hello.txt。
工具落盘校验通过
事件链完整：tool_call / tool_result / usage / done(end)
端到端冒烟通过
```

## 3. 代码走查发现并修复的问题

| 问题 | 处置 |
|---|---|
| `sseFrames` 的 event/data 分帧需要消费方记住 event 名 | Anthropic 客户端显式跟踪 `currentEvent`；单测覆盖 |
| `grep` 使用带 `g` 的正则 `.test()` 会因 `lastIndex` 跳行 | 改为无 `g` 正则；单测覆盖 |
| MCP 连接失败后 `dispose` 把状态改成 disabled，UI 看不到原因 | 连接失败后保留 `unavailable` + error；单测覆盖 |
| MCP reconnect 连接失败被误报 404 | 管理器返回 `not_found/connected/failed`；路由区分 404 与 `{ok:false}` |
| loop 把完整 `usage` delta 传给回调（多带 `kind`） | 改为只传 `{inputTokens,outputTokens,reported}` |
| 设置页新增供应商后 BotsPage 仍用 `/api/meta` 启动快照，内置引擎可能不出现 | BotsPage 的新建表单改用 `/api/runtimes` 实时列表 |
| 冒烟脚本默认边界只读导致写操作被直接拒绝 | 冒烟先给 Bot `allowDirs`，再走权限卡批准路径（也验证了边界行为正确） |

## 4. 未验证项 / 风险

1. **真实模型供应商**：未用真实 API key 做 live smoke；协议层用本地假网关覆盖。风险：特定网关的 SSE 字段差异（如不支持 `stream_options`）只能在实际配置后暴露；已实现降级非流式。
2. **独立 critic**：本轮未完成独立只读验收，以上为主流程自检；建议后续用 critic 复核 UI 视觉与文案。
3. **MCP 冷启动**：启动时并行连接，单 server 最多 20s；若配置了不可达 server，启动会变慢。功能不受影响。
4. **既有 7 个 Windows 环境失败**：未修，非本轮引入。
5. **`/api/meta` 快照**：除 BotsPage 外，其它依赖 meta 的页面在运行期新增供应商后需刷新页面才能看到 builtin 状态变化。
6. **上下文窗口未知**：provider 未填 `contextWindow` 时不做 token 裁剪（与既有策略一致），长会话可能触发供应商侧溢出；loop 有一次裁剪重试。

## 5. 结论

- 功能完整度：N1–N6 全部落地，15 条 P0 均有实现。
- 质量：新增 36 测试全绿；端到端链路真实跑通；无新增回归。
- 交付建议：合并 `continue-dev` 前，建议补一次真实供应商 live smoke 与独立 critic 的视觉复核。
