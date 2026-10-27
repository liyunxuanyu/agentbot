# 新需求：初始化引导 / 基础技能 / 热插拔 / 技能按需加载

> 2026-10-28。用户口述四条需求，本文整理成可执行条目。
> 与前两份文档的关系：`agentbot-11` 是上一轮口径，`agentbot-18` 是待修的 7 条缺口。
> **状态（2026-10-28）**：N1 / N2 / N3-1 / N3-2 / N4 全部已实现（迁移 v4 与 18 号合并）。运行时的热插拔按文档建议留到下一轮。

## 0. 一句话

让 AgentBot 从「手工配好才能用」变成「装完就能跑、能力可插拔」：新机器上有一条走到底的初始化引导；
Agent 自带最基本的文件读写技能；能力和技能都能热插拔；Bot 默认不背任何技能，用到才加载。

## 1. 现状（实测，不是推测）

| 事实 | 位置 | 对本文的含义 |
|---|---|---|
| 已有 `/setup` 三步向导（探测运行时 → 建 Bot → 发第一条消息） | `src/web/pages/SetupPage.vue` | N1 不是从零做，是**补齐**：它没建模型供应商、没建管理员、没设工作区、没装技能 |
| 空库时不会自动进 `/setup` | `src/web/router/index.ts:15` 注释明确「无 Bot → /setup 的判断放在 BotsPage 空态里」 | N1 需要一个真正的首启判定 |
| 内置工具已有 8 个（读/写/编辑/列目录/grep/run_shell/web_fetch/read_skill） | `src/server/core/agent/tools/builtin/index.ts` | N2 的工具**已经存在**，缺的是「作为技能暴露」与「新机器默认装上」 |
| 技能目录 `~/.agentbot/skills/` 当前为空 | 实测 `ls` | N2/N4 的默认内容需要新建 |
| 技能索引上限 800 字符，只放 name + 一行描述 | `src/server/core/agent/skills.ts:12`、`AGENT_LIMITS.maxSkillsIndexChars` | N4「按需加载」的机制**已有一半**：索引轻、正文靠 `read_skill` 拉。缺的是「Bot 可开关」与「默认全关」 |
| 技能在每轮 prompt 时重扫目录 | `driver.ts:227` → `scanSkills(opts.skillsDir)` | N4 的开关必须在这里生效，否则改了不生效 |
| 没有任何插件机制 | `grep plugin/插件` 在 `src/server` 零命中 | N3 是全新能力 |
| 运行时是「声明式 adapter」：放 YAML 即接入 | `src/server/adapters/declarations/` | N3 可复用这套思路，但热插拔要求「不重启」 |

## 2. N1 · 初始化引导（新机器 / 格式化后）

**目标**：一条走到底，跑完就能聊。中途可跳过，跳过项在设置页有未完成提示。

**为什么不能只靠现有 `/setup`**：现有向导只覆盖「有运行时 → 建 Bot → 发消息」。
新机器上真正会卡住的是**没有模型供应商**（内置引擎不可用）、**没有管理员 Bot**（R6 的种子只在库为空时跑，格式化后确实会跑，但如果用户先建了普通 Bot 就再也不会种）、**没有默认工作区**。

**流程（5 步，每步可跳过）**

| 步 | 内容 | 数据来源 | 完成判据 |
|---|---|---|---|
| 1 | 欢迎 + 环境检查 | `GET /api/meta`、`GET /api/runtimes` | 至少一个运行时 `ready`，否则给安装指引 |
| 2 | 配置模型供应商 | `POST /api/providers`，复用「拉取模型」能力 | 至少一个供应商可用（`POST /api/providers/:id/test` 通过） |
| 3 | 管理员 Bot | `GET /api/admin/bots`，空则提示「点一下创建」 | 存在 `role='admin'` 的 Bot |
| 4 | 默认工作区 | 选一个目录（可选） | 可跳过 |
| 5 | 基础技能 | 一键安装 N2 的基础技能包（可选） | 可跳过 |

**关键设计**

