import * as crypto from "crypto";
import * as vscode from "vscode";

export interface NotebookAccessResult {
  allowed: boolean;
  notebook?: vscode.NotebookDocument;
  editor?: vscode.NotebookEditor;
  error?: string;
}

export async function resolveNotebook(
  notebookUri?: string
): Promise<NotebookAccessResult> {
  if (notebookUri) {
    const uri = vscode.Uri.parse(notebookUri);
    const notebook =
      vscode.workspace.notebookDocuments.find(
        (doc) => doc.uri.toString() === uri.toString()
      ) ??
      (await tryOpenNotebook(uri));

    if (!notebook) {
      return {
        allowed: false,
        error: `Notebook not found: ${notebookUri}. Use notebook_list_open to see available notebooks.`
      };
    }
    return {
      allowed: true,
      notebook,
      editor: findVisibleEditor(notebook)
    };
  }

  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    return {
      allowed: false,
      error:
        "No active notebook. Open a .ipynb file first, or pass notebook_uri."
    };
  }
  return { allowed: true, notebook: editor.notebook, editor };
}

async function tryOpenNotebook(
  uri: vscode.Uri
): Promise<vscode.NotebookDocument | undefined> {
  try {
    return await vscode.workspace.openNotebookDocument(uri);
  } catch {
    return undefined;
  }
}

function findVisibleEditor(
  notebook: vscode.NotebookDocument
): vscode.NotebookEditor | undefined {
  return vscode.window.visibleNotebookEditors.find(
    (e) => e.notebook.uri.toString() === notebook.uri.toString()
  );
}

export async function insertCells(
  uri: vscode.Uri,
  index: number,
  cells: vscode.NotebookCellData[]
): Promise<void> {
  const edit = vscode.NotebookEdit.insertCells(index, cells);
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(uri, [edit]);
  await vscode.workspace.applyEdit(workspaceEdit);
}

export async function deleteCells(
  uri: vscode.Uri,
  index: number,
  count: number
): Promise<void> {
  const edit = vscode.NotebookEdit.deleteCells(
    new vscode.NotebookRange(index, index + count)
  );
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(uri, [edit]);
  await vscode.workspace.applyEdit(workspaceEdit);
}

export function generateCellId(): string {
  return crypto.randomUUID();
}

// Ids for cells that have no nbformat id (notebooks older than nbformat 4.5).
// Keyed by the NotebookCell object, which VS Code keeps stable for the life
// of the document, so these ids survive edits and index shifts without
// writing anything into the notebook.
const sessionIds = new WeakMap<vscode.NotebookCell, string>();

/**
 * Stable id for a cell: its nbformat cell id when it has one (VS Code's ipynb
 * serializer keeps it in `metadata.id`; cells we insert get one too), else a
 * session-only id that stays valid until VS Code reloads the notebook.
 */
export function cellIdOf(cell: vscode.NotebookCell): string {
  const id = cell.metadata?.id;
  if (typeof id === "string" && id.length > 0) return id;
  let sessionId = sessionIds.get(cell);
  if (!sessionId) {
    sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    sessionIds.set(cell, sessionId);
  }
  return sessionId;
}

export type CellLookup =
  | { cell: vscode.NotebookCell; error?: undefined }
  | { cell?: undefined; error: string };

/** Find a cell by id (preferred) or index. */
export function resolveCell(
  notebook: vscode.NotebookDocument,
  target: { cell_id?: string; index?: number }
): CellLookup {
  if (target.cell_id !== undefined) {
    const cell = notebook.getCells().find((c) => cellIdOf(c) === target.cell_id);
    return cell
      ? { cell }
      : {
          error: `No cell with id "${target.cell_id}". Call notebook_list_cells to get current ids.`
        };
  }
  if (target.index !== undefined) {
    if (target.index >= notebook.cellCount) {
      return {
        error: `Cell index ${target.index} out of range (0-${notebook.cellCount - 1}).`
      };
    }
    return { cell: notebook.cellAt(target.index) };
  }
  return { error: "Pass cell_id or index to choose a cell." };
}

