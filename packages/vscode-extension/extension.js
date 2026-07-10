const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");
const cacheModule = require("./extensionCache");
const diagnosticsModule = require("./extensionDiagnostics");
const reportsModule = require("./extensionReports");
const setupModule = require("./extensionSetup");
const testingModule = require("./extensionTesting");
const utils = require("./extensionUtils");

const {
  isCancellationError,
  shouldSkipDirectory,
} = utils;

let codeLensChanged;
let diagnosticManager;
let reportPanels;
let outputChannel;
let testExplorer;
let analysisCacheManager;
let setupManager;
let lastReports = [];
const ANALYSIS_TIMEOUT_MS = 120000;
const DOCTOR_TIMEOUT_MS = 30000;
const SETUP_NUDGE_STORAGE_KEY = "ghostTestCatcher.setupNudge.v1";

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection("ghost-test-catcher");
  codeLensChanged = new vscode.EventEmitter();
  diagnosticManager = new diagnosticsModule.GhostDiagnosticManager({ vscode, diagnostics, codeLensChanged });
  reportPanels = new reportsModule.GhostReportPanels({ vscode, createNonce: utils.createNonce });
  outputChannel = vscode.window.createOutputChannel("Ghost Test Catcher");
  setupManager = new setupModule.GhostSetupManager({
    vscode,
    context,
    getConfig,
    getActiveWorkspaceFolder,
    buildPythonEnv,
    execFile,
    openDoctorReport,
    logOutput,
  });
  analysisCacheManager = new cacheModule.AnalysisCacheManager({
    workspaceState: context.workspaceState,
    getConfig,
    logOutput,
  });
  analysisCacheManager.load();

  context.subscriptions.push(diagnostics);
  context.subscriptions.push(codeLensChanged);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeCurrentTest", analyzeCurrentTest));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeChangedTests", analyzeChangedTests));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeSelectedFiles", analyzeSelectedFiles));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.setup", setupGhostTestCatcher));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.runDoctor", runDoctor));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openLastReport", openLastReport));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openSetupGuide", openSetupGuide));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.refreshTestExplorer", refreshTestExplorer));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.clearAnalysisCache", clearAnalysisCache));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.copyReportSummary", copyReportSummary));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.addGitHubActionsGate", addGitHubActionsGate));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openEvidence", openEvidence));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.copyMissingSymbols", copyMissingSymbols));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.runStaticAnalysisForFile", runStaticAnalysisForFile));
  diagnosticManager.register(context);
  testExplorer = new testingModule.GhostTestExplorer({
    vscode,
    getConfig,
    getWorkspaceFolderForFile,
    runCli,
    resolveExecutionMode,
    publishResult,
    onReports: updateLastReports,
    onPythonFileChanged: handlePythonFileChanged,
    onPythonFileDeleted: handlePythonFileDeleted,
    logOutput,
  });
  testExplorer.register(context);
  restoreCachedReports().catch((error) => logOutput(`Failed to restore cached reports: ${error.message}`));
  maybeShowSetupNudge(context).catch((error) => logOutput(`Setup nudge failed: ${error.message}`));
}

function deactivate() {
  diagnosticManager?.clear();
  testExplorer?.dispose();
}

async function refreshTestExplorer() {
  await testExplorer?.refreshTestExplorer();
}

async function openSetupGuide() {
  await setupManager?.openExtensionReadme();
}

async function maybeShowSetupNudge(context) {
  if (process.env.GHOST_TEST_CATCHER_DISABLE_SETUP_NUDGE === "1") {
    return;
  }
  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }
  if (!getConfig().get("setupNudgeEnabled", true)) {
    return;
  }
  if (context.workspaceState.get(SETUP_NUDGE_STORAGE_KEY, false)) {
    return;
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  const activePythonTest = activeDocument?.languageId === "python" && core.isTestPath(activeDocument.uri.fsPath);
  const hasPythonTests = activePythonTest || await workspaceHasPythonTests();
  if (!hasPythonTests) {
    return;
  }

  await context.workspaceState.update(SETUP_NUDGE_STORAGE_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    "Ghost Test Catcher can verify Python tests against real source evidence before you trust them.",
    "Set Up",
    "Open Guide",
    "Later"
  );
  if (choice === "Set Up") {
    await vscode.commands.executeCommand("ghostTestCatcher.setup");
  } else if (choice === "Open Guide") {
    await openSetupGuide();
  }
}

