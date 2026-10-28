import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "src/web",
  plugins: [vue()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // /api 之外，登录/退出也是后端路由：不代理的话 Vite 会用 SPA 兜底返回
      // index.html，前端路由没有 /login，又跳回 /bots → 401 → /login 死循环。
      "/api": "http://127.0.0.1:8787",
      "/login": "http://127.0.0.1:8787",
      "/logout": "http://127.0.0.1:8787",
    },
  },
});
