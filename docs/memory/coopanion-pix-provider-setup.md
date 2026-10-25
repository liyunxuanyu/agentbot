---
name: coopanion-pix-provider-setup
description: Coopanion 桌宠的模型端点配置位置、协议选择规则与实测可用的服务商
metadata:
  node_type: memory
  type: project
  originSessionId: sess_3782181f-6136-4ea4-9ef1-3e3fb52961be
---

Coopanion（D:\Program software\Coopanion，Electron 打包版）的模型供应商配置在 `data/home/providers/<名字>/config.json` 与同目录 `.env`，`data/home/companion/config.json` 的 `activeProvider` 指向启用项。

**当前启用：`zy-deepseek`**（2026-10-22 切换）——`https://api.zayuapi.com`，`options.protocol: "anthropic"`（Messages API），模型 `deepseek-v4.1-flash`，thinking adaptive + effort max。旧端点 `pix-deepseek` 保留但未激活。

改配置不要手写文件，走本地 hub HTTP API 最稳（幂等、带校验和回滚）：
- `GET /api/providers` 列表、`GET /api/providers/<name>` 拿 revision
- `POST /api/providers` 新建（body: `{name, entry, secretValue}`）
- `POST /api/providers/<name>/save` 改（必须带 `expectedRevision`）
- `POST /api/providers/<name>/activate` 切换（要求 readiness=ready）
- `POST /api/providers/<name>/test` 探活、`/models` 列模型

协议选择（`options.protocol` 只认 `responses|chat|anthropic|gemini`）：
- pix 网关（`https://api.ai-pixel.online/v1`）必须 `chat`。内置 `openai-responses-compat` 走 `/responses`，而 pix 的 Responses 流式事件不带 `sequence_number`，Cortico 的 `ResponseAccumulator` 会判 `Non-increasing event sequence` 并整轮失败。
- zayuapi（`https://api.zayuapi.com`）必须 `anthropic`，地址填 `/v1` 之前的部分；实测流式、工具调用、thinking 均正常（注意它不回 `signature_delta`，所以 reasoning 不会以加密块形式回放）。

**Why:** 应用内 WebUI 只暴露配置面板，看不到协议差异；日志 `data/logs/core.log` 里只会显示协议错误而不是明确的「不支持」。

**How to apply:** 改完不需要重启，hub 每次请求都重新读盘。验证看 `data/home/companion/data/usage.jsonl` 里 `origin.instance` 是新端点名 + `outcome: "completed"`。

**桌宠「输入了没回复」排查顺序**（2026-10-22 踩过）：
1. 先看 `data/home/companion/data/session-main.jsonl` 末尾——模型往往已经生成回复，只是 `pet_say` 返回 `[pet_say 没执行] 桌宠窗口没有连接`。此时 `usage.jsonl` 里是 `completed 200`，不是模型问题。
2. `GET /api/worlds` 看 desktop-pet 的 `桌宠窗口` lamp：`loading/未打开` = 页面 socket 没连上（进程还在，只是页面断了）。
3. 修复：`POST /api/worlds/restart {"id":"desktop-pet"}`，几秒后 lamp 变 `online/页面已连接`，core 会补发 `The World "桌宠" restarted.` 事件让模型把没说的话重说一遍。
4. 手动连 `ws://127.0.0.1:7797/socket?role=pet&host=window` 调试会**顶掉真窗口**（server 里 `host=window` 的 role=pet 连接互斥，新的替换旧的），调试完必须重启 world，否则桌宠一直静默。调试想只读就别带 `host=window`，用 `role=pet&host=tab` 走 watcher 分支。参见 [[user-language-context-habits]]。
