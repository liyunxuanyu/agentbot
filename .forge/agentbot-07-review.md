# AgentBot 验收报告（阶段 7）

> 验收对象：`src/`（114 个 ts/vue 文件）+ `dist/` 构建产物
> 验收依据：`agentbot-01-prd.md` P0-01 至 P0-15 的「验收标准」与「边界处理」两列
> 验收方式：两个 critic 实例并行只读验收（分 P0-01~08 / P0-09~15），主流程独立复测
> 日期：2026-10-25

---

## 结论

**通过（含已知限制）**

- 15 条 P0 全部有实现，其中 11 条完全通过
- 4 条带已知限制或未验证项（本机环境所限），逐条列在下方
- 首轮验收发现 **6 个阻断 + 11 个重要 + 13 个次要**，全部修复后复测通过
- 静态基线：`vue-tsc --noEmit` 0 错、`tsc --noEmit` 0 错、`check-boundaries` 通过、`vitest` 331/331

---

## 一、首轮验收发现的问题（全部已修复）

### 阻断（6）

| # | 问题 | 根因 | 修复 | 复测证据 |
|---|---|---|---|---|
| 1 | CLI 通道完全不注入人格与记忆 | `cli/driver.ts` 的 `newSession()` 丢弃 `opts.systemPrompt` | 保存 systemPrompt 并前置拼进 prompt 文本（CLI 无 system 参数，诚实降级） | 真实 ZCode：人格「每句以嘎结尾」+ 记忆「紫罗兰-42」→ 回答「我叫铁蛋，秘密口令是紫罗兰-42嘎」 |
| 2 | CLI 每轮正常退出被判 crashed，下一轮新建 Session 且不重建 | `onProcessExit` 把任何非主动退出判 crashed；`hasHistory` 只看 `runtime_session_id` | 预期退出 = code 0 且无进行中 Turn → `idle`；重建判据改为看 `messages` 表；首轮也注入人格+记忆（bootstrap） | sessions 表：`status=idle, resume_state=rebuilt`；第二轮答「你上一条问的是…嘎」；meta 只落 1 条 |
| 3 | 刷新后全部非消息事件与 token 用量消失 | 无事件 REST 端点，私聊游标取渠道最大 lastEventId 从不回放 | 新增 `GET /api/sessions/:id/events`；前端首连先分页拉全量再建 SSE | 刷新前后 `turn-sum` 均为「完成 · 66.8k/6」，展开后 `∑ 66,792 in / 6 out` 一致 |
| 4 | 单轮 2205 事件全量渲染（1103 个 DOM 子节点） | 虚拟化只做到 Turn 粒度 | 展开态 >200 项时用 `@tanstack/vue-virtual`（overscan 50），Turn 体成独立滚动容器 | 2205 事件：折叠态 1 个子节点；展开态 59 个虚拟行 |
| 5 | 手动添加自定义运行时完全缺失 | `POST /api/runtimes` 404 | 新增端点 + 设置页弹层；重复 → 409 `already_exists` + 高亮 `existingId` | 添加 Node Runner → 201 ready；重复 → 409 并 toast + 高亮 |
| 6 | 删除 Bot 完全缺失 | `DELETE /api/bots/:id` 404 | 新增端点（`confirmName` + `cascade`/`archive`）+ 危险区弹层 | 名字错 → 内联报错；cascade → Bot 删、`usage_records` 保留 1 条；archive → `status=archived` |

### 重要（11，全部修复）

1. 人格编辑不生效 → `PATCH` 补 `persona` 分支，UI 加编辑弹层
2. UI 无法 @ Bot → Composer @ 选择浮层，`mentionBotIds` 随消息提交
3. 空名单缺「指定 Bot 回复」按钮 → 系统块内补按钮，复用 @ 选择器
4. 主持人原始 JSON 显示为普通气泡 → 识别并折叠为一行
5. 运行时 unavailable 时发送未禁用 → store 暴露 `sendBlockReason`/`canSend`，Bot 详情横幅统一文案
6. 最低版本原因未展示 → `probeDetail` 优先，显示「需要 ≥ x.y，当前 a.b」
7. 「重新探测」是假按钮 → 每行「重试」+ 全局循环，真实调 probe
8. 「重发」只填输入框 → 改为以上一条原文新建一轮
9. 空回复不显示「未返回内容」→ 降级块 + 重发
10. 30s 无事件无「无响应」→ Turn 头 warning chip + 停止
11. 同毫秒消息顺序颠倒 → 排序键改 `created_at DESC, rowid DESC`（零 schema 变更）

