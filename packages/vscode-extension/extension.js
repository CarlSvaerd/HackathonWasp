const vscode = require("vscode");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");

let diagnostics;
let codeLensChanged;
let reportPanel;
let lastReports = [];
const reportsByFile = new Map();

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("ghost-test-catcher");
  codeLensChanged = new vscode.EventEmitter();

  context.subscriptions.push(diagnostics);
  context.subscriptions.push(codeLensChanged);
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeCurrentTest", analyzeCurrentTest));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeChangedTests", analyzeChangedTests));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeSelectedFiles", analyzeSelectedFiles));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openLastReport", openLastReport));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "python" }, new GhostCodeLensProvider()));
}

function deactivate() {
  if (diagnostics) {
    diagnostics.clear();
  }
}

async function analyzeCurrentTest() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "python") {
    vscode.window.showWarningMessage("Open a Python test file before running Ghost Test Catcher.");
    return;
  }

  const document = editor.document;
  if (document.isDirty) {
    await document.save();
  }

  const testFile = document.uri.fsPath;
  if (!core.isTestPath(testFile)) {
    const choice = await vscode.window.showWarningMessage(
      "This file does not look like a Python test file. Analyze it anyway?",
      "Analyze",
      "Cancel"
    );
    if (choice !== "Analyze") {
      return;
    }
  }

  await analyzeFiles([testFile], "Analyzing current test file");
}

async function analyzeChangedTests() {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Open a workspace before analyzing changed tests.");
    return;
  }

  const workspaceRoot = folder.uri.fsPath;
  const activeFile = vscode.window.activeTextEditor?.document.uri.scheme === "file"
    ? vscode.window.activeTextEditor.document.uri.fsPath
    : "";
  const root = activeFile ? core.findProjectRootForFile(activeFile, workspaceRoot) : workspaceRoot;
  const changedFiles = await gitChangedFiles(root);
  const testFiles = changedFiles
    .map((item) => path.join(root, item))
    .filter((item) => fs.existsSync(item) && core.isTestPath(item));

  if (!testFiles.length) {
    vscode.window.showInformationMessage("No changed Python test files were found.");
    return;
  }

  await analyzeFiles(testFiles, `Analyzing ${testFiles.length} changed test file${testFiles.length === 1 ? "" : "s"}`);
}

async function analyzeSelectedFiles(uri, selectedUris) {
  const selected = Array.isArray(selectedUris) && selectedUris.length ? selectedUris : uri ? [uri] : [];
  if (!selected.length && vscode.window.activeTextEditor?.document.languageId === "python") {
    selected.push(vscode.window.activeTextEditor.document.uri);
  }
  const fileUris = selected.filter((item) => item && item.scheme === "file");
  if (!fileUris.length) {
    vscode.window.showWarningMessage("Select one or more Python files or folders before running Ghost Test Catcher.");
    return;
  }

  await vscode.workspace.saveAll(false);
  const expandedFiles = await expandSelectedPaths(fileUris.map((item) => item.fsPath));
  const pythonFiles = expandedFiles.filter(core.isPythonPath);
  const testFiles = pythonFiles.filter(core.isTestPath);
  const sourceFiles = pythonFiles.filter((item) => !core.isTestPath(item));

  if (!testFiles.length) {
    vscode.window.showWarningMessage("Select at least one Python test file along with any source files or folders you want as context.");
    return;
  }

  await analyzeFiles(
    testFiles,
    `Analyzing ${testFiles.length} selected test file${testFiles.length === 1 ? "" : "s"}`,
    { sourceFiles }
  );
}

