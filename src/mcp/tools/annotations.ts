import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations, so clients can tell reads from writes and decide what
 * to auto-approve. They are hints only; enforcement is the client's job.
 */

/** Reads notebook or kernel state; changes nothing. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
};

/** Changes the editor's notebook in an undoable way, or saves it. */
export const EDITS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
};

/** Removes cells, outputs or kernel state. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false
};

/** Executes user code in the kernel, which can do anything the code does. */
export const RUNS_CODE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true
};
