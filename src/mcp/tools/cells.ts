import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema,
  CellTargetSchema,
  TimeoutSchema,
  OutputBudgetSchema
} from "../../schemas/index.js";
import {
  parseOutputs,
  formatOutputsAsMarkdown,
  fenced,
  CellOutput,
  OutputBudget
} from "../../utils/output.js";
import {
  resolveNotebook,
  resolveCell,
  cellIdOf,
  insertCells,
  deleteCells,
  generateCellId,
  runCellAndWait,
  isCellExecuting,
  forgetRuns,
  findReplaceRanges,
  applyCellTextEdits,
  CellTextEdit,
  saveNotebook
} from "../../utils/notebook.js";
import { READ_ONLY, EDITS, DESTRUCTIVE, RUNS_CODE } from "./annotations.js";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const TextResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }] });

const ErrorResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], isError: true });

function ResultWithImages(text: string, outputs: CellOutput[]) {
  const content: ContentBlock[] = [{ type: "text", text }];
  for (const o of outputs) {
    if (o.type === "image") {
      content.push({ type: "image", data: o.data, mimeType: o.mimeType });
    }
  }
  return { content };
}

const kindOf = (cell: vscode.NotebookCell) =>
  cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown";

const budgetOf = (args: { max_output_chars: number; max_images: number }): OutputBudget => ({
  maxChars: args.max_output_chars,
  maxImages: args.max_images
});

const ListCellsInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const CellTargetInput = {
  ...CellTargetSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const CellOutputInput = {
  ...CellTargetInput,
  ...OutputBudgetSchema
};

const RunCellInput = {
  ...CellTargetInput,
  timeout_seconds: TimeoutSchema,
  ...OutputBudgetSchema
};

const InsertCellInput = {
  content: z.string().describe("Cell content (code or markdown source)"),
  type: z.enum(["code", "markdown"]).default("code").describe("Cell type"),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Position to insert at. Defaults to appending at the end."),
  language: z
    .string()
    .default("python")
    .describe("Language identifier for code cells"),
  execute: z
    .boolean()
    .default(false)
    .describe("Execute the cell immediately after inserting (code cells only)"),
  timeout_seconds: TimeoutSchema,
  ...OutputBudgetSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const EditCellInput = {
  ...CellTargetSchema,
  content: z.string().describe("New cell content (replaces existing)"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const ReplaceSpecShape = {
  old_string: z
    .string()
    .describe("Exact text to replace, including whitespace and indentation. Must occur exactly once unless replace_all is true."),
  new_string: z.string().describe("Text to put in its place"),
  replace_all: z
    .boolean()
    .default(false)
    .describe("Replace every occurrence instead of requiring a unique match")
};

const ReplaceInCellInput = {
  ...CellTargetSchema,
  ...ReplaceSpecShape,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const ApplyEditsInput = {
  edits: z
    .array(
      z.object({
        ...CellTargetSchema,
        old_string: ReplaceSpecShape.old_string.optional(),
        new_string: ReplaceSpecShape.new_string.optional(),
        replace_all: ReplaceSpecShape.replace_all,
        content: z
          .string()
          .optional()
          .describe("Replace the whole cell with this. Use instead of old_string/new_string.")
      })
    )
    .min(1)
    .describe(
      "Edits to apply together. Each targets a cell by cell_id (or index) and gives either old_string + new_string or content. Indexes and matches refer to the notebook as it is before any of these edits."
    ),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const NotebookOnlyInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

/** Lines (1-based) touched by a set of ranges, for confirmation messages. */
function touchedLines(ranges: vscode.Range[]): string {
  const lines = [...new Set(ranges.map((r) => r.start.line + 1))].sort((a, b) => a - b);
  return lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(", ")}`;
}

/**
 * Run (or wait for) a cell and build the tool result. Shared by run, wait and
 * insert-with-execute so they report the same shape.
 */
async function runAndDescribe(
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

type RunDescription = Awaited<ReturnType<typeof runAndDescribe>>;

function describeRunMarkdown(r: RunDescription, timeoutSeconds: number): string[] {
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

export function registerCellTools(server: McpServer): void {
  server.tool(
    "notebook_list_cells",
    "List cells in a notebook with stable id, index, kind, language, line count, content preview, and execution state. Use the ids to target cells in other tools.",
    ListCellsInput,
    READ_ONLY,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const cells = access.notebook!.getCells().map((cell, index) => ({
        id: cellIdOf(cell),
        index,
        kind: kindOf(cell),
        language: cell.document.languageId,
        lineCount: cell.document.lineCount,
        preview: cell.document
          .getText()
          .substring(0, 100)
          .replace(/\n/g, "↵"),
        hasOutput: cell.outputs.length > 0,
        executionOrder: cell.executionSummary?.executionOrder ?? null,
        running: isCellExecuting(cell)
      }));

      if (response_format === "json") {
        return TextResult(JSON.stringify({ total: cells.length, cells }, null, 2));
      }

      const lines = [`# Notebook Cells (${cells.length} total)`, ""];
      for (const cell of cells) {
        const exec = cell.running ? " [*]" : cell.executionOrder ? ` [${cell.executionOrder}]` : "";
        const out = cell.hasOutput ? " 📊" : "";
        lines.push(
          `## Cell ${cell.index}${exec}${out} (${cell.kind}/${cell.language}) id: \`${cell.id}\``
        );
        lines.push(...fenced(cell.preview + (cell.lineCount > 3 ? "..." : "")), "");
      }
      return TextResult(lines.join("\n"));
    }
  );

  server.tool(
    "notebook_get_cell_content",
    "Get the full source of a cell.",
    CellTargetInput,
    READ_ONLY,
    async ({ cell_id, index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const found = resolveCell(access.notebook!, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const cell = found.cell;
      const output = {
        id: cellIdOf(cell),
        index: cell.index,
        kind: kindOf(cell),
        language: cell.document.languageId,
        content: cell.document.getText()
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(output, null, 2));
      }
      return TextResult(
        [
          `# Cell ${output.index} (${output.kind}/${output.language}) id: \`${output.id}\``,
          "",
          ...fenced(output.content, output.language)
        ].join("\n")
      );
    }
  );

  server.tool(
    "notebook_get_cell_output",
    "Get the current outputs of a cell without running it (text, errors, images). Text is trimmed to max_output_chars, keeping the start and end.",
    CellOutputInput,
    READ_ONLY,
    async ({ cell_id, index, notebook_uri, response_format, ...budget }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const found = resolveCell(access.notebook!, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const cell = found.cell;
      const outputs = await parseOutputs(cell.outputs, budgetOf(budget));
      const result = {
        id: cellIdOf(cell),
        index: cell.index,
        hasOutput: outputs.length > 0,
        running: isCellExecuting(cell),
        executionOrder: cell.executionSummary?.executionOrder ?? null,
        outputs
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      if (outputs.length === 0) {
        return TextResult(`# Cell ${result.index} Output\n\nNo output available.`);
      }
      return ResultWithImages(
        [
          `# Cell ${result.index} Output`,
          result.running ? "Still running; outputs so far:" : result.executionOrder ? `Execution #${result.executionOrder}` : "",
          "",
          formatOutputsAsMarkdown(outputs)
        ].join("\n"),
        outputs
      );
    }
  );

  server.tool(
    "notebook_insert_cell",
    "Insert a new cell (code or markdown) and return its id. Optionally execute it immediately in the notebook's kernel.",
    InsertCellInput,
    RUNS_CODE,
    async ({ content, type, index, language, execute, timeout_seconds, notebook_uri, response_format, ...budget }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      const cellId = generateCellId();
      const kind =
        type === "code"
          ? vscode.NotebookCellKind.Code
          : vscode.NotebookCellKind.Markup;
      const cellData = new vscode.NotebookCellData(
        kind,
        content,
        type === "code" ? language : "markdown"
      );
      cellData.metadata = { id: cellId };

      const insertIndex =
        index !== undefined ? Math.min(index, notebook.cellCount) : notebook.cellCount;
      await insertCells(notebook.uri, insertIndex, [cellData]);

      const inserted = notebook.getCells().find((c) => c.metadata?.id === cellId);
      if (!inserted) return ErrorResult("Error: failed to locate inserted cell.");

      const cellIndex = inserted.index;

      if (access.editor) {
        access.editor.revealRange(
          new vscode.NotebookRange(cellIndex, cellIndex + 1),
          vscode.NotebookEditorRevealType.InCenter
        );
      }

      let execution: (RunDescription & { error?: string }) | null = null;
      if (execute && type === "code") {
        try {
          execution = await runAndDescribe(notebook, inserted, {
            execute: true,
            timeoutSeconds: timeout_seconds,
            budget: budgetOf(budget)
          });
        } catch (err) {
          execution = {
            cellId,
            cellIndex: inserted.index,
            status: "finished",
            success: false,
            executionOrder: null,
            outputs: [],
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }

      const result = {
        cellId,
        cellIndex,
        type,
        language: type === "code" ? language : "markdown",
        executed: !!execute && type === "code",
        execution
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }

      const lines = [
        `# Cell Inserted`,
        "",
        `**Index**: ${cellIndex}`,
        `**Id**: \`${cellId}\``,
        `**Type**: ${type}/${result.language}`
      ];
      if (execution) {
        lines.push("");
        if (execution.error) {
          lines.push(`**Execution**: Failed - ${execution.error}`);
        } else {
          lines.push(...describeRunMarkdown(execution, timeout_seconds));
        }
      }
      return ResultWithImages(lines.join("\n"), execution?.outputs ?? []);
    }
  );

  server.tool(
    "notebook_edit_cell",
    "Replace the whole contents of an existing cell. To change part of a cell, use notebook_replace_in_cell instead. The change stays in the editor (undoable) until notebook_save.",
    EditCellInput,
    EDITS,
    async ({ cell_id, index, content, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const found = resolveCell(access.notebook!, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const cell = found.cell;
      if (!(await applyCellTextEdits([{ cell, kind: "set", content }]))) {
        return ErrorResult("Error: VS Code rejected the edit.");
      }

      if (response_format === "json") {
        return TextResult(
          JSON.stringify({ id: cellIdOf(cell), index: cell.index, updated: true }, null, 2)
        );
      }
      return TextResult(`Updated cell ${cell.index} (id \`${cellIdOf(cell)}\`)`);
    }
  );

  server.tool(
    "notebook_replace_in_cell",
    "Replace one exact piece of text inside a cell and leave the rest of the cell untouched, like a find-and-replace. old_string must match exactly (including indentation) and be unique in the cell unless replace_all is true. The change stays in the editor (undoable) until notebook_save; the kernel is not affected until the cell is run.",
    ReplaceInCellInput,
    EDITS,
    async ({ cell_id, index, old_string, new_string, replace_all, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const found = resolveCell(access.notebook!, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const cell = found.cell;
      const match = findReplaceRanges(cell, { old_string, new_string, replace_all });
      if (!match.ranges) return ErrorResult(`Error: ${match.error}`);

      const where = touchedLines(match.ranges);
      if (!(await applyCellTextEdits([{ cell, kind: "replace", ranges: match.ranges, new_string }]))) {
        return ErrorResult("Error: VS Code rejected the edit.");
      }

      const result = {
        id: cellIdOf(cell),
        index: cell.index,
        replacements: match.ranges.length,
        at: where
      };
      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      return TextResult(
        `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in cell ${result.index} (id \`${result.id}\`) at ${where}.`
      );
    }
  );

  server.tool(
    "notebook_apply_edits",
    "Apply several text edits across one or more cells at once. Every edit is checked first; if any fails (text not found, ambiguous match, unknown cell, overlapping edits) nothing is changed. Use this instead of many separate calls when changing several places.",
    ApplyEditsInput,
    EDITS,
    async ({ edits, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      const planned: CellTextEdit[] = [];
      const problems: string[] = [];
      // Ranges already claimed per cell, to reject overlapping edits up front
      // instead of letting VS Code fail the whole WorkspaceEdit.
      const claimed = new Map<vscode.NotebookCell, vscode.Range[] | "whole">();

      edits.forEach((e, n) => {
        const label = `Edit ${n + 1}`;
        const found = resolveCell(notebook, { cell_id: e.cell_id, index: e.index });
        if (!found.cell) {
          problems.push(`${label}: ${found.error}`);
          return;
        }
        const cell = found.cell;
        const hasReplace = e.old_string !== undefined || e.new_string !== undefined;
        if (hasReplace === (e.content !== undefined)) {
          problems.push(`${label}: give either content, or old_string and new_string.`);
          return;
        }
        const prior = claimed.get(cell);

        if (e.content !== undefined) {
          if (prior) {
            problems.push(`${label}: cell ${cell.index} is already edited by another edit in this batch.`);
            return;
          }
          claimed.set(cell, "whole");
          planned.push({ cell, kind: "set", content: e.content });
          return;
        }

        if (e.old_string === undefined || e.new_string === undefined) {
          problems.push(`${label}: old_string and new_string must both be given.`);
          return;
        }
        const match = findReplaceRanges(cell, {
          old_string: e.old_string,
          new_string: e.new_string,
          replace_all: e.replace_all
        });
        if (!match.ranges) {
          problems.push(`${label}: ${match.error}`);
          return;
        }
        if (prior === "whole" || (prior && match.ranges.some((r) => prior.some((p) => !!p.intersection(r))))) {
          problems.push(`${label}: overlaps another edit to cell ${cell.index} in this batch.`);
          return;
        }
        claimed.set(cell, [...(prior ?? []), ...match.ranges]);
        planned.push({ cell, kind: "replace", ranges: match.ranges, new_string: e.new_string });
      });

      if (problems.length > 0) {
        return ErrorResult(`Error: no edits were applied.\n- ${problems.join("\n- ")}`);
      }
      if (!(await applyCellTextEdits(planned))) {
        return ErrorResult("Error: VS Code rejected the edits; nothing was changed.");
      }

      const cells = [...new Set(planned.map((p) => p.cell))].map((c) => ({
        id: cellIdOf(c),
        index: c.index
      }));
      if (response_format === "json") {
        return TextResult(JSON.stringify({ applied: planned.length, cells }, null, 2));
      }
      return TextResult(
        `Applied ${planned.length} edit${planned.length === 1 ? "" : "s"} to ${cells.length} cell${cells.length === 1 ? "" : "s"}: ${cells.map((c) => `${c.index} (\`${c.id}\`)`).join(", ")}.`
      );
    }
  );

  server.tool(
    "notebook_delete_cell",
    "Delete a cell.",
    CellTargetInput,
    DESTRUCTIVE,
    async ({ cell_id, index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;
      const found = resolveCell(notebook, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const deletedIndex = found.cell.index;
      await deleteCells(notebook.uri, deletedIndex, 1);

      if (response_format === "json") {
        return TextResult(
          JSON.stringify(
            { deletedIndex, newCellCount: notebook.cellCount },
            null,
            2
          )
        );
      }
      return TextResult(
        `Deleted cell ${deletedIndex}. New cell count: ${notebook.cellCount}`
      );
    }
  );

  server.tool(
    "notebook_run_cell",
    "Execute a code cell in the notebook's kernel and return the outputs of this run. Waits up to timeout_seconds; a longer run is reported as status 'running' with the outputs so far and keeps going. If the cell is already running, waits for that run instead. The cell and its output persist in the notebook.",
    RunCellInput,
    RUNS_CODE,
    async ({ cell_id, index, timeout_seconds, notebook_uri, response_format, ...budget }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;
      const found = resolveCell(notebook, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const cell = found.cell;
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        return ErrorResult(
          `Error: Cell ${cell.index} is markdown. Only code cells can be executed.`
        );
      }

      if (access.editor) {
        access.editor.revealRange(
          new vscode.NotebookRange(cell.index, cell.index + 1),
          vscode.NotebookEditorRevealType.InCenter
        );
      }

      let result: RunDescription;
      try {
        result = await runAndDescribe(notebook, cell, {
          execute: true,
          timeoutSeconds: timeout_seconds,
          budget: budgetOf(budget)
        });
      } catch (err) {
        return ErrorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [
        `# Cell ${result.cellIndex} Execution Result`,
        "",
        ...describeRunMarkdown(result, timeout_seconds)
      ];
      return ResultWithImages(lines.join("\n"), result.outputs);
    }
  );

  server.tool(
    "notebook_wait_cell",
    "Wait for a cell that is already running (for example one that notebook_run_cell reported as 'running') and return its outputs. Does not start a run; if the cell is not running, returns its current outputs at once.",
    RunCellInput,
    READ_ONLY,
    async ({ cell_id, index, timeout_seconds, notebook_uri, response_format, ...budget }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const found = resolveCell(access.notebook!, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      let result: RunDescription;
      try {
        result = await runAndDescribe(access.notebook!, found.cell, {
          execute: false,
          timeoutSeconds: timeout_seconds,
          budget: budgetOf(budget)
        });
      } catch (err) {
        return ErrorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [
        `# Cell ${result.cellIndex}`,
        "",
        ...describeRunMarkdown(result, timeout_seconds)
      ];
      return ResultWithImages(lines.join("\n"), result.outputs);
    }
  );

  server.tool(
    "notebook_interrupt_kernel",
    "Stop the code that is currently running in the notebook (like pressing the stop button), and cancel cells waiting to run. Kernel state (variables) is kept, unlike notebook_restart_kernel.",
    NotebookOnlyInput,
    DESTRUCTIVE,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      const running = notebook.getCells().filter(isCellExecuting);
      // Interrupt the kernel (stops the running cell, keeps state), then
      // cancel whatever is still queued behind it. Jupyter's command resolves
      // only once the kernel has handled the interrupt, which for code that
      // ignores it (time.sleep on Windows, some C extensions) is when that
      // code returns, so don't wait on it past our own deadline.
      const deadline = Date.now() + 10_000;
      const interrupted = Promise.resolve(
        vscode.commands.executeCommand("jupyter.interruptkernel", {
          notebookEditor: { notebookUri: notebook.uri }
        })
      ).then(undefined, () => {
        // not a Jupyter kernel, or Jupyter unavailable: cancelExecution below
      });
      await Promise.race([interrupted, new Promise((r) => setTimeout(r, 2_000))]);
      await vscode.commands.executeCommand("notebook.cell.cancelExecution", {
        ranges: [{ start: 0, end: notebook.cellCount }],
        document: notebook.uri
      });

      // The kernel acknowledges the interrupt asynchronously; give it a moment
      // so the reply reflects whether the cells actually stopped.
      while (running.some(isCellExecuting) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const stillRunning = running.filter(isCellExecuting);
      if (stillRunning.length === 0) forgetRuns(notebook);
      const result = {
        interrupted: running.map((c) => ({ id: cellIdOf(c), index: c.index })),
        stillRunning: stillRunning.map((c) => ({ id: cellIdOf(c), index: c.index }))
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      if (running.length === 0) {
        return TextResult("Nothing was running. Sent an interrupt anyway to cancel any queued cells.");
      }
      return TextResult(
        stillRunning.length === 0
          ? `Interrupted cell${running.length === 1 ? "" : "s"} ${running.map((c) => c.index).join(", ")}.`
          : `Sent an interrupt, but cell${stillRunning.length === 1 ? "" : "s"} ${stillRunning.map((c) => c.index).join(", ")} ${stillRunning.length === 1 ? "is" : "are"} still running after 10 s. The code may be ignoring interrupts (on Windows, time.sleep and some C extensions only stop when they return); wait with notebook_wait_cell, or use notebook_restart_kernel, which stops it but clears all variables.`
      );
    }
  );

  server.tool(
    "notebook_clear_cell_output",
    "Clear the outputs of a single cell.",
    CellTargetInput,
    DESTRUCTIVE,
    async ({ cell_id, index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;
      const found = resolveCell(notebook, { cell_id, index });
      if (!found.cell) return ErrorResult(`Error: ${found.error}`);

      const at = found.cell.index;
      await vscode.commands.executeCommand("notebook.cell.clearOutputs", {
        ranges: [{ start: at, end: at + 1 }],
        document: notebook.uri
      });

      if (response_format === "json") {
        return TextResult(JSON.stringify({ index: at, cleared: true }, null, 2));
      }
      return TextResult(`Cleared outputs for cell ${at}`);
    }
  );

  server.tool(
    "notebook_clear_all_outputs",
    "Clear outputs from every cell in the notebook.",
    NotebookOnlyInput,
    DESTRUCTIVE,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      const ranges = [{ start: 0, end: notebook.cellCount }];
      await vscode.commands.executeCommand("notebook.cell.clearOutputs", {
        ranges,
        document: notebook.uri
      });

      if (response_format === "json") {
        return TextResult(
          JSON.stringify(
            { cleared: true, cellCount: notebook.cellCount },
            null,
            2
          )
        );
      }
      return TextResult(
        `Cleared outputs from all ${notebook.cellCount} cells`
      );
    }
  );

  server.tool(
    "notebook_save",
    "Save the notebook's in-editor state (sources and outputs) to its .ipynb file. Call this when a set of edits is done, or before anything reads the file from disk.",
    NotebookOnlyInput,
    EDITS,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (notebook.isUntitled) {
        return ErrorResult(
          "Error: this notebook has never been saved. Ask the user to save it once in VS Code to choose a file name."
        );
      }
      const wasDirty = notebook.isDirty;
      const saved = await saveNotebook(notebook);
      if (!saved) {
        return ErrorResult(`Error: VS Code could not save ${notebook.uri.fsPath}.`);
      }

      const result = { saved: true, hadUnsavedChanges: wasDirty, path: notebook.uri.fsPath };
      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      return TextResult(
        wasDirty ? `Saved ${result.path}` : `No unsaved changes in ${result.path}`
      );
    }
  );
}
