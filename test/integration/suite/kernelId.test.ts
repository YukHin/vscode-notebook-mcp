import * as assert from "assert";
import * as crypto from "crypto";
import {
  controllerIdForInterpreter,
  normalizeInterpreterPath
} from "../../../src/utils/kernel.js";

// Pure-function coverage for the controller-id computation that used to live
// only in the test helper. Moving it into src means agents can point
// notebook_select_kernel at an interpreter path instead of hashing one
// themselves; these tests pin the exact format the Jupyter extension expects.
suite("kernel id computation", () => {
  test("normalizeInterpreterPath strips /bin for venv-style paths", () => {
    assert.strictEqual(
      normalizeInterpreterPath("/x/y/.venv/bin/python", "linux"),
      "/x/y/.venv/python"
    );
  });

  test("normalizeInterpreterPath leaves system interpreters untouched", () => {
    assert.strictEqual(
      normalizeInterpreterPath("/usr/bin/python3", "linux"),
      "/usr/bin/python3"
    );
  });

  test("controllerIdForInterpreter builds the Jupyter controller id", () => {
    const id = controllerIdForInterpreter("/x/y/.venv/bin/python", "linux");
    const norm = "/x/y/.venv/python";
    const sha = crypto.createHash("sha256").update(norm).digest("hex");
    assert.strictEqual(
      id,
      `.jvsc74a57bd0${sha}.${norm}.${norm}.-m#ipykernel_launcher`
    );
  });

  // vscode.Uri only understands drive letters and backslashes on Windows.
  (process.platform === "win32" ? test : test.skip)(
    "controllerIdForInterpreter on Windows hashes the Uri path and embeds the fsPath",
    () => {
      const id = controllerIdForInterpreter("C:\\x\\.venv\\Scripts\\python.exe", "win32");
      const fsPath = "c:\\x\\.venv\\Scripts\\python.exe";
      const sha = crypto
        .createHash("sha256")
        .update("/c:/x/.venv/Scripts/python.exe")
        .digest("hex");
      assert.strictEqual(
        id,
        `.jvsc74a57bd0${sha}.${fsPath}.${fsPath}.-m#ipykernel_launcher`
      );
    }
  );
});
