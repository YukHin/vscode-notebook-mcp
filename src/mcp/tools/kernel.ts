import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema
} from "../../schemas/index.js";
import { resolveNotebook, forgetRuns } from "../../utils/notebook.js";
import {
  controllerIdForInterpreter,
  selectKernelById
} from "../../utils/kernel.js";
import {
  registerInterpreter,
  getWorkspaceInterpreter,
  InterpreterRegistration
} from "../../utils/pythonEnv.js";
import { READ_ONLY, EDITS, DESTRUCTIVE } from "./annotations.js";

const TextResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }] });

const ErrorResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], isError: true });

const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";

let jupyterApi: any | undefined;

async function getJupyterApi(): Promise<any> {
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
 * Wait for an in-flight kernel restart to finish.
 *
 * `jupyter.restartkernel` kicks the restart off fire-and-forget — its handler
 * (`restartKernelImpl` in vscode-jupyter) calls `wrapKernelMethod("restart")`
 * without awaiting it, so `executeCommand` resolves while the old kernel is
 * still alive. Returning then would let the caller's next execution race the
 * not-yet-restarted session and see stale state. We watch the kernel's public
 * status instead: a restart drives it out of "idle" (restarting/starting/busy)
 * and back to "idle"; "dead" means the restart failed. Subscribe BEFORE issuing
 * the command so no transition is missed (status changes are events, not polled).
 *
 * Two bounds keep this from hanging: if the restart never *starts* within
 * `startGraceMs` we stop waiting (the environment may not surface the transition
 * — e.g. the headless test host doesn't honor the command at all — or the
 * restart finished too fast to observe); once it has started we allow up to
 * `totalTimeoutMs` for it to settle back to idle.
 */
function waitForKernelRestart(
  kernel: any,
  startGraceMs = 5_000,
  totalTimeoutMs = 60_000
): Promise<string> {
  return new Promise<string>((resolve) => {
    if (typeof kernel?.onDidChangeStatus !== "function") {
      resolve(kernel?.status ?? "unknown");
      return;
    }
    let started = false;
    let settled = false;
    const finish = (status: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(totalTimer);
      try {
        sub?.dispose?.();
      } catch {
        // disposing the listener is best-effort
      }
      resolve(status);
    };
    const onStatus = () => {
      const s = kernel?.status;
      if (
        s === "restarting" ||
        s === "autorestarting" ||
        s === "starting" ||
        s === "busy"
      ) {
        // The restart is underway — stop the start grace and wait for idle.
        started = true;
        clearTimeout(graceTimer);
      } else if (s === "dead") {
        finish(s);
      } else if (s === "idle" && started) {
        finish(s);
      }
    };
    const sub = kernel.onDidChangeStatus(onStatus);
    const graceTimer = setTimeout(
      () => finish(kernel?.status ?? "unknown"),
      startGraceMs
    );
    const totalTimer = setTimeout(
      () => finish(kernel?.status ?? "unknown"),
      totalTimeoutMs
    );
  });
}

const KernelInfoInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const RestartKernelInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const SelectKernelInput = {
  kernel_id: z
    .string()
    .optional()
    .describe(
      "Kernel controller id (e.g. 'python3' or a Jupyter kernelspec id). Takes precedence over python_path. Omit both to use what the user already has."
    ),
  python_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to a Python interpreter (e.g. a venv's bin/python or Scripts\\python.exe). The matching Jupyter controller id is computed automatically. Ignored if kernel_id is given. Omit both to use what the user already has."
    ),
  replace_running_kernel: z
    .boolean()
    .default(false)
    .describe(
      "Allow switching away from a kernel that is already running for this notebook. Switching discards that kernel's variables, so only set this when the user asked for a different kernel."
    ),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

export function registerKernelTools(server: McpServer): void {
  server.tool(
    "notebook_get_kernel_info",
    "Get the active notebook's kernel: language, status, and notebook URI.",
    KernelInfoInput,
    READ_ONLY,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      let kernel: any;
      try {
        const api = await getJupyterApi();
        kernel = await api?.kernels?.getKernel?.(notebook.uri);
      } catch (err) {
        return ErrorResult(
          `Error: cannot reach Jupyter extension. ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (!kernel) {
        const result = {
          connected: false,
          notebookUri: notebook.uri.toString()
        };
        if (response_format === "json") {
          return TextResult(JSON.stringify(result, null, 2));
        }
        return TextResult(
          `# Kernel Info\n\nNo kernel connected for ${notebook.uri.toString()}.\n\nUse notebook_select_kernel to attach one.`
        );
      }

      const result = {
        connected: true,
        language: kernel.language ?? "unknown",
        status: kernel.status ?? "unknown",
        notebookUri: notebook.uri.toString()
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      return TextResult(
        [
          `# Kernel Info`,
          `- **Language**: ${result.language}`,
          `- **Status**: ${result.status}`,
          `- **Notebook**: ${result.notebookUri}`
        ].join("\n")
      );
    }
  );

  server.tool(
    "notebook_select_kernel",
    "Make sure a notebook has a kernel, respecting the user's setup. Without kernel_id or python_path: keeps the kernel that is already running, or else attaches the workspace's selected Python interpreter (the one Pylance and the terminal use), and only opens the picker if there is none. With kernel_id or python_path: attaches that kernel, but refuses to replace a running kernel unless replace_running_kernel is true. A kernel that was selected but has not run any cell yet counts as not running.",
    SelectKernelInput,
    EDITS,
    async ({ kernel_id, python_path, replace_running_kernel, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      let current: any;
      try {
        const api = await getJupyterApi();
        current = await api?.kernels?.getKernel?.(notebook.uri);
      } catch {
        // no Jupyter API: treat as no running kernel
      }
      const explicit = kernel_id !== undefined || python_path !== undefined;

      if (current && !explicit) {
        const kept = {
          notebookUri: notebook.uri.toString(),
          mode: "kept",
          connected: true,
          language: current.language ?? null,
          status: current.status ?? null
        };
        if (response_format === "json") {
          return TextResult(JSON.stringify(kept, null, 2));
        }
        return TextResult(
          `# Kernel Selection\n\nKept the kernel that is already running: ${kept.language} (${kept.status}). Nothing was changed.`
        );
      }
      if (current && explicit && !replace_running_kernel) {
        return ErrorResult(
          `Error: this notebook already has a running ${current.language ?? ""} kernel (${current.status ?? "unknown"}). Switching kernels discards its variables. Omit kernel_id/python_path to keep it, or pass replace_running_kernel: true if the user asked to switch.`
        );
      }

      // With no explicit choice, use the interpreter the user already picked
      // for this workspace rather than a picker an agent can't operate.
      let pythonPath = python_path;
      let mode = kernel_id || python_path ? "programmatic" : "picker";
      if (!explicit) {
        const workspaceInterpreter = await getWorkspaceInterpreter(notebook.uri);
        if (workspaceInterpreter) {
          pythonPath = workspaceInterpreter;
          mode = "workspace-interpreter";
        }
      }

      // Prefer an explicit kernel_id; otherwise derive the controller id from
      // the interpreter path so callers never have to hash it themselves.
      const effectiveKernelId =
        kernel_id ??
        (pythonPath ? controllerIdForInterpreter(pythonPath) : undefined);

      let registration: InterpreterRegistration | undefined;
      let interpreterRestored = false;
      try {
        // Make the Python extension aware of the interpreter first, so a venv
        // the user has never selected in VS Code still gets a controller to
        // bind to. Best effort: if it fails we still try to select by id.
        if (pythonPath) {
          try {
            registration = await registerInterpreter(pythonPath);
          } catch (err) {
            console.error(
              `[notebook_select_kernel] could not register interpreter ${pythonPath}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }

        if (effectiveKernelId) {
          // When we just registered a fresh interpreter, the controller may
          // appear a beat after selection — retry so the bind isn't lost.
          await selectKernelById(
            notebook.uri,
            effectiveKernelId,
            pythonPath ? 10 : 1
          );
        } else {
          await vscode.commands.executeCommand("notebook.selectKernel", {
            notebookEditor: { notebookUri: notebook.uri }
          });
        }
      } catch (err) {
        return ErrorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        // Registering may have switched the workspace's Python interpreter,
        // which Pylance, terminals and debugging share. The notebook keeps the
        // kernel it was just given; put everything else back.
        interpreterRestored = (await registration?.restore()) ?? false;
      }

      let confirmed: any;
      try {
        const api = await getJupyterApi();
        confirmed = await api?.kernels?.getKernel?.(notebook.uri);
      } catch {
        // best-effort confirmation only
      }

      const result = {
        notebookUri: notebook.uri.toString(),
        requested: effectiveKernelId ?? null,
        pythonPath: pythonPath ?? null,
        mode,
        replacedRunningKernel: !!current,
        workspaceInterpreterRestored: interpreterRestored,
        connected: !!confirmed,
        language: confirmed?.language ?? null,
        status: confirmed?.status ?? null
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [`# Kernel Selection`, ""];
      if (mode === "workspace-interpreter") {
        lines.push(`Attached the workspace's Python interpreter: \`${pythonPath}\`.`);
      } else if (effectiveKernelId) {
        lines.push(`Attempted to select **${effectiveKernelId}**.`);
      } else {
        lines.push(`No workspace interpreter is selected, so the kernel picker was opened for the user.`);
      }
      if (current) {
        lines.push("The previously running kernel was replaced; its variables are gone.");
      }
      lines.push(
        result.connected
          ? `Currently connected: ${result.language} (${result.status})`
          : `No kernel currently reported as connected (the picker may still be open).`
      );
      return TextResult(lines.join("\n"));
    }
  );

  server.tool(
    "notebook_restart_kernel",
    "Restart the active notebook's kernel, clearing all in-memory state (variables, imports) while leaving cell outputs untouched. The kernel must already be connected — use notebook_select_kernel first if not.",
    RestartKernelInput,
    DESTRUCTIVE,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      let kernel: any;
      try {
        const api = await getJupyterApi();
        kernel = await api?.kernels?.getKernel?.(notebook.uri);
      } catch (err) {
        return ErrorResult(
          `Error: cannot reach Jupyter extension. ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (!kernel) {
        return ErrorResult(
          `Error: no kernel connected for ${notebook.uri.toString()}. Use notebook_select_kernel to attach one before restarting.`
        );
      }

      let finalStatus: string;
      try {
        // Subscribe to the kernel's status BEFORE issuing the command so the
        // restart transitions aren't missed, then block until the restart
        // actually completes (the command itself returns early — see
        // waitForKernelRestart).
        const restartDone = waitForKernelRestart(kernel);
        await vscode.commands.executeCommand("jupyter.restartkernel", {
          notebookEditor: { notebookUri: notebook.uri }
        });
        finalStatus = await restartDone;
        forgetRuns(notebook);
      } catch (err) {
        return ErrorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let confirmed: any;
      try {
        const api = await getJupyterApi();
        confirmed = await api?.kernels?.getKernel?.(notebook.uri);
      } catch {
        // best-effort confirmation only
      }

      const result = {
        notebookUri: notebook.uri.toString(),
        restarted: true,
        connected: !!confirmed,
        language: confirmed?.language ?? null,
        status: confirmed?.status ?? finalStatus ?? null
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      return TextResult(
        [
          `# Kernel Restart`,
          ``,
          `Restarted the kernel for ${result.notebookUri}.`,
          result.connected
            ? `Currently connected: ${result.language} (${result.status})`
            : `No kernel currently reported as connected.`
        ].join("\n")
      );
    }
  );
}
