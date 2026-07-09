const vscode = require("vscode");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");

let extensionContext;
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
const analysisCache = new Map();
const quickFixContextByDiagnosticKey = new Map();
const ANALYSIS_TIMEOUT_MS = 120000;
const DOCTOR_TIMEOUT_MS = 30000;
const SETUP_TIMEOUT_MS = 300000;
const TEST_REFRESH_DELAY_MS = 250;
const ANALYSIS_CACHE_STORAGE_KEY = "ghostTestCatcher.analysisCache.v1";
const ANALYSIS_CACHE_MAX_ENTRIES = 100;

function activate(context) {
  extensionContext = context;
  diagnostics = vscode.languages.createDiagnosticCollection("ghost-test-catcher");
  codeLensChanged = new vscode.EventEmitter();
  outputChannel = vscode.window.createOutputChannel("Ghost Test Catcher");
  loadAnalysisCache();

  context.subscriptions.push(diagnostics);
  context.subscriptions.push(codeLensChanged);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeCurrentTest", analyzeCurrentTest));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeChangedTests", analyzeChangedTests));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.analyzeSelectedFiles", analyzeSelectedFiles));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.setup", setupGhostTestCatcher));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.runDoctor", runDoctor));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openLastReport", openLastReport));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.refreshTestExplorer", refreshTestExplorer));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.clearAnalysisCache", clearAnalysisCache));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.addGitHubActionsGate", addGitHubActionsGate));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.openEvidence", openEvidence));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.copyMissingSymbols", copyMissingSymbols));
  context.subscriptions.push(vscode.commands.registerCommand("ghostTestCatcher.runStaticAnalysisForFile", runStaticAnalysisForFile));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "python" }, new GhostCodeLensProvider()));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
    { language: "python" },
    new GhostCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  ));
  setupTestController(context);
  restoreCachedReports().catch((error) => logOutput(`Failed to restore cached reports: ${error.message}`));
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
  watcher.onDidCreate(handlePythonFileChanged, null, context.subscriptions);
  watcher.onDidChange(handlePythonFileChanged, null, context.subscriptions);
  watcher.onDidDelete(handlePythonFileDeleted, null, context.subscriptions);

  context.subscriptions.push(testController);
  context.subscriptions.push(testRunProfile);
  context.subscriptions.push(watcher);
}

async function refreshTestExplorer() {
  await discoverWorkspaceTests();
  vscode.window.showInformationMessage("Ghost Test Catcher refreshed the Testing panel.");
}

async function clearAnalysisCache() {
  analysisCache.clear();
  await persistAnalysisCache();
  vscode.window.showInformationMessage("Ghost Test Catcher analysis cache cleared.");
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
    ? await buildAnalysisFingerprints(root, testFile, sourcePaths, config.get("cacheFingerprintLimit", 300))
    : null;
  if (cacheEnabled && fingerprints) {
    const cached = readCachedAnalysis(cacheKey, fingerprints);
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
      await writeCachedAnalysis(cacheKey, cacheMetadata, fingerprints, result);
    }
    return result;
  } catch (error) {
    const detail = stderr ? `${stdout}\n${stderr}` : stdout;
    logOutput(`Invalid JSON from ${label}:\n${detail}`);
    throw new Error(`Ghost Test Catcher returned invalid JSON.\n${detail}`);
  }
}

function loadAnalysisCache() {
  analysisCache.clear();
  const entries = extensionContext?.workspaceState.get(ANALYSIS_CACHE_STORAGE_KEY, []) || [];
  for (const entry of entries) {
    if (entry && entry.key && entry.result && entry.fingerprints && entry.metadata) {
      analysisCache.set(entry.key, entry);
    }
  }
}

async function persistAnalysisCache() {
  if (!extensionContext) {
    return;
  }
  const entries = Array.from(analysisCache.values())
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, ANALYSIS_CACHE_MAX_ENTRIES);
  await extensionContext.workspaceState.update(ANALYSIS_CACHE_STORAGE_KEY, entries);
}

