import * as vscode from "vscode";

const PLOTLY_MIME_PREFIX = "application/vnd.plotly.v1+json";
const VIEW_TYPE = "notebook-mcp.plotlyRenderer";
const RENDER_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;

export interface PlotlyFigure {
  data: unknown[];
  layout?: { width?: number; height?: number; [key: string]: unknown };
  [key: string]: unknown;
}

let extensionUri: vscode.Uri | undefined;
let panel: vscode.WebviewPanel | undefined;
let panelReady: Promise<void> | undefined;
const pending = new Map<
  string,
  { resolve: (b64: string) => void; reject: (err: Error) => void }
>();

// The last real editor the user had in front. The active editor can be
// undefined at the moment a render starts (for example while VS Code is busy
// showing the kernel or the new tab), and then we'd have nothing to go back to.
let lastEditor: ActiveEditor;

export function initPlotlyRenderer(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  lastEditor = activeEditor();
  context.subscriptions.push(
    { dispose: () => panel?.dispose() },
    vscode.window.onDidChangeActiveNotebookEditor((e) => {
      if (e) lastEditor = e;
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      // Text editors inside a notebook are its cells; keep the notebook.
      if (e && e.document.uri.scheme !== "vscode-notebook-cell") lastEditor = e;
    })
  );
}

/**
 * Create the renderer as an editor tab in the active group, without taking
 * focus. Plotly needs a DOM, so rendering happens in a webview; between
 * renders it stays as a background tab (retainContextWhenHidden). It used to
 * live in the bottom panel, and closing the panel afterwards hid the user's
 * terminal. If the user closes the tab, the next render recreates it.
 */
function createPanel(): Promise<void> {
  const distUri = vscode.Uri.joinPath(extensionUri!, "dist");
  const created = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "Notebook MCP: Plotly renderer",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distUri] }
  );
  panel = created;

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  created.webview.onDidReceiveMessage((msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "ready") {
      resolveReady();
      return;
    }
    if (typeof m.id !== "string") return;
    const entry = pending.get(m.id);
    if (!entry) return;
    pending.delete(m.id);
    if (m.type === "rendered" && typeof m.dataUrl === "string") {
      entry.resolve(stripDataUrlPrefix(m.dataUrl));
    } else if (m.type === "error") {
      entry.reject(
        new Error(typeof m.message === "string" ? m.message : "Plotly render error")
      );
    }
  });

  created.onDidDispose(() => {
    if (panel === created) {
      panel = undefined;
      panelReady = undefined;
    }
    rejectReady(new Error("Plotly renderer was closed"));
    for (const { reject } of pending.values()) {
      reject(new Error("Plotly renderer was closed"));
    }
    pending.clear();
  });

  const plotlyJsUri = created.webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, "plotly.min.js")
  );
  created.webview.html = renderHtml(plotlyJsUri.toString(), created.webview.cspSource);

  return ready;
}

export function isPlotlyMime(mime: string): boolean {
  return mime.startsWith(PLOTLY_MIME_PREFIX);
}

// The editor to bring back once rendering is done. Callers render all the
// figures of a call and then call restoreAfterRendering() once, so several
// figures switch tabs only once, and the user's editor is back in front
// before the tool replies (the next call may rely on the active notebook).
let editorToRestore: ActiveEditor;

export async function renderPlotlyToPng(figure: PlotlyFigure): Promise<string> {
  if (!extensionUri) {
    throw new Error("Plotly renderer not initialized");
  }
  if (!panel?.visible) {
    editorToRestore ??= activeEditor() ?? lastEditor;
  }
  return renderInPanel(figure);
}

/** Put the user's editor back in front after one or more renders. */
export async function restoreAfterRendering(): Promise<void> {
  const previous = editorToRestore;
  editorToRestore = undefined;
  await restoreEditor(previous);
}

/**
 * Render in the webview while it is visible. VS Code gives hidden webviews no
 * time to run (a background tab never answers), so the renderer tab is shown
 * for the duration of the render, without taking focus, and the previous
 * editor comes back right after.
 */
async function renderInPanel(figure: PlotlyFigure): Promise<string> {
  const v = await ensurePanel();
  if (!v.visible) {
    v.reveal(v.viewColumn, true);
  }
  const id = randomId();
  const width =
    typeof figure.layout?.width === "number" ? figure.layout.width : DEFAULT_WIDTH;
  const height =
    typeof figure.layout?.height === "number"
      ? figure.layout.height
      : DEFAULT_HEIGHT;

  const rendered = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`Plotly render timed out after ${RENDER_TIMEOUT_MS}ms`));
      }
    }, RENDER_TIMEOUT_MS);
    pending.set(id, {
      resolve: (b64) => { clearTimeout(timer); resolve(b64); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });
    v.webview.postMessage({
      type: "render",
      id,
      figure: { data: figure.data, layout: figure.layout ?? {} },
      width,
      height
    });
  });

  return rendered;
}

type ActiveEditor = vscode.NotebookEditor | vscode.TextEditor | undefined;

function activeEditor(): ActiveEditor {
  return vscode.window.activeNotebookEditor ?? vscode.window.activeTextEditor;
}

async function restoreEditor(previous: ActiveEditor): Promise<void> {
  if (!previous) return;
  try {
    if ("notebook" in previous) {
      await vscode.window.showNotebookDocument(previous.notebook, {
        viewColumn: previous.viewColumn,
        preserveFocus: false
      });
    } else {
      await vscode.window.showTextDocument(previous.document, {
        viewColumn: previous.viewColumn,
        preserveFocus: false
      });
    }
  } catch {
    // the editor may have been closed meanwhile
  }
}

async function ensurePanel(): Promise<vscode.WebviewPanel> {
  if (!panel || !panelReady) {
    panelReady = createPanel();
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Plotly renderer failed to load")),
      RESOLVE_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([panelReady, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return panel!;
}

function renderHtml(plotlyJsUri: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data: blob:; font-src ${cspSource} data:; connect-src 'none';" />
    <style>
      html, body { margin: 0; padding: 0; background: white; }
      #graph { width: ${DEFAULT_WIDTH}px; height: ${DEFAULT_HEIGHT}px; }
    </style>
  </head>
  <body>
    <div id="graph"></div>
    <script src="${plotlyJsUri}"></script>
    <script>
      const vscode = acquireVsCodeApi();
      const div = document.getElementById('graph');
      window.addEventListener('message', async (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'render') return;
        try {
          div.style.width = msg.width + 'px';
          div.style.height = msg.height + 'px';
          const layout = Object.assign({}, msg.figure.layout, { width: msg.width, height: msg.height });
          await Plotly.newPlot(div, msg.figure.data, layout, { staticPlot: true, displayModeBar: false });
          const dataUrl = await Plotly.toImage(div, { format: 'png', width: msg.width, height: msg.height });
          vscode.postMessage({ type: 'rendered', id: msg.id, dataUrl });
        } catch (err) {
          vscode.postMessage({ type: 'error', id: msg.id, message: (err && err.message) ? err.message : String(err) });
        } finally {
          try { Plotly.purge(div); } catch (_) {}
        }
      });
      vscode.postMessage({ type: 'ready' });
    </script>
  </body>
</html>`;
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl;
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}
