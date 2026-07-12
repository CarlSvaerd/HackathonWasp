const core = require("./extensionCore");

const ACTIVE_EDITOR_IS_TEST_CONTEXT = "ghostTestCatcher.activeEditorIsPythonTest";
const ACTIVE_EDITOR_HAS_REPORT_CONTEXT = "ghostTestCatcher.activeEditorHasGhostReport";

class GhostUxManager {
  constructor(options = {}) {
    if (!options.vscode) {
      throw new Error("GhostUxManager requires a VS Code API object.");
    }
    if (typeof options.getLastReports !== "function") {
      throw new Error("GhostUxManager requires getLastReports.");
    }
    this.vscode = options.vscode;
    this.getLastReports = options.getLastReports;
    this.statusBarItem = undefined;
  }

  register(context) {
    this.statusBarItem = this.vscode.window.createStatusBarItem(this.vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.name = "Ghost Test Catcher";
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(this.vscode.window.onDidChangeActiveTextEditor(() => this.refresh()));
    context.subscriptions.push(this.vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri?.toString?.() === this.vscode.window.activeTextEditor?.document.uri?.toString?.()) {
        this.refresh();
      }
    }));
    this.refresh();
  }

  refresh() {
    const state = statusStateForEditor(this.vscode.window.activeTextEditor, this.getLastReports());
    this.vscode.commands.executeCommand("setContext", ACTIVE_EDITOR_IS_TEST_CONTEXT, state.isPythonTest);
    this.vscode.commands.executeCommand("setContext", ACTIVE_EDITOR_HAS_REPORT_CONTEXT, Boolean(state.report));
    if (!this.statusBarItem) {
      return;
    }
    if (!state.visible) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = state.text;
    this.statusBarItem.tooltip = state.tooltip;
    this.statusBarItem.command = state.command;
    this.statusBarItem.accessibilityInformation = {
      label: state.accessibilityLabel,
      role: "button",
    };
    this.statusBarItem.show();
  }

  dispose() {
    this.statusBarItem?.dispose();
  }
}

function statusStateForEditor(editor, reports = []) {
  const isPythonTest = isPythonTestEditor(editor);
  if (!isPythonTest) {
    return {
      isPythonTest: false,
      visible: false,
      report: null,
    };
  }

  const testFile = editor.document.uri.fsPath;
  const report = reportForFile(reports, testFile);
  if (!report) {
    return {
      isPythonTest: true,
      visible: true,
      report: null,
      text: "$(shield) Ghost Test: Analyze",
      tooltip: "Analyze this Python test file with Ghost Test Catcher.",
      command: "ghostTestCatcher.analyzeCurrentTest",
      accessibilityLabel: "Analyze this Python test file with Ghost Test Catcher",
    };
  }

  const summary = statusSummaryForReport(report);
  return {
    isPythonTest: true,
    visible: true,
    report,
    text: summary.text,
    tooltip: `${summary.tooltip} Click to open the latest Ghost Test Catcher report.`,
    command: "ghostTestCatcher.openLastReport",
    accessibilityLabel: summary.accessibilityLabel,
  };
}

function isPythonTestEditor(editor) {
  const document = editor?.document;
  return Boolean(
    document &&
    document.languageId === "python" &&
    document.uri?.scheme === "file" &&
    core.isTestPath(document.uri.fsPath)
  );
}

function reportForFile(reports = [], testFile = "") {
  if (!testFile) {
    return null;
  }
  const normalizedTestFile = core.normalizePath(testFile);
  return (reports || []).find((report) => {
    const reportFile = report?.__testFile;
    return reportFile && core.normalizePath(reportFile) === normalizedTestFile;
  }) || null;
}

function statusSummaryForReport(report) {
  const decisions = core.summarizeTestDecisions([report]);
  const cost = core.costSummaryText([report]);
  if (decisions.highRisk > 0) {
    return {
      text: `$(warning) Ghost Test: ${decisions.highRisk} risk${decisions.highRisk === 1 ? "" : "s"}`,
      tooltip: `${decisions.highRisk} high-risk ghost test${decisions.highRisk === 1 ? "" : "s"} found. ${cost}.`,
      accessibilityLabel: `Ghost Test Catcher report has ${decisions.highRisk} high-risk ghost test${decisions.highRisk === 1 ? "" : "s"}`,
    };
  }
  if (decisions.review > 0) {
    return {
      text: `$(circle-large-outline) Ghost Test: ${decisions.review} review`,
      tooltip: `${decisions.review} test${decisions.review === 1 ? "" : "s"} need review. ${cost}.`,
      accessibilityLabel: `Ghost Test Catcher report has ${decisions.review} test${decisions.review === 1 ? "" : "s"} needing review`,
    };
  }
  if (decisions.safe > 0) {
    return {
      text: `$(check) Ghost Test: ${decisions.safe} keep`,
      tooltip: `${decisions.safe} test${decisions.safe === 1 ? "" : "s"} safe to keep. ${cost}.`,
      accessibilityLabel: `Ghost Test Catcher report has ${decisions.safe} test${decisions.safe === 1 ? "" : "s"} safe to keep`,
    };
  }
  return {
    text: "$(shield) Ghost Test: Report",
    tooltip: `Ghost Test Catcher report is available. ${cost}.`,
    accessibilityLabel: "Ghost Test Catcher report is available",
  };
}

module.exports = {
  ACTIVE_EDITOR_HAS_REPORT_CONTEXT,
  ACTIVE_EDITOR_IS_TEST_CONTEXT,
  GhostUxManager,
  isPythonTestEditor,
  reportForFile,
  statusStateForEditor,
  statusSummaryForReport,
};
