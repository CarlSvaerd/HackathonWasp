const vscode = require("vscode");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");

let diagnostics;
let codeLensChanged;
let reportPanel;
let doctorPanel;
let outputChannel;
let testController;
let testRunProfile;
let lastReports = [];
const reportsByFile = new Map();
const testItemMetadataById = new Map();
const pendingTestRefreshes = new Map();
const ANALYSIS_TIMEOUT_MS = 120000;
const DOCTOR_TIMEOUT_MS = 30000;
const TEST_REFRESH_DELAY_MS = 250;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("ghost-test-catcher");
  codeLensChanged = new vscode.EventEmitter();
  outputChannel = vscode.window.createOutputChannel("Ghost Test Catcher");

  context.subscriptions.push(diagnostics);
  context.subscriptions.push(codeLensChanged);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeCurrentTest", analyzeCurrentTest));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeChangedTests", analyzeChangedTests));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeSelectedFiles", analyzeSelectedFiles));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.runDoctor", runDoctor));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openLastReport", openLastReport));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.refreshTestExplorer", refreshTestExplorer));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "python" }, new GhostCodeLensProvider()));
  setupTestController(context);
}

function deactivate() {
  if (diagnostics) {
    diagnostics.clear();
  }
  for (const timer of pendingTestRefreshes.values()) {
    clearTimeout(timer);
  }
  pendingTestRefreshes.clear();
}

