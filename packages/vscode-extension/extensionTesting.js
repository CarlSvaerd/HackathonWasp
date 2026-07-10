const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");
const {
  isCancellationError,
  throwIfCancellationRequested,
} = require("./extensionUtils");

const DEFAULT_TEST_REFRESH_DELAY_MS = 250;
const DEFAULT_DISCOVERY_LIMIT_WARNING_INTERVAL_MS = 10 * 60 * 1000;
const TEST_DISCOVERY_EXCLUDE_GLOB = "{**/.git/**,**/.hg/**,**/.mypy_cache/**,**/.pnpm-store/**,**/.pytest_cache/**,**/.ruff_cache/**,**/.tox/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/build/**,**/dist/**,**/node_modules/**,**/docs/_build/**}";

class GhostTestExplorer {
  constructor(options = {}) {
    if (!options.vscode) {
      throw new Error("GhostTestExplorer requires a VS Code API object.");
    }
    this.vscode = options.vscode;
    this.getConfig = requireFunction(options.getConfig, "getConfig");
    this.getWorkspaceFolderForFile = requireFunction(options.getWorkspaceFolderForFile, "getWorkspaceFolderForFile");
    this.runCli = requireFunction(options.runCli, "runCli");
    this.resolveExecutionMode = requireFunction(options.resolveExecutionMode, "resolveExecutionMode");
    this.publishResult = requireFunction(options.publishResult, "publishResult");
    this.onReports = typeof options.onReports === "function" ? options.onReports : () => {};
    this.onPythonFileChanged = typeof options.onPythonFileChanged === "function" ? options.onPythonFileChanged : () => {};
    this.onPythonFileDeleted = typeof options.onPythonFileDeleted === "function" ? options.onPythonFileDeleted : () => {};
    this.logOutput = typeof options.logOutput === "function" ? options.logOutput : () => {};
    this.testRefreshDelayMs = Number.isFinite(options.testRefreshDelayMs)
      ? options.testRefreshDelayMs
      : DEFAULT_TEST_REFRESH_DELAY_MS;
    this.discoveryLimitWarningIntervalMs = Number.isFinite(options.discoveryLimitWarningIntervalMs)
      ? options.discoveryLimitWarningIntervalMs
      : DEFAULT_DISCOVERY_LIMIT_WARNING_INTERVAL_MS;
    this.testController = undefined;
    this.testRunProfile = undefined;
    this.testItemMetadataById = new Map();
    this.pendingTestRefreshes = new Map();
    this.lastDiscoveryLimitWarningAt = 0;
  }

  register(context) {
    this.testController = this.vscode.tests.createTestController("ghostTestCatcher", "Ghost Test Catcher");
    this.testController.resolveHandler = async (item) => {
      if (!item) {
        await this.discoverWorkspaceTests();
        return;
      }
      const metadata = this.testItemMetadataById.get(item.id);
      if (metadata?.type === "file" && item.uri) {
        await this.refreshTestFile(item.uri);
      }
    };
    this.testRunProfile = this.testController.createRunProfile(
      "Analyze with Ghost Test Catcher",
      this.vscode.TestRunProfileKind.Run,
      (request, token) => this.runNativeTestAnalysis(request, token),
      true
    );

    const watcher = this.vscode.workspace.createFileSystemWatcher("**/*.py");
    watcher.onDidCreate((uri) => this.handlePythonFileChanged(uri), null, context.subscriptions);
    watcher.onDidChange((uri) => this.handlePythonFileChanged(uri), null, context.subscriptions);
    watcher.onDidDelete((uri) => this.handlePythonFileDeleted(uri), null, context.subscriptions);

    context.subscriptions.push(this.testController);
    context.subscriptions.push(this.testRunProfile);
    context.subscriptions.push(watcher);
  }

  dispose() {
    for (const timer of this.pendingTestRefreshes.values()) {
      clearTimeout(timer);
    }
    this.pendingTestRefreshes.clear();
  }

