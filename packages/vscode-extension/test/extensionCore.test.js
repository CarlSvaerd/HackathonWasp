const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const core = require("../extensionCore");
const manifest = require("../package.json");

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
    executionBackend: "docker",
    dockerImage: "python:3.11-slim",
  });

  assert.deepEqual(args.slice(0, 8), [
    "-m",
    "ghost_test_catcher.cli",
    "analyze",
    "--repo",
    root,
    "--format",
    "json",
    "--tests",
  ]);
  assert.equal(args[8], "tests/test_auth.py");
  assert.ok(args.includes("--no-execution"));
  assert.deepEqual(args.slice(args.indexOf("--execution-backend"), args.indexOf("--execution-backend") + 2), ["--execution-backend", "docker"]);
  assert.deepEqual(args.slice(args.indexOf("--docker-image"), args.indexOf("--docker-image") + 2), ["--docker-image", "python:3.11-slim"]);
  assert.ok(args.includes("integration"));
  assert.ok(args.includes("42"));
  assert.deepEqual(args.slice(args.indexOf("--source"), args.indexOf("--source") + 3), ["--source", "src", "lib"]);
});

test("analysisCacheKey is stable for the same analysis inputs and changes for meaningful settings", () => {
  const root = path.join("C:", "workspace", "project");
  const testFile = path.join(root, "tests", "test_auth.py");
  const base = {
    root,
    testFile,
    sourcePaths: ["src/auth.py", "src"],
    testMode: "mixed",
    maxFiles: 80,
    executeTests: true,
    pythonPath: "python",
    executionBackend: "local",
    dockerImage: "",
  };

  assert.equal(core.analysisCacheKey(base), core.analysisCacheKey({ ...base }));
  assert.notEqual(core.analysisCacheKey(base), core.analysisCacheKey({ ...base, executeTests: false }));
  assert.notEqual(core.analysisCacheKey(base), core.analysisCacheKey({ ...base, sourcePaths: ["src"] }));
  assert.notEqual(core.analysisCacheKey(base), core.analysisCacheKey({ ...base, testMode: "unit" }));
  assert.notEqual(core.analysisCacheKey(base), core.analysisCacheKey({ ...base, executionBackend: "docker" }));
});

test("setup helpers produce safe defaults for first-run onboarding", () => {
  assert.deepEqual(core.defaultPythonCandidates("C:/Python311/python.exe"), [
    "C:/Python311/python.exe",
    "python",
    "python3",
  ]);
  assert.deepEqual(core.defaultPythonCandidates("python"), ["python", "python3"]);
  assert.deepEqual(core.setupProfileSettings("local"), {
    executeTests: true,
    executionBackend: "local",
    confirmExecution: true,
  });
  assert.deepEqual(core.setupProfileSettings("static"), {
    executeTests: false,
    executionBackend: "local",
    confirmExecution: true,
  });
  assert.deepEqual(core.setupProfileSettings("docker"), {
    executeTests: true,
    executionBackend: "docker",
    confirmExecution: true,
  });
  assert.deepEqual(core.editableInstallArgs(), ["-m", "pip", "install", "-e", ".[ghost]"]);
  assert.deepEqual(core.pypiInstallArgs(), ["-m", "pip", "install", "ghost-test-catcher[ghost]"]);
});

