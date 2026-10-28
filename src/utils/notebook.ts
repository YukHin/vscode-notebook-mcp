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

export async function editCellContent(
  cell: vscode.NotebookCell,
  newContent: string
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(0, 0, cell.document.lineCount, 0);
  edit.replace(cell.document.uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
}

export function generateCellId(): string {
  return crypto.randomUUID();
}

export function isCellExecuting(cell: vscode.NotebookCell): boolean {
  const timing = cell.executionSummary?.timing;
  return !!timing && timing.startTime !== undefined && timing.endTime === undefined;
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
 * run instead.
 */
export function runCellAndWait(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  timeoutMs = 60_000
): Promise<vscode.NotebookCell> {
  const alreadyRunning = isCellExecuting(cell);
  const before = alreadyRunning
    ? undefined
    : {
        order: cell.executionSummary?.executionOrder,
        start: cell.executionSummary?.timing?.startTime
      };

  const isDone = () => {
    const summary = cell.executionSummary;
    if (typeof summary?.success !== "boolean") return false;
    if (!before) return true;
    return (
      summary.executionOrder !== before.order ||
      summary.timing?.startTime !== before.start
    );
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(safetyPoll);
      sub.dispose();
      err ? reject(err) : resolve(cell);
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
    const timer = setTimeout(
      () => finish(new Error(`Cell execution timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    if (alreadyRunning) {
      check();
      return;
    }
    Promise.resolve(
      vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: cell.index, end: cell.index + 1 }],
        document: notebook.uri
      })
    ).then(check, (err) =>
      finish(err instanceof Error ? err : new Error(String(err)))
    );
  });
}

/** Save the notebook to disk if it has unsaved changes. */
export async function saveNotebook(
  notebook: vscode.NotebookDocument
): Promise<boolean> {
  if (!notebook.isDirty) return true;
  return notebook.save();
}