  async refreshTestExplorer() {
    await this.discoverWorkspaceTests();
    this.vscode.window.showInformationMessage("Ghost Test Catcher refreshed the Testing panel.");
  }

  async discoverWorkspaceTests() {
    if (!this.testController || !this.vscode.workspace.workspaceFolders?.length) {
      return;
    }

    const limit = this.getConfig().get("testDiscoveryLimit", 500);
    const uris = await this.vscode.workspace.findFiles("**/*.py", TEST_DISCOVERY_EXCLUDE_GLOB, limit);
    const hitDiscoveryLimit = uris.length >= limit;
    const discoveredFiles = new Set();

    for (const uri of uris) {
      if (!core.isTestPath(uri.fsPath)) {
        continue;
      }
      discoveredFiles.add(core.normalizePath(uri.fsPath));
      await this.refreshTestFile(uri);
    }

    for (const filePath of this.knownTestControllerFiles()) {
      if (!fs.existsSync(filePath) || (!hitDiscoveryLimit && !discoveredFiles.has(core.normalizePath(filePath)))) {
        this.removeTestFileItem(filePath);
      }
    }

    if (hitDiscoveryLimit) {
      await this.showDiscoveryLimitWarning(limit);
    }
  }

  async showDiscoveryLimitWarning(limit) {
    const message = core.discoveryLimitWarningMessage(limit);
    this.logOutput(message);

    const now = Date.now();
    if (now - this.lastDiscoveryLimitWarningAt < this.discoveryLimitWarningIntervalMs) {
      return;
    }
    this.lastDiscoveryLimitWarningAt = now;

    const increaseAction = "Increase Limit";
    const settingsAction = "Open Settings";
    const choice = await this.vscode.window.showWarningMessage(message, increaseAction, settingsAction, "Dismiss");
    if (choice === settingsAction) {
      await this.vscode.commands.executeCommand("workbench.action.openSettings", "ghostTestCatcher.testDiscoveryLimit");
      return;
    }
    if (choice === increaseAction) {
      const nextLimit = core.nextDiscoveryLimit(limit);
      await this.getConfig().update("testDiscoveryLimit", nextLimit, this.vscode.ConfigurationTarget.Workspace);
      this.vscode.window.showInformationMessage(`Ghost Test Catcher test discovery limit increased to ${nextLimit}.`);
      await this.discoverWorkspaceTests();
    }
  }

  async refreshTestFile(uri) {
    if (!this.testController || !uri || uri.scheme !== "file") {
      return;
    }

    const testFile = uri.fsPath;
    if (!core.isPythonPath(testFile) || !core.isTestPath(testFile)) {
      this.removeTestFileItem(testFile);
      return;
    }

    let text;
    try {
      text = await fs.promises.readFile(testFile, "utf-8");
    } catch (error) {
      this.removeTestFileItem(testFile);
      return;
    }

    const locations = core.parseTestFunctionLocations(text);
    if (!locations.length) {
      this.removeTestFileItem(testFile);
      return;
    }

    const fileId = testFileItemId(testFile);
    const workspaceFolder = this.getWorkspaceFolderForFile(testFile);
    const root = workspaceFolder
      ? core.findProjectRootForFile(testFile, workspaceFolder.uri.fsPath)
      : path.dirname(testFile);
    const label = core.relativePathFromRoot(root, testFile) || path.basename(testFile);
    let fileItem = this.testController.items.get(fileId);
    if (!fileItem) {
      fileItem = this.testController.createTestItem(fileId, label, uri);
      this.testController.items.add(fileItem);
    }
    fileItem.label = label;
    fileItem.canResolveChildren = false;
    this.clearTestMetadataForFile(testFile);
    this.testItemMetadataById.set(fileId, { type: "file", filePath: testFile });

    const childItems = locations.map((location) => {
      const qualifiedName = location.qualifiedName || location.name;
      const item = this.testController.createTestItem(testCaseItemId(testFile, qualifiedName), qualifiedName, uri);
      item.range = new this.vscode.Range(location.line, location.start, location.line, location.end);
      this.testItemMetadataById.set(item.id, {
        type: "test",
        filePath: testFile,
        name: location.name,
        qualifiedName,
      });
      return item;
    });
    fileItem.children.replace(childItems);
  }

