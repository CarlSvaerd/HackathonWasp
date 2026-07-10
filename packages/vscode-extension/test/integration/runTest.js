const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { downloadAndUnzipVSCode, runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  const workspacePath = path.resolve(__dirname, "fixtures", "python-project");
  const repoRoot = path.resolve(extensionDevelopmentPath, "..", "..");
  const userData = resolveUserDataDir(extensionDevelopmentPath);
  const userDataDir = userData.path;
  const pythonPath = process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python";
  const pythonPathEntries = [path.join(repoRoot, "src")];
  if (process.env.PYTHONPATH) {
    pythonPathEntries.push(process.env.PYTHONPATH);
  }

  process.env.GHOST_TEST_CATCHER_TEST_PYTHON = pythonPath;
  process.env.GHOST_TEST_CATCHER_REPO_ROOT = repoRoot;
  process.env.GHOST_TEST_CATCHER_DISABLE_SETUP_NUDGE = "1";
  process.env.PYTHONPATH = pythonPathEntries.join(path.delimiter);

  const vscodeVersion = process.env.VSCODE_TEST_VERSION || "stable";
  const vscodeExecutablePath =
    process.env.VSCODE_TEST_EXECUTABLE_PATH ||
    (await downloadAndUnzipVSCode({
      version: vscodeVersion,
      extensionDevelopmentPath,
    }));

  if (process.platform === "darwin") {
    clearMacQuarantine(vscodeExecutablePath);
  }

  const launchArgs = [
    workspacePath,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--disable-gpu",
    "--skip-welcome",
    "--skip-release-notes",
    "--user-data-dir",
    userDataDir,
  ];
  if (process.platform === "linux") {
    launchArgs.push("--no-sandbox");
  }

  console.log("Ghost Test Catcher integration launcher");
  console.log(`  extensionDevelopmentPath=${extensionDevelopmentPath}`);
  console.log(`  extensionTestsPath=${extensionTestsPath}`);
  console.log(`  workspacePath=${workspacePath}`);
  console.log(`  repoRoot=${repoRoot}`);
  console.log(`  pythonPath=${pythonPath}`);
  console.log(`  PYTHONPATH=${process.env.PYTHONPATH}`);
  console.log(`  vscodeVersion=${vscodeVersion}`);
  console.log(`  vscodeExecutablePath=${vscodeExecutablePath}`);
  console.log(`  launchArgs=${launchArgs.join(" ")}`);

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });
  } finally {
    if (userData.cleanup) {
      cleanupDirectory(userDataDir);
    }
  }
}

function resolveUserDataDir(extensionDevelopmentPath) {
  if (process.platform === "win32") {
    return {
      path: path.join(extensionDevelopmentPath, ".vscode-test", `user-data-${process.platform}-${process.arch}`),
      cleanup: false,
    };
  }

  const tempRoot = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return {
    path: path.join(tempRoot, `gtc-vscode-${process.platform}-${process.arch}-${process.pid}`),
    cleanup: true,
  };
}

function cleanupDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Ghost Test Catcher integration: could not remove temporary user data dir ${directory}: ${error.message}`);
  }
}

function clearMacQuarantine(vscodeExecutablePath) {
  const appPath = resolveMacAppPath(vscodeExecutablePath);
  if (!fs.existsSync(appPath)) {
    console.warn(`Ghost Test Catcher integration: macOS app path was not found for quarantine cleanup: ${appPath}`);
    return;
  }

  const result = childProcess.spawnSync("xattr", ["-dr", "com.apple.quarantine", appPath], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    console.warn(`Ghost Test Catcher integration: unable to run xattr quarantine cleanup: ${result.error.message}`);
    return;
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    console.warn(
      `Ghost Test Catcher integration: xattr quarantine cleanup exited with code ${result.status}` +
        (output ? `\n${output}` : "")
    );
    return;
  }

  console.log(`Ghost Test Catcher integration: cleared macOS quarantine attributes from ${appPath}`);
}

function resolveMacAppPath(vscodeExecutablePath) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = vscodeExecutablePath.indexOf(marker);
  if (markerIndex >= 0) {
    return vscodeExecutablePath.slice(0, markerIndex);
  }

  if (vscodeExecutablePath.endsWith(".app")) {
    return vscodeExecutablePath;
  }

  return path.dirname(vscodeExecutablePath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