function setupTestController(context) {
  testController = vscode.tests.createTestController("ghostTestCatcher", "Ghost Test Catcher");
  testController.resolveHandler = async (item) => {
    if (!item) {
      await discoverWorkspaceTests();
      return;
    }
    const metadata = testItemMetadataById.get(item.id);
    if (metadata?.type === "file" && item.uri) {
      await refreshTestFile(item.uri);
    }
  };
  testRunProfile = testController.createRunProfile(
    "Analyze with Ghost Test Catcher",
    vscode.TestRunProfileKind.Run,
    runNativeTestAnalysis,
    true
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
  watcher.onDidCreate(scheduleTestFileRefresh, null, context.subscriptions);
  watcher.onDidChange(scheduleTestFileRefresh, null, context.subscriptions);
  watcher.onDidDelete((uri) => removeTestFileItem(uri.fsPath), null, context.subscriptions);

  context.subscriptions.push(testController);
  context.subscriptions.push(testRunProfile);
  context.subscriptions.push(watcher);
}

async function refreshTestExplorer() {
  await discoverWorkspaceTests();
  vscode.window.showInformationMessage("Ghost Test Catcher refreshed the Testing panel.");
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
  const executionMode = await resolveExecutionMode();
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
          applyDiagnostics(testFile, result);
          reportsByFile.set(core.normalizePath(testFile), result);
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

async function resolveExecutionMode() {
  const config = getConfig();
  let executeTests = config.get("executeTests", true);
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

  if (executeTests && confirmExecution) {
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
  const args = core.buildAnalyzeArgs({
    root,
    testFile,
    sourcePaths,
    testMode: config.get("testMode", "mixed"),
    maxFiles: config.get("maxFiles", 80),
    executeTests,
  });

  const pythonPath = config.get("pythonPath", "python");
  const env = buildPythonEnv(root);
  const label = `analysis for ${path.relative(root, testFile)}`;

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
    return result;
  } catch (error) {
    const detail = stderr ? `${stdout}\n${stderr}` : stdout;
    logOutput(`Invalid JSON from ${label}:\n${detail}`);
    throw new Error(`Ghost Test Catcher returned invalid JSON.\n${detail}`);
  }
}

async function discoverWorkspaceTests() {
  if (!testController || !vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const limit = getConfig().get("testDiscoveryLimit", 500);
  const exclude = "{**/.git/**,**/.hg/**,**/.mypy_cache/**,**/.pytest_cache/**,**/.ruff_cache/**,**/.tox/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/build/**,**/dist/**,**/node_modules/**,**/docs/_build/**}";
  const uris = await vscode.workspace.findFiles("**/*.py", exclude, limit);
  const hitDiscoveryLimit = uris.length >= limit;
  const discoveredFiles = new Set();

  for (const uri of uris) {
    if (!core.isTestPath(uri.fsPath)) {
      continue;
    }
    discoveredFiles.add(core.normalizePath(uri.fsPath));
    await refreshTestFile(uri);
  }

  for (const filePath of knownTestControllerFiles()) {
    if (!fs.existsSync(filePath) || (!hitDiscoveryLimit && !discoveredFiles.has(core.normalizePath(filePath)))) {
      removeTestFileItem(filePath);
    }
  }

  if (hitDiscoveryLimit) {
    logOutput(`Test discovery reached ghostTestCatcher.testDiscoveryLimit (${limit}). Increase the setting if tests are missing from the Testing panel.`);
  }
}

async function refreshTestFile(uri) {
  if (!testController || !uri || uri.scheme !== "file") {
    return;
  }

  const testFile = uri.fsPath;
  if (!core.isPythonPath(testFile) || !core.isTestPath(testFile)) {
    removeTestFileItem(testFile);
    return;
  }

  let text;
  try {
    text = await fs.promises.readFile(testFile, "utf-8");
  } catch (error) {
    removeTestFileItem(testFile);
    return;
  }

  const locations = core.parseTestFunctionLocations(text);
  if (!locations.length) {
    removeTestFileItem(testFile);
    return;
  }

  const fileId = testFileItemId(testFile);
  const workspaceFolder = getWorkspaceFolderForFile(testFile);
  const root = workspaceFolder
    ? core.findProjectRootForFile(testFile, workspaceFolder.uri.fsPath)
    : path.dirname(testFile);
  const label = core.relativePathFromRoot(root, testFile) || path.basename(testFile);
  let fileItem = testController.items.get(fileId);
  if (!fileItem) {
    fileItem = testController.createTestItem(fileId, label, uri);
    testController.items.add(fileItem);
  }
  fileItem.label = label;
  fileItem.canResolveChildren = false;
  clearTestMetadataForFile(testFile);
  testItemMetadataById.set(fileId, { type: "file", filePath: testFile });

  const childItems = locations.map((location) => {
    const qualifiedName = location.qualifiedName || location.name;
    const item = testController.createTestItem(testCaseItemId(testFile, qualifiedName), qualifiedName, uri);
    item.range = new vscode.Range(location.line, location.start, location.line, location.end);
    testItemMetadataById.set(item.id, {
      type: "test",
      filePath: testFile,
      name: location.name,
      qualifiedName,
    });
    return item;
  });
  fileItem.children.replace(childItems);
}

async function runNativeTestAnalysis(request, token) {
  const run = testController.createTestRun(request, "Ghost Test Catcher");
  const completed = new Set();
  try {
    await ensureTestsResolvedForRequest(request, token);
    const selectedItems = collectRunnableTestItems(request);
    if (!selectedItems.length) {
      return;
    }

    for (const item of selectedItems) {
      run.enqueued(item);
    }

    const executionMode = await resolveExecutionMode();
    if (!executionMode) {
      for (const item of selectedItems) {
        run.skipped(item);
        completed.add(item.id);
      }
      return;
    }

    const reports = [];
    const groupedItems = groupTestItemsByFile(selectedItems);
    for (const [testFile, items] of groupedItems) {
      throwIfCancellationRequested(token, "Ghost Test Catcher native test run was cancelled.");
      for (const item of items) {
        run.started(item);
      }

      try {
        const result = await runCli(testFile, executionMode.executeTests, [], token);
        result.__testFile = testFile;
        reports.push(result);
        applyDiagnostics(testFile, result);
        reportsByFile.set(core.normalizePath(testFile), result);
        applyNativeTestResults(run, items, result, completed);
      } catch (error) {
        if (isCancellationError(error)) {
          for (const item of items) {
            if (!completed.has(item.id)) {
              run.skipped(item);
              completed.add(item.id);
            }
          }
          vscode.window.showInformationMessage("Ghost Test Catcher Testing run cancelled.");
          return;
        }
        logOutput(`Testing panel analysis failed for ${testFile}: ${error.message}`);
        for (const item of items) {
          if (!completed.has(item.id)) {
            run.errored(item, new vscode.TestMessage(error.message));
            completed.add(item.id);
          }
        }
      }
    }

    for (const item of selectedItems) {
      if (!completed.has(item.id)) {
        run.skipped(item);
      }
    }

    if (reports.length) {
      lastReports = reports;
      codeLensChanged.fire();
      const summary = core.summarizeReports(reports);
      vscode.window.showInformationMessage(
        `Ghost Test Catcher Testing: ${summary.reliable} reliable, ${summary.needsReview} needs review, ${summary.ghostRisk} ghost risk.`
      );
    }
  } catch (error) {
    if (isCancellationError(error)) {
      vscode.window.showInformationMessage("Ghost Test Catcher Testing run cancelled.");
      return;
    }
    logOutput(`Testing panel run failed: ${error.message}`);
    vscode.window.showErrorMessage(`Ghost Test Catcher Testing failed: ${error.message}`);
  } finally {
    run.end();
  }
}

async function ensureTestsResolvedForRequest(request, token) {
  throwIfCancellationRequested(token, "Ghost Test Catcher native test run was cancelled.");
  if (!request.include || !request.include.length) {
    await discoverWorkspaceTests();
    return;
  }

  const fileUris = new Map();
  for (const item of request.include) {
    const metadata = testItemMetadataById.get(item.id);
    if (metadata?.type === "file" && item.uri) {
      fileUris.set(core.normalizePath(item.uri.fsPath), item.uri);
    }
  }

  for (const uri of fileUris.values()) {
    throwIfCancellationRequested(token, "Ghost Test Catcher native test run was cancelled.");
    await refreshTestFile(uri);
  }
}

function applyNativeTestResults(run, items, result, completed) {
  const checks = core.mapBy(result.verification?.claim_checks || [], "claim");
  const runs = core.mapBy(result.execution?.per_test_results || [], "name");

  for (const item of items) {
    const metadata = testItemMetadataById.get(item.id);
    if (!metadata) {
      run.errored(item, new vscode.TestMessage("Ghost Test Catcher could not resolve metadata for this test item."));
      completed.add(item.id);
      continue;
    }

    const check = lookupByTestName(checks, metadata) || {};
    const execution = lookupByTestName(runs, metadata) || {};
    if (!check.status && !execution.status) {
      run.errored(item, new vscode.TestMessage(`Ghost Test Catcher did not return a result for ${metadata.qualifiedName}.`));
      completed.add(item.id);
      continue;
    }

    const groundedStatus = check.status || "unsupported";
    const executionStatus = execution.status || "unknown";
    const outcome = core.nativeTestOutcome(groundedStatus, executionStatus);
    const message = new vscode.TestMessage(core.nativeTestMessage({
      name: metadata.qualifiedName,
      groundedStatus,
      executionStatus,
      confidence: check.confidence,
      missingSymbols: check.missing_symbols || [],
      riskCategories: check.risk_categories || [],
      recommendation: check.recommendation || "",
    }));

    if (outcome === "passed") {
      run.passed(item);
    } else if (outcome === "failed") {
      run.failed(item, message);
    } else {
      run.skipped(item);
    }
    completed.add(item.id);
  }
}

function collectRunnableTestItems(request) {
  const excluded = new Set();
  for (const item of request.exclude || []) {
    collectTestItemIds(item, excluded);
  }

  const roots = request.include && request.include.length
    ? request.include
    : testItemCollectionToArray(testController.items);
  const selected = new Map();
  for (const item of roots) {
    collectLeafTestItems(item, excluded, selected);
  }
  return Array.from(selected.values());
}

function collectLeafTestItems(item, excluded, selected) {
  if (excluded.has(item.id)) {
    return;
  }
  const metadata = testItemMetadataById.get(item.id);
  if (metadata?.type === "test") {
    selected.set(item.id, item);
    return;
  }
  item.children.forEach((child) => collectLeafTestItems(child, excluded, selected));
}

function collectTestItemIds(item, ids) {
  ids.add(item.id);
  item.children.forEach((child) => collectTestItemIds(child, ids));
}

function groupTestItemsByFile(items) {
  const grouped = new Map();
  for (const item of items) {
    const metadata = testItemMetadataById.get(item.id);
    if (!metadata?.filePath) {
      continue;
    }
    if (!grouped.has(metadata.filePath)) {
      grouped.set(metadata.filePath, []);
    }
    grouped.get(metadata.filePath).push(item);
  }
  return grouped;
}

function lookupByTestName(items, metadata) {
  return items.get(metadata.qualifiedName) || items.get(metadata.name);
}

function testItemCollectionToArray(collection) {
  const items = [];
  collection.forEach((item) => items.push(item));
  return items;
}

function knownTestControllerFiles() {
  const files = new Set();
  for (const metadata of testItemMetadataById.values()) {
    if (metadata.type === "file") {
      files.add(metadata.filePath);
    }
  }
  return files;
}

function scheduleTestFileRefresh(uri) {
  if (!uri || uri.scheme !== "file" || !core.isPythonPath(uri.fsPath)) {
    return;
  }
  const key = core.normalizePath(uri.fsPath);
  const existing = pendingTestRefreshes.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    pendingTestRefreshes.delete(key);
    refreshTestFile(uri).catch((error) => logOutput(`Failed to refresh Testing panel item for ${uri.fsPath}: ${error.message}`));
  }, TEST_REFRESH_DELAY_MS);
  pendingTestRefreshes.set(key, timer);
}

function removeTestFileItem(testFile) {
  if (!testController) {
    return;
  }
  const fileId = testFileItemId(testFile);
  testController.items.delete(fileId);
  clearTestMetadataForFile(testFile);
}

function clearTestMetadataForFile(testFile) {
  const fileId = testFileItemId(testFile);
  const childPrefix = `${fileId}:`;
  for (const id of Array.from(testItemMetadataById.keys())) {
    if (id === fileId || id.startsWith(childPrefix)) {
      testItemMetadataById.delete(id);
    }
  }
}

function testFileItemId(testFile) {
  return `ghost-file:${core.normalizePath(testFile)}`;
}

function testCaseItemId(testFile, qualifiedName) {
  return `${testFileItemId(testFile)}:${qualifiedName}`;
}

async function runDoctor(uri) {
  const targetUri = uri?.scheme === "file"
    ? uri
    : vscode.window.activeTextEditor?.document.uri;
  const folder = targetUri
    ? vscode.workspace.getWorkspaceFolder(targetUri)
    : getActiveWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Open a workspace before running Ghost Test Catcher Doctor.");
    return;
  }

  const targetPath = targetUri?.scheme === "file" ? targetUri.fsPath : folder.uri.fsPath;
  const root = core.findProjectRootForFile(targetPath, folder.uri.fsPath);
  const config = getConfig();
  const pythonPath = config.get("pythonPath", "python");
  const configuredSourcePaths = config.get("sourcePaths", ["src"]);
  const inferredSourcePaths = targetPath && core.isPythonPath(targetPath) && core.isTestPath(targetPath)
    ? core.inferSourcePathsFromImports(root, targetPath)
    : [];
  const env = buildPythonEnv(root);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Running Ghost Test Catcher Doctor",
      cancellable: true,
    },
    async (progress, token) => {
      const report = {
        root,
        pythonPath,
        sourcePaths: core.mergeSourcePaths(inferredSourcePaths, configuredSourcePaths),
        inferredSourcePaths,
        importOk: false,
        importMessage: "",
        doctor: null,
      };

      try {
        progress.report({ message: "Checking Python module import" });
        const importCheck = await execFile(
          pythonPath,
          ["-c", "import llmSHAP.ghost.cli as cli; print(cli.__file__)"],
          {
            cwd: root,
            env,
            maxBuffer: 1024 * 1024,
            timeout: DOCTOR_TIMEOUT_MS,
            token,
            label: "doctor import check",
          }
        );
        report.importOk = true;
        report.importMessage = `Loaded llmSHAP.ghost.cli from ${importCheck.stdout.trim()}.`;
      } catch (error) {
        if (isCancellationError(error)) {
          vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
          return;
        }
        report.importOk = false;
        report.importMessage = `Could not import llmSHAP.ghost.cli with the configured Python path. ${error.message}`;
      }

      try {
        if (token.isCancellationRequested) {
          vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
          return;
        }
        progress.report({ message: "Inspecting CLI configuration" });
        const doctorResult = await execFile(
          pythonPath,
          ["-m", "llmSHAP.ghost.cli", "doctor", "--repo", root],
          {
            cwd: root,
            env,
            maxBuffer: 5 * 1024 * 1024,
            timeout: DOCTOR_TIMEOUT_MS,
            token,
            label: "doctor CLI inspection",
          }
        );
        report.doctor = JSON.parse(doctorResult.stdout);
      } catch (error) {
        if (isCancellationError(error)) {
          vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
          return;
        }
        report.doctor = {
          config: {
            source_paths: configuredSourcePaths,
            test_paths: [],
            test_mode: config.get("testMode", "mixed"),
            execute_tests: config.get("executeTests", true),
          },
          discovered_source_specs: [],
          discovered_test_specs: [],
          error: error.message,
        };
      }

      openDoctorReport(report);
      vscode.window.showInformationMessage(
        report.importOk
          ? "Ghost Test Catcher Doctor: Python module loaded successfully."
          : "Ghost Test Catcher Doctor: setup issue found."
      );
    }
  );
}