- **首启判定**：服务端提供 `GET /api/setup/state`，返回 `{ needsSetup: boolean, steps: {...} }`。判据：无供应商 **或** 无 Bot **或** 无管理员。前端在 `App.vue` 挂载时若 `needsSetup` 且当前不在 `/setup`，跳转。
- **可重入**：`/setup` 任何时候都能打开（设置页留入口），已经完成的步骤显示 ✓ 而不是跳过。
- **不阻断**：任何一步都能「稍后再说」，进入工作台后侧栏底部显示「初始化未完成 N/5」的轻提示，点回去继续。
- **幂等**：重复跑不重复创建（供应商按 baseUrl+protocol 去重、Bot 按名字去重、技能按目录名去重）。

**改哪里**

| 文件 | 改什么 |
|---|---|
| 新建 `src/server/http/routes/setup.ts` | `GET /api/setup/state` |
| `src/server/http/routes/index.ts` | 注册路由 |
| `src/web/pages/SetupPage.vue` | 从 3 步扩到 5 步；每步可跳过；已完成显示 ✓ |
| `src/web/App.vue` 或 `router/index.ts` | 首启跳转判定 |
| 新建 `src/web/stores/setup.ts` | 步骤状态与完成度 |
| `src/web/components/layout/Sidebar.vue` | 「初始化未完成 N/5」轻提示 |

**验收**

- [x] 清空 `~/.agentbot` 后首次打开，自动进入引导
- [x] 走完 5 步后能直接发消息并收到回复
- [x] 每步都能跳过；跳过后侧栏有未完成提示，点进去能续
- [x] 重复跑不产生重复的供应商 / Bot / 技能目录
- [x] 已有完整配置的库不会被打扰（`needsSetup=false`，不跳转）

## 3. N2 · 基础技能（Agent 的看家本领）

**目标**：新机器默认就有「读写文件、跑命令、查目录、搜内容、联网」这些最基本的操作能力，不用用户自己写 SKILL.md。

**现状澄清**：这 8 个操作**已经是内置工具**（`createBuiltinTools()`），模型一直能用。缺的是：

1. 它们没有被表达成「技能」，用户在技能页看不到、关不掉；
2. 技能页是空的，用户以为没有能力；
3. 新机器上没有一份「什么时候该用哪个」的说明，模型靠工具描述自己猜。

**做法**：把「基础技能包」做成内置的一组 SKILL.md，随代码分发，首次启动时安装到 `~/.agentbot/skills/`。

| 技能名 | 描述（进索引的一行） | 对应工具 |
|---|---|---|
| `file-basics` | 读取、写入、精确编辑文件；先读后改，改完自检 | `read_file` / `write_file` / `edit_file` |
| `shell-basics` | 在工作区里执行命令；先看目录结构再跑，长命令给超时 | `run_shell` |
| `search-basics` | 按内容或文件名找东西；grep 找内容，list_dir 看结构 | `grep` / `list_dir` |
| `web-basics` | 抓取网页正文；只取需要的部分，不整页塞进上下文 | `web_fetch` |

每个 SKILL.md 正文写：什么时候用、常见错误、边界（工作区外拒绝、写前要批准）。

**为什么是技能而不是只留工具**：工具描述只够模型知道「怎么调」，不够知道「什么时候该调、调完该检查什么」。技能是可维护的说明书，用户也能改。

**改哪里**

| 文件 | 改什么 |
|---|---|
| 新建 `src/server/core/agent/skills/builtin/*.md` | 4 份 SKILL.md（打包进产物） |
| 新建 `src/server/core/agent/skills/install.ts` | 首次启动时把内置技能写入 `~/.agentbot/skills/`；已存在则跳过，不覆盖用户改动 |
| `src/server/main.ts` | 启动时调用 install |
| `src/web/pages/SettingsPage.vue` 技能分区 | 标注「内置」徽标；显示「已被哪些 Bot 启用」 |

**验收**

