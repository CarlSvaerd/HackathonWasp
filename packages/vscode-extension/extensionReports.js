const core = require("./extensionCore");

class GhostReportPanels {
  constructor(options = {}) {
    if (!options.vscode) {
      throw new Error("GhostReportPanels requires a VS Code API object.");
    }
    this.vscode = options.vscode;
    this.createNonce = typeof options.createNonce === "function"
      ? options.createNonce
      : () => "";
    this.reportPanel = undefined;
    this.doctorPanel = undefined;
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
        this.reportPanel = undefined;
      });
    }

    this.reportPanel.webview.html = core.renderReportHtml(selectedReports, { nonce: this.createNonce() });
    this.reportPanel.reveal(this.vscode.ViewColumn.Beside);
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
