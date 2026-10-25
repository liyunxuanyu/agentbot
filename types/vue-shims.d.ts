/**
 * 裸 `tsc` 的 `.vue` 声明（vue-tsc 不用它）。
 *
 * 为什么需要：`tsc --noEmit` 不认 `.vue` 文件，会把 `import X from './App.vue'`
 * 判成 TS2307。仓库的完整类型检查是 `vue-tsc --noEmit`（它读真实 .vue 并检查
 * props/emits），但验收要求「`npx tsc --noEmit` 也通过」，所以这里给裸 tsc
 * 一个最小声明。
 *
 * 放在 `types/` 而不是 `src/web/`：前端目录归前端所有，后端不该往里加文件。
 * 不削弱检查：vue-tsc 优先解析真实 `.vue` 文件，ambient 声明只对裸 tsc 生效。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
