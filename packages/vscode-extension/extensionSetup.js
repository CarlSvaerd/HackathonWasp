const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");
const {
  isCancellationError,
  quoteForLog,
  throwIfCancellationRequested,
} = require("./extensionUtils");

const DOCTOR_TIMEOUT_MS = 30000;
const SETUP_TIMEOUT_MS = 300000;

class GhostSetupManager {
  constructor(options = {}) {
    if (!options.vscode) {
      throw new Error("GhostSetupManager requires a VS Code API object.");
    }
    if (!options.context) {
      throw new Error("GhostSetupManager requires an extension context.");
    }
    this.vscode = options.vscode;
    this.context = options.context;
    this.getConfig = requireFunction(options.getConfig, "getConfig");
    this.getActiveWorkspaceFolder = requireFunction(options.getActiveWorkspaceFolder, "getActiveWorkspaceFolder");
    this.buildPythonEnv = requireFunction(options.buildPythonEnv, "buildPythonEnv");
    this.execFile = requireFunction(options.execFile, "execFile");
    this.openDoctorReport = requireFunction(options.openDoctorReport, "openDoctorReport");
    this.logOutput = typeof options.logOutput === "function" ? options.logOutput : () => {};
  }

  async setup(uri) {
    const targetUri = uri?.scheme === "file"
      ? uri
      : this.vscode.window.activeTextEditor?.document.uri;
    const folder = targetUri
      ? this.vscode.workspace.getWorkspaceFolder(targetUri)
      : this.getActiveWorkspaceFolder();
    if (!folder) {
      this.vscode.window.showWarningMessage("Open a workspace before running Ghost Test Catcher setup.");
      return;
    }

    const targetPath = targetUri?.scheme === "file" ? targetUri.fsPath : folder.uri.fsPath;
    const root = core.findProjectRootForFile(targetPath, folder.uri.fsPath);
    const profile = await this.vscode.window.showQuickPick(setupProfileChoices(), {
      ignoreFocusOut: true,
      placeHolder: "Choose how Ghost Test Catcher should run in this workspace.",
    });
    if (!profile) {
      return;
    }

    let profileId = profile.id;
    if (!this.vscode.workspace.isTrusted && profileId !== "static") {
      this.vscode.window.showWarningMessage(
        "This workspace is untrusted, so Ghost Test Catcher setup will use static analysis only until the workspace is trusted."
      );
      profileId = "static";
    }

    const config = this.getConfig();
    const candidates = core.defaultPythonCandidates(config.get("pythonPath", "python"), root);
    const setupState = await this.vscode.window.withProgress(
      {
        location: this.vscode.ProgressLocation.Notification,
        title: "Setting up Ghost Test Catcher",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: "Finding Python" });
        const python = await this.findPython(root, candidates, token);
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
        const cli = await this.checkGhostCliImport(root, python.command, token);
        return {
          root,
          profileId,
          python,
          cli,
        };
      }
    );

    if (!setupState?.python) {
      this.vscode.window.showErrorMessage(setupState?.cli?.message || "Ghost Test Catcher setup could not find Python.");
      return;
    }

    await this.applySetupSettings(setupState.python.command, setupState.profileId);

    let cliReady = setupState.cli.ok;
    if (!cliReady) {
      cliReady = await this.offerCliInstall(setupState.root, setupState.python.command, setupState.cli.message);
    }

    if (setupState.profileId === "docker") {
      await this.verifyDockerSetup(this.getConfig().get("dockerImage", "ghost-test-catcher-runner:latest"));
    }

    if (!cliReady) {
      this.vscode.window.showWarningMessage(
        "Ghost Test Catcher setup saved your workspace settings, but the Python CLI is still not importable. Run Doctor after installing the package."
      );
      await this.runDoctor(this.vscode.Uri.file(setupState.root));
      return;
    }

    this.vscode.window.showInformationMessage(
      `Ghost Test Catcher is ready with ${setupState.python.executable || setupState.python.command}.`
    );
    await this.runDoctor(this.vscode.Uri.file(setupState.root));
  }

  async findPython(root, candidates, token) {
    for (const command of candidates) {
      try {
        throwIfCancellationRequested(token, "Ghost Test Catcher setup was cancelled.");
        const result = await this.execFile(
          command,
          ["-c", "import sys; print(sys.executable); print(sys.version.split()[0])"],
          {
            cwd: root,
            env: this.buildPythonEnv(root),
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
        this.logOutput(`Setup skipped Python candidate ${command}: ${error.message}`);
      }
    }
    return null;
  }

  async checkGhostCliImport(root, pythonPath, token) {
    try {
      const result = await this.execFile(
        pythonPath,
        ["-c", `import ${core.GHOST_CLI_MODULE} as cli; print(cli.__file__)`],
        {
          cwd: root,
          env: this.buildPythonEnv(root),
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

  async applySetupSettings(pythonPath, profileId) {
    const profileSettings = core.setupProfileSettings(profileId);
    const config = this.getConfig();
    await config.update("pythonPath", pythonPath, this.vscode.ConfigurationTarget.Workspace);
    await config.update("executeTests", profileSettings.executeTests, this.vscode.ConfigurationTarget.Workspace);
    await config.update("executionBackend", profileSettings.executionBackend, this.vscode.ConfigurationTarget.Workspace);
    await config.update("confirmExecution", profileSettings.confirmExecution, this.vscode.ConfigurationTarget.Workspace);
  }

  async offerCliInstall(root, pythonPath, importMessage) {
    const hasLocalProject = fs.existsSync(path.join(root, "pyproject.toml"));
    const installArgs = hasLocalProject ? core.editableInstallArgs() : core.pypiInstallArgs();
    const installCommand = installCommandForPython(pythonPath, installArgs);
    const choice = await this.vscode.window.showWarningMessage(
      `${importMessage} Install Ghost Test Catcher for this Python environment?`,
      { modal: false },
      "Install CLI",
      "Copy Install Command",
      "Open Setup Docs",
      "Cancel"
    );

    if (choice === "Copy Install Command") {
      await this.vscode.env.clipboard.writeText(installCommand);
      this.vscode.window.showInformationMessage("Copied the Ghost Test Catcher install command.");
      return false;
    }

    if (choice === "Open Setup Docs") {
      await this.openExtensionReadme();
      return false;
    }

    if (choice !== "Install CLI") {
      return false;
    }

    if (!this.vscode.workspace.isTrusted) {
      this.vscode.window.showWarningMessage("Ghost Test Catcher will not install Python packages from an untrusted workspace.");
      return false;
    }

    try {
      await this.vscode.window.withProgress(
        {
          location: this.vscode.ProgressLocation.Notification,
          title: "Installing Ghost Test Catcher CLI",
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: installCommand });
          await this.execFile(pythonPath, installArgs, {
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
        this.vscode.window.showInformationMessage("Ghost Test Catcher CLI install cancelled.");
        return false;
      }
      this.logOutput(`Setup CLI install failed: ${error.message}`);
      this.vscode.window.showErrorMessage(`Ghost Test Catcher CLI install failed: ${error.message}`);
      return false;
    }

    const postInstall = await this.checkGhostCliImport(root, pythonPath);
    if (!postInstall.ok) {
      this.vscode.window.showWarningMessage(`Ghost Test Catcher install finished, but the CLI still did not import. ${postInstall.message}`);
      return false;
    }
    return true;
  }

  async verifyDockerSetup(dockerImage) {
    try {
      await this.execFile("docker", ["version", "--format", "{{.Server.Version}}"], {
        maxBuffer: 1024 * 1024,
        timeout: DOCTOR_TIMEOUT_MS,
        label: "setup Docker engine check",
      });
    } catch (error) {
      this.vscode.window.showWarningMessage(`Docker execution is selected, but Docker is not available yet. ${error.message}`);
      return false;
    }

    try {
      await this.execFile("docker", ["image", "inspect", dockerImage], {
        maxBuffer: 1024 * 1024,
        timeout: DOCTOR_TIMEOUT_MS,
        label: "setup Docker image check",
      });
      return true;
    } catch (error) {
      const command = `docker build -t ${quoteForLog(dockerImage)} docker/ghost-test-catcher-runner`;
      const choice = await this.vscode.window.showWarningMessage(
        `Docker is available, but image ${dockerImage} was not found. Build it before running tests with Docker.`,
        { modal: false },
        "Copy Build Command",
        "Continue"
      );
      if (choice === "Copy Build Command") {
        await this.vscode.env.clipboard.writeText(command);
        this.vscode.window.showInformationMessage("Copied the Ghost Test Catcher Docker build command.");
      }
      this.logOutput(`Docker image check failed for ${dockerImage}: ${error.message}`);
      return false;
    }
  }

  async openExtensionReadme() {
    const readmeCandidates = [
      this.context.asAbsolutePath("README.md"),
      this.context.asAbsolutePath("readme.md"),
    ].filter(Boolean);
    for (const readmePath of readmeCandidates) {
      if (fs.existsSync(readmePath)) {
        const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(readmePath));
        await this.vscode.window.showTextDocument(document, this.vscode.ViewColumn.Beside);
        return;
      }
    }
    this.vscode.window.showInformationMessage("Open the Ghost Test Catcher extension README from the Extensions view for setup instructions.");
  }

  async runDoctor(uri) {
    const targetUri = uri?.scheme === "file"
      ? uri
      : this.vscode.window.activeTextEditor?.document.uri;
    const folder = targetUri
      ? this.vscode.workspace.getWorkspaceFolder(targetUri)
      : this.getActiveWorkspaceFolder();
    if (!folder) {
      this.vscode.window.showWarningMessage("Open a workspace before running Ghost Test Catcher Doctor.");
      return;
    }

    const targetPath = targetUri?.scheme === "file" ? targetUri.fsPath : folder.uri.fsPath;
    const root = core.findProjectRootForFile(targetPath, folder.uri.fsPath);
    const config = this.getConfig();
    const pythonPath = config.get("pythonPath", "python");
    const configuredSourcePaths = config.get("sourcePaths", ["src"]);
    const inferredSourcePaths = targetPath && core.isPythonPath(targetPath) && core.isTestPath(targetPath)
      ? core.inferSourcePathsFromImports(root, targetPath)
      : [];
    const env = this.buildPythonEnv(root);

    await this.vscode.window.withProgress(
      {
        location: this.vscode.ProgressLocation.Notification,
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
          const importCheck = await this.execFile(
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
            this.vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
            return;
          }
          report.importOk = false;
          report.importMessage = `Could not import ${core.GHOST_CLI_MODULE} with the configured Python path. ${error.message}`;
        }

        try {
          if (token.isCancellationRequested) {
            this.vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
            return;
          }
          progress.report({ message: "Inspecting CLI configuration" });
          const doctorResult = await this.execFile(
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
            this.vscode.window.showInformationMessage("Ghost Test Catcher Doctor cancelled.");
            return;
          }
          report.doctor = doctorFallbackReport(config, configuredSourcePaths, error.message);
        }

        this.openDoctorReport(report);
        this.vscode.window.showInformationMessage(
          report.importOk
            ? "Ghost Test Catcher Doctor: Python module loaded successfully."
            : "Ghost Test Catcher Doctor: setup issue found."
        );
      }
    );
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`GhostSetupManager requires ${name}.`);
  }
  return value;
}

function setupProfileChoices() {
  return [
    {
      id: "local",
      label: "Recommended: local execution with confirmation",
      description: "Analyze tests and ask before executing Python test code.",
      detail: "Best day-to-day mode. Existing-test review uses 0 LLM calls and only runs pytest after confirmation.",
    },
    {
      id: "static",
      label: "Static analysis only",
      description: "Never execute tests from VS Code; safest first-run mode.",
      detail: "Cheapest and safest review mode. Uses 0 LLM calls and skips pytest execution entirely.",
    },
    {
      id: "docker",
      label: "Docker isolation",
      description: "Execute tests inside the configured Docker image.",
      detail: "Still 0 LLM calls for existing tests, but isolates pytest in a container when Docker is available.",
    },
  ];
}

function installCommandForPython(pythonPath, installArgs) {
  return `${quoteForLog(pythonPath)} ${installArgs.map(quoteForLog).join(" ")}`;
}

function doctorFallbackReport(config, configuredSourcePaths, errorMessage) {
  return {
    config: {
      source_paths: configuredSourcePaths,
      test_paths: [],
      test_mode: config.get("testMode", "mixed"),
      execute_tests: config.get("executeTests", true),
    },
    discovered_source_specs: [],
    discovered_test_specs: [],
    error: errorMessage,
  };
}

module.exports = {
  DOCTOR_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  GhostSetupManager,
  doctorFallbackReport,
  installCommandForPython,
  setupProfileChoices,
};
