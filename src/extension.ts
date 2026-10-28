import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { startMCPServer, ServerHandle } from "./mcp/server.js";
import { initPlotlyRenderer } from "./utils/plotly.js";
import { watchCellExecution } from "./utils/notebook.js";
import { registerAgentEditMarkers } from "./utils/agentEdits.js";

const TOKEN_SECRET_KEY = "notebook-mcp.token";
// One JSON file per running window, so local clients can find the port and
// token without the user copying them around (same idea as Jupyter's runtime
// connection files). The home directory is readable only by the user.
const DISCOVERY_DIR = path.join(os.homedir(), ".vscode-notebook-mcp");

let serverHandle: ServerHandle | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let lastError: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let token: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  watchCellExecution(context);
  registerAgentEditMarkers(context);
  initPlotlyRenderer(context);
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "notebook-mcp.showInfo";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("notebook-mcp.restartServer", async () => {
      await stopServer();
      await startServer();
    }),
    vscode.commands.registerCommand("notebook-mcp.showInfo", () => showInfo()),
    vscode.commands.registerCommand("notebook-mcp.copyClaudeCommand", () =>
      copyClaudeCommand()
    ),
    vscode.commands.registerCommand("notebook-mcp.addToClaudeCode", () =>
      addToClaudeCode()
    ),
    vscode.commands.registerCommand("notebook-mcp.regenerateToken", async () => {
      token = crypto.randomBytes(32).toString("base64url");
      await context.secrets.store(TOKEN_SECRET_KEY, token);
      await stopServer();
      await startServer();
      vscode.window.showWarningMessage(
        "Notebook MCP: token regenerated. Clients connected through the bridge pick it up automatically; HTTP clients configured with the old token must be updated."
      );
    })
  );

  installBridge(context);
  await startServer();
}

export async function deactivate() {
  await stopServer();
}

async function getToken(): Promise<string> {
  if (token) return token;
  const secrets = extensionContext!.secrets;
  token = await secrets.get(TOKEN_SECRET_KEY);
  if (!token) {
    token = crypto.randomBytes(32).toString("base64url");
    await secrets.store(TOKEN_SECRET_KEY, token);
  }
  return token;
}

async function startServer() {
  const preferredPort = vscode.workspace
    .getConfiguration("notebook-mcp")
    .get<number>("port", 49777);

  try {
    const version: string = extensionContext!.extension.packageJSON.version;
    serverHandle = await startMCPServer(preferredPort, await getToken(), version);
    lastError = undefined;
    writeDiscoveryFile(serverHandle.port);
    updateStatusBar();
    if (serverHandle.port !== preferredPort) {
      vscode.window.showInformationMessage(
        `Notebook MCP: port ${preferredPort} was busy, started on ${serverHandle.port} instead. Update your MCP client config: http://127.0.0.1:${serverHandle.port}/mcp`
      );
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    serverHandle = undefined;
    updateStatusBar();
    vscode.window.showErrorMessage(`Notebook MCP: ${lastError}`);
  }
}

async function stopServer() {
  if (serverHandle) {
    await serverHandle.stop();
    serverHandle = undefined;
    removeDiscoveryFile();
    updateStatusBar();
  }
}

function discoveryFilePath(): string {
  return path.join(DISCOVERY_DIR, `${process.pid}.json`);
}

function writeDiscoveryFile(port: number) {
  try {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true, mode: 0o700 });
    removeStaleDiscoveryFiles();
    const info = {
      url: `http://127.0.0.1:${port}/mcp`,
      port,
      token,
      pid: process.pid,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
        (f) => f.uri.fsPath
      ),
      startedAt: new Date().toISOString()
    };
    fs.writeFileSync(discoveryFilePath(), JSON.stringify(info, null, 2), {
      mode: 0o600
    });
  } catch (err) {
    console.error("Notebook MCP: could not write discovery file:", err);
  }
}

function removeDiscoveryFile() {
  try {
    fs.rmSync(discoveryFilePath(), { force: true });
  } catch {
    // best effort
  }
}

/** Drop files left behind by windows that crashed instead of deactivating. */
function removeStaleDiscoveryFiles() {
  for (const name of fs.readdirSync(DISCOVERY_DIR)) {
    const pid = Number(path.basename(name, ".json"));
    if (!name.endsWith(".json") || !Number.isInteger(pid) || pid === process.pid) {
      continue;
    }
    try {
      process.kill(pid, 0);
    } catch {
      fs.rmSync(path.join(DISCOVERY_DIR, name), { force: true });
    }
  }
}