function openDoctorReport(report) {
  if (!doctorPanel) {
    doctorPanel = vscode.window.createWebviewPanel(
      "ghostTestCatcherDoctor",
      "Ghost Test Catcher Doctor",
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    doctorPanel.onDidDispose(() => {
      doctorPanel = undefined;
    });
  }

  doctorPanel.webview.html = core.renderDoctorHtml(report);
  doctorPanel.reveal(vscode.ViewColumn.Beside);
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
      { enableScripts: false, retainContextWhenHidden: true, localResourceRoots: [] }
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
  return execFile("git", ["diff", "--name-only", "HEAD"], {
    cwd: root,
    timeout: DOCTOR_TIMEOUT_MS,
    label: "git changed files",
  })
    .then(({ stdout }) => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .catch(() => []);
}

function buildPythonEnv(root) {
  const env = { ...process.env };
  const srcPath = path.join(root, "src");
  const entries = [srcPath, root];
  if (env.PYTHONPATH) {
    entries.push(env.PYTHONPATH);
  }
  env.PYTHONPATH = entries.join(path.delimiter);
  return env;
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

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const label = options.label || command;
    const timeoutMs = options.timeout || options.timeoutMs || 0;
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle;
    let cancellation;

    logOutput(`Running ${label}: ${command} ${args.map(quoteForLog).join(" ")}`);

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (cancellation) {
        cancellation.dispose();
      }
    };
    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const stopProcess = (message) => {
      terminateProcess(child);
      const error = new Error(message);
      error.cancelled = message.toLowerCase().includes("cancelled");
      finishReject(error);
    };
    const appendStdout = (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer) {
        stopProcess(`${label} produced more than ${maxBuffer} bytes of stdout.`);
      }
    };
    const appendStderr = (chunk) => {
      stderr += chunk;
      appendOutput(chunk);
      if (Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        stopProcess(`${label} produced more than ${maxBuffer} bytes of stderr.`);
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", appendStdout);
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", appendStderr);
    }

    child.on("error", (error) => {
      finishReject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code === 0) {
        finishResolve({ stdout, stderr });
        return;
      }
      const message = stderr.trim() || stdout.trim() || `${label} exited with code ${code}.`;
      const error = new Error(message);
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      finishReject(error);
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        stopProcess(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }, timeoutMs);
    }
    if (options.token) {
      cancellation = options.token.onCancellationRequested(() => {
        stopProcess(`${label} was cancelled.`);
      });
      if (options.token.isCancellationRequested) {
        stopProcess(`${label} was cancelled.`);
      }
    }
  });
}

function terminateProcess(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    const killer = childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      child.kill();
    });
    return;
  }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 3000);
  if (typeof killTimer.unref === "function") {
    killTimer.unref();
  }
}

function isCancellationError(error) {
  return Boolean(error?.cancelled) || /cancelled/i.test(error?.message || "");
}

function throwIfCancellationRequested(token, message) {
  if (token?.isCancellationRequested) {
    const error = new Error(message);
    error.cancelled = true;
    throw error;
  }
}

function quoteForLog(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
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
