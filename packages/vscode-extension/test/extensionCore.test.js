const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const core = require("../extensionCore");

test("buildAnalyzeArgs creates the CLI contract used by the extension", () => {
  const root = path.join("C:", "workspace", "project");
  const testFile = path.join(root, "tests", "test_auth.py");

  const args = core.buildAnalyzeArgs({
    root,
    testFile,
    sourcePaths: ["src", "lib"],
    testMode: "integration",
    maxFiles: 42,
    executeTests: false,
  });

  assert.deepEqual(args.slice(0, 8), [
    "-m",
    "llmSHAP.ghost.cli",
    "analyze",
    "--repo",
    root,
    "--format",
    "json",
    "--tests",
  ]);
  assert.equal(args[8], "tests/test_auth.py");
  assert.ok(args.includes("--no-execution"));
  assert.ok(args.includes("integration"));
  assert.ok(args.includes("42"));
  assert.deepEqual(args.slice(args.indexOf("--source"), args.indexOf("--source") + 3), ["--source", "src", "lib"]);
});

test("parseTestFunctionLocations returns stable line ranges", () => {
  const locations = core.parseTestFunctionLocations([
    "def helper():",
    "    pass",
    "",
    "def test_login_accepts_user():",
    "    assert True",
    "    def test_nested_is_not_collected():",
    "        assert False",
    "",
    "async def test_async_is_supported():",
    "    pass",
    "",
    "class TestAccountFlow:",
    "    def test_class_method_is_supported(self):",
    "        assert True",
  ].join("\n"));

  assert.deepEqual(locations, [
    {
      name: "test_login_accepts_user",
      qualifiedName: "test_login_accepts_user",
      line: 3,
      start: 4,
      end: 27,
    },
    {
      name: "test_async_is_supported",
      qualifiedName: "test_async_is_supported",
      line: 8,
      start: 10,
      end: 33,
    },
    {
      name: "test_class_method_is_supported",
      qualifiedName: "TestAccountFlow.test_class_method_is_supported",
      className: "TestAccountFlow",
      line: 12,
      start: 8,
      end: 38,
    },
  ]);
});

test("isTestPath recognizes Python test naming and tests directories", () => {
  assert.equal(core.isTestPath("/repo/tests/test_auth.py"), true);
  assert.equal(core.isTestPath("/repo/src/auth_test.py"), true);
  assert.equal(core.isTestPath("/repo/src/test_auth.py"), true);
  assert.equal(core.isTestPath("/repo/src/auth.py"), false);
});

test("findProjectRootForFile prefers a nested Python project over the open workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-workspace-"));
  const project = path.join(workspace, "HackathonWasp");
  const sourceRoot = path.join(project, "src", "llmSHAP", "ghost");
  const testsRoot = path.join(project, "tests");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(testsRoot, { recursive: true });
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\nname = \"demo\"\n", "utf-8");
  fs.writeFileSync(path.join(sourceRoot, "cli.py"), "def main():\n    return 0\n", "utf-8");
  const testFile = path.join(testsRoot, "test_demo.py");
  fs.writeFileSync(testFile, "def test_demo():\n    assert True\n", "utf-8");

  assert.equal(core.findProjectRootForFile(testFile, workspace), project);
  assert.deepEqual(core.toRelativeSourcePaths(project, [path.join(project, "src", "demo.py")]), ["src/demo.py"]);
});

test("extractPythonImportModules parses direct and from imports", () => {
  const modules = core.extractPythonImportModules([
    "import os",
    "import src.billing as billing, llmSHAP.webapp.execution",
    "from src.auth import AuthService",
    "from .local_helpers import fixture_builder",
    "from llmSHAP.webapp.test_artifacts import parse_python_test_source",
  ].join("\n"));

  assert.deepEqual(modules, [
    "llmSHAP.webapp.execution",
    "llmSHAP.webapp.test_artifacts",
    "os",
    "src.auth",
    "src.billing",
  ]);
});