- [x] 新机器首次启动后 `~/.agentbot/skills/` 有 4 个目录
- [x] 用户改过某个 SKILL.md 后重启，不会被覆盖
- [x] 删除某个内置技能目录后重启，会重新安装（可恢复）
- [x] 技能页显示 4 个内置技能，带「内置」标记

## 4. N3 · 热插拔（像插件那样）

**目标**：不重启服务就能加载/卸载能力。分两层，**建议先做第一层**。

### 4.1 第一层：技能热插拔（低成本，收益直接）

技能本来就是文件 + 每轮重扫，只要补一个「变更后立刻生效」的信号即可。

| 能力 | 做法 |
|---|---|
| 新增技能目录 | 设置页「重扫」按钮已有（`routes/skills.ts`）；补「保存后自动重扫」 |
| 启用/停用某个技能 | `bots.enabled_skills`（JSON 数组，null = 全部启用）；每轮 prompt 按它过滤 |
| 立即生效 | 技能扫描结果加 mtime 缓存，文件变化即失效；不需要重启 |

### 4.2 第二层：能力热插拔（成本高，需单独评估）

指「运行时 / MCP server / 模型供应商」不重启即可增删。现状：

| 对象 | 现在能不能热插拔 |
|---|---|
| 模型供应商 | **能**，`providers.json` 每次请求重读 |
| MCP server | **部分**，有「重连」按钮；新增 server 需重启（`main.ts` 启动时连接） |
| 运行时（adapter） | **不能**，启动时探测一次 |

建议本轮只做：**MCP server 热插拔**（新增/删除后自动连接/断开，不重启）+ 技能热插拔。运行时热插拔留到下一轮，因为它要处理「正在跑的会话怎么办」。

**改哪里**

| 文件 | 改什么 |
|---|---|
| `src/server/adapters/mcp/manager.ts` | 加 `add(server)` / `remove(id)`，支持运行期增删连接 |
| `src/server/http/routes/mcp.ts` | POST/PATCH/DELETE 后直接调 manager，不再提示「需重启」 |
| `src/server/core/agent/skills.ts` | 扫描结果按 mtime 缓存 |
| `src/server/core/agent/prompt.ts` | 按 `bots.enabled_skills` 过滤技能索引 |
| `src/server/core/db/migrate.ts` | v4：`bots.enabled_skills TEXT`（JSON 数组，默认 NULL） |
| `src/web/pages/SettingsPage.vue` | 技能开关；MCP 去掉「需重启」提示 |

**验收**

- [x] 新建一个技能目录，保存后下一轮对话即生效，不重启
- [x] 停用某技能后，该 Bot 的索引里不再出现它
- [x] 新增 MCP server 后不用重启就能被模型调用
- [x] 删除 MCP server 后工具立刻消失，不残留

## 5. N4 · 技能默认不加载（按需加载）

**目标**：Bot 刚创建时一个技能都不背，用到才加载。避免工具上下文过长。

**现状**：索引已经只放 name + 一行描述（≤800 字符），正文靠 `read_skill` 拉。这已经算「按需加载正文」，但**索引本身仍是固定成本**——技能多了，800 字符装不下，且模型会看到一堆用不上的名字。

**做法（三档，按激进程度递增，建议做前两档）**

| 档 | 做法 | 效果 |
|---|---|---|
| A | **默认不注入索引**：新建 Bot 的 `enabled_skills = []`，索引为空 | 最彻底，但模型不知道有什么技能，只能靠用户点名 |
| B | **默认只注入「基础技能包」**：`enabled_skills` 默认含 N2 的 4 个 | 保证看家本领在，其它按需开 |
| C | **按需发现**：注入一句「有 N 个技能可用，调用 `list_skills` 查看」 | 索引成本恒定 1 行，但多一次工具调用 |

**建议 B + C 组合**：默认装基础 4 个（N2），其余技能通过 `list_skills` 发现。理由：

- 纯 A 会让模型在需要时完全想不到有技能；
- 纯 C 每次都要多一轮工具调用；
- B+C 兼顾「基础能力常在」与「长尾不占上下文」。

**改哪里**

