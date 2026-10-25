# 项目记忆（跨设备继续开发用）

这里的文件是开发过程中沉淀的「经验记忆」，从 ZCode 的记忆目录复制过来，**跟着仓库走**，换设备时不需要重新踩一遍坑。

| 文件 | 什么时候看 |
|---|---|
| `agentbot-project-state.md` | **先看这个**。项目定位、技术栈、启动方式、安全底线（CLI 强制 worktree）、以及 7 处真机踩过的坑（虚拟列表 transform 毁 sticky、CLI 人格注入、exit 0 误判 crashed、messages 同毫秒排序、pending Turn、最新轮不自动折叠等） |
| `coopanion-pix-provider-setup.md` | 配模型供应商时看。pix 网关必须用 `chat` 协议、zayuapi 必须用 `anthropic` 协议，以及为什么 |
| `pix-deepseek-thinking-leak.md` | 用 pix 网关时看。约 1/4 请求会把思维链落进正文，成因在 provider 侧 |
| `user-language-context-habits.md` | 与用户协作的偏好（中文交流、大任务注意上下文体量） |
| `feedback-no-thinking-in-output.md` | 输出规范：思考不得进正文 |

## 注意

- 这些是**开发经验**，不是产品文档。产品文档在 `.forge/`（PRD / UX / 视觉 / 架构 / 验收报告）。
- 记忆里可能有本机绝对路径（如 `D:/workspace/Agent WorkSpace/agentbot`、`D:/Program software/ZCode/...`），换设备后按实际情况替换。
- **不要往这里放任何密钥**。provider 的 apiKey 存在 `~/.agentbot/providers.json`（权限收紧），不进仓库。
