import * as vscode from "vscode";
import { getKernel, JupyterKernel } from "./jupyter.js";

/**
 * Which cells' code is actually reflected in the kernel.
 *
 * The usual way a notebook "loses context" is that the code on screen is not
 * the code the kernel ran: a cell was edited after it ran, or never ran in
 * this kernel (outputs loaded from disk, or the kernel restarted since). We
 * record each cell's source when a run starts, per kernel session, and
 * compare.
 */

// Source of each cell at the start of its last run in the current kernel
// session. Keyed by the NotebookCell object, which is stable for the life of
// the document.
const ranSource = new WeakMap<vscode.NotebookCell, string>();
// The kernel each notebook's records belong to. A different kernel object on
// a later run means a new session (the old kernel died and Jupyter started a
// fresh one), so earlier records no longer apply.
const sessionKernel = new WeakMap<vscode.NotebookDocument, JupyterKernel>();

export type CellRunState =
  /** Ran in this kernel session and hasn't changed since. */
  | "fresh"
  /** Changed since it last ran; the kernel has the old version. */
  | "edited"
  /** Hasn't run in this kernel session (any outputs are from earlier). */
  | "not-run"
  | "running"
  | "markdown";

/** Call when a run of `cell` starts. */
export function recordRunStart(cell: vscode.NotebookCell): void {
  ranSource.set(cell, cell.document.getText());
  void watchKernel(cell.notebook, cell);
}

/** Forget what ran in a notebook, e.g. after its kernel restarted. */
export function resetSession(
  notebook: vscode.NotebookDocument,
  except?: vscode.NotebookCell
): void {
  for (const cell of notebook.getCells()) {
    if (cell !== except) ranSource.delete(cell);
  }
}

/**
 * Follow the notebook's kernel so restarts from the editor (not just through
 * our tool) clear the record. The Jupyter API has no "kernel started" event,
 * but each kernel reports status changes ("restarting"); and if the kernel
 * died and a new one was started, the next run sees a different kernel
 * object. ("dead" alone is not used: it is also reported when a notebook's
 * kernel is merely being disposed.)
 */
async function watchKernel(
  notebook: vscode.NotebookDocument,
  ranCell: vscode.NotebookCell
): Promise<void> {
  const kernel = await getKernel(notebook.uri);
  if (!kernel || typeof kernel.onDidChangeStatus !== "function") return;
  const previous = sessionKernel.get(notebook);
  if (previous === kernel) return;
  sessionKernel.set(notebook, kernel);
  if (previous) {
    // A new kernel: only the run that just started belongs to it.
    resetSession(notebook, ranCell);
  }
  kernel.onDidChangeStatus((status) => {
    if (sessionKernel.get(notebook) !== kernel) return;
    if (status === "restarting" || status === "autorestarting") {
      resetSession(notebook);
    }
  });
}

export function runStateOf(
  cell: vscode.NotebookCell,
  isRunning: (cell: vscode.NotebookCell) => boolean
): CellRunState {
  if (cell.kind !== vscode.NotebookCellKind.Code) return "markdown";
  if (isRunning(cell)) return "running";
  const ran = ranSource.get(cell);
  if (ran === undefined) return "not-run";
  return ran === cell.document.getText() ? "fresh" : "edited";
}

export interface NotebookRunStates {
  states: { cell: vscode.NotebookCell; state: CellRunState; afterStale: boolean }[];
  /** Index of the first code cell that is edited or not-run, or -1. */
  firstStaleIndex: number;
}

/**
 * Run state of every cell, plus `afterStale` for fresh code cells that come
 * after the first stale one: they ran against state that may since have
 * changed (or never existed), so their outputs can't be trusted either.
 */
export function notebookRunStates(
  notebook: vscode.NotebookDocument,
  isRunning: (cell: vscode.NotebookCell) => boolean
): NotebookRunStates {
  let firstStaleIndex = -1;
  const states = notebook.getCells().map((cell) => {
    const state = runStateOf(cell, isRunning);
    if (firstStaleIndex === -1 && (state === "edited" || state === "not-run")) {
      firstStaleIndex = cell.index;
    }
    const afterStale = firstStaleIndex !== -1 && cell.index > firstStaleIndex && state === "fresh";
    return { cell, state, afterStale };
  });
  return { states, firstStaleIndex };
}
