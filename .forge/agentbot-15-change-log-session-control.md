# 变更日志：会话控制 / 记忆隔离 / 管理员 Bot

> 2026-10-27。对应需求 [`agentbot-11-requirements-align.md`](agentbot-11-requirements-align.md) 的 R1–R8。
> 实现提交：`16f0591`（迁移 v3 地基）、`c318706`（M1/M2/M3）、`69412ae`（M5 前端）、`6e83172`（记忆刷新与 create_bot 修复）。

## 1. 迁移 v3

`core/db/migrate.ts` 新增 v3，`schema.sql` 同步：

| 表 | 新列 |
|---|---|
| `channels` | `workspace_path` |
| `sessions` | `workspace_path`、`provider_id`、`model`、`permission_mode`（默认 `confirm`） |
| `bots` | `role`（默认 `member`）、`permission_mode`（默认 `confirm`） |
| `memory_entries` | `scope`（默认 `bot`）、`channel_id`，新增 `idx_memory_scope` |
| `usage_records` | `cached_input_tokens`、`cache_write_tokens`、`model` |

回填策略：历史记忆全部落在 `scope='bot'`（该 Bot 的全局记忆），内容与行数不变；老库升级日志为 `v0 → v3`。

## 2. 需求落地与验收证据

| 编号 | 实现 | 验收证据（`node scripts/smoke-builtin.mjs`） |
|---|---|---|
| R1 | 内置引擎 Bot 不填路径可建；`repoPath` 仅在实际填写时校验 | `Bot 已创建（无默认路径）并授权目录 …` |
| R2 | cwd 解析 `sessions.workspace_path → channels.workspace_path → bots.repo_path → process.cwd()`；`PATCH /api/channels/:id` | `渠道工作区已设为 …`、`confirm：权限卡 → 批准 → 文件落在渠道工作区，系统提示 cwd 正确`、`坏工作区被拒：目录不存在` |
| R3 | 记忆作用域 `bot/channel/session`，装配与摘要按当前渠道过滤 | `记忆隔离通过：渠道/会话作用域互不串` |
| R4 | 会话级 `provider_id/model` 覆盖；每轮 prompt 读取；跨协议提示 | `会话级模型覆盖：下一轮即生效`、`跨协议切换有提示：…建议新开一个会话` |
| R5 | 四档权限 + 输入区常显胶囊 + Shift+Tab | `plan：工具列表 read_file,list_dir,grep,read_skill，写类已裁掉`、`auto：边界内写自动批准并写审计（mode:auto），未弹卡`、`full：绕过 Bot 边界执行并写审计（mode:full）` |
| R6 | `role=admin` + `create_bot` 工具 + 种子 | `管理员已种下：管理员`、`create_bot：admin 权限卡 → 批准 → 建出「工具 Bot」`、`普通 Bot 看不到 create_bot（工具表按角色裁剪）` |
| R7 | 上下文压缩：阈值触发 + `POST /api/sessions/:id/compact` + `meta.compaction` | `手动压缩：移除 18 条，meta.compaction 已入流` |
| R8 | 缓存 token 记录与 `/usage` 命中率列 | `缓存命中率：50%（1400 / 2800）` |

## 3. 门禁结果

| 门禁 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | 0 错误 |
| `vue-tsc -p tsconfig.json --noEmit` | 0 错误 |
| `scripts/check-boundaries.mjs` | 通过（core 无协议字符串，adapters 无数据库依赖） |
| `vitest run` | 409 passed / 0 failed（连续两次） |
| `scripts/smoke-builtin.mjs` | 全链路通过 |

## 4. 本轮修掉的两处环境假失败

1. `tests/unit/assignment.test.ts` 的「无法统计」用例：本机 `%TEMP%` 落在祖先 git 仓库里，runner 正确地判成 git 目录。改为在检测到祖先仓库时直接验证渲染契约，其它环境仍走整链路。
2. 同文件 `not_repo_root` 用例与冒烟的权限目标比较：Windows 8.3 短名（`LIYUNX~1`）+ 反斜杠导致字符串不等。统一按 `realpathSync.native` + `/` + 小写比较。

## 5. 已知边界

- 只覆盖内置引擎；CLI / ACP / native 运行时的模型与权限控件为禁用态，行为未改。
- 群聊共用工作区不做文件锁；写类工具靠主持人串行，超并发场景由 PRD 的并发 1 约束兜底。
- 压缩不回滚：原文仍可从 events 展开，但不重新注入。
- 缓存命中率依赖供应商上报；缺失时显示 `—`，不按 0 处理。

## 6. 追加（2026-10-27 晚）：模型能力表可维护 + 数据整理可勾选

**模型能力对照表改成数据文件，不再写死在代码里**

- 内置表 `src/server/adapters/providers/model-catalog.json`（38 条规则，v2），随代码升级；
- 用户覆盖 `~/.agentbot/model-catalog.json`，**优先命中**，改完保存即生效；
- `GET /api/providers/catalog` 返回两层表 + 用户表路径 + 来源说明，设置页弹窗可查；
- 拉模型时每个条目带 `known` 标记：命中表为 true，命名推断为 false（界面提示需核对），
  完全认不出返回 null，不编数字。

数值来源只取能核实的：DeepSeek 官方定价页（v4 flash / v4 pro 1M 上下文 / 384K 输出）、
Anthropic 上下文文档（1M 系列单请求 128K 输出，其余 200K 窗口）。其余条目为公开文档的
保守取值，已在表的 `sources` 字段注明。**没有**采用搜索到的互相矛盾的二手数据。

**数据整理可勾选范围**

`POST /api/admin/tidy` 接受 `targets`：

| 类别 | 含义 | 默认 |
|---|---|---|
| `channels` | dm/群聊无在用参与者，连带会话/消息/事件 | 勾选 |
| `orphanSessions` | 渠道还在但所属 Bot 已删除的会话 | 勾选 |
| `memories` | 所属 Bot 已不存在的记忆条目 | 勾选 |
| `orphanUsage` | 所属 Bot 已不存在的用量行 | **不勾**（历史账目） |

`targets` 省略时用安全默认（前三项）。前端按类别显示条数、数量为 0 的禁用勾选。
