import { copyFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  // 产物名固定为 server.js：验收命令 `node dist/server.js` 与 npm start 都按它找
  entry: { server: "src/server/main.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  // 不能 clean：dist/web 是前端构建产物，先 build:web 再 build:server
  clean: false,
  sourcemap: true,
  // 原生模块与 yaml 声明文件不能打包
  external: ["better-sqlite3"],
  noExternal: ["yaml", "zod"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  /**
   * schema.sql 与 adapter 声明是运行时读取的资源，不参与打包。
   * 复制到 dist/ 后，`node dist/server.js` 从任意 cwd 启动都能找到它们。
   */
  onSuccess: async () => {
    mkdirSync("dist", { recursive: true });
    copyFileSync("src/server/core/db/schema.sql", "dist/schema.sql");
    const declarations = "src/server/adapters/declarations";
    if (existsSync(declarations)) {
      cpSync(declarations, "dist/declarations", { recursive: true });
    }
    // 内置技能包（N2）也是运行时读取的资源
    const builtinSkills = "src/server/core/agent/skills/builtin";
    if (existsSync(builtinSkills)) {
      cpSync(builtinSkills, "dist/skills/builtin", { recursive: true });
    }
  },
});
