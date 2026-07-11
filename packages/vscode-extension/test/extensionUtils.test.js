const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const utils = require("../extensionUtils");

test("buildPythonEnv prepends trusted workspace paths before existing PYTHONPATH", () => {
  const root = path.join("C:", "repo", "ghost");
  const env = utils.buildPythonEnv(root, {
    baseEnv: { PYTHONPATH: "already-there", OTHER: "kept" },
    includeWorkspacePaths: true,
    extraPythonPaths: [path.join("C:", "extension", "python-src")],
    pathDelimiter: ";",
  });

  assert.equal(env.OTHER, "kept");
  assert.equal(env.PYTHONPATH, [path.join("C:", "extension", "python-src"), path.join(root, "src"), root, "already-there"].join(";"));
});

test("buildPythonEnv can keep workspace paths out for untrusted workspaces", () => {
  const env = utils.buildPythonEnv("C:/repo/ghost", {
    baseEnv: { PYTHONPATH: "system-only" },
    includeWorkspacePaths: false,
    pathDelimiter: ";",
  });

  assert.equal(env.PYTHONPATH, "system-only");
});

test("resolveBundledPythonSourcePath finds packaged and development CLI sources", () => {
  const packagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-packaged-extension-"));
  const packagedPythonSource = path.join(packagedRoot, "python-src");
  writeGhostCliSourceTree(packagedPythonSource);

  assert.equal(utils.resolveBundledPythonSourcePath(packagedRoot), packagedPythonSource);

  const developmentRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-development-repo-"));
  const developmentExtensionRoot = path.join(developmentRepo, "packages", "vscode-extension");
  const developmentPythonSource = path.join(developmentRepo, "src");
  fs.mkdirSync(developmentExtensionRoot, { recursive: true });
  writeGhostCliSourceTree(developmentPythonSource);

  assert.equal(utils.resolveBundledPythonSourcePath(developmentExtensionRoot), developmentPythonSource);
});

test("shouldSkipDirectory ignores generated dependency and cache folders", () => {
  assert.equal(utils.shouldSkipDirectory("project/node_modules"), true);
  assert.equal(utils.shouldSkipDirectory("project\\.pnpm-store\\v11"), true);
  assert.equal(utils.shouldSkipDirectory("project/.venv/lib/python3.12/site-packages"), true);
  assert.equal(utils.shouldSkipDirectory("project/.venv"), true);
  assert.equal(utils.shouldSkipDirectory("project/docs/_build"), true);
  assert.equal(utils.shouldSkipDirectory("project/docs/_build/html"), true);
  assert.equal(utils.shouldSkipDirectory("project/src"), false);
});

test("quoteForLog preserves simple args and quotes args with spaces", () => {
  assert.equal(utils.quoteForLog("plain"), "plain");
  assert.equal(utils.quoteForLog("two words"), "\"two words\"");
  assert.equal(utils.quoteForLog("say \"hello\""), "\"say \\\"hello\\\"\"");
});

test("isInsideOrEqualPath recognizes children, parents, and exact paths", () => {
  const root = path.resolve("repo");
  assert.equal(utils.isInsideOrEqualPath(root, root), true);
  assert.equal(utils.isInsideOrEqualPath(path.join(root, "src", "app.py"), root), true);
  assert.equal(utils.isInsideOrEqualPath(path.dirname(root), root), false);
});

test("createNonce returns compact alphanumeric values", () => {
  const first = utils.createNonce();
  const second = utils.createNonce();
  assert.match(first, /^[A-Za-z0-9]+$/);
  assert.notEqual(first, second);
});

test("throwIfCancellationRequested marks cancellation errors", () => {
  assert.doesNotThrow(() => utils.throwIfCancellationRequested({ isCancellationRequested: false }, "stop"));
  assert.throws(
    () => utils.throwIfCancellationRequested({ isCancellationRequested: true }, "stop now"),
    (error) => {
      assert.equal(error.message, "stop now");
      assert.equal(error.cancelled, true);
      assert.equal(utils.isCancellationError(error), true);
      return true;
    }
  );
});

test("execFile captures stdout, stderr, and log output", async () => {
  const logs = [];
  const stderrChunks = [];
  const result = await utils.execFile(
    process.execPath,
    ["-e", "console.error('warn'); console.log('ok')"],
    {
      label: "node smoke",
      logOutput: (message) => logs.push(message),
      appendOutput: (message) => stderrChunks.push(message),
    }
  );

  assert.equal(result.stdout.trim(), "ok");
  assert.equal(result.stderr.trim(), "warn");
  assert.equal(stderrChunks.join("").trim(), "warn");
  assert.ok(logs[0].includes("Running node smoke:"));
});

test("execFile rejects non-zero exits with captured output", async () => {
  await assert.rejects(
    () => utils.execFile(
      process.execPath,
      ["-e", "console.log('out'); console.error('bad'); process.exit(7)"],
      { label: "fail smoke" }
    ),
    (error) => {
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdout.trim(), "out");
      assert.equal(error.stderr.trim(), "bad");
      assert.equal(error.message, "bad");
      return true;
    }
  );
});

test("execFile turns missing executables into actionable setup errors", async () => {
  await assert.rejects(
    () => utils.execFile("__ghost_test_catcher_missing_executable__", [], { label: "missing executable smoke" }),
    (error) => {
      assert.equal(error.code, "ENOENT");
      assert.ok(error.message.includes("Could not start missing executable smoke"));
      assert.ok(error.message.includes("Ghost Test Catcher: Setup"));
      return true;
    }
  );
});

function writeGhostCliSourceTree(root) {
  fs.mkdirSync(path.join(root, "ghost_test_catcher"), { recursive: true });
  fs.mkdirSync(path.join(root, "llmSHAP", "ghost"), { recursive: true });
  fs.writeFileSync(path.join(root, "ghost_test_catcher", "cli.py"), "def main():\n    return 0\n", "utf-8");
  fs.writeFileSync(path.join(root, "llmSHAP", "ghost", "cli.py"), "def main():\n    return 0\n", "utf-8");
}