const BRIDGE_PATH = path.join(DISCOVERY_DIR, "bridge.js");

/**
 * Keep a copy of the stdio bridge at a fixed path, so MCP client configs
 * don't break when the extension updates (its install folder includes the
 * version).
 */
function installBridge(context: vscode.ExtensionContext) {
  try {
    const source = path.join(context.extensionPath, "dist", "bridge.js");
    const code = fs.readFileSync(source);
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true, mode: 0o700 });
    let current: Buffer | undefined;
    try {
      current = fs.readFileSync(BRIDGE_PATH);
    } catch {
      // not installed yet
    }
    if (!current || !current.equals(code)) {
      fs.writeFileSync(BRIDGE_PATH, code);
    }
  } catch (err) {
    console.error("Notebook MCP: could not install the bridge:", err);
  }
}

/** Args for `claude mcp add` that register the bridge for all projects. */
function claudeAddArgs(): string[] {
  return ["mcp", "add", "--scope", "user", "notebook", "--", "node", BRIDGE_PATH];
}

function claudeCommand(): string {
  return `claude ${claudeAddArgs().map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;
}

async function copyClaudeCommand() {
  await vscode.env.clipboard.writeText(claudeCommand());
  vscode.window.showInformationMessage(
    "Notebook MCP: Claude Code command copied. Run it once in a terminal; Claude Code then reaches the VS Code window for whatever folder it runs in."
  );
}

function runClaude(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // shell: claude is a .cmd/.ps1 shim on some Windows installs.
    execFile("claude", args, { shell: process.platform === "win32", timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() || (err ? String(err.message) : "") });
    });
  });
}

/**
 * Register the bridge with Claude Code (user scope), replacing an existing
 * "notebook" server after asking.
 */
async function addToClaudeCode() {
  const choice = await vscode.window.showInformationMessage(
    "Add Notebook MCP to Claude Code for all your projects? This replaces any existing Claude Code MCP server named \"notebook\". Claude Code will then reach the VS Code window for the folder it runs in; no token is stored in its config.",
    { modal: true },
    "Add"
  );
  if (choice !== "Add") return;

  const probe = await runClaude(["--version"]);
  if (!probe.ok) {
    await vscode.env.clipboard.writeText(claudeCommand());
    vscode.window.showWarningMessage(
      "Notebook MCP: couldn't run the claude command from VS Code. The setup command is on your clipboard; run it in a terminal where claude works."
    );
    return;
  }
  await runClaude(["mcp", "remove", "--scope", "user", "notebook"]);
  const added = await runClaude(claudeAddArgs());
  if (added.ok) {
    vscode.window.showInformationMessage(
      "Notebook MCP: added to Claude Code. Start a new Claude Code session to use it."
    );
  } else {
    await vscode.env.clipboard.writeText(claudeCommand());
    vscode.window.showErrorMessage(
      `Notebook MCP: claude mcp add failed (${added.output.slice(0, 200)}). The command is on your clipboard to run yourself.`
    );
  }
}

function updateStatusBar() {
  if (!statusBarItem) return;
  if (serverHandle) {
    statusBarItem.text = `$(notebook) :${serverHandle.port}`;
    statusBarItem.tooltip = `Notebook MCP\nhttp://127.0.0.1:${serverHandle.port}/mcp\n\nClick for info`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(notebook) ✗`;
    statusBarItem.tooltip = `Notebook MCP: not running\n${lastError ?? ""}\n\nClick for info`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  }
  statusBarItem.show();
}

async function showInfo() {
  if (serverHandle) {
    const url = `http://127.0.0.1:${serverHandle.port}/mcp`;
    const choice = await vscode.window.showInformationMessage(
      `Notebook MCP running at ${url}`,
      "Add to Claude Code",
      "Copy URL",
      "Restart"
    );
    if (choice === "Add to Claude Code") {
      await addToClaudeCode();
    } else if (choice === "Copy URL") {
      await vscode.env.clipboard.writeText(url);
    } else if (choice === "Restart") {
      await vscode.commands.executeCommand("notebook-mcp.restartServer");
    }
  } else {
    const choice = await vscode.window.showErrorMessage(
      `Notebook MCP not running: ${lastError ?? "unknown error"}`,
      "Restart"
    );
    if (choice === "Restart") {
      await vscode.commands.executeCommand("notebook-mcp.restartServer");
    }
  }
}