### 次要（13，全部修复）

`plan` 缺 entries 静默变「计划 0 项」、worktree 未就绪提示原始错误码且无重试、记忆缺「来源会话」、`--color-text-faint` 暗色取值、`.is-dim` 被 `animation-fill-mode: both` 锁死、usage 表头字号、@ 按钮尺寸、`btn--sm` 圆角、状态图标尺寸、`本轮调用 2/3` 文案、`/assignments` 派活入口、F3 顶部提示条、演示浮钮遮挡。

---

## 二、15 条 P0 最终状态

| P0 | 项 | 判定 | 说明 |
|---|---|---|---|
| P0-01 | 运行时发现 | 通过 | 5 条运行时 1.6s 列出；单项 3s 超时互不阻塞；手动添加 + 重试已补 |
| P0-02 | 能力上报 | 通过 | 三态徽标；`probeDetail` 展示「需要 ≥ x.y」；不可用禁用发送 |
| P0-03 | Bot 实体 | 通过 | 创建/重名内联/编辑人格/删除（cascade+archive）全部实测 |
| P0-04 | 私聊流式 | 通过 | ACP 146ms 首 token；停止 148ms 到达运行时且为终态；重发新建轮；空回复降级；崩溃标失败 |
| P0-05 | 统一事件流 | 通过 | 9 类分块可折叠；掩码生效；未知事件虚线块保留 raw；2000+ 虚拟滚动；30s 无响应 |
| P0-06 | 群聊主持 | 通过 | 主持人 0–3 人 + 理由；未点名 0 调用（实测 `calls:2` 且第三 Bot 无记录）；@ 必含优先；≤3；四条降级路径 |
| P0-07 | Assignment | 通过 | 并发 1、队列 5、第 7 个 409；报告四节；回贴原会话；30min 超时与崩溃附 50 条事件有实现（未等 30min 实测） |
| P0-08 | 权限卡片 | 通过 | 卡片 240–268ms 出现；4 按钮；决策 3–4ms 回传；reject 120s 真实等满；hold 24h；进程退出转 invalidated |
| P0-09 | Bot 边界 | 部分通过 | 默认全关、字段级校验、二次确认实测通过；**越界实时拒绝仅单测覆盖**（本机无可发权限请求的运行时） |
| P0-10 | 记忆 | 通过 | 6000 预算截断（`usedChars:4036, truncatedCount:4`）；40 条自动摘要；空记忆不注入；运行时不可用留标记重试；真实 ZCode 验证注入生效 |
| P0-11 | 定时任务 | 通过 | 三种触发；<5min 拒绝；到点真触发并回贴；补跑 1 次不重复；连续失败 3 次自动暂停 |
| P0-12 | 用量统计 | 部分通过 | 四档筛选、未上报不估算、删除 Bot 保留均实测；**累计值/增量 10% warning 未验证**（无运行时上报 cumulative） |
| P0-13 | 执行位置 | 通过 | git 校验、两 Bot 同仓库独立 worktree、失败标未就绪并 409 阻止、CLI 强制 worktree、重试入口 |
| P0-14 | 本地鉴权 | 通过 | 32 字节 token + icacls；401 无业务数据；SSE 握手校验；删文件重生成旧失效；11 次错误 429；重置 1.5s 断连 |
| P0-15 | 会话真相 | 通过 | 1s 落库；重启完整恢复（顺序用 rowid 修正）；resume 优先、失败重建并标记；崩溃重发新 Session；双标签页排队 |

---

## 三、未验证项（本机环境限制，非实现缺陷）

