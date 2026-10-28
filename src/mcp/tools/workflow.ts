import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema,
  OutputBudgetSchema
} from "../../schemas/index.js";
import {
  resolveNotebook,
  resolveCell,
  cellIdOf,
  isCellExecuting
} from "../../utils/notebook.js";
import { notebookRunStates } from "../../utils/staleness.js";
import { getKernel } from "../../utils/jupyter.js";
import {
  parseOutputs,
  formatOutputsAsMarkdown,
  fenced,
  stripAnsi
} from "../../utils/output.js";
import {
  TextResult,
  ErrorResult,
  ResultWithImages,
  runAndDescribe,
  RunDescription
} from "./common.js";
import { READ_ONLY, RUNS_CODE } from "./annotations.js";

const preview = (cell: vscode.NotebookCell) =>
  cell.document.getText().substring(0, 80).replace(/\n/g, "↵");

const StatusInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const RunCellsInput = {
  mode: z
    .enum(["range", "stale", "all"])
    .default("range")
    .describe(
      "'range': code cells from start to end (inclusive). 'stale': from the first cell that is edited or not run in this kernel through the end of the notebook — what's needed to bring the kernel in line with the code on screen. 'all': every code cell."
    ),
  start_cell_id: z.string().optional().describe("First cell of the range (default: first cell)"),
  start_index: z.number().int().min(0).optional(),
  end_cell_id: z.string().optional().describe("Last cell of the range, inclusive (default: last cell)"),
  end_index: z.number().int().min(0).optional(),
  stop_on_error: z
    .boolean()
    .default(true)
    .describe("Stop at the first cell that fails (later cells usually depend on it)"),
  timeout_seconds: z
    .number()
    .positive()
    .max(24 * 60 * 60)
    .default(300)
    .describe("Total seconds for the whole batch. If time runs out, the current cell keeps running and the rest are not started."),
  outputs: z
    .enum(["failed_and_last", "all", "none"])
    .default("failed_and_last")
    .describe("Which cells' outputs to return. The default keeps the reply small: the failing cell (if any) and the last cell run."),
  ...OutputBudgetSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const InspectInput = {
  names: z
    .array(z.string())
    .optional()
    .describe("Variables to describe in detail, with a value preview. Omit to list all user variables (no previews except for short scalars and strings)."),
  include_callables: z
    .boolean()
    .default(false)
    .describe("Also list functions, classes and modules"),
  max_preview_chars: z.number().int().min(20).max(5000).default(300),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

// Runs inside the kernel. Everything lives in a function that deletes itself,
// so nothing is added to the user's namespace; executeCode doesn't touch the
// execution count or history either.
const INSPECT_SCRIPT = `
def __nbmcp_inspect(names, include_callables, max_chars):
    import json, types
    ip = get_ipython()
    ns = ip.user_ns
    hidden = getattr(ip, "user_ns_hidden", {})
    skip = {"In", "Out", "exit", "quit", "get_ipython"}
    scalar = (int, float, complex, bool, str, bytes, type(None))
    def describe(name, value, detailed):
        t = type(value)
        d = {"name": name, "type": (t.__module__ + "." if t.__module__ not in ("builtins",) else "") + t.__qualname__}
        try:
            shape = getattr(value, "shape", None)
            if shape is not None and not callable(shape):
                d["shape"] = list(shape) if hasattr(shape, "__iter__") else str(shape)
        except Exception:
            pass
        try:
            dtype = getattr(value, "dtype", None)
            if dtype is not None and not isinstance(value, type):
                d["dtype"] = str(dtype)
        except Exception:
            pass
        if "shape" not in d:
            try:
                if not isinstance(value, (str, bytes, type)):
                    d["len"] = len(value)
            except Exception:
                pass
        try:
            cols = getattr(value, "columns", None)
            if cols is not None and not isinstance(value, type):
                d["columns"] = [str(c) for c in list(cols)[:30]]
        except Exception:
            pass
        if detailed or isinstance(value, scalar):
            try:
                r = repr(value)
                d["preview"] = r if len(r) <= max_chars else r[: max_chars] + "…"
            except Exception as e:
                d["preview"] = "<repr failed: %s>" % type(e).__name__
        return d
    out = {"variables": [], "missing": []}
    if names:
        for n in names:
            if n in ns:
                out["variables"].append(describe(n, ns[n], True))
            else:
                out["missing"].append(n)
    else:
        for n, v in list(ns.items()):
            if n.startswith("_") or n in skip or (n in hidden and hidden[n] is v):
                continue
            if not include_callables and isinstance(v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
                continue
            out["variables"].append(describe(n, v, False))
    print("__NBMCP__" + json.dumps(out, default=str))
`;

export function registerWorkflowTools(server: McpServer): void {
  server.tool(
    "notebook_status",
    "Show whether the kernel's state matches the code on screen: which code cells were edited since they ran, which haven't run in this kernel (outputs from disk or before a restart), which ran after such a cell, which are running, and whether there are unsaved changes. Check this before trusting outputs or variables, and use notebook_run_cells with mode 'stale' to bring the kernel up to date.",
    StatusInput,
    READ_ONLY,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      const { states, firstStaleIndex } = notebookRunStates(notebook, isCellExecuting);
      const kernel = await getKernel(notebook.uri);
      const code = states.filter((s) => s.state !== "markdown");
      const count = (state: string) => code.filter((s) => s.state === state).length;
      const attention = code
        .filter((s) => s.state !== "fresh" || s.afterStale)
        .map(({ cell, state, afterStale }) => ({
          id: cellIdOf(cell),
          index: cell.index,
          state,
          afterStale,
          preview: preview(cell)
        }));
      const result = {
        notebookUri: notebook.uri.toString(),
        unsavedChanges: notebook.isDirty,
        kernel: kernel ? { connected: true, status: kernel.status } : { connected: false },
        codeCells: code.length,
        fresh: count("fresh"),
        edited: count("edited"),
        notRun: count("not-run"),
        running: count("running"),
        firstStaleIndex: firstStaleIndex === -1 ? null : firstStaleIndex,
        upToDate: firstStaleIndex === -1 && count("running") === 0,
        cells: attention
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [
        `# Notebook Status`,
        "",
        `- **Kernel**: ${kernel ? kernel.status : "not started"}`,
        `- **Unsaved changes**: ${result.unsavedChanges ? "yes (notebook_save to write them)" : "no"}`,
        `- **Code cells**: ${result.codeCells} — ${result.fresh} up to date, ${result.edited} edited since they ran, ${result.notRun} not run in this kernel, ${result.running} running`
      ];
      if (result.upToDate) {
        lines.push("", "The kernel matches the code on screen.");
      } else {
        lines.push("", "## Cells to look at");
        for (const c of attention) {
          const why =
            c.state === "edited"
              ? "edited since it ran"
              : c.state === "not-run"
                ? "not run in this kernel"
                : c.state === "running"
                  ? "running"
                  : "ran after a stale cell; may depend on old state";
          lines.push(`- Cell ${c.index} \`${c.id}\`: ${why} — \`${c.preview}\``);
        }
        if (firstStaleIndex !== -1) {
          lines.push(
            "",
            `To bring the kernel up to date, run from cell ${firstStaleIndex} on: notebook_run_cells with mode "stale".`
          );
        }
      }
      return TextResult(lines.join("\n"));
    }
  );

  server.tool(
    "notebook_run_cells",
    "Run several code cells in order and return one summary: a range, everything from the first stale cell on ('stale'), or all. Stops at the first error by default. Returns outputs only for the failing cell and the last cell unless outputs is 'all'.",
    RunCellsInput,
    RUNS_CODE,
    async (args) => {
      const access = await resolveNotebook(args.notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;
      const all = notebook.getCells();

      let from = 0;
      let to = all.length - 1;
      if (args.mode === "range") {
        if (args.start_cell_id !== undefined || args.start_index !== undefined) {
          const s = resolveCell(notebook, { cell_id: args.start_cell_id, index: args.start_index });
          if (!s.cell) return ErrorResult(`Error (start): ${s.error}`);
          from = s.cell.index;
        }
        if (args.end_cell_id !== undefined || args.end_index !== undefined) {
          const e = resolveCell(notebook, { cell_id: args.end_cell_id, index: args.end_index });
          if (!e.cell) return ErrorResult(`Error (end): ${e.error}`);
          to = e.cell.index;
        }
        if (from > to) return ErrorResult("Error: the start cell comes after the end cell.");
      } else if (args.mode === "stale") {
        const { firstStaleIndex } = notebookRunStates(notebook, isCellExecuting);
        if (firstStaleIndex === -1) {
          const msg = "Nothing to run: every code cell ran in this kernel and is unchanged since.";
          return args.response_format === "json"
            ? TextResult(JSON.stringify({ mode: "stale", planned: 0, ran: 0, cells: [], message: msg }, null, 2))
            : TextResult(msg);
        }
        from = firstStaleIndex;
      }

      const planned = all
        .slice(from, to + 1)
        .filter((c) => c.kind === vscode.NotebookCellKind.Code);
      const deadline = Date.now() + args.timeout_seconds * 1000;
      const done: { cell: vscode.NotebookCell; run: RunDescription }[] = [];
      let stopped: { reason: "error" | "timeout" | "deleted"; cellIndex: number } | undefined;

      // Outputs are fetched again at the end for only the cells we report,
      // so the budget isn't spent on cells whose outputs are dropped.
      const quietBudget = { maxChars: 2_000, maxImages: 0 };
      for (const cell of planned) {
        const remaining = Math.max(1, (deadline - Date.now()) / 1000);
        let run: RunDescription;
        try {
          run = await runAndDescribe(notebook, cell, {
            execute: true,
            timeoutSeconds: remaining,
            budget: quietBudget
          });
        } catch {
          stopped = { reason: "deleted", cellIndex: cell.index };
          break;
        }
        done.push({ cell, run });
        if (run.status === "running") {
          stopped = { reason: "timeout", cellIndex: run.cellIndex };
          break;
        }
        if (!run.success && args.stop_on_error) {
          stopped = { reason: "error", cellIndex: run.cellIndex };
          break;
        }
      }

      const failed = done.filter((d) => d.run.status === "finished" && !d.run.success);
      const last = done[done.length - 1];
      const withOutputs = new Set(
        args.outputs === "all"
          ? done.map((d) => d.cell)
          : args.outputs === "none"
            ? []
            : [...failed.map((d) => d.cell), ...(last ? [last.cell] : [])]
      );
      const perCell = Math.max(500, Math.floor(args.max_output_chars / Math.max(1, withOutputs.size)));
      const cells = [];
      for (const { cell, run } of done) {
        const include = withOutputs.has(cell);
        cells.push({
          ...run,
          outputs: include
            ? await parseOutputs(cell.outputs, { maxChars: perCell, maxImages: args.max_images })
            : undefined
        });
      }
      const result = {
        mode: args.mode,
        planned: planned.length,
        ran: done.length,
        succeeded: done.filter((d) => d.run.success).length,
        stopped: stopped ?? null,
        notStarted: planned.slice(done.length).map((c) => ({ id: cellIdOf(c), index: c.index })),
        cells
      };

      if (args.response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [
        `# Ran ${result.ran} of ${result.planned} code cells`,
        "",
        ...cells.map(
          (c) =>
            `- Cell ${c.cellIndex} \`${c.cellId}\`: ${c.status === "running" ? "still running" : c.success ? "ok" : "FAILED"}${c.executionOrder ? ` [${c.executionOrder}]` : ""}`
        )
      ];
      if (stopped) {
        lines.push(
          "",
          stopped.reason === "error"
            ? `Stopped after cell ${stopped.cellIndex} failed; ${result.notStarted.length} cell(s) not started.`
            : stopped.reason === "timeout"
              ? `Time ran out while cell ${stopped.cellIndex} was running (it keeps running; notebook_wait_cell to wait). ${result.notStarted.length} cell(s) not started.`
              : `Stopped: cell ${stopped.cellIndex} was deleted while running.`
        );
      }
      const shown = cells.filter((c) => c.outputs && c.outputs.length > 0);
      for (const c of shown) {
        lines.push("", `## Cell ${c.cellIndex} output`, formatOutputsAsMarkdown(c.outputs!));
      }
      return ResultWithImages(lines.join("\n"), shown.flatMap((c) => c.outputs!));
    }
  );

  server.tool(
    "notebook_inspect_variables",
    "List the variables in the notebook's kernel (name, type, shape/len, dtype, DataFrame columns), or describe specific ones with a value preview — without adding a cell, printing into the notebook or changing the execution count. Use it to check state instead of inserting throwaway print cells.",
    InspectInput,
    READ_ONLY,
    async ({ names, include_callables, max_preview_chars, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      const kernel = await getKernel(notebook.uri);
      if (!kernel || typeof kernel.executeCode !== "function") {
        return ErrorResult(
          "Error: the notebook has no running kernel (it starts on the first cell run). Run a cell first, or attach one with notebook_select_kernel."
        );
      }
      if (kernel.language && kernel.language !== "python") {
        return ErrorResult(`Error: variable inspection supports Python kernels; this one is ${kernel.language}.`);
      }

      // Arguments travel as a JSON string parsed on the Python side; a JSON
      // string literal is also a valid Python string literal.
      const argsJson = JSON.stringify(JSON.stringify([names ?? null, include_callables, max_preview_chars]));
      const call = `${INSPECT_SCRIPT}\n__nbmcp_inspect(*__import__("json").loads(${argsJson}))\ndel __nbmcp_inspect\n`;
      const decoder = new TextDecoder();
      const cts = new vscode.CancellationTokenSource();
      const timer = setTimeout(() => cts.cancel(), 30_000);
      let text = "";
      let errorText = "";
      try {
        for await (const output of kernel.executeCode(call, cts.token)) {
          for (const item of output.items) {
            const s = decoder.decode(item.data);
            if (/error/i.test(item.mime)) errorText += s;
            else text += s;
          }
        }
      } catch (err) {
        // The Jupyter extension asks the user once before another extension
        // may run code in its kernels; a refusal or a dismissed dialog lands
        // here.
        const message = err instanceof Error ? err.message : String(err);
        if (/access|revoked|denied|permission/i.test(message)) {
          return ErrorResult(
            `Error: Notebook MCP doesn't have access to Jupyter kernels (${message}). The first time, VS Code asks "Do you want to grant Kernel access to the extension VS Code Notebook MCP?" — the user needs to choose Allow. To change an earlier Deny, run "Jupyter: Manage Access To Jupyter Kernels" in VS Code.`
          );
        }
        return ErrorResult(`Error: inspection failed in the kernel: ${message}`);
      } finally {
        clearTimeout(timer);
        cts.dispose();
      }
      if (cts.token.isCancellationRequested) {
        return ErrorResult("Error: the kernel didn't answer within 30 s. Is a cell still running? (Inspection waits for the kernel to be idle.)");
      }

      const marker = text.lastIndexOf("__NBMCP__");
      if (marker === -1) {
        return ErrorResult(`Error: inspection failed.${errorText ? "\n" + fenced(stripAnsi(errorText)).join("\n") : ""}`);
      }
      const parsed = JSON.parse(text.slice(marker + "__NBMCP__".length).trim()) as {
        variables: Record<string, unknown>[];
        missing: string[];
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(parsed, null, 2));
      }
      const lines = [`# Kernel variables (${parsed.variables.length})`, ""];
      for (const v of parsed.variables) {
        const extra = [
          v.shape !== undefined ? `shape ${JSON.stringify(v.shape)}` : undefined,
          v.len !== undefined ? `len ${v.len}` : undefined,
          v.dtype !== undefined ? `dtype ${v.dtype}` : undefined,
          v.columns !== undefined ? `columns ${(v.columns as string[]).join(", ")}` : undefined
        ].filter(Boolean);
        lines.push(`- \`${v.name}\`: ${v.type}${extra.length ? ` (${extra.join("; ")})` : ""}${v.preview !== undefined ? ` = \`${String(v.preview).replace(/`/g, "'")}\`` : ""}`);
      }
      if (parsed.missing.length) {
        lines.push("", `Not defined: ${parsed.missing.join(", ")}`);
      }
      return TextResult(lines.join("\n"));
    }
  );
}
