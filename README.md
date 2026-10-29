<img src="images/icon.png" width="96" alt="" align="right">

# vscode-notebook-mcp

**Jupyter notebooks for AI agents other than GitHub Copilot.** Copilot works on a notebook inside VS Code: it edits cells in the open editor and runs them in the kernel you're using. Agents outside VS Code — Claude Code, Codex, or any other MCP client — can't. They can only rewrite the `.ipynb` file on disk while the same notebook is open in VS Code, and that breaks in three ways:

- **File conflicts you can't save past.** The editor and the file now disagree. VS Code reports that the file on disk is newer, and saving means choosing between throwing away your unsaved work and overwriting the agent's changes. Outputs and edits get lost either way.
- **No access to the running kernel.** The agent can't run a cell in the kernel you're using or read its variables, so it re-runs whole notebooks from scratch or guesses.
- **Lost context.** Nothing tells the agent which code the kernel actually ran, so it reasons about variables that no longer match the code on screen.

This extension closes that gap. It exposes the notebooks open in VS Code to MCP-compatible agents, so they work the way Copilot does:

- **Edit in the editor, not on disk — no file conflicts.** Changes go through VS Code's notebook API, into the document you have open: undoable, marked in the editor, other cells' outputs untouched, and saved by VS Code itself only when asked, so there is never a second version of the file to conflict with.
- **Run in the live kernel.** Cells run in the kernel VS Code is already using, so variables survive between the agent's steps; long runs, interrupts and restarts are handled.
- **Change only what's needed.** Replace one piece of a cell instead of rewriting it, address cells by stable ids, and get compact outputs instead of whole HTML tables.
- **Keep the context straight.** The agent can see which cells were edited since they ran or never ran in this kernel, rerun just what's stale, and inspect variables without adding cells.
- **Stay out of the way.** It keeps your kernel and Python interpreter choices, doesn't hide your terminal, and connects each Claude Code session to the right VS Code window.

