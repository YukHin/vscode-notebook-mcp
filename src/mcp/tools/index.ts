import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNotebookTools } from "./notebooks.js";
import { registerCellTools } from "./cells.js";
import { registerKernelTools } from "./kernel.js";
import { registerWorkflowTools } from "./workflow.js";

export function registerAllTools(server: McpServer): void {
  registerNotebookTools(server);
  registerCellTools(server);
  registerKernelTools(server);
  registerWorkflowTools(server);
}