async function analyzeFiles(testFiles, title, options = {}) {
  const executeTests = getConfig().get("executeTests", true);
  const confirmExecution = getConfig().get("confirmExecution", true);
  if (executeTests && confirmExecution) {
    const choice = await vscode.window.showWarningMessage(
      "Ghost Test Catcher will execute Python tests against a temporary copy of the selected tests and source files.",
      { modal: false },
      "Run Analysis",
      "Cancel"
    );
    if (choice !== "Run Analysis") {
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    async (progress) => {
      const reports = [];
      try {
        for (let index = 0; index < testFiles.length; index += 1) {
          const testFile = testFiles[index];
          progress.report({
            message: path.basename(testFile),
            increment: testFiles.length ? 100 / testFiles.length : 100,
          });
          const result = await runCli(testFile, executeTests, options.sourceFiles || []);
          result.__testFile = testFile;
          reports.push(result);
          applyDiagnostics(testFile, result);
          reportsByFile.set(core.normalizePath(testFile), result);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Ghost Test Catcher failed: ${error.message}`);
        return;
      }
      lastReports = reports;
      codeLensChanged.fire();
      openLastReport();
      const summary = core.summarizeReports(reports);
      vscode.window.showInformationMessage(
        `Ghost Test Catcher: ${summary.reliable} reliable, ${summary.needsReview} needs review, ${summary.ghostRisk} ghost risk.`
      );
    }
  );
}

async function runCli(testFile, executeTests, selectedSourceFiles = []) {
  const workspaceFolder = getWorkspaceFolderForFile(testFile);
  if (!workspaceFolder) {
    throw new Error("The selected test file is not inside an open workspace.");
  }

  const root = core.findProjectRootForFile(testFile, workspaceFolder.uri.fsPath);
  const config = getConfig();
  const selectedSourcePaths = core.toRelativeSourcePaths(root, selectedSourceFiles);
  const sourcePaths = selectedSourcePaths.length ? selectedSourcePaths : config.get("sourcePaths", ["src"]);
  const args = core.buildAnalyzeArgs({
    root,
    testFile,
    sourcePaths,
    testMode: config.get("testMode", "mixed"),
    maxFiles: config.get("maxFiles", 80),
    executeTests,
  });

  const pythonPath = config.get("pythonPath", "python");
  const env = { ...process.env };
  const srcPath = path.join(root, "src");
  env.PYTHONPATH = env.PYTHONPATH ? `${srcPath}${path.delimiter}${env.PYTHONPATH}` : srcPath;

  const { stdout, stderr } = await execFile(pythonPath, args, {
    cwd: root,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });

  try {
    return JSON.parse(stdout);
  } catch (error) {
    const detail = stderr ? `${stdout}\n${stderr}` : stdout;
    throw new Error(`Ghost Test Catcher returned invalid JSON.\n${detail}`);
  }
}

function applyDiagnostics(testFile, result) {
  const uri = vscode.Uri.file(testFile);
  const text = fs.readFileSync(testFile, "utf-8");
  const locations = findTestFunctions(text);
  const checks = core.mapBy(result.verification?.claim_checks || [], "claim");
  const runs = core.mapBy(result.execution?.per_test_results || [], "name");
  const names = result.generated_tests?.test_names || [];
  const fileDiagnostics = [];

  for (const name of names) {
    const check = checks.get(name) || {};
    const run = runs.get(name) || {};
    const range = locations.get(name) || new vscode.Range(0, 0, 0, 1);
    const groundedStatus = check.status || "unsupported";
    const executionStatus = run.status || "unknown";
    const missing = check.missing_symbols || [];
    const categories = check.risk_categories || [];
    const confidence = core.percent(Number(check.confidence || 0));
    const severity = diagnosticSeverity(groundedStatus, executionStatus);
    const missingText = missing.length ? ` Missing symbols: ${missing.join(", ")}.` : "";
    const categoryText = categories.length ? ` Categories: ${categories.join(", ")}.` : "";
    const diagnostic = new vscode.Diagnostic(
      range,
      `Ghost Test Catcher: ${core.supportLabel(groundedStatus)} (${confidence} grounded), test run ${executionStatus}.${missingText}${categoryText}`,
      severity
    );
    diagnostic.source = "Ghost Test Catcher";
    diagnostic.code = "ghost-test-catcher";
    fileDiagnostics.push(diagnostic);
  }

  diagnostics.set(uri, fileDiagnostics);
}

function openLastReport(explicitResult) {
  const reports = explicitResult ? [explicitResult] : lastReports;
  if (!reports.length) {
    vscode.window.showInformationMessage("No Ghost Test Catcher report is available yet.");
    return;
  }

  if (!reportPanel) {
    reportPanel = vscode.window.createWebviewPanel(
      "ghostTestCatcherReport",
      "Ghost Test Catcher",
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    reportPanel.onDidDispose(() => {
      reportPanel = undefined;
    });
  }

  reportPanel.webview.html = core.renderReportHtml(reports);
  reportPanel.reveal(vscode.ViewColumn.Beside);
}

class GhostCodeLensProvider {
  get onDidChangeCodeLenses() {
    return codeLensChanged.event;
  }

  provideCodeLenses(document) {
    const result = reportsByFile.get(core.normalizePath(document.uri.fsPath));
    if (!result) {
      return [];
    }
    const locations = findTestFunctions(document.getText());
    const checks = core.mapBy(result.verification?.claim_checks || [], "claim");
    const runs = core.mapBy(result.execution?.per_test_results || [], "name");
    return (result.generated_tests?.test_names || []).map((name) => {
      const check = checks.get(name) || {};
      const run = runs.get(name) || {};
      const range = locations.get(name) || new vscode.Range(0, 0, 0, 1);
      const title = `Ghost Test: ${core.supportLabel(check.status || "unsupported")} | run ${run.status || "unknown"} | ${core.percent(Number(check.confidence || 0))}`;
      return new vscode.CodeLens(range, {
        title,
        command: "ghostTestCatcher.openLastReport",
        arguments: [result],
      });
    });
  }
}

function findTestFunctions(text) {
  const locations = new Map();
  for (const item of core.parseTestFunctionLocations(text)) {
    const range = new vscode.Range(item.line, item.start, item.line, item.end);
    locations.set(item.name, range);
    if (item.qualifiedName) {
      locations.set(item.qualifiedName, range);
    }
  }
  return locations;
}

function diagnosticSeverity(groundedStatus, executionStatus) {
  if (groundedStatus === "unsupported" || executionStatus === "error") {
    return vscode.DiagnosticSeverity.Error;
  }
  if (groundedStatus === "borderline" || executionStatus === "failed" || executionStatus === "skipped") {
    return vscode.DiagnosticSeverity.Warning;
  }
  return vscode.DiagnosticSeverity.Information;
}

function gitChangedFiles(root) {
  return execFile("git", ["diff", "--name-only", "HEAD"], { cwd: root })
    .then(({ stdout }) => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .catch(() => []);
}

async function expandSelectedPaths(selectedPaths) {
  const files = [];
  const seen = new Set();
  for (const selectedPath of selectedPaths) {
    await collectPythonFiles(selectedPath, files, seen);
  }
  return files;
}

async function collectPythonFiles(selectedPath, files, seen) {
  let stats;
  try {
    stats = await fs.promises.stat(selectedPath);
  } catch {
    return;
  }
  const normalized = core.normalizePath(selectedPath);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);

  if (stats.isDirectory()) {
    if (shouldSkipDirectory(selectedPath)) {
      return;
    }
    const entries = await fs.promises.readdir(selectedPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await collectPythonFiles(path.join(selectedPath, entry.name), files, seen);
    }
    return;
  }

  if (stats.isFile() && core.isPythonPath(selectedPath)) {
    files.push(selectedPath);
  }
}

function shouldSkipDirectory(directory) {
  const normalized = core.toPosixPath(directory).toLowerCase();
  const name = path.basename(normalized);
  return [
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
  ].includes(name) || normalized.endsWith("/docs/_build");
}

function execFile(command, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const message = stderr || stdout || error.message;
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getConfig() {
  return vscode.workspace.getConfiguration("ghostTestCatcher");
}

function getActiveWorkspaceFolder() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    return vscode.workspace.getWorkspaceFolder(editor.document.uri);
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function getWorkspaceFolderForFile(file) {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
}

module.exports = {
  activate,
  deactivate,
};
