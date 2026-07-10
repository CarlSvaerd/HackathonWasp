const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const audit = require("../../../tools/vscode_extension_static_audit");

test("VS Code extension static audit passes for the repository", () => {
  const result = audit.runAudit();
  assert.deepEqual(result.failures, []);
});

test("checkForbiddenPatterns catches unsafe process and dynamic-code usage", () => {
  const failures = [];
  audit.checkForbiddenPatterns(
    {
      "extensionUnsafe.js": [
        "childProcess.exec('python -m ghost_test_catcher.cli')",
        "childProcess.spawn('python', [], { shell: true })",
        "eval('1 + 1')",
      ].join("\n"),
    },
    failures
  );

  assert.ok(failures.some((failure) => failure.includes("exec or execSync")));
  assert.ok(failures.some((failure) => failure.includes("shell: true")));
  assert.ok(failures.some((failure) => failure.includes("eval")));
});

test("listExtensionModules returns only packaged extension runtime modules", () => {
  const modules = audit.listExtensionModules();
  assert.ok(modules.includes("extension.js"));
  assert.ok(modules.includes("extensionCache.js"));
  assert.ok(modules.includes("extensionSetup.js"));
  assert.equal(modules.some((moduleName) => moduleName.includes(".test.")), false);
});

test("checkTypecheckConfig requires the checked JavaScript quality gate", () => {
  const failures = [];
  audit.checkTypecheckConfig(
    path.join(__dirname, "__missing_extension__"),
    { devDependencies: {} },
    {
      "extensionCache.js": "const cache = {};",
      "extensionUtils.js": "// @ts-check\nconst utils = {};",
    },
    failures
  );

  assert.ok(failures.some((failure) => failure.includes("tsconfig.json must exist")));
});