async function workspaceHasPythonTests() {
  const excludes = "**/{.git,node_modules,.venv,venv,__pycache__,.tox,.nox,build,dist}/**";
  for (const pattern of ["**/test_*.py", "**/*_test.py", "**/tests/**/*.py"]) {
    const matches = await vscode.workspace.findFiles(pattern, excludes, 1);
    if (matches.length) {
      return true;
    }
  }
  return false;
}

async function clearAnalysisCache() {
  await analysisCacheManager?.clear();
  vscode.window.showInformationMessage("Ghost Test Catcher analysis cache cleared.");
}

async function copyReportSummary(explicitReports) {
  const reports = Array.isArray(explicitReports) && explicitReports.length ? explicitReports : lastReports;
  if (!reports.length) {
    vscode.window.showInformationMessage("No Ghost Test Catcher report is available to copy yet.");
    return;
  }

  const markdown = core.renderMarkdownReportSummary(reports, { workspaceRoot: workspaceRootForReports(reports) });
  await vscode.env.clipboard.writeText(markdown);
  const testCount = core.summarizeTestDecisions(reports).total;
  vscode.window.showInformationMessage(`Copied Ghost Test Catcher summary for ${testCount} test${testCount === 1 ? "" : "s"}.`);
}

function workspaceRootForReports(reports) {
  for (const result of reports || []) {
    const candidate = result?.__testFile || result?.input_test_files?.find((item) => item?.path)?.path;
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidate));
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return getActiveWorkspaceFolder()?.uri.fsPath || "";
}

async function addGitHubActionsGate() {
  const folder = getActiveWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Open a workspace before adding the Ghost Test Catcher GitHub Actions gate.");
    return;
  }

  const config = getConfig();
  const workflowPath = path.join(folder.uri.fsPath, ".github", "workflows", "ghost-test-catcher.yml");
  if (fs.existsSync(workflowPath)) {
    const choice = await vscode.window.showWarningMessage(
      "A Ghost Test Catcher GitHub Actions workflow already exists. Overwrite it?",
      { modal: false },
      "Overwrite",
      "Cancel"
    );
    if (choice !== "Overwrite") {
      return;
    }
  }

  const content = core.renderGitHubActionsWorkflow({
    pythonVersion: config.get("ciPythonVersion", "3.11"),
    failOn: config.get("ciFailOn", "ghost_risk"),
    sourcePaths: config.get("sourcePaths", ["src"]),
    testPaths: config.get("ciTestPaths", ["tests"]),
  });
  await fs.promises.mkdir(path.dirname(workflowPath), { recursive: true });
  await fs.promises.writeFile(workflowPath, content, "utf-8");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(workflowPath));
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  vscode.window.showInformationMessage("Ghost Test Catcher GitHub Actions gate added.");
}

