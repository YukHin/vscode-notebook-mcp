import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { startMCPServer, ServerHandle } from "./mcp/server.js";
import { initPlotlyRenderer } from "./utils/plotly.js";
import { watchCellExecution } from "./utils/notebook.js";

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
    vscode.commands.registerCommand("notebook-mcp.regenerateToken", async () => {
      token = crypto.randomBytes(32).toString("base64url");
      await context.secrets.store(TOKEN_SECRET_KEY, token);
      await stopServer();
      await startServer();
      const choice = await vscode.window.showWarningMessage(
        "Notebook MCP: token regenerated. Clients using the old token must be reconfigured.",
        "Copy Claude Code Command"
      );
      if (choice) await copyClaudeCommand();
    })
  );

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

function claudeCommand(port: number, secret: string): string {
  return `claude mcp add --transport http --scope user notebook http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${secret}"`;
}

async function copyClaudeCommand() {
  if (!serverHandle) {
    vscode.window.showErrorMessage("Notebook MCP is not running.");
    return;
  }
  await vscode.env.clipboard.writeText(
    claudeCommand(serverHandle.port, await getToken())
  );
  vscode.window.showInformationMessage(
    "Notebook MCP: Claude Code command copied. Paste it into a terminal and run it once. It contains your access token, so don't share it."
  );
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
      "Copy Claude Code Command",
      "Copy URL",
      "Restart"
    );
    if (choice === "Copy Claude Code Command") {
      await copyClaudeCommand();
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
