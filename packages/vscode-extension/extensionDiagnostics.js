const fs = require("fs");
const core = require("./extensionCore");

const DIAGNOSTIC_SOURCE = "Ghost Test Catcher";
const DIAGNOSTIC_CODE = "ghost-test-catcher";

class GhostDiagnosticManager {
  constructor(options = {}) {
    if (!options.vscode) {
      throw new Error("GhostDiagnosticManager requires a VS Code API object.");
    }
    if (!options.diagnostics) {
      throw new Error("GhostDiagnosticManager requires a diagnostic collection.");
    }
    if (!options.codeLensChanged) {
      throw new Error("GhostDiagnosticManager requires a CodeLens event emitter.");
    }
    this.vscode = options.vscode;
    this.diagnostics = options.diagnostics;
    this.codeLensChanged = options.codeLensChanged;
    this.reportsByFile = new Map();
    this.quickFixContextByDiagnosticKey = new Map();
  }

  register(context) {
    context.subscriptions.push(this.vscode.languages.registerCodeLensProvider(
      { language: "python" },
      new GhostCodeLensProvider(this)
    ));
    context.subscriptions.push(this.vscode.languages.registerCodeActionsProvider(
      { language: "python" },
      new GhostCodeActionProvider(this),
      { providedCodeActionKinds: [this.vscode.CodeActionKind.QuickFix] }
    ));
  }

  publish(testFile, result) {
    this.applyDiagnostics(testFile, result);
    this.reportsByFile.set(core.normalizePath(testFile), result);
  }

  deleteFile(uriOrFile) {
    const testFile = typeof uriOrFile === "string" ? uriOrFile : uriOrFile?.fsPath;
    if (!testFile) {
      return;
    }
    const uri = typeof uriOrFile === "string" ? this.vscode.Uri.file(uriOrFile) : uriOrFile;
    this.diagnostics.delete(uri);
    this.reportsByFile.delete(core.normalizePath(testFile));
    this.clearQuickFixContextsForFile(testFile);
  }

  clear() {
    this.diagnostics.clear();
    this.reportsByFile.clear();
    this.quickFixContextByDiagnosticKey.clear();
  }

  fireCodeLensChanged() {
    this.codeLensChanged.fire();
  }