async function openEvidence(testFile, evidence) {
  if (!evidence?.path) {
    vscode.window.showWarningMessage("No evidence file is available for this Ghost Test Catcher diagnostic.");
    return;
  }
  const workspaceFolder = getWorkspaceFolderForFile(testFile);
  const root = workspaceFolder
    ? core.findProjectRootForFile(testFile, workspaceFolder.uri.fsPath)
    : path.dirname(testFile);
  const evidencePath = path.isAbsolute(evidence.path) ? evidence.path : path.join(root, evidence.path);
  if (!fs.existsSync(evidencePath)) {
    vscode.window.showWarningMessage(`Ghost Test Catcher evidence file does not exist: ${evidence.path}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(evidencePath));
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  const line = Math.min(document.lineCount - 1, Math.max(0, Number(evidence.start_line || 1) - 1));
  const range = new vscode.Range(line, 0, line, Math.max(1, document.lineAt(line).text.length));
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function copyMissingSymbols(symbols) {
  const missing = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  if (!missing.length) {
    vscode.window.showInformationMessage("No missing symbols were recorded for this Ghost Test Catcher diagnostic.");
    return;
  }
  await vscode.env.clipboard.writeText(missing.join("\n"));
  vscode.window.showInformationMessage(`Copied ${missing.length} missing symbol${missing.length === 1 ? "" : "s"} from Ghost Test Catcher.`);
}

async function runStaticAnalysisForFile(testFile) {
  if (!testFile || !fs.existsSync(testFile)) {
    vscode.window.showWarningMessage("Ghost Test Catcher could not find the selected test file for static analysis.");
    return;
  }
  await analyzeFiles([testFile], "Running static Ghost Test Catcher analysis", {
    executeTestsOverride: false,
    skipExecutionPrompt: true,
  });
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
  const executionMode = await resolveExecutionMode(options);
  if (!executionMode) {
    return;
  }
  const { executeTests } = executionMode;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (progress, token) => {
      const reports = [];
      try {
        for (let index = 0; index < testFiles.length; index += 1) {
          if (token.isCancellationRequested) {
            vscode.window.showInformationMessage("Ghost Test Catcher analysis cancelled.");
            return;
          }
          const testFile = testFiles[index];
          progress.report({
            message: `${index + 1}/${testFiles.length}: ${path.basename(testFile)}`,
            increment: 0,
          });
          const result = await runCli(testFile, executeTests, options.sourceFiles || [], token);
          result.__testFile = testFile;
          reports.push(result);
          publishResult(testFile, result);
          progress.report({
            increment: testFiles.length ? 100 / testFiles.length : 100,
          });
        }
      } catch (error) {
        if (isCancellationError(error)) {
          vscode.window.showInformationMessage("Ghost Test Catcher analysis cancelled.");
          return;
        }
        logOutput(`Analysis failed: ${error.message}`);
        vscode.window.showErrorMessage(`Ghost Test Catcher failed: ${error.message}`);
        return;
      }
      if (!reports.length) {
        return;
      }
      updateLastReports(reports);
      openLastReport();
      const summary = core.summarizeReports(reports);
      vscode.window.showInformationMessage(
        `Ghost Test Catcher: ${summary.reliable} reliable, ${summary.needsReview} needs review, ${summary.ghostRisk} ghost risk. Cost: ${core.costSummaryText(reports)}.`
      );
    }
  );
}

function publishResult(testFile, result) {
  diagnosticManager?.publish(testFile, result);
}

function updateLastReports(reports) {
  lastReports = reports;
  diagnosticManager?.fireCodeLensChanged();
}

async function resolveExecutionMode(options = {}) {
  const config = getConfig();
  let executeTests = typeof options.executeTestsOverride === "boolean"
    ? options.executeTestsOverride
    : config.get("executeTests", true);
  const confirmExecution = config.get("confirmExecution", true);
  const requireWorkspaceTrust = config.get("requireWorkspaceTrustForExecution", true);

  if (executeTests && requireWorkspaceTrust && !vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      "Ghost Test Catcher will not execute Python tests in an untrusted workspace. Run static analysis only instead?",
      { modal: false },
      "Run Static Analysis",
      "Cancel"
    );
    if (choice !== "Run Static Analysis") {
      return null;
    }
    executeTests = false;
  }

  if (executeTests && confirmExecution && !options.skipExecutionPrompt) {
    const choice = await vscode.window.showWarningMessage(
      "Ghost Test Catcher will execute Python tests against a temporary copy of the selected tests and source files.",
      { modal: false },
      "Run Analysis",
      "Cancel"
    );
    if (choice !== "Run Analysis") {
      return null;
    }
  }

  return { executeTests };
}

async function runCli(testFile, executeTests, selectedSourceFiles = [], token) {
  const workspaceFolder = getWorkspaceFolderForFile(testFile);
  if (!workspaceFolder) {
    throw new Error("The selected test file is not inside an open workspace.");
  }

  const root = core.findProjectRootForFile(testFile, workspaceFolder.uri.fsPath);
  const config = getConfig();
  const selectedSourcePaths = core.toRelativeSourcePaths(root, selectedSourceFiles);
  const configuredSourcePaths = config.get("sourcePaths", ["src"]);
  const inferredSourcePaths = config.get("smartSourceContext", true)
    ? core.inferSourcePathsFromImports(root, testFile)
    : [];
  const sourcePaths = selectedSourcePaths.length
    ? selectedSourcePaths
    : core.mergeSourcePaths(inferredSourcePaths, configuredSourcePaths);
  const testMode = config.get("testMode", "mixed");
  const maxFiles = config.get("maxFiles", 80);
  const executionBackend = config.get("executionBackend", "local");
  const dockerImage = executionBackend === "docker" ? config.get("dockerImage", "ghost-test-catcher-runner:latest") : "";
  const args = core.buildAnalyzeArgs({
    root,
    testFile,
    sourcePaths,
    testMode,
    maxFiles,
    executeTests,
    executionBackend,
    dockerImage,
  });

  const pythonPath = config.get("pythonPath", "python");
  const env = buildPythonEnv(root);
  const label = `analysis for ${path.relative(root, testFile)}`;
  const cacheMetadata = {
    root,
    testFile,
    sourcePaths,
    testMode,
    maxFiles,
    executeTests,
    pythonPath,
    executionBackend,
    dockerImage,
  };
  const cacheEnabled = config.get("analysisCacheEnabled", true);
  const cacheKey = core.analysisCacheKey(cacheMetadata);
  const fingerprints = cacheEnabled
    ? await analysisCacheManager.buildFingerprints(root, testFile, sourcePaths, config.get("cacheFingerprintLimit", 300))
    : null;
  if (cacheEnabled && fingerprints) {
    const cached = analysisCacheManager.read(cacheKey, fingerprints);
    if (cached) {
      logOutput(`Using cached ${label}.`);
      cached.__sourcePaths = sourcePaths;
      cached.__inferredSourcePaths = inferredSourcePaths;
      cached.__cacheHit = true;
      return cached;
    }
  }

  const { stdout, stderr } = await execFile(pythonPath, args, {
    cwd: root,
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: ANALYSIS_TIMEOUT_MS,
    token,
    label,
  });

  try {
    const result = JSON.parse(stdout);
    result.__sourcePaths = sourcePaths;
    result.__inferredSourcePaths = inferredSourcePaths;
    result.__cacheHit = false;
    if (cacheEnabled && fingerprints) {
      await analysisCacheManager.write(cacheKey, cacheMetadata, fingerprints, result);
    }
    return result;
  } catch (error) {
    const detail = stderr ? `${stdout}\n${stderr}` : stdout;
    logOutput(`Invalid JSON from ${label}:\n${detail}`);
    throw new Error(`Ghost Test Catcher returned invalid JSON.\n${detail}`);
  }
}

async function restoreCachedReports() {
  const restored = await analysisCacheManager.restore();
  const published = [];
  for (const result of restored) {
    try {
      publishResult(result.__testFile, result);
      published.push(result);
    } catch (error) {
      logOutput(`Could not restore cached diagnostics for ${result.__testFile}: ${error.message}`);
    }
  }
  if (published.length) {
    updateLastReports(published
      .sort((left, right) => String(left.__testFile || "").localeCompare(String(right.__testFile || "")))
      .slice(0, 20));
    logOutput(`Restored ${published.length} cached Ghost Test Catcher report${published.length === 1 ? "" : "s"}.`);
  }
}

function handlePythonFileChanged(uri) {
  if (!uri || uri.scheme !== "file") {
    return;
  }
  invalidateAnalysisCacheForPath(uri.fsPath);
  if (core.isTestPath(uri.fsPath)) {
    diagnosticManager?.deleteFile(uri);
    diagnosticManager?.fireCodeLensChanged();
  }
}

function handlePythonFileDeleted(uri) {
  if (!uri || uri.scheme !== "file") {
    return;
  }
  invalidateAnalysisCacheForPath(uri.fsPath);
  diagnosticManager?.deleteFile(uri);
  diagnosticManager?.fireCodeLensChanged();
}

function invalidateAnalysisCacheForPath(changedPath) {
  analysisCacheManager?.invalidateForPath(changedPath).catch((error) => {
    logOutput(`Failed to persist cache invalidation: ${error.message}`);
  });
}

async function setupGhostTestCatcher(uri) {
  await setupManager?.setup(uri);
}

async function runDoctor(uri) {
  await setupManager?.runDoctor(uri);
}

function openDoctorReport(report) {
  reportPanels?.openDoctorReport(report);
}

function openLastReport(explicitResult) {
  reportPanels?.openLastReport(lastReports, explicitResult);
}

function gitChangedFiles(root) {
  return execFile("git", ["diff", "--name-only", "HEAD"], {
    cwd: root,
    timeout: DOCTOR_TIMEOUT_MS,
    label: "git changed files",
  })
    .then(({ stdout }) => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .catch(() => []);
}

function buildPythonEnv(root, options = {}) {
  const includeWorkspacePaths = typeof options.includeWorkspacePaths === "boolean"
    ? options.includeWorkspacePaths
    : vscode.workspace.isTrusted;
  return utils.buildPythonEnv(root, { ...options, includeWorkspacePaths });
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

function execFile(command, args, options = {}) {
  return utils.execFile(command, args, {
    ...options,
    logOutput,
    appendOutput,
  });
}

function logOutput(message) {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function appendOutput(message) {
  if (outputChannel) {
    outputChannel.append(String(message));
  }
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
