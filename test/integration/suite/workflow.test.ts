import * as assert from "assert";
import * as vscode from "vscode";
import {
  TestMcpClient,
  callTool,
  createTestMcpClient
} from "./mcpClient";
import {
  closeAllEditors,
  copyFixtureToTmp,
  ensureJupyterActivated,
  selectVenvKernel
} from "./helpers";

async function openWithKernel(mcp: TestMcpClient, fixture: string): Promise<string> {
  const tmpPath = copyFixtureToTmp(fixture);
  const open = await callTool(mcp.client, "notebook_open", {
    path: tmpPath,
    show: true,
    response_format: "json"
  });
  assert.strictEqual(open.isError, false, open.text);
  const uri = JSON.parse(open.text).uri as string;
  await selectVenvKernel(vscode.Uri.parse(uri));
  return uri;
}

async function insert(mcp: TestMcpClient, uri: string, content: string, execute = false) {
  const r = await callTool(mcp.client, "notebook_insert_cell", {
    notebook_uri: uri,
    content,
    type: "code",
    execute,
    response_format: "json"
  });
  assert.strictEqual(r.isError, false, r.text);
  return JSON.parse(r.text) as { cellId: string; cellIndex: number };
}

async function status(mcp: TestMcpClient, uri: string) {
  const r = await callTool(mcp.client, "notebook_status", {
    notebook_uri: uri,
    response_format: "json"
  });
  assert.strictEqual(r.isError, false, r.text);
  return JSON.parse(r.text);
}

suite("workflow tools", () => {
  let mcp: TestMcpClient;

  suiteSetup(async () => {
    await ensureJupyterActivated();
    mcp = await createTestMcpClient();
  });

  suiteTeardown(async () => {
    await mcp.dispose();
  });

  setup(async () => {
    await closeAllEditors();
  });

  test("notebook_status tracks edited, not-run and downstream cells", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    const a = await insert(mcp, uri, "a = 1", true);
    const b = await insert(mcp, uri, "b = a + 1", true);
    const c = await insert(mcp, uri, "c = b * 2");

    let s = await status(mcp, uri);
    assert.strictEqual(s.fresh, 2, JSON.stringify(s));
    assert.strictEqual(s.notRun, 1);
    assert.strictEqual(s.firstStaleIndex, c.cellIndex);

    await callTool(mcp.client, "notebook_replace_in_cell", {
      notebook_uri: uri,
      cell_id: a.cellId,
      old_string: "a = 1",
      new_string: "a = 10"
    });
    s = await status(mcp, uri);
    assert.strictEqual(s.edited, 1);
    assert.strictEqual(s.firstStaleIndex, a.cellIndex);
    const bState = s.cells.find((x: { id: string }) => x.id === b.cellId);
    assert.ok(bState?.afterStale, "a fresh cell after an edited one should be flagged");
  });

  test("notebook_run_cells mode 'stale' brings the kernel up to date", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    const a = await insert(mcp, uri, "a = 1", true);
    await insert(mcp, uri, "b = a + 1", true);
    await insert(mcp, uri, "print(a + b)");
    await callTool(mcp.client, "notebook_replace_in_cell", {
      notebook_uri: uri,
      cell_id: a.cellId,
      old_string: "a = 1",
      new_string: "a = 10"
    });

    const run = await callTool(mcp.client, "notebook_run_cells", {
      notebook_uri: uri,
      mode: "stale",
      response_format: "json"
    });
    assert.strictEqual(run.isError, false, run.text);
    const r = JSON.parse(run.text);
    assert.strictEqual(r.ran, 3, run.text);
    assert.strictEqual(r.succeeded, 3);
    const last = r.cells[r.cells.length - 1];
    assert.match(last.outputs.map((o: { text?: string }) => o.text ?? "").join(""), /21/);

    const s = await status(mcp, uri);
    assert.strictEqual(s.upToDate, true, JSON.stringify(s));
  });

  test("notebook_run_cells stops at the first error and reports it", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    await insert(mcp, uri, "x = 1");
    await insert(mcp, uri, "raise RuntimeError('stop here')");
    await insert(mcp, uri, "y = 2");

    const run = await callTool(mcp.client, "notebook_run_cells", {
      notebook_uri: uri,
      mode: "all",
      response_format: "json"
    });
    const r = JSON.parse(run.text);
    assert.strictEqual(r.ran, 2, run.text);
    assert.strictEqual(r.stopped.reason, "error");
    assert.strictEqual(r.notStarted.length, 1);
    const failed = r.cells.find((c: { success: boolean }) => !c.success);
    assert.ok(failed.outputs.some((o: { type: string; name?: string }) => o.type === "error" && o.name === "RuntimeError"));
  });

  test("notebook_inspect_variables lists variables without adding cells or bumping the count", async function () {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    const setupRun = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "import numpy as np\nmatrix = np.zeros((3, 4))\nname = 'demo'\ncount = 7",
      type: "code",
      execute: true,
      response_format: "json"
    });
    const order = JSON.parse(setupRun.text).execution.executionOrder;

    const list = await callTool(mcp.client, "notebook_inspect_variables", {
      notebook_uri: uri,
      response_format: "json"
    });
    // The Jupyter extension asks the user before granting another extension
    // kernel access, and the test host refuses every dialog. Covered by the
    // manual end-to-end check instead.
    if (list.isError && /Kernel access/i.test(list.text)) {
      this.skip();
    }
    assert.strictEqual(list.isError, false, list.text);
    const vars = JSON.parse(list.text).variables as { name: string; shape?: number[]; preview?: string; type: string }[];
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    assert.deepStrictEqual(byName.matrix.shape, [3, 4]);
    assert.strictEqual(byName.count.preview, "7");
    assert.ok(!byName.np, "modules are hidden by default");
    assert.ok(!vars.some((v) => v.name.startsWith("__nbmcp")), "the helper must not leak into the namespace");

    const cells = await callTool(mcp.client, "notebook_list_cells", {
      notebook_uri: uri,
      response_format: "json"
    });
    const parsed = JSON.parse(cells.text);
    assert.strictEqual(parsed.total, 1, "inspection must not add cells");

    const next = await insert(mcp, uri, "1", true);
    const after = await callTool(mcp.client, "notebook_get_cell_output", {
      notebook_uri: uri,
      cell_id: next.cellId,
      response_format: "json"
    });
    assert.strictEqual(JSON.parse(after.text).executionOrder, order + 1, "inspection must not use up an execution count");
  });
});
