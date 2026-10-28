import * as vscode from "vscode";

const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";

/** The parts of the Jupyter extension's public kernel API we use. */
export interface JupyterKernel {
  readonly status: string;
  readonly language: string;
  onDidChangeStatus: vscode.Event<string>;
  executeCode(
    code: string,
    token: vscode.CancellationToken
  ): AsyncIterable<{ items: { mime: string; data: Uint8Array }[] }>;
}

let jupyterApi: any | undefined;

/** Activate the Jupyter extension on first use and return its API. */
export async function getJupyterApi(): Promise<any> {
  if (jupyterApi) return jupyterApi;
  const ext = vscode.extensions.getExtension(JUPYTER_EXTENSION_ID);
  if (!ext) {
    throw new Error(
      `Jupyter extension (${JUPYTER_EXTENSION_ID}) is not installed.`
    );
  }
  jupyterApi = await ext.activate();
  return jupyterApi;
}

/**
 * The started kernel of an open notebook, or undefined. The Jupyter API only
 * reports kernels that have run something; a selected-but-unstarted kernel is
 * invisible here.
 */
export async function getKernel(uri: vscode.Uri): Promise<JupyterKernel | undefined> {
  try {
    const api = await getJupyterApi();
    return (await api?.kernels?.getKernel?.(uri)) ?? undefined;
  } catch {
    return undefined;
  }
}