async function restoreCachedReports() {
  const restored = [];
  let pruned = false;
  for (const [key, entry] of analysisCache.entries()) {
    const metadata = entry.metadata || {};
    if (!metadata.root || !metadata.testFile || !Array.isArray(metadata.sourcePaths)) {
      analysisCache.delete(key);
      pruned = true;
      continue;
    }

    const fingerprints = await buildAnalysisFingerprints(
      metadata.root,
      metadata.testFile,
      metadata.sourcePaths,
      getConfig().get("cacheFingerprintLimit", 300)
    );
    if (!fingerprints || !fingerprintsEqual(fingerprints, entry.fingerprints)) {
      analysisCache.delete(key);
      pruned = true;
      continue;
    }

    const result = cloneJson(entry.result);
    result.__testFile = metadata.testFile;
    result.__sourcePaths = metadata.sourcePaths;
    result.__inferredSourcePaths = result.__inferredSourcePaths || [];
    result.__cacheHit = true;
    reportsByFile.set(core.normalizePath(metadata.testFile), result);
    try {
      applyDiagnostics(metadata.testFile, result);
      restored.push(result);
    } catch (error) {
      logOutput(`Could not restore cached diagnostics for ${metadata.testFile}: ${error.message}`);
    }
  }
  if (restored.length) {
    lastReports = restored
      .sort((left, right) => String(left.__testFile || "").localeCompare(String(right.__testFile || "")))
      .slice(0, 20);
    codeLensChanged.fire();
    logOutput(`Restored ${restored.length} cached Ghost Test Catcher report${restored.length === 1 ? "" : "s"}.`);
  }
  if (pruned) {
    await persistAnalysisCache();
  }
}

function readCachedAnalysis(cacheKey, fingerprints) {
  const entry = analysisCache.get(cacheKey);
  if (!entry || !fingerprintsEqual(fingerprints, entry.fingerprints)) {
    return null;
  }
  entry.updatedAt = Date.now();
  persistAnalysisCache().catch((error) => logOutput(`Failed to update cache recency: ${error.message}`));
  return cloneJson(entry.result);
}