| 项 | 原因 |
|---|---|
| P0-09 越界实时拒绝 / 相对路径实时判定 / 进行中请求按旧版本 | 本机无可发权限请求的可用运行时（ZCode/DSH `channel: none`；Codex 未登录；Claude Code/Gemini 未安装）。仅有单测覆盖 |
| P0-09 目录「不可写」内联报错 | Windows `accessSync(W_OK)` 对目录语义弱，本机无法构造只读目录 |
| P0-12 累计值/增量 10% warning | 所有可用运行时都不上报 `cumulative` |
| P0-15 上下文窗口裁剪 + 「已省略 N 条历史」 | 所有运行时 `contextWindow` 均为 `null`，不触发裁剪；`omittedMessages` 数据已到位，展示层已修 |
| P0-07 30 分钟超时 | 未等 30 分钟；代码有 `waitTurnDone(timeoutMs)` 与 `TAIL_LIMIT=50` |
| Codex 原生通道端到端 | 本机 `codex` 未登录，`turn/start` 后模型请求发不出；协议握手/会话/取消已实测，6 类事件仅 fixture 回放 |
| 真实群聊完整派发 | 主持人 15s + 发言人 15–45s，用真实 HTTP 请求体 + 合成 Turn 验证；完整链路单测覆盖 |

---

## 四、安全修复（用户裁定）

**CLI 运行时默认强制 worktree**。背景：`zcode`/`dsh` 声明 `permission.channel: none`，产品层收不到授权请求，M10 实测中 ZCode 直接改了仓库 `package.json` 并新建 `tsconfig.server.json`。

实现：
- `core/permissions/worktree-guard.ts` —— `requiresWorktree()` 纯判定 + 风险文案
- `core/process/session-cwd.ts` —— Session 启动强制 worktree；未就绪抛 `WorktreeNotReadyError`，**绝不静默降级 local**
- 建 Bot 时默认强制 worktree 且必填 repoPath；改 local 需 `confirmRisk: true`

实测：Bot 配 `local` 后发消息，文件落在 `wt/ZCode-*/proof.txt`，主仓库 `git status` 干净；worktree 未就绪返回 409 且不落消息。

---

## 五、文档对齐（用户裁定）

| 项 | 变更 |
|---|---|
| P0-06 群聊决策超时 | 「5s 内」→「默认 20s，`AGENTBOT_GROUP_DECISION_MS` 可调」。依据：真实 CLI 一轮 14–22s，5s 物理不可达 |
| P0-07 Assignment 并发 | 「同时 2 个」→「同时 1 个，第二个起排队」。依据：local 模式并发写同目录有真实冲突风险；架构 §5 同步 |
| P0-13 CLI 强制 worktree | 新增安全底线（用户裁定） |

---

## 六、构建与测试基线

```
vue-tsc --noEmit       exit 0
tsc --noEmit           exit 0
check-boundaries       通过（core/ 无协议字符串，adapters/ 无数据库依赖）
vitest                 19 files / 331 tests 全绿
build:web              dist/web 产出正常
build:server           dist/server.js 产出正常
```

真实运行基线（本机）：ZCode ready 0.17.0、DSH ready 0.1.1、Codex ready 0.163.0（未登录）、Claude Code missing、Gemini missing。启动耗时 1.6–1.8s。

---

## 七、剩余风险（按严重度）

1. **Codex 未登录**，原生通道的 6 类事件只有 fixture 回放。需要 `codex login` 后补录真实样本。
2. **CLI 通道无权限拦截**，靠强制 worktree 隔离。若用户显式确认后改回 local，Bot 仍可无审批改文件（这是用户已知的选择）。
3. **DSH 健康检查偏乐观**：只跑 `--version` 就判 ready，实际缺 `DEEPSEEK_API_KEY` 时会失败。
4. **`permission_requests` 缺 `runtime_request_id` 列**：用 `#n` 后缀绕开，进程回收重建后理论上可能撞主键。
5. **`assignments` 表缺 `source_message_id`**：回贴按「该 Bot 在该渠道最近的 Session」解析，同一渠道多任务会贴在同一 Session 末尾。
6. **群聊 SSE 游标**：改为按 Session 分别建连 + 从 0 回放，Session 数多时回放成本上升。

---

## 八、验收后补充修复（2026-10-25 试用反馈）

