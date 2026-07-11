const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "src");
const EXTENSION_ROOT = path.join(ROOT, "packages", "vscode-extension");
const BUNDLE_ROOT = path.join(EXTENSION_ROOT, "python-src");

function main() {
  if (!isGhostSourceRoot(SOURCE_ROOT)) {
    throw new Error(`Expected Ghost Test Catcher Python sources under ${SOURCE_ROOT}.`);
  }

  fs.rmSync(BUNDLE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(BUNDLE_ROOT, { recursive: true });
  copyPythonSources(SOURCE_ROOT, BUNDLE_ROOT);
  assertBundleReady(BUNDLE_ROOT);
  console.log(`Prepared VS Code Python bundle at ${path.relative(ROOT, BUNDLE_ROOT).split(path.sep).join("/")}.`);
}

function copyPythonSources(sourceDir, destinationDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      fs.mkdirSync(destinationPath, { recursive: true });
      copyPythonSources(sourcePath, destinationPath);
      removeEmptyDirectory(destinationPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".py")) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function shouldSkipDirectory(name) {
  return new Set([
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
  ]).has(name);
}

function removeEmptyDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  if (fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

function assertBundleReady(bundleRoot) {
  if (!isGhostSourceRoot(bundleRoot)) {
    throw new Error(`Prepared bundle at ${bundleRoot} is missing the public CLI modules.`);
  }
}

function isGhostSourceRoot(candidate) {
  return fs.existsSync(path.join(candidate, "ghost_test_catcher", "cli.py"))
    && fs.existsSync(path.join(candidate, "llmSHAP", "ghost", "cli.py"));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

module.exports = {
  BUNDLE_ROOT,
  SOURCE_ROOT,
  copyPythonSources,
  isGhostSourceRoot,
};