async function writeCachedAnalysis(cacheKey, metadata, fingerprints, result) {
  analysisCache.set(cacheKey, {
    key: cacheKey,
    metadata: cloneJson(metadata),
    fingerprints,
    result: cloneJson(result),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await persistAnalysisCache();
}

async function buildAnalysisFingerprints(root, testFile, sourcePaths, limit) {
  const entries = [];
  const state = { count: 0, limit: Number(limit || 300), exceeded: false };
  await addFingerprintForPath(entries, testFile, state);
  for (const sourcePath of sourcePaths || []) {
    const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(root, sourcePath);
    await addFingerprintForPath(entries, absolute, state);
    if (state.exceeded) {
      logOutput(`Skipping analysis cache because source fingerprinting exceeded ${state.limit} files.`);
      return null;
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function addFingerprintForPath(entries, targetPath, state) {
  if (state.exceeded) {
    return;
  }
  let stats;
  try {
    stats = await fs.promises.stat(targetPath);
  } catch {
    entries.push({ path: core.normalizePath(targetPath), missing: true });
    return;
  }

  if (stats.isDirectory()) {
    entries.push(fingerprintEntry(targetPath, stats, "directory"));
    const files = [];
    await collectFingerprintFiles(targetPath, files, state);
    for (const file of files) {
      if (state.exceeded) {
        return;
      }
      await addFingerprintForPath(entries, file, state);
    }
    return;
  }

  if (stats.isFile()) {
    state.count += 1;
    if (state.count > state.limit) {
      state.exceeded = true;
      return;
    }
    entries.push(fingerprintEntry(targetPath, stats, "file"));
  }
}

async function collectFingerprintFiles(directory, files, state) {
  if (state.exceeded || shouldSkipDirectory(directory)) {
    return;
  }
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFingerprintFiles(absolute, files, state);
      continue;
    }
    if (entry.isFile() && core.isPythonPath(absolute)) {
      files.push(absolute);
      if (files.length > state.limit) {
        state.exceeded = true;
        return;
      }
    }
  }
}

function fingerprintEntry(file, stats, kind) {
  return {
    path: core.normalizePath(file),
    kind,
    mtimeMs: Math.round(Number(stats.mtimeMs || 0)),
    size: Number(stats.size || 0),
  };
}

function fingerprintsEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

function handlePythonFileChanged(uri) {
  if (!uri || uri.scheme !== "file") {
    return;
  }
  invalidateAnalysisCacheForPath(uri.fsPath);
  if (core.isTestPath(uri.fsPath)) {
    diagnostics.delete(uri);
    reportsByFile.delete(core.normalizePath(uri.fsPath));
    clearQuickFixContextsForFile(uri.fsPath);
    codeLensChanged.fire();
  }
  scheduleTestFileRefresh(uri);
}

function handlePythonFileDeleted(uri) {
  if (!uri || uri.scheme !== "file") {
    return;
  }
  invalidateAnalysisCacheForPath(uri.fsPath);
  diagnostics.delete(uri);
  reportsByFile.delete(core.normalizePath(uri.fsPath));
  clearQuickFixContextsForFile(uri.fsPath);
  removeTestFileItem(uri.fsPath);
  codeLensChanged.fire();
}

function invalidateAnalysisCacheForPath(changedPath) {
  const normalized = core.normalizePath(changedPath);
  let changed = false;
  for (const [key, entry] of analysisCache.entries()) {
    const metadata = entry.metadata || {};
    const root = metadata.root || "";
    const testFile = metadata.testFile || "";
    const sourcePaths = metadata.sourcePaths || [];
    const fingerprintHit = (entry.fingerprints || []).some((item) => item.path === normalized);
    const sourceSpecHit = sourcePaths.some((sourcePath) => {
      const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(root, sourcePath);
      return isInsideOrEqualPath(changedPath, absolute);
    });
    if (core.normalizePath(testFile) === normalized || fingerprintHit || sourceSpecHit) {
      analysisCache.delete(key);
      changed = true;
    }
  }
  if (changed) {
    persistAnalysisCache().catch((error) => logOutput(`Failed to persist cache invalidation: ${error.message}`));
  }
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

async function setupGhostTestCatcher(uri) {
  const targetUri = uri?.scheme === "file"
    ? uri
    : vscode.window.activeTextEditor?.document.uri;
  const folder = targetUri
    ? vscode.workspace.getWorkspaceFolder(targetUri)
    : getActiveWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Open a workspace before running Ghost Test Catcher setup.");
    return;
  }

  const targetPath = targetUri?.scheme === "file" ? targetUri.fsPath : folder.uri.fsPath;
  const root = core.findProjectRootForFile(targetPath, folder.uri.fsPath);
  const profile = await vscode.window.showQuickPick(
    [
      {
        id: "local",
        label: "Recommended: local execution with confirmation",
        description: "Analyze tests and ask before executing Python test code.",
      },
      {
        id: "static",
        label: "Static analysis only",
        description: "Never execute tests from VS Code; safest first-run mode.",
      },
      {
        id: "docker",
        label: "Docker isolation",
        description: "Execute tests inside the configured Docker image.",
      },
    ],
    {
      ignoreFocusOut: true,
      placeHolder: "Choose how Ghost Test Catcher should run in this workspace.",
    }
  );
  if (!profile) {
    return;
  }
  let profileId = profile.id;
  if (!vscode.workspace.isTrusted && profileId !== "static") {
    vscode.window.showWarningMessage(
      "This workspace is untrusted, so Ghost Test Catcher setup will use static analysis only until the workspace is trusted."
    );
    profileId = "static";
  }

  const config = getConfig();
  const candidates = core.defaultPythonCandidates(config.get("pythonPath", "python"));
  const setupState = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Setting up Ghost Test Catcher",
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: "Finding Python" });
      const python = await findPythonForSetup(root, candidates, token);
      if (!python) {
        return {
          root,
          profileId,
          python: null,
          cli: { ok: false, message: `No usable Python executable found. Tried: ${candidates.join(", ")}` },
        };
      }

      throwIfCancellationRequested(token, "Ghost Test Catcher setup was cancelled.");
      progress.report({ message: "Checking Ghost Test Catcher CLI" });
      const cli = await checkGhostCliImport(root, python.command, token);
      return {
        root,
        profileId,
        python,
        cli,
      };
    }
  );

  if (!setupState?.python) {
    vscode.window.showErrorMessage(setupState?.cli?.message || "Ghost Test Catcher setup could not find Python.");
    return;
  }

  await applySetupSettings(setupState.python.command, setupState.profileId);

  let cliReady = setupState.cli.ok;
  if (!cliReady) {
    cliReady = await offerCliInstall(setupState.root, setupState.python.command, setupState.cli.message);
  }

  if (setupState.profileId === "docker") {
    await verifyDockerSetup(getConfig().get("dockerImage", "ghost-test-catcher-runner:latest"));
  }

  if (!cliReady) {
    vscode.window.showWarningMessage(
      "Ghost Test Catcher setup saved your workspace settings, but the Python CLI is still not importable. Run Doctor after installing the package."
    );
    await runDoctor(vscode.Uri.file(setupState.root));
    return;
  }

  vscode.window.showInformationMessage(
    `Ghost Test Catcher is ready with ${setupState.python.executable || setupState.python.command}.`
  );
  await runDoctor(vscode.Uri.file(setupState.root));
}

