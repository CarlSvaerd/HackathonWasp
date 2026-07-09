const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  const workspacePath = path.resolve(__dirname, "fixtures", "python-project");
  const repoRoot = path.resolve(extensionDevelopmentPath, "..", "..");
  const userDataDir = path.join(
    extensionDevelopmentPath,
    ".vscode-test",
    `user-data-${process.platform}-${process.arch}`
  );
  const pythonPath = process.env.GHOST_TEST_CATCHER_TEST_PYTHON || "python";
  const pythonPathEntries = [path.join(repoRoot, "src")];
  if (process.env.PYTHONPATH) {
    pythonPathEntries.push(process.env.PYTHONPATH);
  }

  process.env.GHOST_TEST_CATCHER_TEST_PYTHON = pythonPath;
  process.env.GHOST_TEST_CATCHER_REPO_ROOT = repoRoot;
  process.env.PYTHONPATH = pythonPathEntries.join(path.delimiter);

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
  console.log(`  launchArgs=${launchArgs.join(" ")}`);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs,
    version: process.env.VSCODE_TEST_VERSION || "stable",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
