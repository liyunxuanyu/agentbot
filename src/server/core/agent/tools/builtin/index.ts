import type { ToolDefinition } from "../registry.js";
import { createCreateBotTool, type CreateBotHandler } from "./create_bot.js";
import { editFileTool } from "./edit_file.js";
import { grepTool } from "./grep.js";
import { listDirTool } from "./list_dir.js";
import { readFileTool } from "./read_file.js";
import { readSkillTool } from "./read_skill.js";
import { runShellTool } from "./run_shell.js";
import { webFetchTool } from "./web_fetch.js";
import { writeFileTool } from "./write_file.js";

export type { CreateBotHandler, CreateBotRequest, CreateBotResult } from "./create_bot.js";

export interface BuiltinToolsOptions {
  /**
   * 管理员 `create_bot` 的实现（装配层注入）。不传时工具不存在 ——
   * 普通 Bot 的模型根本看不到它（M3）。
   */
  createBot?: CreateBotHandler;
}

/** 内置工具全集。顺序即系统提示里的工具顺序（稳定，便于缓存）。 */
export function createBuiltinTools(opts: BuiltinToolsOptions = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    grepTool,
    runShellTool,
    webFetchTool,
    readSkillTool,
  ];
  // 管理工具放最后：普通 Bot 的列表与历史完全一致，缓存不因角色变化而整体失效
  if (opts.createBot) tools.push(createCreateBotTool(opts.createBot));
  return tools;
}
