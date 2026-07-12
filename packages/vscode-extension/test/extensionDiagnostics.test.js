const assert = require("node:assert/strict");
const test = require("node:test");

const diagnostics = require("../extensionDiagnostics");

test("diagnosticSeverityName maps unsupported and execution errors to error", () => {
  assert.equal(diagnostics.diagnosticSeverityName("unsupported", "unknown"), "error");
  assert.equal(diagnostics.diagnosticSeverityName("grounded", "error"), "error");
});

test("diagnosticSeverityName maps borderline or failed execution to warning", () => {
  assert.equal(diagnostics.diagnosticSeverityName("borderline", "passed"), "warning");
  assert.equal(diagnostics.diagnosticSeverityName("grounded", "failed"), "warning");
  assert.equal(diagnostics.diagnosticSeverityName("grounded", "skipped"), "warning");
});

test("diagnosticSeverityName maps grounded passing tests to information", () => {
  assert.equal(diagnostics.diagnosticSeverityName("grounded", "passed"), "information");
  assert.equal(diagnostics.diagnosticSeverityName("grounded", "unknown"), "information");
});

test("diagnosticContextKey captures file, range, and message", () => {
  const diagnostic = {
    range: {
      start: { line: 3, character: 2 },
      end: { line: 3, character: 18 },
    },
    message: "Ghost Test Catcher: Needs review",
  };

  assert.equal(
    diagnostics.diagnosticContextKey("C:\\repo\\tests\\test_api.py", diagnostic),
    "c:/repo/tests/test_api.py|3|2|3|18|Ghost Test Catcher: Needs review"
  );
});

test("diagnostic constants match the registered product identity", () => {
  assert.equal(diagnostics.DIAGNOSTIC_SOURCE, "Ghost Test Catcher");
  assert.equal(diagnostics.DIAGNOSTIC_CODE, "ghost-test-catcher");
});

test("GhostDiagnosticManager exposes report navigation from diagnostics", () => {
  const fakeVscode = {
    CodeActionKind: { QuickFix: "quickfix" },
    CodeAction: class {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
      }
    },
  };
  const manager = new diagnostics.GhostDiagnosticManager({
    vscode: fakeVscode,
    diagnostics: {},
    codeLensChanged: {},
  });
  const diagnostic = {
    source: diagnostics.DIAGNOSTIC_SOURCE,
    range: {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 9 },
    },
    message: "Ghost Test Catcher: Ghost risk",
  };
  const testFile = "C:\\repo\\tests\\test_api.py";
  manager.quickFixContextByDiagnosticKey.set(
    diagnostics.diagnosticContextKey(testFile, diagnostic),
    {
      testFile,
      name: "test_api",
      evidence: { path: "src/api.py", start_line: 1 },
      missingSymbols: ["ApiClient"],
    }
  );

  const actions = manager.provideCodeActions({ uri: { fsPath: testFile } }, { diagnostics: [diagnostic] });
  const titles = actions.map((action) => action.title);

  assert.ok(titles.includes("Ghost Test Catcher: Open Evidence File"));
  assert.ok(titles.includes("Ghost Test Catcher: Open Full Report"));
  assert.ok(titles.includes("Ghost Test Catcher: Copy Missing Symbols"));
  assert.ok(titles.includes("Ghost Test Catcher: Run Static Analysis Only"));
  assert.equal(
    actions.find((action) => action.title === "Ghost Test Catcher: Open Full Report").command.command,
    "ghostTestCatcher.openLastReport"
  );
});
