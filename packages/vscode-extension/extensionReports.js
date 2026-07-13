const core = require("./extensionCore");

const REPORT_COMMANDS = new Set([
  "analyzeCurrentTest",
  "copyReportSummary",
]);

class GhostReportPanels {
  constructor(options = {}) {
    if (!options.vscode) {
      throw new Error("GhostReportPanels requires a VS Code API object.");
    }
    this.vscode = options.vscode;
    this.createNonce = typeof options.createNonce === "function"
      ? options.createNonce
      : () => "";
    this.onReportCommand = typeof options.onReportCommand === "function"
      ? options.onReportCommand
      : () => {};
    this.reportPanel = undefined;
    this.doctorPanel = undefined;
    this.reportMessageDisposable = undefined;
  }

  openLastReport(reports, explicitResult) {
    const selectedReports = explicitResult ? [explicitResult] : reports;
    if (!selectedReports?.length) {
      this.vscode.window.showInformationMessage("No Ghost Test Catcher report is available yet.");
      return;
    }

    if (!this.reportPanel) {
      this.reportPanel = this.vscode.window.createWebviewPanel(
        "ghostTestCatcherReport",
        "Ghost Test Catcher",
        this.vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
      );
      this.reportPanel.onDidDispose(() => {
        this.reportMessageDisposable?.dispose();
        this.reportMessageDisposable = undefined;
        this.reportPanel = undefined;
      });
      this.reportMessageDisposable = this.reportPanel.webview.onDidReceiveMessage((message) => {
        if (!message || message.type !== "command" || !REPORT_COMMANDS.has(message.command)) {
          return;
        }
        this.onReportCommand(message.command);
      });
    }

    this.reportPanel.webview.html = core.renderReportHtml(selectedReports, {
      nonce: this.createNonce(),
      workspaceRoot: this.workspaceRootForReports(selectedReports),
    });
    this.reportPanel.reveal(this.vscode.ViewColumn.Beside);
  }

  workspaceRootForReports(reports) {
    for (const result of reports || []) {
      const candidate = result?.__testFile || result?.input_test_files?.find((item) => item?.path)?.path;
      if (!candidate || !this.isAbsoluteFilePath(candidate)) {
        continue;
      }
      const folder = this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(candidate));
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return this.vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "";
  }

  isAbsoluteFilePath(candidate) {
    return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("/") || candidate.startsWith("\\\\");
  }

  openDoctorReport(report) {
    if (!this.doctorPanel) {
      this.doctorPanel = this.vscode.window.createWebviewPanel(
        "ghostTestCatcherDoctor",
        "Ghost Test Catcher Doctor",
        this.vscode.ViewColumn.Beside,
        { enableScripts: false, retainContextWhenHidden: true, localResourceRoots: [] }
      );
      this.doctorPanel.onDidDispose(() => {
        this.doctorPanel = undefined;
      });
    }

    this.doctorPanel.webview.html = core.renderDoctorHtml(report);
    this.doctorPanel.reveal(this.vscode.ViewColumn.Beside);
  }
}

module.exports = {
  GhostReportPanels,
};
