import type { ToolDefinition } from "../registry.js";
import { editFileTool } from "./edit_file.js";
import { grepTool } from "./grep.js";
import { listDirTool } from "./list_dir.js";
import { readFileTool } from "./read_file.js";
import { readSkillTool } from "./read_skill.js";
import { runShellTool } from "./run_shell.js";
import { webFetchTool } from "./web_fetch.js";
import { writeFileTool } from "./write_file.js";

/** 内置工具全集。顺序即系统提示里的工具顺序（稳定，便于缓存）。 */
export function createBuiltinTools(): ToolDefinition[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    grepTool,
    runShellTool,
    webFetchTool,
    readSkillTool,
  ];
}