> **This is a fork.** It is based on [caryan/vscode-notebook-mcp](https://github.com/caryan/vscode-notebook-mcp) by Colm Ryan (MIT), forked at v0.3.0 (commit `9e8061a`). The original license and copyright are kept in [LICENSE](LICENSE).
>
> **How the fork was made.** The changes from 0.4.0 on — token authentication and DNS-rebinding protection, reliable execution tracking, Windows support, partial edits, stable cell ids, long-run handling, output budgets, stale-cell tracking, variable inspection, agent-edit markers and the stdio bridge — were designed, implemented and tested mainly by [Claude Code](https://claude.com/claude-code) (Anthropic's coding agent, model Claude Opus 5.5), working from a code review it wrote of the original project and directed and reviewed by YukHin. See [CHANGELOG.md](CHANGELOG.md) for the full list and the commit history for details.
>
> Status: pre-alpha.

## Tools (22)

### Discovery
| Tool | Description |
|---|---|
| `notebook_list_open` | List all open notebooks with URI, file name, cell count, and which is active |
| `notebook_open` | Open a `.ipynb` file (absolute path, `file://` URI, or workspace-relative) so its cells become available |
| `notebook_list_cells` | List cells with stable id, index, kind, language, preview, execution state, and run state (fresh / edited since run / not run in this kernel) |
| `notebook_status` | Does the kernel match the code on screen? Edited, not-run and downstream cells, running cells, unsaved changes |
| `notebook_get_cell_content` | Full source of a cell |
| `notebook_get_cell_output` | Current outputs of a cell (text, errors, images), within an output budget |

### Cell manipulation
| Tool | Description |
|---|---|
| `notebook_insert_cell` | Insert a code or markdown cell at any position; optionally execute |
| `notebook_replace_in_cell` | Replace one exact piece of text in a cell, leaving the rest untouched |
| `notebook_apply_edits` | Several replace / whole-cell edits across cells, all-or-nothing |
| `notebook_edit_cell` | Replace the whole contents of a cell |
| `notebook_delete_cell` | Delete a cell |
| `notebook_save` | Save the editor's in-memory notebook to its `.ipynb` |

### Execution
| Tool | Description |
|---|---|
| `notebook_run_cell` | Execute a code cell and return this run's outputs; long runs report `running` after `timeout_seconds` |
| `notebook_run_cells` | Run a range, everything from the first stale cell on (`mode: "stale"`), or all; stops at the first error; one summary |
| `notebook_wait_cell` | Wait for a running cell without starting it again |
| `notebook_inspect_variables` | Kernel variables with type / shape / dtype / columns, or previews of named ones — no cell added, execution count unchanged |
| `notebook_interrupt_kernel` | Stop running and queued cells, keeping kernel state |
| `notebook_clear_cell_output` | Clear outputs of one cell |
| `notebook_clear_all_outputs` | Clear outputs of every cell |

### Kernel
| Tool | Description |
|---|---|
| `notebook_get_kernel_info` | Language, status, notebook URI |
| `notebook_select_kernel` | Make sure the notebook has a kernel. With no arguments it keeps the running kernel or attaches the workspace's selected Python interpreter; with `python_path` or `kernel_id` it attaches that one, but won't replace a running kernel unless `replace_running_kernel` is set (see [Kernel selection](#kernel-selection)) |
| `notebook_restart_kernel` | Restart the kernel, clearing in-memory state but keeping cell outputs |

All tools accept an optional `notebook_uri` (omitted → uses the active notebook editor) and `response_format` (`"markdown"` or `"json"`). Cell tools take `cell_id` (from `notebook_list_cells`; it survives inserts and deletes) or `index`. Tools that return outputs take `max_output_chars` (default 20,000; long text keeps its start and end) and `max_images` (default 4), and return one form per output (no HTML duplicate of a DataFrame, no ANSI color codes).

## Installation

### Requirements

- VS Code 1.85 or later, with the **Python** and **Jupyter** extensions (`ms-python.python`, `ms-toolsai.jupyter`).
- **Node.js** 18 or later on PATH, to build the extension and to run the bridge that Claude Code talks to.
- A Python environment with `ipykernel` for your notebooks (what Jupyter in VS Code needs anyway).
- [Claude Code](https://claude.com/claude-code), or another MCP client.

### Install from the Marketplace

In VS Code, open the Extensions view, search for **Notebook MCP for Claude Code & Codex**, and install it. Or from a terminal:

```bash
code --install-extension yukhin.vscode-notebook-mcp
```

### Or build from source

```bash
git clone https://github.com/YukHin/vscode-notebook-mcp.git
cd vscode-notebook-mcp
npm install
npx @vscode/vsce package --no-dependencies
code --install-extension vscode-notebook-mcp-0.6.1.vsix
```

The extension id is `yukhin.vscode-notebook-mcp`. If you installed an earlier build published as `colmryan.vscode-notebook-mcp`, uninstall it first: `code --uninstall-extension colmryan.vscode-notebook-mcp`.

On Windows PowerShell, if scripts are disabled (`npm.ps1 cannot be loaded`), use `npm.cmd` and `npx.cmd` instead, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

Installing or updating an extension makes VS Code restart the extension host in **every open window**, which stops running Jupyter kernels there. Do it when no notebook has state you want to keep.

After installing, each VS Code window shows a notebook icon with `:49777` (or the next free port) on the right of the status bar. Click it for the server info.

## Connecting Claude Code

1. In VS Code, open the command palette (Ctrl+Shift+P / Cmd+Shift+P) and run **Notebook MCP: Add to Claude Code**, then confirm. This runs, for all your projects:
   ```bash
   claude mcp add --scope user notebook -- node ~/.vscode-notebook-mcp/bridge.js
   ```
   If VS Code can't find the `claude` command, the command is copied to your clipboard instead; run it in a terminal (**Copy Claude Code Command** does the same).
2. Start a **new** Claude Code session from your project folder. Claude Code loads MCP servers when a session starts.
3. Check the connection from that folder:
   ```bash
   claude mcp get notebook
   ```
   It should say "Connected". The bridge talks to the VS Code window whose workspace contains the folder Claude Code runs in, so open the project folder in VS Code first. With several windows open, each project reaches its own window; to point at a different folder, set `NOTEBOOK_MCP_WORKSPACE`.

No token is stored in Claude Code's config: the bridge reads it from `~/.vscode-notebook-mcp/<pid>.json`, which each window writes when it starts.

Other MCP clients can use the bridge the same way (a stdio server: `node ~/.vscode-notebook-mcp/bridge.js`), or talk HTTP directly to the URL in that file with `Authorization: Bearer <token>`. To keep the token out of a checked-in `.mcp.json`, reference an environment variable: `"headers": { "Authorization": "Bearer ${NOTEBOOK_MCP_TOKEN}" }`.

## Using it

Open the notebook in VS Code, then ask Claude Code about it in plain language. It sees the notebook as it is in the editor (including unsaved changes and the running kernel), and its edits land in the editor, where you can undo them.

Examples of what to ask:

- "Look at `analysis.ipynb`. Which cells are out of date, and bring the kernel up to date." → `notebook_status`, then `notebook_run_cells` with `mode: "stale"`.
- "In the cell that loads the data, change the date filter to 2024 and rerun everything after it." → `notebook_replace_in_cell` (changes only that line), then `notebook_run_cells`.
- "What's in the kernel right now? I need the shape of `df` and the columns." → `notebook_inspect_variables` (no cell is added, the execution count doesn't change).
- "Run the training cell; it takes about 10 minutes." → `notebook_run_cell` returns `running` after its timeout with the output so far; Claude Code keeps waiting with `notebook_wait_cell`, or stops it with `notebook_interrupt_kernel` if you ask.
- "Fix the error in cell 7 and save the notebook." → edit, run, `notebook_save`.

What you'll see in VS Code:

- Cells Claude changed or inserted show **Changed by agent** / **Inserted by agent** in their cell status bar until you edit or run them. Undo with Ctrl+Z (Cmd+Z) in the notebook.
- The first time Claude inspects variables, Jupyter asks *"Do you want to grant Kernel access to the extension Notebook MCP for Claude Code & Codex?"*. Choose **Allow** (once). To change it later, run **Jupyter: Manage Access To Jupyter Kernels**.
- To approve every change before it's applied, turn on the setting `notebook-mcp.confirmEdits`: a diff opens and a notification asks **Apply** or **Reject** (no answer in 2 minutes rejects).
- Edits stay in the editor until saved. Claude Code is told to use these tools, not its file tools, for open notebooks, and to call `notebook_save` when done.

The kernel is chosen the way you'd expect: if the notebook already has a running kernel, it is kept; otherwise the workspace's selected Python interpreter is used. Claude Code only switches to a different kernel if you ask it to (switching discards the kernel's variables), and it puts your workspace's Python interpreter back afterwards.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `claude mcp get notebook` fails: "No VS Code window with Notebook MCP is open for …" | Open that folder (or a parent) in VS Code, or set `NOTEBOOK_MCP_WORKSPACE` to the folder of an open window. |
| Claude Code doesn't list the notebook tools | Start a new Claude Code session; check `claude mcp list`. |
| The status bar shows the notebook icon with `✗` | Click it for the error, then **Restart**. Another program may hold the ports 49777–49876; set `notebook-mcp.port`. |
| `notebook_inspect_variables` says it has no kernel access | Run **Jupyter: Manage Access To Jupyter Kernels** and allow Notebook MCP for Claude Code & Codex. |
| An interrupt doesn't stop a cell on Windows | `time.sleep` and some C extensions can't be interrupted until they return. Wait (`notebook_wait_cell`) or restart the kernel. |
| You think the token leaked | Run **Notebook MCP: Regenerate Access Token**. The bridge picks up the new one automatically. |

For development (running from source with F5, tests), see [Development](#development).

### Security

The server listens on `127.0.0.1` only, rejects requests whose `Host` isn't `127.0.0.1`/`localhost` on its port (DNS rebinding), rejects any request with an `Origin` header (web pages), sends no CORS headers, and requires the bearer token on `/mcp`. If the token leaks, run **Notebook MCP: Regenerate Access Token**.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `notebook-mcp.port` | `49777` | Preferred port. Auto-increments if busy (up to +99). |
| `notebook-mcp.confirmEdits` | `false` | Review each agent change first: a diff opens and a notification asks to apply or reject (no answer in 2 minutes rejects). |

Cells the agent changed or inserted show **Changed by agent** / **Inserted by agent** in their cell status bar until you edit or run them; undo with Ctrl+Z (Cmd+Z).

### Commands

- `Notebook MCP: Add to Claude Code`
- `Notebook MCP: Copy Claude Code Command`
- `Notebook MCP: Regenerate Access Token`
- `Notebook MCP: Restart Server`
- `Notebook MCP: Show Server Info`

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code window                       │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Jupyter extension (ms-toolsai.jupyter)           │  │
│  │                                                   │  │
│  │  Notebook document  ◄──►  Kernel  ──►  Outputs    │  │
│  └───────────────────────────────────────────────────┘  │
│                          ▲                              │
│                          │ vscode.NotebookEdit,         │
│                          │ notebook.cell.execute,       │
│                          │ jupyter.kernels.getKernel    │
│                          │                              │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │  This extension                                   │  │
│  │                                                   │  │
│  │   HTTP server :49777  ──►  MCP tools (13)         │  │
│  │   (StreamableHTTPServerTransport)                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                              │ HTTP (MCP protocol)
                              ▼
                ┌───────────────────────────────┐
                │   AI agent                    │
                │   (Claude Code, Cursor, etc.) │
                └───────────────────────────────┘
```

### Implementation notes

- **Writes** go through `vscode.NotebookEdit` + `vscode.WorkspaceEdit`, preserving undo/redo.
- **Execution** dispatches `notebook.cell.execute` and waits by polling `cell.executionSummary.success` for a `boolean` value (VS Code creates the summary as soon as execution starts but `success` only becomes a boolean when the kernel finishes).
- **Inserted cells** are tagged with a metadata id so the executor can find them again after the index shifts due to other concurrent edits.
- **Multi-notebook**: every tool accepts `notebook_uri`. Resolution: explicit URI → look up in `vscode.workspace.notebookDocuments` (or open it); otherwise fall back to `vscode.window.activeNotebookEditor`.

## Kernel selection

The agent-friendly way to attach a kernel is to give `notebook_select_kernel` a **`python_path`** — the absolute path to the interpreter you want (e.g. a venv's `bin/python`):

```jsonc
notebook_select_kernel({ "python_path": "/abs/path/to/.venv/bin/python" })
```

You don't have to know any controller id, and the interpreter doesn't have to be one you've already selected in VS Code — the tool does both the discovery and the id computation for you. (`kernel_id` is still accepted for the rare case you already hold a controller id; without either argument the tool falls back to popping VS Code's kernel picker, which is useless to a headless agent.)

Under the hood this navigates two pieces of friction — **the Jupyter extension exposes no public API to enumerate or assign controllers, and controller ids for interpreter-backed Python kernels are derived strings it computes internally**:

1. **No controller until the interpreter is known.** A venv you've never selected in VS Code has no controller to bind to. Given `python_path`, the tool registers the interpreter with the Python extension first (`registerInterpreter` in `src/utils/pythonEnv.ts`: refresh discovery, resolve the path, set it active for the workspace) so Jupyter creates one — the same thing "Python: Select Interpreter → Enter interpreter path…" would do, done programmatically.
2. **Computing the id.** The controller id is built from the interpreter path (`controllerIdForInterpreter` in `src/utils/kernel.ts`). Empirically (verified by reading VS Code's "wanted kernel … all: …" log line) the format for an interpreter-backed kernel is:

   ```
   .jvsc74a57bd0<sha256(normalizedInterpreterPath)>.<normPath>.<normPath>.-m#ipykernel_launcher
   ```

   Where `normalizedInterpreterPath` strips just the `bin/` segment of a venv path while keeping the `python` filename — so `/x/y/.venv/bin/python` becomes `/x/y/.venv/python` (system paths like `/usr/bin/python3` are left untouched). See `getKernelId` and `getInterpreterKernelSpecName` in [microsoft/vscode-jupyter](https://github.com/microsoft/vscode-jupyter/blob/main/src/kernels/helpers.ts).

The controller lands a beat after the interpreter becomes known, so the tool retries `notebook.selectKernel` for a few seconds (`selectKernelById`) rather than firing once and risking a silent no-op. This is brittle to upstream changes in the Jupyter extension, but the failure mode is informative — VS Code logs both the requested id and the available ones (`wanted kernel DOES NOT EXIST, wanted: <id>, all: <ids>`) so a changed format can be reverse-engineered the same way. The integration suite exercises the full path (including a brand-new, never-registered venv) in `test/integration/suite/kernel.test.ts`.

Still open / not yet handled: other forms of "kernel" (a global kernelspec name, a remote Jupyter server URL), and version probing of the interpreter.

## Development

```bash
npm install
npm run build       # esbuild bundle
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # @vscode/test-electron + Mocha integration tests
```

Press **F5** in VS Code to launch the Extension Development Host.

### Running the tests

`npm test` runs the integration suite under `@vscode/test-electron`. It downloads a fresh **VS Code Insiders** build, installs `ms-python.python` and `ms-toolsai.jupyter` into it, opens the test workspace at `test/fixtures/workspace/`, and runs Mocha specs that drive the MCP tools through an in-memory transport (no HTTP). Test files live in `test/integration/suite/`.

> Why Insiders: macOS refuses to launch a second extension-host of the same bundle id, so running tests against stable VS Code fails when you already have stable VS Code open ("currently only supported if no other instance of Code is running"). Insiders and stable have distinct bundle ids and coexist. Override with `VSCODE_TEST_CHANNEL=stable` if you don't have stable open.

Prerequisites:

- [`uv`](https://docs.astral.sh/uv/) on PATH — used to manage the Python venv at `test/fixtures/python/.venv` that supplies the test kernel (ipykernel + matplotlib + numpy + plotly). Pinned to Python 3.13 via `.python-version`.

The `pretest` hook builds the extension (`npm run build`), compiles the tests (`npm run build:test` → `out/`), and runs `scripts/setup-test-python.sh` which is idempotent (`uv sync` only).

Notes on what the tests cover:

- **Non-execution tools** (`notebooks.test.ts`, `cells.test.ts`) — list/open/get/insert/edit/delete/clear, error paths, active-editor fallback. Run without a Python kernel.
- **Execution + kernel** (`execution.test.ts`, `kernel.test.ts`) — depend on `selectVenvKernel` attaching the venv's interpreter; see [Kernel selection](#kernel-selection).
- **Plotly** (`plotly.test.ts`) — verifies a Plotly figure flows through the hidden webview renderer to a PNG image content block.

### Dependencies

**Runtime (`dependencies`)**

- **`@modelcontextprotocol/sdk`** — the MCP server itself. We use `McpServer` (one per session, see `src/mcp/server.ts`) and `StreamableHTTPServerTransport` to speak MCP over the embedded HTTP server. Tool registration in `src/mcp/tools/*.ts` is all SDK API.
- **`plotly.js-dist-min`** — bundled into `dist/plotly.min.js` by the `copy:plotly` script and loaded inside the `notebook-mcp.plotlyRenderer` webview, which runs as a background editor tab. The webview converts Plotly figure JSON to PNG via `Plotly.newPlot` + `Plotly.toImage`. We can't run Plotly in the extension host (no DOM), and shipping the bundle locally avoids a runtime CDN fetch under the webview's strict CSP. Using `-dist-min` (the prebuilt minified bundle) instead of `plotly.js` keeps the VSIX smaller and avoids pulling in Plotly's full build toolchain.
- **`zod`** — schema definitions in `src/schemas/index.ts` and per-tool input validation across `cells.ts` / `kernel.ts` / `notebooks.ts`. The MCP SDK accepts zod schemas directly when registering tools, so we get validation + JSON Schema generation for free.

**Dev (`devDependencies`)**

- **`@types/node`** — Node typings for extension-host code (`Buffer`, `process`, `http`, etc.).
- **`@types/vscode`** — VS Code Extension API typings. Pinned to `^1.85.0` to match `engines.vscode`.
- **`esbuild`** — bundler used by `npm run build` to produce the single `dist/extension.js` that VS Code loads. Chosen over `tsc` for build speed and tree-shaking; `--external:vscode` keeps the host-provided module out of the bundle.
- **`typescript`** — provides `tsc` for the `typecheck` script (`tsc --noEmit`) and the `build:test` script (`tsc -p tsconfig.test.json` → `out/`). Esbuild handles the production bundle; tsc handles the test build because Mocha loads test files directly.
- **`mocha` + `@types/mocha`** — test runner, the convention with `@vscode/test-electron`. The bootstrapper at `test/integration/suite/index.ts` discovers `*.test.js` files under `out/test/integration/suite/` and feeds them to Mocha.
- **`@vscode/test-electron`** — downloads a stable VS Code into `.vscode-test/`, installs `ms-toolsai.jupyter` into it, and launches it with the extension under development plus the test workspace fixture. See `test/integration/runTest.ts`.
- **`glob` + `@types/glob`** — used by the Mocha bootstrapper to discover compiled test files.

### Building a VSIX

To produce an installable `.vsix` file:

```bash
npx @vscode/vsce package
```

This runs `vscode:prepublish` (which builds via esbuild) and writes `vscode-notebook-mcp-<version>.vsix` to the repo root. Install it with:

```bash
code --install-extension vscode-notebook-mcp-<version>.vsix
```

`.vscodeignore` keeps the package small by excluding TS sources, `node_modules`, source maps, and dev configs — only the bundled `dist/`, `package.json`, `README.md`, and `LICENSE` are shipped.

## References

Other projects along similar lines to this project:

- [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server) — MCP server that talks to a running Jupyter server via HTTP/WebSocket.
- [olavocarvalho/vscode-runtime-notebook-mcp](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp) — similar architecture as this project (VS Code Notebook API + embedded HTTP MCP server).

The original author built the upstream project fresh, to learn and to have room to tweak the design and develop new features such as reading Plotly images; this fork builds on that work.

## License

MIT. Copyright (c) 2026 Colm Ryan for the original project; the fork's changes are released under the same license.