test("resolveImportModulesToSourcePaths finds local source files and skips test files", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-imports-"));
  fs.mkdirSync(path.join(project, "src", "llmSHAP", "webapp"), { recursive: true });
  fs.mkdirSync(path.join(project, "tests"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "billing.py"), "def charge():\n    return True\n", "utf-8");
  fs.writeFileSync(path.join(project, "src", "llmSHAP", "webapp", "execution.py"), "def run():\n    return True\n", "utf-8");
  fs.writeFileSync(path.join(project, "tests", "test_auth.py"), "def test_demo():\n    assert True\n", "utf-8");

  assert.deepEqual(
    core.resolveImportModulesToSourcePaths(project, [
      "src.billing",
      "llmSHAP.webapp.execution",
      "tests.test_auth",
      "does.not.exist",
    ]),
    ["src/billing.py", "src/llmSHAP/webapp/execution.py"]
  );
});

test("mergeSourcePaths keeps inferred files ahead of configured folders", () => {
  assert.deepEqual(
    core.mergeSourcePaths(["src/auth.py", "src/billing.py"], ["src", "src/auth.py"]),
    ["src/auth.py", "src/billing.py", "src"]
  );
});

test("summarizeReports groups report verdicts for notifications", () => {
  const summary = core.summarizeReports([
    { trust_assessment: { verdict: "reliable" } },
    { trust_assessment: { verdict: "needs_review" } },
    { trust_assessment: { verdict: "ghost_risk" } },
    {},
  ]);

  assert.deepEqual(summary, {
    reliable: 1,
    needsReview: 2,
    ghostRisk: 1,
  });
});

test("renderDoctorHtml escapes setup details and includes inferred source files", () => {
  const html = core.renderDoctorHtml({
    root: "C:/repo/<demo>",
    pythonPath: "python",
    sourcePaths: ["src/<auth>.py"],
    inferredSourcePaths: ["src/auth.py"],
    importOk: false,
    importMessage: "Could not import <module>",
    doctor: {
      config: { test_mode: "mixed", execute_tests: true },
      discovered_source_specs: ["src/auth.py"],
      discovered_test_specs: ["tests/test_auth.py"],
    },
  });

  assert.ok(html.includes("Ghost Test Catcher Doctor"));
  assert.ok(html.includes("C:/repo/&lt;demo&gt;"));
  assert.ok(html.includes("src/&lt;auth&gt;.py"));
  assert.ok(html.includes("Could not import &lt;module&gt;"));
  assert.ok(!html.includes("Could not import <module>"));
});

test("renderReportHtml escapes user-controlled text and includes exact evidence symbols", () => {
  const html = core.renderReportHtml([
    {
      __testFile: "tests/test_<auth>.py",
      trust_assessment: {
        verdict: "ghost_risk",
        message: "Review <script>alert(1)</script>",
        reliability_score: 0.1,
        components: { etv_score: 0 },
      },
      execution: {
        status: "failed",
        passed: 0,
        test_count: 1,
        per_test_results: [{ name: "test_login", status: "failed" }],
      },
      generated_tests: { test_names: ["test_login"] },
      verification: {
        claim_checks: [
          {
            claim: "test_login",
            status: "unsupported",
            confidence: 0.12,
            evidence: { path: "src/auth.py", start_line: 1, end_line: 8 },
            evidence_symbols: ["login -> src/auth.py:1"],
            missing_symbols: ["chargeCustomer"],
            framework: "unittest",
            risk_categories: ["missing_symbols"],
            recommendation: "Point the test at APIs that exist in the selected source context.",
          },
        ],
      },
    },
  ]);

  assert.ok(html.includes("Ghost Test Catcher"));
  assert.ok(html.includes("tests/test_&lt;auth&gt;.py"));
  assert.ok(html.includes("Review &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("login -&gt; src/auth.py:1"));
  assert.ok(html.includes("unittest"));
  assert.ok(html.includes("missing_symbols"));
  assert.ok(html.includes("Point the test at APIs"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
});
