import * as crypto from "crypto";
import * as vscode from "vscode";

const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";

/**
 * Normalize an interpreter path the way the Jupyter extension does before it
 * builds a controller id.
 *
 * macOS/Linux: for venv-style paths the "/bin" segment is dropped while the
 * "python" filename is kept:
 *   /x/y/.venv/bin/python  ->  /x/y/.venv/python
 * System interpreters like /usr/bin/python3 (<= 4 segments) are left untouched.
 *
 * Windows: nothing is dropped; the path is only put in VS Code's fsPath form
 * (backslashes, lower-case drive letter), because that is what Jupyter reads
 * off the interpreter's Uri:
 *   C:\x\.venv\Scripts\python.exe  ->  c:\x\.venv\Scripts\python.exe
 *
 * Mirrors `getNormalizedInterpreterPath` in microsoft/vscode-jupyter
 * (src/platform/pythonEnvironments/info/interpreter.ts). If upstream changes
 * the scheme this — and the controller ids derived from it — break.
 */
export function normalizeInterpreterPath(
  p: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    return vscode.Uri.file(p).fsPath;
  }
  const parts = p.split("/");
  const last = parts[parts.length - 1] ?? "";
  const second = parts[parts.length - 2] ?? "";
  if (parts.length > 4 && last.startsWith("python") && second === "bin") {
    return [...parts.slice(0, -2), last].join("/");
  }
  return p;
}

/**
 * Compute the NotebookController id the Jupyter extension registers for a given
 * interpreter, so callers can attach a kernel by interpreter path instead of
 * hashing the id themselves. Format (derived empirically from the ids Jupyter
 * registers — see the VS Code log "wanted kernel ... all: ..."):
 *   .jvsc74a57bd0<sha256(uriPath)>.<normPath>.<normPath>.-m#ipykernel_launcher
 * where uriPath is the normalized path as a Uri path. On macOS/Linux that is
 * the path itself; on Windows it is "/c:/x/.venv/Scripts/python.exe"
 * (`getInterpreterHash` hashes `Uri.path`, the id embeds `fsPath`).
 * The Python version does not appear in the id for interpreter-backed kernels.
 */
export function controllerIdForInterpreter(
  pythonPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized = normalizeInterpreterPath(pythonPath, platform);
  const hashed = platform === "win32" ? vscode.Uri.file(normalized).path : normalized;
  const sha = crypto.createHash("sha256").update(hashed).digest("hex");
  return `.jvsc74a57bd0${sha}.${normalized}.${normalized}.-m#ipykernel_launcher`;
}

/**
 * Bind a controller to a notebook via the `notebook.selectKernel` command,
 * retrying because the command silently no-ops when the controller doesn't
 * exist yet. For a freshly registered interpreter the Jupyter extension creates
 * the controller a beat after the interpreter becomes known, so a single select
 * can fire too early and never bind — leaving the next cell execution to pop the
 * kernel picker. Re-issuing the select on an interval guarantees one attempt
 * lands once the controller is live.
 */
export async function selectKernelById(
  notebookUri: vscode.Uri,
  kernelId: string,
  attempts = 1,
  intervalMs = 600
): Promise<void> {
  for (let i = 0; i < Math.max(1, attempts); i++) {
    await vscode.commands.executeCommand("notebook.selectKernel", {
      notebookEditor: { notebookUri },
      id: kernelId,
      extension: JUPYTER_EXTENSION_ID
    });
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