export interface ReplaceSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Find the ranges `old_string` occupies in a cell, Edit-tool style: the match
 * must be exact and, unless replace_all is set, unique.
 */
export function findReplaceRanges(
  cell: vscode.NotebookCell,
  spec: ReplaceSpec
): { ranges: vscode.Range[]; error?: undefined } | { ranges?: undefined; error: string } {
  if (spec.old_string.length === 0) {
    return { error: "old_string is empty. Use notebook_edit_cell to replace a whole cell." };
  }
  if (spec.old_string === spec.new_string) {
    return { error: "old_string and new_string are identical; nothing to change." };
  }
  const doc = cell.document;
  const text = doc.getText();
  const offsets: number[] = [];
  for (let at = text.indexOf(spec.old_string); at !== -1; at = text.indexOf(spec.old_string, at + spec.old_string.length)) {
    offsets.push(at);
  }
  if (offsets.length === 0) {
    return {
      error: `old_string was not found in cell ${cell.index}. It must match exactly, including whitespace and indentation; read the cell with notebook_get_cell_content first.`
    };
  }
  if (offsets.length > 1 && !spec.replace_all) {
    return {
      error: `old_string occurs ${offsets.length} times in cell ${cell.index}. Include more surrounding lines to make it unique, or set replace_all.`
    };
  }
  return {
    ranges: offsets.map(
      (o) => new vscode.Range(doc.positionAt(o), doc.positionAt(o + spec.old_string.length))
    )
  };
}

export type CellTextEdit =
  | { cell: vscode.NotebookCell; kind: "set"; content: string }
  | { cell: vscode.NotebookCell; kind: "replace"; ranges: vscode.Range[]; new_string: string };

/**
 * Apply text edits to one or more cells in a single WorkspaceEdit, so they
 * land together. Callers validate every edit first; this only applies.
 */
export async function applyCellTextEdits(edits: CellTextEdit[]): Promise<boolean> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const e of edits) {
    if (e.kind === "set") {
      const doc = e.cell.document;
      const full = new vscode.Range(0, 0, doc.lineCount, 0);
      workspaceEdit.replace(doc.uri, full, e.content);
    } else {
      for (const r of e.ranges) {
        workspaceEdit.replace(e.cell.document.uri, r, e.new_string);
      }
    }
  }
  return vscode.workspace.applyEdit(workspaceEdit);
}

// Cells whose execution summary changed to "started, not finished" since we
// began watching. The summary alone can't tell a running cell from one loaded
// from disk: while a cell runs, the Jupyter kernel gives it an execution order
// but no start time, and a cell read from an .ipynb looks the same (execution
// count, no success flag). Change events only fire for real runs, so we track
// those. This also sees runs the user started from the editor.
const runningCells = new WeakSet<vscode.NotebookCell>();

/** Start tracking cell execution state. Call once from activate(). */
export function watchCellExecution(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      for (const change of e.cellChanges) {
        const summary = change.executionSummary;
        if (!summary) continue;
        if (typeof summary.success === "boolean") {
          runningCells.delete(change.cell);
        } else if (
          summary.executionOrder !== undefined ||
          summary.timing?.startTime !== undefined
        ) {
          // Only a run that has actually started: inserting or editing a cell
          // can also report an empty summary, and treating that as running
          // would make the tools wait on a run that never happens.
          runningCells.add(change.cell);
        }
      }
    })
  );
}

export function isCellExecuting(cell: vscode.NotebookCell): boolean {
  if (runningCells.has(cell) || inflight.has(cell)) return true;
  const timing = cell.executionSummary?.timing;
  return !!timing && timing.startTime !== undefined && timing.endTime === undefined;
}

export interface RunResult {
  cell: vscode.NotebookCell;
  /** False when the timeout passed first; the cell is still running. */
  finished: boolean;
}