| 文件 | 改什么 |
|---|---|
| `src/server/core/db/migrate.ts` | v4：`bots.enabled_skills TEXT DEFAULT NULL`（NULL = 默认集合） |
| `src/server/core/bots/create.ts` | 新建时写默认集合（N2 的 4 个） |
| `src/server/core/agent/prompt.ts` | 索引按 enabled_skills 过滤；超限时只列前 N 个 + 「还有 M 个，用 list_skills 查看」 |
| 新建 `src/server/core/agent/tools/builtin/list_skills.ts` | `list_skills` 工具：返回全部技能名 + 一行描述（不进系统提示） |
| `src/web/pages/BotDetailPage.vue` | 技能开关区：勾选启用哪些 |

**验收**

- [x] 新建 Bot 的索引只有 4 个基础技能（不是全部）
- [x] 技能超过 12 个时，索引仍 ≤800 字符，并出现「还有 M 个」提示
- [x] 模型能通过 `list_skills` 发现未启用的技能，并能 `read_skill` 读取
- [x] 用户在某 Bot 上关掉某技能后，下一轮索引里消失

## 6. 条目汇总与优先级

| 编号 | 需求 | 工作量 | 优先级 | 依赖 |
|---|---|---|---|---|
| N1 | 初始化引导（5 步 + 首启判定 + 可重入） | 中 | **高** | 无 |
| N2 | 基础技能包（4 份 SKILL.md + 首次安装） | 小 | **高** | 无 |
| N3-1 | 技能热插拔（含启用/停用） | 小 | 中 | N4 的 `enabled_skills` 列 |
| N3-2 | MCP server 热插拔 | 中 | 中 | 无 |
| N4 | 技能默认不加载 + `list_skills` | 中 | **高** | N2 |
| — | 运行时热插拔 | 大 | 低（下一轮） | 需要定「运行中的会话怎么办」 |

**建议顺序**：N2 → N4 → N1 → N3-1 → N3-2。
N2 和 N4 改同一批文件（skills / prompt / migrate），一起做最省；N1 独立；N3 放最后因为它依赖前两者的数据结构。

## 7. 不可逆项

- **迁移 v4**：`bots.enabled_skills TEXT`（可空，回填 NULL 表示「用默认集合」，不改变现有 Bot 行为）
- **内置技能首次安装**：会往 `~/.agentbot/skills/` 写 4 个目录。若用户已有同名目录，跳过不覆盖。

## 8. 明确不做

- 不做「技能市场」/ 远程下载技能（安全边界太大，单独评估）
- 不做运行时热插拔（本轮）
- 不做技能版本管理（改了就是改了，靠 git 或用户自己备份）
- 不做技能的权限声明（技能只是说明书，实际权限仍由工具层裁决）

## 9. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `agentbot-11-requirements-align.md` | 上一轮口径（R1–R8），本轮不动它 |
| `agentbot-18-fix-list.md` | 7 条待修缺口，与本轮**并行**，文件不重叠（详见下表） |
| `agentbot-05-architecture.md` | 需追加 N1/N3 的架构说明 |
| `agentbot-02-ux.md` | 需追加 5 步引导与技能开关的交互 |

**与 18 号文档的文件冲突检查**

| 本轮要改 | 18 号是否也要改 | 冲突 |
|---|---|---|
| `core/agent/skills.ts`、`prompt.ts`、`builtin/list_skills.ts` | 否 | 无 |
| `core/db/migrate.ts` | **是**（R8 要加 `cache_reported` 列） | **有** —— 两轮都加列，建议合并成一次 v4 迁移 |
| `adapters/mcp/manager.ts`、`routes/mcp.ts` | 否 | 无 |
| `pages/SetupPage.vue`、`stores/setup.ts` | 否 | 无 |
| `pages/SettingsPage.vue` | 否（18 号不动设置页） | 无 |
| `main.ts` | 否 | 无 |

**结论**：迁移 v4 要合并两边的新列（`bots.enabled_skills` + `usage_records.cache_reported`），一次做完。