test("reportTestNames safely reads generated test names", () => {
  assert.deepEqual(core.reportTestNames({ generated_tests: { test_names: ["test_a"] } }), ["test_a"]);
  assert.deepEqual(core.reportTestNames({}), []);
  assert.deepEqual(core.reportTestNames(null), []);
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

test("nativeTestOutcome maps Ghost Test Catcher statuses to VS Code Testing states", () => {
  assert.equal(core.nativeTestOutcome("supported", "passed"), "passed");
  assert.equal(core.nativeTestOutcome("supported", "skipped"), "skipped");
  assert.equal(core.nativeTestOutcome("supported", "unknown"), "skipped");
  assert.equal(core.nativeTestOutcome("supported", "failed"), "failed");
  assert.equal(core.nativeTestOutcome("supported", "error"), "failed");
  assert.equal(core.nativeTestOutcome("borderline", "passed"), "failed");
  assert.equal(core.nativeTestOutcome("unsupported", "passed"), "failed");
});

test("nativeTestMessage includes actionable per-test review details", () => {
  const message = core.nativeTestMessage({
    name: "TestCheckout.test_total",
    groundedStatus: "unsupported",
    executionStatus: "failed",
    confidence: 0.125,
    missingSymbols: ["calculate_total"],
    riskCategories: ["missing_symbols"],
    recommendation: "Point the test at APIs that exist in the selected source context.",
  });

  assert.ok(message.includes("TestCheckout.test_total"));
  assert.ok(message.includes("Grounding: Ghost risk"));
  assert.ok(message.includes("Confidence: 12.5%"));
  assert.ok(message.includes("Execution: failed"));
  assert.ok(message.includes("Missing symbols: calculate_total"));
  assert.ok(message.includes("Risk categories: missing_symbols"));
  assert.ok(message.includes("Recommendation: Point the test at APIs"));
});

test("package manifest declares limited workspace trust and guarded execution", () => {
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
  assert.ok(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes("ghostTestCatcher.executeTests"));
  assert.ok(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes("ghostTestCatcher.pythonPath"));
  assert.ok(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes("ghostTestCatcher.executionBackend"));
  assert.ok(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes("ghostTestCatcher.dockerImage"));
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.requireWorkspaceTrustForExecution"].default,
    true
  );
  assert.ok(manifest.activationEvents.includes("onCommand:ghostTestCatcher.setup"));
  assert.ok(manifest.activationEvents.includes("onCommand:ghostTestCatcher.openSetupGuide"));
  assert.ok(manifest.activationEvents.includes("onCommand:ghostTestCatcher.refreshTestExplorer"));
  assert.ok(manifest.activationEvents.includes("onCommand:ghostTestCatcher.clearAnalysisCache"));
  assert.ok(manifest.activationEvents.includes("onCommand:ghostTestCatcher.addGitHubActionsGate"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "ghostTestCatcher.setup"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "ghostTestCatcher.openSetupGuide"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "ghostTestCatcher.refreshTestExplorer"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "ghostTestCatcher.addGitHubActionsGate"));
  assert.deepEqual(manifest.categories, ["Testing", "Linters"]);
  assert.equal(manifest.pricing, "Free");
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.testDiscoveryLimit"].default,
    500
  );
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.analysisCacheEnabled"].default,
    true
  );
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.executionBackend"].default,
    "local"
  );
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.dockerImage"].default,
    "ghost-test-catcher-runner:latest"
  );
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.ciFailOn"].default,
    "ghost_risk"
  );
  assert.equal(
    manifest.contributes.configuration.properties["ghostTestCatcher.setupNudgeEnabled"].default,
    true
  );
  assert.ok(manifest.contributes.walkthroughs.some((walkthrough) => walkthrough.id === "ghostTestCatcher.gettingStarted"));
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
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("default-src 'none'"));
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
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("filter-verdict"));
  assert.ok(html.includes("data-test-row=\"true\""));
  assert.ok(html.includes("tests/test_&lt;auth&gt;.py"));
  assert.ok(html.includes("Review &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("login -&gt; src/auth.py:1"));
  assert.ok(html.includes("unittest"));
  assert.ok(html.includes("missing_symbols"));
  assert.ok(html.includes("Point the test at APIs"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
});

test("renderReportHtml includes nonce-scoped filtering script when requested", () => {
  const html = core.renderReportHtml([
    {
      trust_assessment: { verdict: "reliable", components: {} },
      execution: { status: "passed", per_test_results: [{ name: "test_ok", status: "passed" }] },
      generated_tests: { test_names: ["test_ok"] },
      verification: { claim_checks: [{ claim: "test_ok", status: "supported", framework: "pytest", confidence: 1 }] },
    },
  ], { nonce: "abc123" });

  assert.ok(html.includes("script-src 'nonce-abc123'"));
  assert.ok(html.includes("<script nonce=\"abc123\">"));
});

test("renderGitHubActionsWorkflow creates a deployable CI gate", () => {
  const workflow = core.renderGitHubActionsWorkflow({
    pythonVersion: "3.12",
    failOn: "needs_review",
    sourcePaths: ["src", "lib"],
    testPaths: ["tests"],
  });

  assert.ok(workflow.includes("name: Ghost Test Catcher"));
  assert.ok(workflow.includes("actions/checkout@v4"));
  assert.ok(workflow.includes("python-version: \"3.12\""));
  assert.ok(workflow.includes("python -m pip install \"ghost-test-catcher[ghost]\""));
  assert.ok(workflow.includes("ghost-test-catcher ci"));
  assert.ok(workflow.includes("--source src lib"));
  assert.ok(workflow.includes("--tests tests"));
  assert.ok(workflow.includes("--fail-on needs_review"));
  assert.ok(workflow.includes("actions/upload-artifact@v4"));
});
