import * as vscode from "vscode";

/**
 * Make the agent's changes visible in the editor, and optionally let the user
 * review them first.
 *
 * Markers: each cell the agent changed or inserted shows a cell status bar
 * item until the user edits that cell or runs it.
 *
 * Review (setting notebook-mcp.confirmEdits): before a change is applied, a
 * diff opens and a notification asks to apply or reject it.
 */

interface Mark {
  kind: "changed" | "inserted";
  at: Date;
  /** The cell's text right after our edit; any other text means the user edited it. */
  text: string;
}

const marks = new WeakMap<vscode.NotebookCell, Mark>();
const changed = new vscode.EventEmitter<void>();
const NOTEBOOK_TYPES = ["jupyter-notebook", "interactive"];
const REVIEW_SCHEME = "notebook-mcp-review";
const REVIEW_TIMEOUT_MS = 120_000;
const reviewContents = new Map<string, string>();

export function registerAgentEditMarkers(context: vscode.ExtensionContext): void {
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    onDidChangeCellStatusBarItems: changed.event,
    provideCellStatusBarItems(cell) {
      const mark = marks.get(cell);
      if (!mark) return [];
      if (cell.document.getText() !== mark.text) {
        marks.delete(cell);
        return [];
      }
      const time = mark.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const item = new vscode.NotebookCellStatusBarItem(
        `$(sparkle) ${mark.kind === "inserted" ? "Inserted" : "Changed"} by agent · ${time}`,
        vscode.NotebookCellStatusBarAlignment.Left
      );
      item.tooltip = `Made through Notebook MCP at ${mark.at.toLocaleTimeString()}. Undo with Ctrl+Z (Cmd+Z) in the notebook. This note goes away when you edit or run the cell.`;
      return [item];
    }
  };
  for (const type of NOTEBOOK_TYPES) {
    context.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider(type, provider));
  }
  context.subscriptions.push(
    changed,
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, {
      provideTextDocumentContent: (uri) => reviewContents.get(uri.path) ?? ""
    }),
    // Running a marked cell, or the user typing in it, clears the marker.
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      let any = false;
      for (const c of e.cellChanges) {
        const mark = marks.get(c.cell);
        if (!mark) continue;
        if (c.executionSummary || c.cell.document.getText() !== mark.text) {
          marks.delete(c.cell);
          any = true;
        }
      }
      if (any) changed.fire();
    })
  );
}

/** Call after the agent changed or inserted cells. */
export function markAgentEdits(cells: vscode.NotebookCell[], kind: Mark["kind"]): void {
  const at = new Date();
  for (const cell of cells) {
    marks.set(cell, { kind, at, text: cell.document.getText() });
  }
  changed.fire();
}

export interface ProposedChange {
  /** Label such as "Cell 3" or "New cell at 2". */
  label: string;
  before: string;
  after: string;
}

/**
 * Ask the user to approve changes when notebook-mcp.confirmEdits is on.
 * Resolves true right away when it's off. Returns false if the user rejects
 * or doesn't answer within two minutes.
 */
export async function confirmChanges(
  notebook: vscode.NotebookDocument,
  summary: string,
  changes: ProposedChange[]
): Promise<boolean> {
  if (!vscode.workspace.getConfiguration("notebook-mcp").get<boolean>("confirmEdits", false)) {
    return true;
  }
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const join = (pick: (c: ProposedChange) => string) =>
    changes.map((c) => `# ── ${c.label} ──\n${pick(c)}`).join("\n\n");
  const left = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${key}/before.py` });
  const right = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${key}/after.py` });
  reviewContents.set(left.path, join((c) => c.before));
  reviewContents.set(right.path, join((c) => c.after));

  const name = notebook.uri.path.split("/").pop() ?? "notebook";
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `Agent change to ${name} (review)`,
    { preview: true, preserveFocus: true }
  );

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), REVIEW_TIMEOUT_MS);
  });
  const choice = await Promise.race([
    vscode.window.showInformationMessage(`Notebook MCP: ${summary} in ${name}. Apply?`, "Apply", "Reject"),
    timedOut
  ]);
  clearTimeout(timer);

  // Close the review diff and drop its contents.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === right.toString()) {
        await vscode.window.tabGroups.close(tab, true);
      }
    }
  }
  reviewContents.delete(left.path);
  reviewContents.delete(right.path);
  return choice === "Apply";
}

export const REJECTED_MESSAGE =
  "The user rejected this change in VS Code (or didn't answer within 2 minutes). Nothing was changed. Ask the user what they want instead.";