  async runNativeTestAnalysis(request, token) {
    const run = this.testController.createTestRun(request, "Ghost Test Catcher");
    const completed = new Set();
    try {
      await this.ensureTestsResolvedForRequest(request, token);
      const selectedItems = this.collectRunnableTestItems(request);
      if (!selectedItems.length) {
        return;
      }

      for (const item of selectedItems) {
        run.enqueued(item);
      }

      const executionMode = await this.resolveExecutionMode();
      if (!executionMode) {
        for (const item of selectedItems) {
          run.skipped(item);
          completed.add(item.id);
        }
        return;
      }

      const reports = [];
      const groupedItems = groupTestItemsByFile(selectedItems, this.testItemMetadataById);
      for (const [testFile, items] of groupedItems) {
        throwIfCancellationRequested(token, "Ghost Test Catcher native test run was cancelled.");
        for (const item of items) {
          run.started(item);
        }

        try {
          const result = await this.runCli(testFile, executionMode.executeTests, [], token);
          result.__testFile = testFile;
          reports.push(result);
          this.publishResult(testFile, result);
          this.applyNativeTestResults(run, items, result, completed);
        } catch (error) {
          if (isCancellationError(error)) {
            for (const item of items) {
              if (!completed.has(item.id)) {
                run.skipped(item);
                completed.add(item.id);
              }
            }
            this.vscode.window.showInformationMessage("Ghost Test Catcher Testing run cancelled.");
            return;
          }
          this.logOutput(`Testing panel analysis failed for ${testFile}: ${error.message}`);
          for (const item of items) {
            if (!completed.has(item.id)) {
              run.errored(item, new this.vscode.TestMessage(error.message));
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
        this.onReports(reports);
        const summary = core.summarizeReports(reports);
        this.vscode.window.showInformationMessage(
          `Ghost Test Catcher Testing: ${summary.reliable} reliable, ${summary.needsReview} needs review, ${summary.ghostRisk} ghost risk. Cost: ${core.costSummaryText(reports)}.`
        );
      }
    } catch (error) {
      if (isCancellationError(error)) {
        this.vscode.window.showInformationMessage("Ghost Test Catcher Testing run cancelled.");
        return;
      }
      this.logOutput(`Testing panel run failed: ${error.message}`);
      this.vscode.window.showErrorMessage(`Ghost Test Catcher Testing failed: ${error.message}`);
    } finally {
      run.end();
    }
  }

  async ensureTestsResolvedForRequest(request, token) {
    throwIfCancellationRequested(token, "Ghost Test Catcher native test run was cancelled.");
    if (!request.include || !request.include.length) {
      await this.discoverWorkspaceTests();
      return;
    }

    const fileUris = new Map();
    for (const item of request.include) {
      const metadata = this.testItemMetadataById.get(item.id);
      if (metadata?.type === "file" && item.uri) {
        fileUris.set(core.normalizePath(item.uri.fsPath), item.uri);
      }
    }

    for (const uri of fileUris.values()) {
      throwIfCancellationRequested(token, "Ghost Test Catcher native test run was cancelled.");
      await this.refreshTestFile(uri);
    }
  }

  applyNativeTestResults(run, items, result, completed) {
    const checks = core.mapBy(result.verification?.claim_checks || [], "claim");
    const runs = core.mapBy(result.execution?.per_test_results || [], "name");

    for (const item of items) {
      const metadata = this.testItemMetadataById.get(item.id);
      if (!metadata) {
        run.errored(item, new this.vscode.TestMessage("Ghost Test Catcher could not resolve metadata for this test item."));
        completed.add(item.id);
        continue;
      }

      const check = lookupByTestName(checks, metadata) || {};
      const execution = lookupByTestName(runs, metadata) || {};
      if (!check.status && !execution.status) {
        run.errored(item, new this.vscode.TestMessage(`Ghost Test Catcher did not return a result for ${metadata.qualifiedName}.`));
        completed.add(item.id);
        continue;
      }

      const groundedStatus = check.status || "unsupported";
      const executionStatus = execution.status || "unknown";
      const outcome = core.nativeTestOutcome(groundedStatus, executionStatus);
      const message = new this.vscode.TestMessage(core.nativeTestMessage({
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

  collectRunnableTestItems(request) {
    const excluded = new Set();
    for (const item of request.exclude || []) {
      collectTestItemIds(item, excluded);
    }

    const roots = request.include && request.include.length
      ? request.include
      : testItemCollectionToArray(this.testController.items);
    const selected = new Map();
    for (const item of roots) {
      collectLeafTestItems(item, excluded, selected, this.testItemMetadataById);
    }
    return Array.from(selected.values());
  }

  knownTestControllerFiles() {
    const files = new Set();
    for (const metadata of this.testItemMetadataById.values()) {
      if (metadata.type === "file") {
        files.add(metadata.filePath);
      }
    }
    return files;
  }

  handlePythonFileChanged(uri) {
    if (!uri || uri.scheme !== "file") {
      return;
    }
    this.onPythonFileChanged(uri);
    this.scheduleTestFileRefresh(uri);
  }

  handlePythonFileDeleted(uri) {
    if (!uri || uri.scheme !== "file") {
      return;
    }
    this.onPythonFileDeleted(uri);
    this.removeTestFileItem(uri.fsPath);
  }

  scheduleTestFileRefresh(uri) {
    if (!uri || uri.scheme !== "file" || !core.isPythonPath(uri.fsPath)) {
      return;
    }
    const key = core.normalizePath(uri.fsPath);
    const existing = this.pendingTestRefreshes.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingTestRefreshes.delete(key);
      this.refreshTestFile(uri).catch((error) => {
        this.logOutput(`Failed to refresh Testing panel item for ${uri.fsPath}: ${error.message}`);
      });
    }, this.testRefreshDelayMs);
    this.pendingTestRefreshes.set(key, timer);
  }

  removeTestFileItem(testFile) {
    if (!this.testController) {
      return;
    }
    const fileId = testFileItemId(testFile);
    this.testController.items.delete(fileId);
    this.clearTestMetadataForFile(testFile);
  }

  clearTestMetadataForFile(testFile) {
    const fileId = testFileItemId(testFile);
    const childPrefix = `${fileId}:`;
    for (const id of Array.from(this.testItemMetadataById.keys())) {
      if (id === fileId || id.startsWith(childPrefix)) {
        this.testItemMetadataById.delete(id);
      }
    }
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`GhostTestExplorer requires ${name}.`);
  }
  return value;
}

function collectLeafTestItems(item, excluded, selected, metadataById) {
  if (excluded.has(item.id)) {
    return;
  }
  const metadata = metadataById.get(item.id);
  if (metadata?.type === "test") {
    selected.set(item.id, item);
    return;
  }
  item.children.forEach((child) => collectLeafTestItems(child, excluded, selected, metadataById));
}

function collectTestItemIds(item, ids) {
  ids.add(item.id);
  item.children.forEach((child) => collectTestItemIds(child, ids));
}

function groupTestItemsByFile(items, metadataById) {
  const grouped = new Map();
  for (const item of items) {
    const metadata = metadataById.get(item.id);
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

function testFileItemId(testFile) {
  return `ghost-file:${core.normalizePath(testFile)}`;
}

function testCaseItemId(testFile, qualifiedName) {
  return `${testFileItemId(testFile)}:${qualifiedName}`;
}

module.exports = {
  GhostTestExplorer,
  TEST_DISCOVERY_EXCLUDE_GLOB,
  groupTestItemsByFile,
  lookupByTestName,
  testCaseItemId,
  testFileItemId,
};