async function findPythonForSetup(root, candidates, token) {
  for (const command of candidates) {
    try {
      throwIfCancellationRequested(token, "Ghost Test Catcher setup was cancelled.");
      const result = await execFile(
        command,
        ["-c", "import sys; print(sys.executable); print(sys.version.split()[0])"],
        {
          cwd: root,
          env: buildPythonEnv(root),
          maxBuffer: 1024 * 1024,
          timeout: DOCTOR_TIMEOUT_MS,
          token,
          label: `setup python check (${command})`,
        }
      );
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return {
        command,
        executable: lines[0] || command,
        version: lines[1] || "unknown",
      };
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      logOutput(`Setup skipped Python candidate ${command}: ${error.message}`);
    }
  }
  return null;
}

async function checkGhostCliImport(root, pythonPath, token) {
  try {
    const result = await execFile(
      pythonPath,
      ["-c", `import ${core.GHOST_CLI_MODULE} as cli; print(cli.__file__)`],
      {
        cwd: root,
        env: buildPythonEnv(root),
        maxBuffer: 1024 * 1024,
        timeout: DOCTOR_TIMEOUT_MS,
        token,
        label: "setup CLI import check",
      }
    );
    return {
      ok: true,
      module: core.GHOST_CLI_MODULE,
      path: result.stdout.trim(),
      message: `Loaded ${core.GHOST_CLI_MODULE} from ${result.stdout.trim()}.`,
    };
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
    return {
      ok: false,
      module: core.GHOST_CLI_MODULE,
      message: `Could not import ${core.GHOST_CLI_MODULE}. ${error.message}`,
    };
  }
}

async function applySetupSettings(pythonPath, profileId) {
  const profileSettings = core.setupProfileSettings(profileId);
  const config = getConfig();
  await config.update("pythonPath", pythonPath, vscode.ConfigurationTarget.Workspace);
  await config.update("executeTests", profileSettings.executeTests, vscode.ConfigurationTarget.Workspace);
  await config.update("executionBackend", profileSettings.executionBackend, vscode.ConfigurationTarget.Workspace);
  await config.update("confirmExecution", profileSettings.confirmExecution, vscode.ConfigurationTarget.Workspace);
}