  applyDiagnostics(testFile, result) {
    const uri = this.vscode.Uri.file(testFile);
    const text = fs.readFileSync(testFile, "utf-8");
    const locations = findTestFunctions(text, this.vscode);
    const checks = core.mapBy(result.verification?.claim_checks || [], "claim");
    const runs = core.mapBy(result.execution?.per_test_results || [], "name");
    const names = result.generated_tests?.test_names || [];
    const fileDiagnostics = [];
    this.clearQuickFixContextsForFile(testFile);

    for (const name of names) {
      const check = checks.get(name) || {};
      const run = runs.get(name) || {};
      const range = locations.get(name) || new this.vscode.Range(0, 0, 0, 1);
      const groundedStatus = check.status || "unsupported";
      const executionStatus = run.status || "unknown";
      const missing = check.missing_symbols || [];
      const categories = check.risk_categories || [];
      const confidence = core.percent(Number(check.confidence || 0));
      const severity = diagnosticSeverity(this.vscode, groundedStatus, executionStatus);
      const missingText = missing.length ? ` Missing symbols: ${missing.join(", ")}.` : "";
      const categoryText = categories.length ? ` Categories: ${categories.join(", ")}.` : "";
      const diagnostic = new this.vscode.Diagnostic(
        range,
        `${DIAGNOSTIC_SOURCE}: ${core.supportLabel(groundedStatus)} (${confidence} grounded), test run ${executionStatus}.${missingText}${categoryText}`,
        severity
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = DIAGNOSTIC_CODE;
      fileDiagnostics.push(diagnostic);
      this.quickFixContextByDiagnosticKey.set(diagnosticContextKey(testFile, diagnostic), {
        testFile,
        name,
        evidence: check.evidence || null,
        missingSymbols: missing,
      });
    }

    this.diagnostics.set(uri, fileDiagnostics);
  }

  provideCodeLenses(document) {
    const result = this.reportsByFile.get(core.normalizePath(document.uri.fsPath));
    if (!result) {
      return [];
    }
    const locations = findTestFunctions(document.getText(), this.vscode);
    const checks = core.mapBy(result.verification?.claim_checks || [], "claim");
    const runs = core.mapBy(result.execution?.per_test_results || [], "name");
    return (result.generated_tests?.test_names || []).map((name) => {
      const check = checks.get(name) || {};
      const run = runs.get(name) || {};
      const range = locations.get(name) || new this.vscode.Range(0, 0, 0, 1);
      const title = `Ghost Test: ${core.supportLabel(check.status || "unsupported")} | run ${run.status || "unknown"} | ${core.percent(Number(check.confidence || 0))}`;
      return new this.vscode.CodeLens(range, {
        title,
        command: "ghostTestCatcher.openLastReport",
        arguments: [result],
      });
    });
  }

  provideCodeActions(document, context) {
    const actions = [];
    for (const diagnostic of context.diagnostics || []) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }
      const quickFixContext = this.quickFixContextByDiagnosticKey.get(
        diagnosticContextKey(document.uri.fsPath, diagnostic)
      );
      if (!quickFixContext) {
        continue;
      }

      if (quickFixContext.evidence?.path) {
        const openEvidenceAction = new this.vscode.CodeAction(
          "Ghost Test Catcher: Open Evidence File",
          this.vscode.CodeActionKind.QuickFix
        );
        openEvidenceAction.command = {
          title: "Open Evidence File",
          command: "ghostTestCatcher.openEvidence",
          arguments: [quickFixContext.testFile, quickFixContext.evidence],
        };
        openEvidenceAction.diagnostics = [diagnostic];
        actions.push(openEvidenceAction);
      }

      if (quickFixContext.missingSymbols?.length) {
        const copySymbolsAction = new this.vscode.CodeAction(
          "Ghost Test Catcher: Copy Missing Symbols",
          this.vscode.CodeActionKind.QuickFix
        );
        copySymbolsAction.command = {
          title: "Copy Missing Symbols",
          command: "ghostTestCatcher.copyMissingSymbols",
          arguments: [quickFixContext.missingSymbols],
        };
        copySymbolsAction.diagnostics = [diagnostic];
        actions.push(copySymbolsAction);
      }

      const staticAction = new this.vscode.CodeAction(
        "Ghost Test Catcher: Run Static Analysis Only",
        this.vscode.CodeActionKind.QuickFix
      );
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

  clearQuickFixContextsForFile(testFile) {
    const prefix = `${core.normalizePath(testFile)}|`;
    for (const key of Array.from(this.quickFixContextByDiagnosticKey.keys())) {
      if (key.startsWith(prefix)) {
        this.quickFixContextByDiagnosticKey.delete(key);
      }
    }
  }
}

class GhostCodeLensProvider {
  constructor(manager) {
    this.manager = manager;
  }

  get onDidChangeCodeLenses() {
    return this.manager.codeLensChanged.event;
  }

  provideCodeLenses(document) {
    return this.manager.provideCodeLenses(document);
  }
}

class GhostCodeActionProvider {
  constructor(manager) {
    this.manager = manager;
  }

  provideCodeActions(document, range, context) {
    return this.manager.provideCodeActions(document, context);
  }
}

function findTestFunctions(text, vscode) {
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

function diagnosticSeverityName(groundedStatus, executionStatus) {
  if (groundedStatus === "unsupported" || executionStatus === "error") {
    return "error";
  }
  if (groundedStatus === "borderline" || executionStatus === "failed" || executionStatus === "skipped") {
    return "warning";
  }
  return "information";
}

function diagnosticSeverity(vscode, groundedStatus, executionStatus) {
  const severity = diagnosticSeverityName(groundedStatus, executionStatus);
  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }
  if (severity === "warning") {
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

module.exports = {
  DIAGNOSTIC_CODE,
  DIAGNOSTIC_SOURCE,
  GhostDiagnosticManager,
  diagnosticContextKey,
  diagnosticSeverityName,
};
