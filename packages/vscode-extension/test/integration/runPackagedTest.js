const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { downloadAndUnzipVSCode, runTests } = require("@vscode/test-electron");

async function main() {
  const extensionRoot = path.resolve(__dirname, "..", "..");
  const packageJson = require(path.join(extensionRoot, "package.json"));
  const expectedVersion = packageJson.version;
  const vsixPath = process.env.GHOST_TEST_CATCHER_VSIX ||
    path.join(extensionRoot, `ghost-test-catcher-${expectedVersion}.vsix`);
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`Packaged VSIX not found at ${vsixPath}. Run npm run package before npm run test:integration:packaged.`);
  }

  const extensionDevelopmentPath = path.resolve(__dirname, "packaged-host");
  const extensionTestsPath = path.resolve(__dirname, "packaged-suite", "index");
  const fixturePath = path.resolve(__dirname, "fixtures", "python-project");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtc-packaged-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  const pythonPath = process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python";

  fs.cpSync(fixturePath, workspacePath, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  process.env.GHOST_TEST_CATCHER_TEST_PYTHON = pythonPath;
  process.env.GHOST_TEST_CATCHER_EXPECTED_VERSION = expectedVersion;
  process.env.GHOST_TEST_CATCHER_DISABLE_SETUP_NUDGE = "1";
  delete process.env.PYTHONPATH;

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

  const commonArgs = [
    "--extensions-dir",
    extensionsDir,
    "--user-data-dir",
    userDataDir,
  ];
  if (process.platform === "linux") {
    commonArgs.push("--no-sandbox");
  }

  const installedExtensionPath = installVsixByExtraction(vsixPath, extensionsDir, expectedVersion);

  const launchArgs = [
    workspacePath,
    "--disable-workspace-trust",
    "--disable-gpu",
    "--skip-welcome",
    "--skip-release-notes",
    ...commonArgs,
  ];

  console.log("Ghost Test Catcher packaged integration launcher");
  console.log(`  vsixPath=${vsixPath}`);
  console.log(`  expectedVersion=${expectedVersion}`);
  console.log(`  extensionDevelopmentPath=${extensionDevelopmentPath}`);
  console.log(`  extensionTestsPath=${extensionTestsPath}`);
  console.log(`  workspacePath=${workspacePath}`);
  console.log(`  extensionsDir=${extensionsDir}`);
  console.log(`  installedExtensionPath=${installedExtensionPath}`);
  console.log(`  userDataDir=${userDataDir}`);
  console.log(`  pythonPath=${pythonPath}`);
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
    if (process.env.GHOST_TEST_CATCHER_KEEP_PACKAGED_TEST_DIR !== "1") {
      await cleanupDirectoryWithRetry(tempRoot);
    } else {
      console.log(`Ghost Test Catcher packaged integration kept temp dir: ${tempRoot}`);
    }
  }
}

function installVsixByExtraction(vsixPath, extensionsDir, expectedVersion) {
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtc-vsix-extract-"));
  const extensionPath = path.join(extensionsDir, `carl-svaerd.ghost-test-catcher-${expectedVersion}`);
  try {
    extractArchive(vsixPath, extractRoot);
    const extractedExtensionPath = path.join(extractRoot, "extension");
    if (!fs.existsSync(path.join(extractedExtensionPath, "package.json"))) {
      throw new Error(`The VSIX did not contain extension/package.json after extraction to ${extractRoot}.`);
    }
    fs.rmSync(extensionPath, { recursive: true, force: true });
    fs.cpSync(extractedExtensionPath, extensionPath, { recursive: true });
    const packageJson = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf-8"));
    if (packageJson.publisher !== "carl-svaerd" || packageJson.name !== "ghost-test-catcher" || packageJson.version !== expectedVersion) {
      throw new Error(`Extracted VSIX package identity was ${packageJson.publisher}.${packageJson.name}@${packageJson.version}, expected carl-svaerd.ghost-test-catcher@${expectedVersion}.`);
    }
    if (!fs.existsSync(path.join(extensionPath, "python-src", "ghost_test_catcher", "cli.py"))) {
      throw new Error("Extracted VSIX is missing python-src/ghost_test_catcher/cli.py.");
    }
    if (!fs.existsSync(path.join(extensionPath, "python-src", "llmSHAP", "ghost", "cli.py"))) {
      throw new Error("Extracted VSIX is missing python-src/llmSHAP/ghost/cli.py.");
    }
    return extensionPath;
  } finally {
    cleanupDirectory(extractRoot);
  }
}

function extractArchive(vsixPath, destination) {
  if (process.platform === "win32") {
    const command = [
      `$literalPath = '${powershellStringLiteral(vsixPath)}'`,
      `$destinationPath = '${powershellStringLiteral(destination)}'`,
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "[System.IO.Compression.ZipFile]::ExtractToDirectory($literalPath, $destinationPath)",
    ].join("; ");
    const result = childProcess.spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: "pipe",
      }
    );
    ensureExtractionSucceeded(result, "Expand-Archive");
    return;
  }

  const result = childProcess.spawnSync("unzip", ["-q", vsixPath, "-d", destination], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe",
  });
  ensureExtractionSucceeded(result, "unzip");
}

function powershellStringLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function ensureExtractionSucceeded(result, label) {
  if (result.error) {
    throw new Error(`Could not extract packaged VSIX with ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not extract packaged VSIX with ${label}; command exited with code ${result.status}.\n` +
        `stdout:\n${result.stdout || ""}\n` +
        `stderr:\n${result.stderr || ""}`
    );
  }
}

function cleanupDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Ghost Test Catcher packaged integration: could not remove ${directory}: ${error.message}`);
  }
}

async function cleanupDirectoryWithRetry(directory) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 6) {
        console.warn(`Ghost Test Catcher packaged integration: could not remove ${directory}: ${error.message}`);
        return;
      }
      await delay(500);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearMacQuarantine(vscodeExecutablePath) {
  const appPath = resolveMacAppPath(vscodeExecutablePath);
  if (!fs.existsSync(appPath)) {
    console.warn(`Ghost Test Catcher packaged integration: macOS app path was not found for quarantine cleanup: ${appPath}`);
    return;
  }

  const result = childProcess.spawnSync("xattr", ["-dr", "com.apple.quarantine", appPath], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    console.warn(`Ghost Test Catcher packaged integration: unable to run xattr quarantine cleanup: ${result.error.message}`);
    return;
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    console.warn(
      `Ghost Test Catcher packaged integration: xattr quarantine cleanup exited with code ${result.status}` +
        (output ? `\n${output}` : "")
    );
    return;
  }

  console.log(`Ghost Test Catcher packaged integration: cleared macOS quarantine attributes from ${appPath}`);
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
