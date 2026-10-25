# 聊天页视觉与动效修复（2 项）

你是 product-forge 的 ui-designer。项目根 `D:/workspace/Agent WorkSpace/agentbot`。

**只改 `src/web/styles/base.css`**（必要时可加 `src/web/components/chat/TurnItem.vue` 的 class 绑定，但先读完再决定）。**不要改 `src/web/pages/ChatPage.vue`**（另一实例在改）。不要碰 `src/server/**`。

## 背景
用户试用后报了两个视觉问题。我已用 Playwright 实测确认根因，照下面的证据修，不要重新设计。

## 必读
- `.forge/agentbot-03-ui.md` §6 动效系统（六类动效规格）、§4 圆角与阴影、§7 输入区组件规格
- `.forge/agentbot-prototype-v2/index.html`（视觉权威，已验收）—— 搜 `.msg-hover`、`.composer`、`.composer textarea` 看原型怎么写的
- `src/web/styles/base.css` 现有实现

---

## 问题 1：消息悬停工具栏「突然弹出来」，没有任何过渡

### 实测证据
```js
// 未悬停
{ display: "none", animation: "none", transition: "all" }
// 悬停后（CSS 规则）
.msg:hover .msg-hover, .msg:focus-within .msg-hover {
  display: flex; animation: fadeIn var(--duration-hover) var(--ease-out) both;
}
```
根因：`display: none → flex` 是离散切换，**布局瞬间多出 24px 高度**，下面的内容整体跳一下；`fadeIn` 只对透明度生效，遮不住高度跳变。用户看到的就是「啪一下弹出来」。

### 修法要求
- **常驻占位**：`.msg-hover` 始终占据它的高度（不再 `display: none`），只用 `opacity` + `translateY(2px)` 做进出
- 过渡用 `--duration-hover`（160ms）+ `--ease-out`；**不要用 spring**（规范 §10 第 2 条：回弹只用于出现与按压，不用于列表重排）
- `visibility: hidden` 与 `opacity: 0` 同步切换，避免隐藏时还能被 Tab 聚焦到按钮
- **必须实测：悬停前后，下方元素（下一条消息 / 轮次栅栏）的 `getBoundingClientRect().top` 不发生变化（差值 0）**
- 顺带检查 `.bot-card .bc-acts`（原型用 `opacity + transform`，如果实现也用了 display 切换就一并修）

---

## 问题 2：输入框是直角

### 实测证据
```js
// 聚焦时
{ composerRadius: "24px",           // 外层胶囊是对的
  taRadius: "0px",                  // ← textarea 自己是直角
  taShadow: "rgba(12,122,143,0.28) 0px 0px 0px 3px",   // ← 自己带了一圈方形焦点环
  taOutline: "none" }
```
根因有两层：
1. `base.css:31` 的全局 `:focus-visible { outline: none; box-shadow: var(--ring-focus); }` 给 textarea 套了一圈 **方形** ring
2. `.composer textarea` 没有 `border-radius`，所以那圈 ring 是直角矩形

用户截图里那个青色直角框就是它。

### 修法要求
- **焦点环只由 `.composer` 外层承担**（它已经有 `:focus-within` 的 ring + translateY，是规范 §7「输入区 / 聚焦(-1px + ring)」要求的形态）。textarea 自己的 ring 必须去掉：
  ```css
  .composer textarea:focus,
  .composer textarea:focus-visible { outline: none; box-shadow: none; }
  ```
- `.composer textarea` 加 `border-radius: var(--radius-pill)`（或 `inherit`），保证任何残留视觉都是圆的
- **必须实测**：聚焦前后，textarea 的 `box-shadow` 为 `none`；`.composer` 的 `box-shadow` 含 `--ring-focus`；截图确认输入区是完整胶囊、无直角框
- 顺带检查 `textarea` 的 `background`：现在是 `rgba(0,0,0,0)`（透明，正确），确认修完后仍然透明、胶囊底色来自 `.composer`

---

## 硬约束
- 颜色只用 `var(--...)`，不写裸 hex（令牌定义块除外）
- 不动令牌值
- 不引入外部依赖
- 不改信息架构、不改交互逻辑（点击行为由另一实例负责）

## 验证（必须自己跑，贴真实输出）
1. `npx vue-tsc --noEmit` 通过、`npm run build:web` 成功
2. 起真实服务：
   ```bash
   npm run build:server
   TMPHOME=$(mktemp -d)
   AGENTBOT_HOME="$TMPHOME" AGENTBOT_PORT=8900 \
   AGENTBOT_BIN_ZCODE="D:/Program software/ZCode/resources/glm/zcode.cjs" \
   node dist/server.js
   ```
   （或用现成的 `~/.agentbot` 与 8792 端口，但**不要**删用户数据）
3. Playwright（不要 npm install）：
   ```js
   import { chromium } from 'file:///D:/workspace/Agent%20WorkSpace/AI-Novel-Writing-Assistant/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
   const EXE='C:/Users/liyunxuanyu/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
   ```
4. 必须给的证据：
   - 悬停前后「下方元素 top 坐标」对比（应为 0 差值）+ 过渡中的 opacity 中间值（证明有渐变）
   - 聚焦时 textarea 的 `box-shadow`（应为 none）与 composer 的 `box-shadow`（应含 ring）
   - 亮色 + 暗色各一张截图（输入区、消息悬停态）
   - 1440/1280/1024/768/375 五宽度无横向滚动

## 返回结果
1. 改动清单（文件 + 行号 + 一句话）
2. 验证真实输出
3. 两项逐条「实测前 → 改法 → 实测后」
4. 截图路径
5. 待确认事项
