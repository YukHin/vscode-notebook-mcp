import * as vscode from "vscode";

const PYTHON_EXTENSION_ID = "ms-python.python";

interface PythonEnvironmentsApi {
  getActiveEnvironmentPath?: (
    scope?: vscode.WorkspaceFolder
  ) => { path: string } | undefined;
  updateActiveEnvironmentPath?: (
    path: string,
    scope?: vscode.WorkspaceFolder
  ) => Promise<void>;
  resolveEnvironment?: (
    path: string
  ) => Promise<{ executable?: { uri?: vscode.Uri } } | undefined>;
  refreshEnvironments?: () => Promise<void>;
  known?: { path: string }[];
}

export interface InterpreterRegistration {
  /**
   * Put back the workspace's previous Python interpreter if we had to change
   * it. Resolves to true when something was restored.
   */
  restore: () => Promise<boolean>;
}

const NO_RESTORE: InterpreterRegistration = { restore: async () => false };

/**
 * Make the Python extension aware of an interpreter so the Jupyter extension
 * will create a NotebookController for it. Without this, a brand-new venv the
 * user has never selected in VS Code has no controller, so
 * `notebook.selectKernel` with its computed id silently no-ops and no kernel
 * can attach.
 *
 * This is the programmatic "Python: Select Interpreter → Enter interpreter
 * path…": refresh discovery, resolve the path, and set it as the workspace's
 * active interpreter (refresh + resolve alone don't make Jupyter create a
 * controller). That setting is shared with Pylance, the terminal, debugging
 * and test runners, so the caller must call `restore()` once the kernel is
 * selected to put the user's interpreter back. The controller lands a little after discovery, so callers select with
 * a retry (see selectKernelById).
 *
 * Throws only if the Python extension itself is unavailable; everything else is
 * best effort so callers can still fall back to selecting by id.
 */
export async function registerInterpreter(
  pythonPath: string
): Promise<InterpreterRegistration> {
  const ext = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
  if (!ext) {
    throw new Error(
      `Python extension (${PYTHON_EXTENSION_ID}) is not installed; cannot register ${pythonPath}.`
    );
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  const environments = (
    ext.exports as { environments?: PythonEnvironmentsApi }
  ).environments;
  if (!environments) {
    return NO_RESTORE;
  }

  try {
    await environments.refreshEnvironments?.();
  } catch {
    // best effort — discovery may already be warm
  }
  try {
    await environments.resolveEnvironment?.(pythonPath);
  } catch {
    // best effort — resolution can fail for paths it doesn't recognize yet
  }
  // Being "known" to the Python extension is not enough: the Jupyter extension
  // only offers a controller once the interpreter has been selected, so we
  // select it and let the caller switch the workspace back afterwards.
  const folder = vscode.workspace.workspaceFolders?.[0];
  const previous = environments.getActiveEnvironmentPath?.(folder)?.path;
  await environments.updateActiveEnvironmentPath?.(pythonPath, folder);

  // Give the Jupyter extension a moment to turn the now-known interpreter into
  // a controller before the caller selects it.
  await waitForKnownInterpreter(environments, pythonPath, 10_000);

  if (!previous || samePath(previous, pythonPath)) {
    return NO_RESTORE;
  }
  return {
    restore: async () => {
      try {
        await environments.updateActiveEnvironmentPath?.(previous, folder);
        return true;
      } catch {
        return false;
      }
    }
  };
}

/**
 * The Python interpreter the user (or another extension) has selected for the
 * workspace folder containing `resource` — the one Pylance, terminals and
 * "Run Python File" use. Undefined if the Python extension isn't installed or
 * nothing is selected. Activates the Python extension if needed.
 */
export async function getWorkspaceInterpreter(
  resource: vscode.Uri
): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  const environments = (ext.exports as { environments?: PythonEnvironmentsApi })
    .environments;
  const folder = vscode.workspace.getWorkspaceFolder(resource) ?? vscode.workspace.workspaceFolders?.[0];
  const active = environments?.getActiveEnvironmentPath?.(folder)?.path;
  if (!active) return undefined;
  // For some environment kinds (e.g. conda) the active "path" is the
  // environment folder rather than the interpreter; resolve it to the
  // executable, which is what kernel ids are built from.
  try {
    const resolved = await environments?.resolveEnvironment?.(active);
    return resolved?.executable?.uri?.fsPath ?? active;
  } catch {
    return active;
  }
}

// Compare as fsPaths, case-insensitively on Windows, so "C:\..." and the
// Python extension's "c:\..." count as the same interpreter.
function normPath(p: string): string {
  const fsPath = vscode.Uri.file(p).fsPath;
  return process.platform === "win32" ? fsPath.toLowerCase() : fsPath;
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

async function waitForKnownInterpreter(
  environments: PythonEnvironmentsApi,
  pythonPath: string,
  timeoutMs: number
): Promise<boolean> {
  const wanted = normPath(pythonPath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (environments.known?.some((e) => normPath(e.path) === wanted)) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