async function offerCliInstall(root, pythonPath, importMessage) {
  const hasLocalProject = fs.existsSync(path.join(root, "pyproject.toml"));
  const installArgs = hasLocalProject ? core.editableInstallArgs() : core.pypiInstallArgs();
  const installCommand = `${quoteForLog(pythonPath)} ${installArgs.map(quoteForLog).join(" ")}`;
  const choice = await vscode.window.showWarningMessage(
    `${importMessage} Install Ghost Test Catcher for this Python environment?`,
    { modal: false },
    "Install CLI",
    "Copy Install Command",
    "Open Setup Docs",
    "Cancel"
  );

  if (choice === "Copy Install Command") {
    await vscode.env.clipboard.writeText(installCommand);
    vscode.window.showInformationMessage("Copied the Ghost Test Catcher install command.");
    return false;
  }

  if (choice === "Open Setup Docs") {
    await openExtensionReadme();
    return false;
  }

  if (choice !== "Install CLI") {
    return false;
  }

  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage("Ghost Test Catcher will not install Python packages from an untrusted workspace.");
    return false;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing Ghost Test Catcher CLI",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: installCommand });
        await execFile(pythonPath, installArgs, {
          cwd: root,
          env: process.env,
          maxBuffer: 20 * 1024 * 1024,
          timeout: SETUP_TIMEOUT_MS,
          token,
          label: "setup CLI install",
        });
      }
    );
  } catch (error) {
    if (isCancellationError(error)) {
      vscode.window.showInformationMessage("Ghost Test Catcher CLI install cancelled.");
      return false;
    }
    logOutput(`Setup CLI install failed: ${error.message}`);
    vscode.window.showErrorMessage(`Ghost Test Catcher CLI install failed: ${error.message}`);
    return false;
  }

  const postInstall = await checkGhostCliImport(root, pythonPath);
  if (!postInstall.ok) {
    vscode.window.showWarningMessage(`Ghost Test Catcher install finished, but the CLI still did not import. ${postInstall.message}`);
    return false;
  }
  return true;
}

async function verifyDockerSetup(dockerImage) {
  try {
    await execFile("docker", ["version", "--format", "{{.Server.Version}}"], {
      maxBuffer: 1024 * 1024,
      timeout: DOCTOR_TIMEOUT_MS,
      label: "setup Docker engine check",
    });
  } catch (error) {
    vscode.window.showWarningMessage(`Docker execution is selected, but Docker is not available yet. ${error.message}`);
    return false;
  }

  try {
    await execFile("docker", ["image", "inspect", dockerImage], {
      maxBuffer: 1024 * 1024,
      timeout: DOCTOR_TIMEOUT_MS,
      label: "setup Docker image check",
    });
    return true;
  } catch (error) {
    const command = `docker build -t ${quoteForLog(dockerImage)} docker/ghost-test-catcher-runner`;
    const choice = await vscode.window.showWarningMessage(
      `Docker is available, but image ${dockerImage} was not found. Build it before running tests with Docker.`,
      { modal: false },
      "Copy Build Command",
      "Continue"
    );
    if (choice === "Copy Build Command") {
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage("Copied the Ghost Test Catcher Docker build command.");
    }
    logOutput(`Docker image check failed for ${dockerImage}: ${error.message}`);
    return false;
  }
}

