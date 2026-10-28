import * as vscode from "vscode";
import {
  parseOutputs,
  formatOutputsAsMarkdown,
  CellOutput,
  OutputBudget
} from "../../utils/output.js";
import { cellIdOf, runCellAndWait } from "../../utils/notebook.js";

// Result helpers and the run-and-report logic shared by the cell, workflow
// and kernel tools.

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export const TextResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }] });

export const ErrorResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], isError: true });

export function ResultWithImages(text: string, outputs: CellOutput[]) {
  const content: ContentBlock[] = [{ type: "text", text }];
  for (const o of outputs) {
    if (o.type === "image") {
      content.push({ type: "image", data: o.data, mimeType: o.mimeType });
    }
  }
  return { content };
}

export const kindOf = (cell: vscode.NotebookCell) =>
  cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown";

export const budgetOf = (args: { max_output_chars: number; max_images: number }): OutputBudget => ({
  maxChars: args.max_output_chars,
  maxImages: args.max_images
});

/**
 * Run (or wait for) a cell and build the tool result. Shared by run, wait,
 * run-cells and insert-with-execute so they report the same shape.
 */
export async function runAndDescribe(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  opts: { execute: boolean; timeoutSeconds: number; budget: OutputBudget }
) {
  const { finished } = await runCellAndWait(notebook, cell, {
    execute: opts.execute,
    timeoutMs: opts.timeoutSeconds * 1000
  });
  const summary = cell.executionSummary;
  return {
    cellId: cellIdOf(cell),
    cellIndex: cell.index,
    status: finished ? ("finished" as const) : ("running" as const),
    success: finished ? (summary?.success ?? false) : null,
    executionOrder: summary?.executionOrder ?? null,
    outputs: await parseOutputs(cell.outputs, opts.budget)
  };
}

export type RunDescription = Awaited<ReturnType<typeof runAndDescribe>>;

export function describeRunMarkdown(r: RunDescription, timeoutSeconds: number): string[] {
  const lines: string[] = [];
  if (r.status === "running") {
    lines.push(
      `**Status**: Still running after ${timeoutSeconds} s (cell id \`${r.cellId}\`). Outputs so far are below. Call notebook_wait_cell to keep waiting, or notebook_interrupt_kernel to stop it.`
    );
  } else {
    lines.push(
      `**Status**: ${r.success ? "Success" : "Failed"}${r.executionOrder ? ` (execution #${r.executionOrder})` : ""}`
    );
  }
  if (r.outputs.length > 0) {
    lines.push("", "## Output", formatOutputsAsMarkdown(r.outputs));
  } else {
    lines.push("", "No output.");
  }
  return lines;
}