**问题**：用户在浏览器地址栏直接输入 `http://127.0.0.1:8792/bots`（未带 `?t=`），页面显示一屏 `{"error":"unauthorized"}`。

**判定**：安全行为正确（P0-14 要求 401 且不含业务数据），但**可用性缺陷** —— 人看到的是给程序读的 JSON。

**修复**：`http/server.ts` 的鉴权钩子按 `Accept` 分流
- 浏览器导航（`Accept` 含 `text/html` 且非 `/api/*`）→ 返回 HTML 说明页（含「需要访问令牌」、URL 形态、如何找回 token），亮暗自动适配
- fetch / EventSource / `/api/*` → 仍然只回 JSON `{"error":"unauthorized"}`，不含业务数据
- 429 限流同样给人看的页面（说明 60 秒后重试）

**新增测试**：`tests/unit/http-auth-page.test.ts` 5 条（HTML 页 / `/api/*` 仍 JSON / fetch 默认仍 JSON / 带 token 能进 SPA 并种 cookie / 429 也是 HTML 页）。

**复测**：`vitest` 336/336 全绿；浏览器实测「带 token 打开一次 → 之后直接点导航均可用」。

---

## 九、试用反馈修复（2026-10-25 第二轮）

用户在真实使用中报了 5 个问题，我逐条实测定位根因，派 ui-designer（视觉/动效）与 builder（交互）两个实例并行修复，另自查发现 2 个问题一并修掉。

| # | 现象 | 根因 | 修复 | 复测 |
|---|---|---|---|---|
| 1 | 消息悬停工具栏「突然弹出来」 | `.msg-hover` 用 `display:none→flex`，高度瞬间多出 18–24px，下方内容跳一下 | 改常驻占位 + `opacity`/`translateY(2px)` 160ms 过渡，`visibility` 延迟同步 | 静止高度 18px（已预留），悬停 opacity 0→0.81→1，无布局跳变 |
| 2 | 折叠态「展开查看」点击无反应 | 摘要行是纯展示，只有 `.turn-head` 有 click | 整行可点 + `role=button`/`tabindex`/Enter/Space + 焦点环 | 点击后 `collapsed` 6→5 |
| 3 | 消息里的 Bot 头像/名字点击无反应 | 纯装饰元素 | 头像+名字成为该轮折叠入口（事件委托，气泡本身不拦截，正文仍可选中） | 点击后 `collapsed` 5→6；气泡文字可选中 |
| 4 | 输入框是直角 | 全局 `:focus-visible` 给 textarea 套了方形 ring，且 textarea `border-radius:0` | 焦点环只由 `.composer` 承担；textarea `border-radius: var(--radius-pill)` | textarea `radius=24px, shadow=none`；composer 有 ring |
| 5 | 发送后 15–30s 内零反馈 | 只乐观插入用户消息，**不创建 pending Turn** | POST 返回后立刻建 pending Turn（生成中 + 秒表 + 非流式等待文案），首条事件用同一 turnId 合并 | t=0.5s 即显示「生成中 0s」+「等待运行时返回完整结果 · 已 0s」+ 发送键变停止；秒数 0→1→4→11 递增；收口后转「完成」，无重复 Turn |
| 6 | （自查）答案一完成就立刻折叠 | `isCollapsed` 对 `status==='done'` 一律收起 | **最新一轮保持展开**（上一条自动收起，单展开仍成立） | 收口后 `lastCollapsed=false`，正文高 174px 可见 |
| 7 | （自查）滚动到底时 Turn 头跑到正文下方 | 虚拟列表用 `transform: translateY()` 定位行，transform 创建包含块，破坏 Turn 头 `position: sticky` | 改用 `top` 定位 | 滚动到底：head 552 < body 596（正确顺序） |

**顺带改进**：折叠摘要行从纯计数（「1 条消息 · 用量 1」）改为**先给回答首句预览**（「9 加 10 等于 19。 · 1 条消息 · 用量 1」），收起的历史轮次能一眼扫出结论。

**复测基线**：`vue-tsc` 0 错、`vitest` 336/336、`check-boundaries` 通过、7 项 Playwright 断言全 PASS、0 JS 错误。

### 十、试用反馈修复（2026-10-25 第三轮）