async function openExtensionReadme() {
  const readmeCandidates = [
    extensionContext?.asAbsolutePath("README.md"),
    extensionContext?.asAbsolutePath("readme.md"),
  ].filter(Boolean);
  for (const readmePath of readmeCandidates) {
    if (fs.existsSync(readmePath)) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(readmePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
      return;
    }
  }
  vscode.window.showInformationMessage("Open the Ghost Test Catcher extension README from the Extensions view for setup instructions.");
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
          ["-c", `import ${core.GHOST_CLI_MODULE} as cli; print(cli.__file__)`],
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
        report.importMessage = `Loaded ${core.GHOST_CLI_MODULE} from ${importCheck.stdout.trim()}.`;
      } catch (error) {
        if (isCancellationError(error)) {
          vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
          return;
        }
        report.importOk = false;
        report.importMessage = `Could not import ${core.GHOST_CLI_MODULE} with the configured Python path. ${error.message}`;
      }

      try {
        if (token.isCancellationRequested) {
          vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
          return;
        }
        progress.report({ message: "Inspecting CLI configuration" });
        const doctorResult = await execFile(
          pythonPath,
          ["-m", core.GHOST_CLI_MODULE, "doctor", "--repo", root],
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
  clearQuickFixContextsForFile(testFile);

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
    quickFixContextByDiagnosticKey.set(diagnosticContextKey(testFile, diagnostic), {
      testFile,
      name,
      evidence: check.evidence || null,
      missingSymbols: missing,
    });
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
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    reportPanel.onDidDispose(() => {
      reportPanel = undefined;
    });
  }

  reportPanel.webview.html = core.renderReportHtml(reports, { nonce: createNonce() });
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

class GhostCodeActionProvider {
  provideCodeActions(document, range, context) {
    const actions = [];
    for (const diagnostic of context.diagnostics || []) {
      if (diagnostic.source !== "Ghost Test Catcher") {
        continue;
      }
      const quickFixContext = quickFixContextByDiagnosticKey.get(diagnosticContextKey(document.uri.fsPath, diagnostic));
      if (!quickFixContext) {
        continue;
      }

      if (quickFixContext.evidence?.path) {
        const openEvidenceAction = new vscode.CodeAction("Ghost Test Catcher: Open Evidence File", vscode.CodeActionKind.QuickFix);
        openEvidenceAction.command = {
          title: "Open Evidence File",
          command: "ghostTestCatcher.openEvidence",
          arguments: [quickFixContext.testFile, quickFixContext.evidence],
        };
        openEvidenceAction.diagnostics = [diagnostic];
        actions.push(openEvidenceAction);
      }

      if (quickFixContext.missingSymbols?.length) {
        const copySymbolsAction = new vscode.CodeAction("Ghost Test Catcher: Copy Missing Symbols", vscode.CodeActionKind.QuickFix);
        copySymbolsAction.command = {
          title: "Copy Missing Symbols",
          command: "ghostTestCatcher.copyMissingSymbols",
          arguments: [quickFixContext.missingSymbols],
        };
        copySymbolsAction.diagnostics = [diagnostic];
        actions.push(copySymbolsAction);
      }

      const staticAction = new vscode.CodeAction("Ghost Test Catcher: Run Static Analysis Only", vscode.CodeActionKind.QuickFix);
      staticAction.command = {
        title: "Run Static Analysis Only",
        command: "ghostTestCatcher.runStaticAnalysisForFile",
        arguments: [quickFixContext.testFile],
      };
      staticAction.diagnostics = [diagnostic];
      actions.push(staticAction);
    }
    return actions;
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

function diagnosticContextKey(testFile, diagnostic) {
  const range = diagnostic.range;
  return [
    core.normalizePath(testFile),
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
    diagnostic.message,
  ].join("|");
}

function clearQuickFixContextsForFile(testFile) {
  const prefix = `${core.normalizePath(testFile)}|`;
  for (const key of Array.from(quickFixContextByDiagnosticKey.keys())) {
    if (key.startsWith(prefix)) {
      quickFixContextByDiagnosticKey.delete(key);
    }
  }
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
  const env = { ...process.env };
  const includeWorkspacePaths = typeof options.includeWorkspacePaths === "boolean"
    ? options.includeWorkspacePaths
    : vscode.workspace.isTrusted;
  const entries = [];
  if (includeWorkspacePaths) {
    entries.push(path.join(root, "src"), root);
  }
  if (env.PYTHONPATH) {
    entries.push(env.PYTHONPATH);
  }
  if (entries.length) {
    env.PYTHONPATH = entries.join(path.delimiter);
  }
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

function createNonce() {
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

function isInsideOrEqualPath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
