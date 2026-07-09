const assert = require("assert");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "carl-svaerd.ghost-test-catcher";
const COMMANDS = [
  "ghostTestCatcher.setup",
  "ghostTestCatcher.runDoctor",
  "ghostTestCatcher.analyzeCurrentTest",
  "ghostTestCatcher.openLastReport",
  "ghostTestCatcher.refreshTestExplorer",
  "ghostTestCatcher.clearAnalysisCache",
  "ghostTestCatcher.addGitHubActionsGate",
];

async function run() {
  console.log(`Ghost Test Catcher integration workspace=${workspaceRoot()}`);
  console.log(`Ghost Test Catcher integration python=${process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python"}`);
  const tests = [
    ["activates and registers product commands", activatesAndRegistersCommands],
    ["runs Doctor against the fixture workspace", runsDoctor],
    ["analyzes the active Python test file and publishes diagnostics", analyzesCurrentTestFile],
    ["refreshes the native Testing panel without throwing", refreshesTestingPanel],
  ];
  const failures = [];

  for (const [name, test] of tests) {
    try {
      console.log(`Ghost Test Catcher integration: ${name}`);
      await test();
      console.log(`  passed: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`  failed: ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} Ghost Test Catcher integration test${failures.length === 1 ? "" : "s"} failed.`);
  }
}

async function activatesAndRegistersCommands() {
  assert.ok(vscode.workspace.workspaceFolders?.length, "expected the fixture workspace to be open");
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `expected ${EXTENSION_ID} to be available`);
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of COMMANDS) {
    assert.ok(commands.includes(command), `expected command ${command} to be registered`);
  }
}

async function runsDoctor() {
  await configureWorkspace();
  await vscode.commands.executeCommand("ghostTestCatcher.runDoctor");
}

async function analyzesCurrentTestFile() {
  await configureWorkspace();
  const testUri = vscode.Uri.file(path.join(workspaceRoot(), "tests", "test_calculator.py"));
  const document = await vscode.workspace.openTextDocument(testUri);
  await vscode.window.showTextDocument(document);

  await vscode.commands.executeCommand("ghostTestCatcher.analyzeCurrentTest");
  const ghostDiagnostics = await waitForGhostDiagnostics(testUri);
  assert.ok(ghostDiagnostics.length >= 2, `expected diagnostics for both fixture tests, got ${ghostDiagnostics.length}`);
  assert.ok(
    ghostDiagnostics.every((diagnostic) => diagnostic.message.includes("Ghost Test Catcher")),
    "expected diagnostics to come from Ghost Test Catcher"
  );

  await vscode.commands.executeCommand("ghostTestCatcher.openLastReport");
}

async function refreshesTestingPanel() {
  await configureWorkspace();
  await vscode.commands.executeCommand("ghostTestCatcher.refreshTestExplorer");
}

async function configureWorkspace() {
  const config = vscode.workspace.getConfiguration("ghostTestCatcher");
  await config.update("pythonPath", process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python", vscode.ConfigurationTarget.Global);
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
