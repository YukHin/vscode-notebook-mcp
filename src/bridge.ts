/**
 * stdio bridge: lets an MCP client that starts servers as processes (Claude
 * Code) reach the right VS Code window without knowing ports or tokens.
 *
 *   claude mcp add --scope user notebook -- node ~/.vscode-notebook-mcp/bridge.js
 *
 * Each VS Code window runs its own server and writes
 * ~/.vscode-notebook-mcp/<pid>.json (url, token, workspace folders). The
 * bridge picks the window whose workspace contains the client's working
 * directory (or NOTEBOOK_MCP_WORKSPACE), forwards newline-delimited JSON-RPC
 * from stdin to that window's HTTP endpoint, and writes the replies to stdout.
 * If the window goes away or its session expires, it finds the window again,
 * replays `initialize`, and retries.
 *
 * Plain Node, no dependencies, no vscode import: it runs outside VS Code.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

const DISCOVERY_DIR = path.join(os.homedir(), ".vscode-notebook-mcp");
const PROTOCOL_HEADER = "mcp-protocol-version";

interface WindowInfo {
  url: string;
  port: number;
  token: string;
  pid: number;
  workspaceFolders: string[];
  startedAt: string;
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; [k: string]: unknown };

const target = path.resolve(process.env.NOTEBOOK_MCP_WORKSPACE ?? process.cwd());
let window: WindowInfo | undefined;
let sessionId: string | undefined;
let protocolVersion: string | undefined;
let initializeRequest: JsonRpc | undefined;
let initializedNotification: JsonRpc | undefined;

function log(message: string) {
  // stderr is the client's log; stdout is reserved for protocol messages.
  process.stderr.write(`[notebook-mcp bridge] ${message}\n`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

function containedDepth(folder: string): number {
  const f = norm(folder);
  const t = norm(target);
  return t === f || t.startsWith(f.endsWith(path.sep) ? f : f + path.sep) ? f.length : -1;
}

/**
 * The live window for `target`: the one with the deepest workspace folder
 * containing it; else, if exactly one window is open, that one.
 */
function findWindow(): WindowInfo | undefined {
  let infos: WindowInfo[] = [];
  try {
    infos = fs
      .readdirSync(DISCOVERY_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, f), "utf8")) as WindowInfo;
        } catch {
          return undefined;
        }
      })
      .filter((i): i is WindowInfo => !!i && typeof i.url === "string" && isAlive(i.pid));
  } catch {
    return undefined;
  }
  const scored = infos
    .map((info) => ({ info, depth: Math.max(-1, ...info.workspaceFolders.map(containedDepth)) }))
    .filter((s) => s.depth >= 0)
    .sort((a, b) => b.depth - a.depth);
  if (scored.length > 0) return scored[0].info;
  return infos.length === 1 ? infos[0] : undefined;
}

class NoWindowError extends Error {}
class SessionGoneError extends Error {}

async function post(message: JsonRpc): Promise<JsonRpc | JsonRpc[] | undefined> {
  if (!window) {
    window = findWindow();
    if (!window) {
      throw new NoWindowError(
        `No VS Code window with Notebook MCP is open for ${target}. Open that folder in VS Code (with the Notebook MCP extension) and try again.`
      );
    }
    log(`using window pid ${window.pid} at ${window.url} (${window.workspaceFolders.join(", ")})`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${window.token}`
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers[PROTOCOL_HEADER] = protocolVersion;

  let res: Response;
  try {
    res = await fetch(window.url, { method: "POST", headers, body: JSON.stringify(message) });
  } catch {
    throw new SessionGoneError("window unreachable");
  }
  if (res.status === 404 || res.status === 401) {
    throw new SessionGoneError(`HTTP ${res.status}`);
  }
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (res.status === 202 || res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    // Not expected (the server answers with JSON), but handle SSE framing.
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as JsonRpc);
    return data.length === 1 ? data[0] : data;
  }
  return JSON.parse(text) as JsonRpc | JsonRpc[];
}

/** Find the window again and start a new session by replaying initialize. */
async function reconnect(): Promise<void> {
  window = undefined;
  sessionId = undefined;
  if (!initializeRequest) return;
  const reply = await post({ ...initializeRequest, id: `bridge-reinit-${Date.now()}` });
  const version = (reply as JsonRpc | undefined)?.result as { protocolVersion?: string } | undefined;
  if (version?.protocolVersion) protocolVersion = version.protocolVersion;
  if (initializedNotification) await post(initializedNotification);
  log("reconnected");
}

async function forward(message: JsonRpc): Promise<JsonRpc | JsonRpc[] | undefined> {
  if (message.method === "initialize") {
    initializeRequest = message;
    window = undefined;
    sessionId = undefined;
  } else if (message.method === "notifications/initialized") {
    initializedNotification = message;
  }
  try {
    const reply = await post(message);
    if (message.method === "initialize") {
      const v = (reply as JsonRpc | undefined)?.result as { protocolVersion?: string } | undefined;
      if (v?.protocolVersion) protocolVersion = v.protocolVersion;
    }
    return reply;
  } catch (err) {
    if (err instanceof SessionGoneError && message.method !== "initialize") {
      await reconnect();
      return post(message);
    }
    throw err;
  }
}

function errorReply(message: JsonRpc, err: unknown): JsonRpc | undefined {
  if (message.id === undefined || message.id === null) return undefined; // notification
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: err instanceof Error ? err.message : String(err) }
  };
}

function write(reply: JsonRpc | JsonRpc[] | undefined) {
  if (!reply) return;
  for (const r of Array.isArray(reply) ? reply : [reply]) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
}

// Requests are forwarded one at a time, in order: notebook edits and runs
// depend on each other, and the server handles a session's requests in order
// anyway.
let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message: JsonRpc;
  try {
    message = JSON.parse(line);
  } catch {
    log(`ignored a line that isn't JSON: ${line.slice(0, 80)}`);
    return;
  }
  queue = queue.then(async () => {
    try {
      write(await forward(message));
    } catch (err) {
      if (!(err instanceof NoWindowError)) log(String(err));
      write(errorReply(message, err));
    }
  });
});
rl.on("close", () => {
  void queue.then(async () => {
    if (window && sessionId) {
      try {
        await fetch(window.url, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${window.token}`, "mcp-session-id": sessionId }
        });
      } catch {
        // window already gone
      }
    }
    process.exit(0);
  });
});
