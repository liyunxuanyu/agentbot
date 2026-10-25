import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import type { AdapterDeclaration } from "./contract.js";

/**
 * 可执行文件解析（仅 Windows 需要，但逻辑放在这里统一）。
 *
 * 为什么需要它：npm 全局安装的 CLI 在 Windows 上只有 `.cmd` 外壳，
 * `spawn("codex", args, { shell: false })` 会直接 ENOENT/EINVAL。
 * 而架构 §8 又禁止 `shell: true`（参数里的用户文本会被 cmd 解释成命令）。
 *
 * 解法：把 `.cmd` 外壳**静态解析**成它真正启动的目标：
 *   - `"%dp0%\node_modules\@openai\codex\bin\codex.js"` → `node <js>`（不再经过 cmd）
 *   - `"%dp0%\node_modules\...\claude.exe"`          → 直接起 exe
 *   - 解析不出来（用户自己写的 .cmd）→ 退回 cmd.exe，并在 note 里明示风险
 *
 * 另一件事：运行时不在 PATH 时（例如 ZCode 只以桌面应用形式安装），
 * 允许用环境变量 `AGENTBOT_BIN_<ID>` 指定可执行文件路径。
 * 这是安装位置的差异，不是产品配置项，所以走环境变量而不是声明字段。
 */

export type LaunchVia = "direct" | "shim" | "node" | "cmd";

export interface ResolvedLaunch {
  command: string;
  args: string[];
  via: LaunchVia;
  /** 非空表示发生了降级或需要用户知道的解析结果。 */
  note?: string;
}

const WIN = process.platform === "win32";

/** `AGENTBOT_BIN_GEMINI_CLI` 之类：声明 id 大写、非字母数字换下划线。 */
export function envBinOverride(id: string): string | undefined {
  const key = `AGENTBOT_BIN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const value = process.env[key];
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

/** 在 PATH 里找可执行文件；Windows 下按 PATHEXT 逐个后缀试。找不到返回 null。 */
export function resolveCommand(command: string): string | null {
  if (command.length === 0) return null;

  const looksLikePath = isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (looksLikePath) return isFile(command) ? command : null;

  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.length > 0);
  const exts = WIN
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0)
    : [""];

  for (const dir of dirs) {
    if (!WIN) {
      const direct = join(dir, command);
      if (isFile(direct)) return direct;
      continue;
    }
    // Windows 上 npm 会同时生成 `codex`（sh 脚本）与 `codex.cmd`。
    // 必须**先**按 PATHEXT 找（.cmd/.exe），否则会拿到那个 sh 脚本 ——
    // 它不可执行，spawn 会 ENOENT（实测踩到）。
    for (const ext of exts) {
      for (const name of [`${command}${ext}`, `${command}${ext.toUpperCase()}`]) {
        const candidate = join(dir, name);
        if (isFile(candidate)) return candidate;
      }
    }
    // 兜底：无扩展名的可执行文件（如 .NET 的 apphost）
    const direct = join(dir, command);
    if (isFile(direct)) return direct;
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析 npm 生成的 `.cmd` 外壳，拿到它真正要启动的东西。
 * 只认两种形态（覆盖 npm/pnpm/yarn 的 shim）：
 *   ① `"%dp0%\<相对路径>.js|cjs|mjs"` → 用当前 node 跑
 *   ② `"%dp0%\<相对路径>.exe"`        → 直接起
 */
function parseCmdShim(path: string): { command: string; args: string[] } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(path);

  const js = /"[^"]*%dp0%\\([^"]+\.(?:cjs|mjs|js))"/i.exec(text);
  const script = js?.[1];
  if (script) return { command: process.execPath, args: [join(dir, script)] };

  const exe = /"[^"]*%dp0%\\([^"]+\.exe)"/i.exec(text);
  const binary = exe?.[1];
  if (binary) return { command: join(dir, binary), args: [] };

  return null;
}

/**
 * 把「声明里的命令 + 参数」解析成真正可 spawn 的形式。
 * 解析失败也原样返回：让 spawn 报 ENOENT，错误信息里带原始命令名更可读。
 */
export function resolveLaunch(command: string, args: string[]): ResolvedLaunch {
  const resolved = resolveCommand(command);
  if (!resolved) {
    return { command, args, via: "direct", note: `命令不在 PATH：${command}` };
  }

  const ext = extname(resolved).toLowerCase();

  if (WIN && (ext === ".cmd" || ext === ".bat")) {
    const shim = parseCmdShim(resolved);
    if (shim) {
      return { command: shim.command, args: [...shim.args, ...args], via: "shim" };
    }
    return {
      command: process.env["ComSpec"] ?? "cmd.exe",
      args: ["/d", "/s", "/c", resolved, ...args],
      via: "cmd",
      note: `无法解析 ${ext} 外壳，退回 cmd.exe；参数中若含 shell 元字符可能被解释`,
    };
  }

  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    // 直接指定脚本（例如 ZCode 内置 CLI）：用当前 node 跑，避免依赖 shebang
    return { command: process.execPath, args: [resolved, ...args], via: "node" };
  }

  return { command: resolved, args, via: "direct" };
}

/** 生效的启动命令：环境变量覆盖优先于声明。 */
export function effectiveLaunch(decl: AdapterDeclaration): ResolvedLaunch {
  const override = envBinOverride(decl.id);
  return resolveLaunch(override ?? decl.launch.command, decl.launch.args);
}

/** 生效的探测命令：与启动命令共用同一个覆盖变量，避免两处指向不同二进制。 */
export function effectiveDetectCommand(decl: AdapterDeclaration): string {
  return envBinOverride(decl.id) ?? decl.detect.command ?? decl.launch.command;
}

/** 生效的启动命令名（未解析成绝对路径）。 */
export function effectiveLaunchCommand(decl: AdapterDeclaration): string {
  return envBinOverride(decl.id) ?? decl.launch.command;
}
