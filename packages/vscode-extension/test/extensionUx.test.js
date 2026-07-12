const assert = require("node:assert/strict");
const test = require("node:test");

const ux = require("../extensionUx");

function editorFor(file, languageId = "python") {
  return {
    document: {
      languageId,
      uri: {
        scheme: "file",
        fsPath: file,
        toString: () => `file:///${file}`,
      },
    },
  };
}

test("isPythonTestEditor only accepts Python test files", () => {
  assert.equal(ux.isPythonTestEditor(editorFor("C:/repo/tests/test_auth.py")), true);
  assert.equal(ux.isPythonTestEditor(editorFor("C:/repo/src/test_auth.py")), true);
  assert.equal(ux.isPythonTestEditor(editorFor("C:/repo/src/auth.py")), false);
  assert.equal(ux.isPythonTestEditor(editorFor("C:/repo/tests/test_auth.py", "javascript")), false);
  assert.equal(ux.isPythonTestEditor({ document: { languageId: "python", uri: { scheme: "untitled", fsPath: "test_auth.py" } } }), false);
});

test("statusStateForEditor shows analyze before a report exists", () => {
  const state = ux.statusStateForEditor(editorFor("C:/repo/tests/test_auth.py"), []);

  assert.equal(state.visible, true);
  assert.equal(state.isPythonTest, true);
  assert.equal(state.report, null);
  assert.equal(state.text, "$(shield) Ghost Test: Analyze");
  assert.equal(state.command, "ghostTestCatcher.analyzeCurrentTest");
});

test("statusStateForEditor opens the latest report for analyzed active tests", () => {
  const report = {
    __testFile: "C:/repo/tests/test_auth.py",
    __cacheHit: true,
    generated_tests: { test_names: ["test_real", "test_ghost"] },
    verification: {
      claim_checks: [
        { claim: "test_real", status: "supported" },
        { claim: "test_ghost", status: "unsupported" },
      ],
    },
    execution: {
      per_test_results: [
        { name: "test_real", status: "passed" },
        { name: "test_ghost", status: "failed" },
      ],
    },
    cost_estimate: { llm_calls: 0, estimated_input_tokens: 0 },
  };

  const state = ux.statusStateForEditor(editorFor("C:/repo/tests/test_auth.py"), [report]);

  assert.equal(state.visible, true);
  assert.equal(state.report, report);
  assert.equal(state.text, "$(warning) Ghost Test: 1 risk");
  assert.equal(state.command, "ghostTestCatcher.openLastReport");
  assert.ok(state.tooltip.includes("0 LLM calls"));
});

test("statusStateForEditor hides for unrelated files", () => {
  const state = ux.statusStateForEditor(editorFor("C:/repo/src/auth.py"), []);

  assert.equal(state.visible, false);
  assert.equal(state.isPythonTest, false);
});

test("reportForFile matches reports with normalized paths", () => {
  const report = { __testFile: "C:\\repo\\tests\\test_api.py" };

  assert.equal(ux.reportForFile([report], "C:/repo/tests/test_api.py"), report);
  assert.equal(ux.reportForFile([report], "C:/repo/tests/test_other.py"), null);
});