**现象**：展开/收起最后一条消息时，消息流的滚动条不自动滚动。

**实测**：
```
初始（贴底）:   scrollTop 1437 = maxScroll 1437  atBottom true
收起最后一轮:   scrollTop 1299 = maxScroll 1299  atBottom true
展开最后一轮:   scrollTop 1299, maxScroll 1437   atBottom false  ← 卡住
                最后一轮底部 727 > 视口 619      ← 新展开的 138px 落在视口下方
```
根因：`toggleTurn()` 只改 `collapsed` 状态，**完全没管滚动位置**。行高变了 138px，`scrollTop` 不动，新露出的正文就跑到视口下面，看起来像「点了没反应」。

**修复**：`toggleTurn` 后按条件重新贴底
- 原本贴底 → 继续保持贴底
- 动的是最新一轮 → 滚到底，让刚展开的正文（或收起后的摘要行）进入视野
- 老轮次在历史中间被展开 → **不动滚动**（用户是特意翻上去看的，跳到底会打断阅读）

滚动补偿等两帧：① Vue patch 完 DOM、虚拟列表 ResizeObserver 量到新行高；② virtualizer 按新总高重排行位置 —— 只等 `nextTick` 时 `scrollHeight` 还是旧值，会差一截。

**复测**：
```
贴底展开最后一轮:  scrollTop 1609 = maxScroll 1609  atBottom true  底部 589 < 视口 619
点「展开查看」展开: scrollTop 1609 = maxScroll 1609  atBottom true
滚到顶部展开老轮次: scrollTop 6 → 0                不跳底（符合预期）
收起最后一轮:      atBottom true
```
`vitest` 336/336、`check-boundaries` 通过、0 JS 错误。

### 十一、响应慢的定位（2026-10-25 第四轮，用户提问「为什么等 10 多秒」）

**结论：不是本产品慢，是 ZCode CLI 自身的成本。** 实测数据（本机 0.17.0）：

| 调用 | 耗时 | 输入 token | 输出 |
|---|---|---|---|
| `zcode --version` | 1.2s | — | — |
| `zcode -p "回答一个字：好"` | 14.4–16.2s | 68,104 | 2 |
| `zcode -p "记住一个数字：42"` | 37.6s | 205,739 | 558 |
| `--resume` 第二轮（问「刚才的数字」） | 24.1s | 62,313 | 18 |
| `--resume` 第三轮 | 15.9s | 69,129 | 2 |
| `--disallowed-tools <全部工具>` | 15.9s | 66,156（缓存 67,968→3,584） | 2 |

**根因**：ZCode headless 每次调用都把约 **62k–69k token 的系统提示**（核心提示 + 插件/MCP 工具定义 + 技能清单）送给模型。即使 2 个字的回答也要一次这么大的上下文往返，provider 侧就是 13–16s。`--resume` 保留会话上下文（实测能记住 42）但不省系统提示，所以没有提速；`--disallowed-tools` 只减 2k token 还打掉了 prompt 缓存，反而更慢。

**本产品开销**：`POST /api/messages` 87ms 返回；整轮 13.3s 与 ZCode 单独跑一轮的 13–16s 同一量级，即产品层开销 ≈ 0。我们注入的人格 + 记忆 + 最近 20 条只有几百 token，占比可忽略。

**顺带修的 bug**：CLI 驱动把 `done` 事件的 `durationMs` 硬写成 0，UI 显示「完成 · 0.0s」—— 用户等了 13 秒看到 0.0s，会以为产品坏了。改为真实墙钟（spawn→exit），实测 UI 现在显示「完成 · 13.3s」。

**可选优化（未实施，待定）**：
1. **登录 Codex**（`codex login`）：Codex 的 app-server 驱动已实现且支持流式，首 token 秒级。零代码改动。
2. **ZCode 改用 `app-server` 协议**：已探明 `zcode app-server` 讲 JSONL（会发 `startup/storageState` 等事件），可做常驻进程 + 流式 + 权限请求，顺带解除「CLI 必须强制 worktree」的限制。需要新写一个通道驱动。
3. 接受现状：UI 已有实时秒表与真实耗时，等待过程可见。
