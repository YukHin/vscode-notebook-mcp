import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as vscode from "vscode";
import { registerAllTools } from "../../../src/mcp/tools/index.js";
import { watchCellExecution } from "../../../src/utils/notebook.js";

export interface TestMcpClient {
  client: Client;
  server: McpServer;
  dispose: () => Promise<void>;
}

export async function createTestMcpClient(): Promise<TestMcpClient> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // The tests drive tools from out/src, a separate copy of the modules from
  // the bundled extension (dist) that VS Code activated. Module-level state
  // like the running-cell and run-state tracking lives per copy, so start the
  // same event listeners activate() starts, on this copy.
  const subscriptions: vscode.Disposable[] = [];
  watchCellExecution({ subscriptions } as unknown as vscode.ExtensionContext);

  const server = new McpServer({
    name: "vscode-notebook-mcp-test",
    version: "0.0.0"
  });
  registerAllTools(server);
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    server,
    dispose: async () => {
      await client.close();
      await server.close();
      subscriptions.forEach((s) => s.dispose());
    }
  };
}

export interface ToolCallResult {
  text: string;
  raw: Awaited<ReturnType<Client["callTool"]>>;
  isError: boolean;
  imageCount: number;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  const raw = await client.callTool({ name, arguments: args });
  const content = (raw as { content?: unknown[] }).content ?? [];
  const textBlocks = content.filter(
    (b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type: unknown }).type === "text"
  );
  const imageBlocks = content.filter(
    (b): b is { type: "image"; data: string; mimeType: string } =>
      typeof b === "object" && b !== null && (b as { type: unknown }).type === "image"
  );
  return {
    text: textBlocks.map((b) => b.text).join("\n"),
    raw,
    isError: !!(raw as { isError?: boolean }).isError,
    imageCount: imageBlocks.length
  };
}
