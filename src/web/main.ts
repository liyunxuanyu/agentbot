// 必须第一个 import：它同步执行 bootstrapToken()，在 router 捕获初始地址之前
// 把 `?t=` 从地址栏抹掉（P0-14 / 架构 §8）。
import "./net/bootstrap";

import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { useUiStore } from "./stores/ui";

// 样式顺序即层叠顺序：令牌 → 全局基础样式。
// 令牌必须在前，base.css 里所有 `var(--...)` 才能解析到值。
import "./styles/tokens.css";
import "./styles/base.css";

/**
 * 应用入口。
 *
 * 启动序：
 *   ① net/bootstrap：从 `?t=` 取 token 存 sessionStorage 并从地址栏抹掉（P0-14）；
 *   ② createApp + pinia；
 *   ③ 应用主题（localStorage / 系统偏好）；
 *   ④ 挂载 router。
 *
 * ① 必须是模块级 import 而不是这里的函数调用：ESM 的 import 求值早于模块体，
 * 而 `createWebHistory()` 在求值时就捕获了 location。写在模块体里会把 token
 * 留在地址栏（实测：`/bots?t=...`）。
 */
const app = createApp(App);
app.use(createPinia());

// pinia 就绪后才能用 store 应用主题
useUiStore().applyTheme();

app.use(router);
app.mount("#app");
