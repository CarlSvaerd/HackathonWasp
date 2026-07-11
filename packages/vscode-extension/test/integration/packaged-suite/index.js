const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "carl-svaerd.ghost-test-catcher";
const COMMANDS = [
  "ghostTestCatcher.setup",
  "ghostTestCatcher.analyzeDemoGhostTest",
  "ghostTestCatcher.openSetupGuide",
  "ghostTestCatcher.runDoctor",
  "ghostTestCatcher.analyzeCurrentTest",
  "ghostTestCatcher.openLastReport",
  "ghostTestCatcher.refreshTestExplorer",
  "ghostTestCatcher.clearAnalysisCache",
  "ghostTestCatcher.copyReportSummary",
  "ghostTestCatcher.addGitHubActionsGate",
];

async function run() {
  console.log(`Ghost Test Catcher packaged integration workspace=${workspaceRoot()}`);
  console.log(`Ghost Test Catcher packaged integration python=${process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python"}`);
  const tests = [
    ["loads the installed VSIX extension and registers commands", loadsInstalledExtension],
    ["opens the self-contained first-run demo", opensFirstRunDemo],
    ["runs Doctor through the bundled analyzer source", runsDoctorWithBundledCli],
    ["analyzes a fixture test through the packaged extension", analyzesFixtureTest],
    ["keeps bad Python path failures contained and actionable", handlesBadPythonPath],
    ["generates a CI workflow with the repository install path", generatesCiWorkflow],
    ["refreshes the Testing panel from the packaged extension", refreshesTestingPanel],
  ];
  const failures = [];

  for (const [name, test] of tests) {
    try {
      console.log(`Ghost Test Catcher packaged integration: ${name}`);
      await test();
      console.log(`  passed: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`  failed: ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} packaged Ghost Test Catcher integration test${failures.length === 1 ? "" : "s"} failed.`);
  }
}

async function loadsInstalledExtension() {
  assert.ok(vscode.workspace.workspaceFolders?.length, "expected the copied fixture workspace to be open");
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `expected ${EXTENSION_ID} to be installed from the VSIX`);
  assert.equal(extension.packageJSON.version, process.env.GHOST_TEST_CATCHER_EXPECTED_VERSION || "0.2.8");
  assert.ok(!extension.extensionPath.includes(`${path.sep}packages${path.sep}vscode-extension`), `expected an installed extension path, got ${extension.extensionPath}`);
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of COMMANDS) {
    assert.ok(commands.includes(command), `expected command ${command} to be registered`);
  }
}

async function opensFirstRunDemo() {
  await vscode.commands.executeCommand("ghostTestCatcher.analyzeDemoGhostTest");
  await vscode.commands.executeCommand("ghostTestCatcher.copyReportSummary");
  const summary = await vscode.env.clipboard.readText();
  assert.ok(summary.includes("Safe to keep: 1"), "expected the demo summary to show one safe test");
  assert.ok(summary.includes("High-risk ghost tests: 1"), "expected the demo summary to show one ghost-risk test");
  assert.ok(summary.includes("0 LLM calls"), "expected the demo to preserve the zero-LLM first-run story");
  assert.ok(summary.includes("demo/tests/test_auth_service.py"), "expected the demo to avoid workspace project paths");
}

async function runsDoctorWithBundledCli() {
  await configureWorkspace({ pythonPath: process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python" });
  await vscode.commands.executeCommand("ghostTestCatcher.runDoctor");
}

async function analyzesFixtureTest() {
  await configureWorkspace({ pythonPath: process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python" });
  const testUri = vscode.Uri.file(path.join(workspaceRoot(), "tests", "test_calculator.py"));
  const document = await vscode.workspace.openTextDocument(testUri);
  await vscode.window.showTextDocument(document);

  await vscode.commands.executeCommand("ghostTestCatcher.analyzeCurrentTest");
  const diagnostics = await waitForGhostDiagnostics(testUri);
  assert.ok(diagnostics.length >= 2, `expected diagnostics for both fixture tests, got ${diagnostics.length}`);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.source === "Ghost Test Catcher"));

  await vscode.commands.executeCommand("ghostTestCatcher.copyReportSummary");
  const summary = await vscode.env.clipboard.readText();
  assert.ok(summary.includes("Tests reviewed: 2"), "expected the copied summary to include both fixture tests");
  assert.ok(summary.includes("0 LLM calls"), "expected packaged existing-test analysis to use zero LLM calls");
  assert.ok(summary.includes("tests/test_calculator.py"), "expected workspace-relative test paths in the summary");
}

async function handlesBadPythonPath() {
  await configureWorkspace({
    pythonPath: process.platform === "win32"
      ? "C:\\definitely\\missing\\ghost-test-catcher-python.exe"
      : "/definitely/missing/ghost-test-catcher-python",
  });
  const testUri = vscode.Uri.file(path.join(workspaceRoot(), "tests", "test_calculator.py"));
  const document = await vscode.workspace.openTextDocument(testUri);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("ghostTestCatcher.analyzeCurrentTest");
}

async function generatesCiWorkflow() {
  await configureWorkspace({ pythonPath: process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python" });
  const workflowPath = path.join(workspaceRoot(), ".github", "workflows", "ghost-test-catcher.yml");
  fs.rmSync(path.dirname(workflowPath), { recursive: true, force: true });
  await vscode.commands.executeCommand("ghostTestCatcher.addGitHubActionsGate");
  assert.ok(fs.existsSync(workflowPath), "expected the CI workflow to be written in the copied fixture workspace");
  const workflow = fs.readFileSync(workflowPath, "utf-8");
  assert.ok(workflow.includes("ghost-test-catcher ci"), "expected the workflow to run the CLI gate");
  assert.ok(
    workflow.includes("ghost-test-catcher[ghost] @ git+https://github.com/CarlSvaerd/HackathonWasp.git@v0.2.8"),
    "expected the generated workflow to use the tagged repository install path while PyPI is unpublished"
  );
}

async function refreshesTestingPanel() {
  await configureWorkspace({ pythonPath: process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python" });
  await vscode.commands.executeCommand("ghostTestCatcher.refreshTestExplorer");
}

async function configureWorkspace({ pythonPath }) {
  const config = vscode.workspace.getConfiguration("ghostTestCatcher");
  await config.update("pythonPath", pythonPath, vscode.ConfigurationTarget.Global);
  await config.update("sourcePaths", ["src"], vscode.ConfigurationTarget.Global);
  await config.update("smartSourceContext", true, vscode.ConfigurationTarget.Global);
  await config.update("executeTests", false, vscode.ConfigurationTarget.Global);
  await config.update("confirmExecution", false, vscode.ConfigurationTarget.Global);
  await config.update("analysisCacheEnabled", false, vscode.ConfigurationTarget.Global);
  await config.update("testDiscoveryLimit", 50, vscode.ConfigurationTarget.Global);
}

function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(folder, "expected fixture workspace folder to be open");
  return folder.uri.fsPath;
}

async function waitForGhostDiagnostics(uri) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages
      .getDiagnostics(uri)
      .filter((diagnostic) => diagnostic.source === "Ghost Test Catcher");
    if (diagnostics.length) {
      return diagnostics;
    }
    await delay(250);
  }
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.source === "Ghost Test Catcher");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { run };