/**
 * Execute a code cell and resolve once *this* run has finished.
 *
 * Completion is "executionSummary.success is a boolean" — VS Code creates the
 * summary when a run starts but only sets success when the kernel reports
 * back. On its own that check is wrong for a cell that already ran: the old
 * summary's success is a boolean too, and `notebook.cell.execute` can return
 * before the new run starts, so the previous outputs would come back as the
 * result. We therefore snapshot the summary first and only accept a finished
 * summary that differs from it (new execution order or start time).
 *
 * The cell is tracked by object, not index: NotebookCell objects survive
 * inserts and deletes around them (their `index` updates, and becomes -1 if
 * the cell itself is removed), so concurrent edits by the user can't make us
 * read another cell's outputs.
 *
 * If the cell is already running, we don't start it again and wait for that
 * run instead. With `execute: false` we never start a run: we wait for a run
 * in progress, or return at once if there is none.
 *
 * Hitting the timeout is not an error — long cells are normal. The result
 * then has `finished: false` and the cell keeps running in the kernel.
 */
// Runs this extension started (or joined) that haven't finished yet. A cell
// queued behind another one has no start time, so isCellExecuting() can't see
// it; this map is how notebook_wait_cell finds a run that timed out while
// still queued.
const inflight = new WeakMap<vscode.NotebookCell, Promise<void>>();

/** Forget tracked runs in a notebook, e.g. after an interrupt cancelled them. */
export function forgetRuns(notebook: vscode.NotebookDocument): void {
  for (const cell of notebook.getCells()) {
    inflight.delete(cell);
    runningCells.delete(cell);
  }
}

/** Resolves when the cell has a finished summary different from `before`. */
function trackCompletion(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  before: { order?: number; start?: number } | undefined
): Promise<void> {
  const isDone = () => {
    const summary = cell.executionSummary;
    if (typeof summary?.success !== "boolean") return false;
    if (!before) return true;
    return (
      summary.executionOrder !== before.order ||
      summary.timing?.startTime !== before.start
    );
  };

  const done = new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      clearInterval(safetyPoll);
      sub.dispose();
      err ? reject(err) : resolve();
    };
    const check = () => {
      if (cell.index < 0) {
        finish(new Error("Cell was deleted while it was running."));
      } else if (isDone()) {
        finish();
      }
    };
    // Execution-state changes arrive as document change events; the slow
    // poll is only a fallback in case an event is missed.
    const sub = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook === notebook) check();
    });
    const safetyPoll = setInterval(check, 1_000);
    check();
  });
  const tracked = done.finally(() => {
    if (inflight.get(cell) === tracked) inflight.delete(cell);
  });
  inflight.set(cell, tracked);
  return tracked;
}

export function runCellAndWait(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  options: { timeoutMs?: number; execute?: boolean } = {}
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const execute = options.execute ?? true;

  let completion = inflight.get(cell);
  if (!completion && isCellExecuting(cell)) {
    // Started by the user or another tool: wait for that run.
    completion = trackCompletion(notebook, cell, undefined);
  }
  if (!completion) {
    if (!execute) {
      return Promise.resolve({ cell, finished: true });
    }
    completion = trackCompletion(notebook, cell, {
      order: cell.executionSummary?.executionOrder,
      start: cell.executionSummary?.timing?.startTime
    });
    Promise.resolve(
      vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: cell.index, end: cell.index + 1 }],
        document: notebook.uri
      })
    ).then(undefined, () => {
      // A failed dispatch leaves the cell unfinished; the timeout reports it.
    });
  }

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => resolve({ cell, finished: false }), timeoutMs);
  });
  return Promise.race([
    completion.then((): RunResult => ({ cell, finished: true })),
    timedOut
  ]).finally(() => clearTimeout(timer));
}

/** Save the notebook to disk if it has unsaved changes. */
export async function saveNotebook(
  notebook: vscode.NotebookDocument
): Promise<boolean> {
  if (!notebook.isDirty) return true;
  return notebook.save();
}
