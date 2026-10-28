import * as http from "http";
import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools/index.js";

const PORT_SCAN_RANGE = 100;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 32;

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

// Guidance sent to the agent at connect time (MCP `instructions`).
const INSTRUCTIONS = [
  "These tools operate on notebooks that are open in the user's VS Code window, through the live editor and its running kernel.",
  "Edits stay in the editor's memory (undoable, kernel state preserved) until notebook_save is called; the .ipynb on disk may be stale.",
  "For a notebook that is open here, use these tools for every read, edit and run. Do not also read or write the same .ipynb with file tools: that sees stale content and can overwrite the user's unsaved work.",
  "Call notebook_save when a set of edits is finished, or when another tool needs the file on disk."
].join(" ");

/**
 * Reject anything that is not a local, non-browser client holding the token.
 *
 * - Host must be 127.0.0.1/localhost on our port, which defeats DNS rebinding
 *   (a rebound page still sends its own hostname).
 * - Browsers always attach Origin to cross-origin fetches; MCP clients such as
 *   Claude Code don't, so any Origin header is refused. No CORS headers are
 *   ever sent, so preflights fail too.
 * - The bearer token proves the caller read the discovery file or was given
 *   the token by the user.
 */
function rejectUnauthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  token: string,
  requireToken: boolean
): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden host" }));
    return true;
  }
  if (req.headers.origin !== undefined) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Browser requests are not allowed" }));
    return true;
  }
  if (requireToken && !tokenMatches(req.headers.authorization, token)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer"
    });
    res.end(
      JSON.stringify({
        error:
          "Missing or invalid token. Connect through the bridge ('Notebook MCP: Add to Claude Code' in VS Code), or read the token from ~/.vscode-notebook-mcp/<pid>.json."
      })
    );
    return true;
  }
  return false;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function startMCPServer(
  preferredPort: number,
  token: string,
  version: string
): Promise<ServerHandle> {
  const port = await findFreePort(preferredPort, preferredPort + PORT_SCAN_RANGE);

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const lastSeen = new Map<string, number>();

  // Clients that crash or lose the connection never send DELETE, so their
  // sessions would pile up for as long as VS Code runs. Close sessions idle
  // for SESSION_IDLE_MS, and the least recently used beyond MAX_SESSIONS.
  // A client that comes back gets a 404 and, per the MCP spec, starts a new
  // session.
  const closeSession = (id: string) => {
    transports.get(id)?.close();
    transports.delete(id);
    servers.delete(id);
    lastSeen.delete(id);
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, seen] of lastSeen) {
      if (now - seen > SESSION_IDLE_MS) closeSession(id);
    }
  }, SWEEP_INTERVAL_MS);
  const enforceCap = () => {
    if (lastSeen.size <= MAX_SESSIONS) return;
    const oldest = [...lastSeen].sort((a, b) => a[1] - b[1]);
    for (const [id] of oldest.slice(0, lastSeen.size - MAX_SESSIONS)) closeSession(id);
  };

  const createMcpServer = (): McpServer => {
    const mcp = new McpServer(
      { name: "vscode-notebook-mcp", version },
      { instructions: INSTRUCTIONS }
    );
    registerAllTools(mcp);
    return mcp;
  };

  const httpServer = http.createServer(async (req, res) => {
    const isHealth = req.method === "GET" && req.url === "/health";
    if (rejectUnauthorized(req, res, port, token, !isHealth)) {
      return;
    }

    if (isHealth) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "ok", server: "vscode-notebook-mcp", port })
      );
      return;
    }

    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      try {
        if (sessionId && transports.has(sessionId)) {
          lastSeen.set(sessionId, Date.now());
          await transports.get(sessionId)!.handleRequest(req, res);
          return;
        }
        if (sessionId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session expired or unknown; start a new session." }));
          return;
        }
        if (req.method === "POST") {
          const newSessionId = crypto.randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            enableJsonResponse: true
          });
          const mcp = createMcpServer();
          transports.set(newSessionId, transport);
          servers.set(newSessionId, mcp);
          lastSeen.set(newSessionId, Date.now());
          enforceCap();
          transport.onclose = () => {
            transports.delete(newSessionId);
            servers.delete(newSessionId);
            lastSeen.delete(newSessionId);
          };
          await mcp.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing session ID" }));
      } catch (err) {
        console.error("MCP request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`Notebook MCP: listening on http://127.0.0.1:${port}/mcp`);

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        for (const t of transports.values()) {
          t.close();
        }
        transports.clear();
        servers.clear();
        lastSeen.clear();
        httpServer.close(() => resolve());
      })
  };
}

async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `No free port found in range ${start}-${end}. Configure notebook-mcp.port to a different value.`
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once("error", () => resolve(false));
    tester.listen(port, "127.0.0.1", () => {
      tester.close(() => resolve(true));
    });
  });
}
