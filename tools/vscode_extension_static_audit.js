const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT, "packages", "vscode-extension");
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "test.yml");

const INTERNAL_COMMANDS = new Set([
  "ghostTestCatcher.openEvidence",
  "ghostTestCatcher.copyMissingSymbols",
  "ghostTestCatcher.runStaticAnalysisForFile",
]);

const MODULE_SIZE_BUDGETS = new Map([
  ["extension.js", 30000],
  ["extensionCache.js", 12000],
  ["extensionCore.js", 55000],
  ["extensionDemo.js", 12000],
  ["extensionDiagnostics.js", 14000],
  ["extensionReports.js", 6000],
  ["extensionSetup.js", 24000],
  ["extensionTesting.js", 24000],
  ["extensionUx.js", 12000],
  ["extensionUtils.js", 10000],
]);

const REQUIRED_TEST_MODULES = [
  "extensionCache",
  "extensionCore",
  "extensionDemo",
  "extensionDiagnostics",
  "extensionSetup",
  "extensionTesting",
  "extensionUx",
  "extensionUtils",
];

const TYPECHECKED_MODULES = [
  "extensionCache.js",
  "extensionDemo.js",
  "extensionUtils.js",
];

function main() {
  const { failures } = runAudit();
  if (failures.length) {
    console.error("Ghost Test Catcher VS Code extension static audit failed:\n");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    return 1;
  }
  console.log("Ghost Test Catcher VS Code extension static audit passed.");
  return 0;
}

function runAudit(options = {}) {
  const root = options.root || ROOT;
  const extensionDir = options.extensionDir || path.join(root, "packages", "vscode-extension");
  const failures = [];
  const packageJson = readJson(path.join(extensionDir, "package.json"));
  const modules = listExtensionModules(extensionDir);
  const moduleTexts = Object.fromEntries(
    modules.map((moduleName) => [moduleName, readText(path.join(extensionDir, moduleName))])
  );

  checkPackageScripts(packageJson, modules, failures);
  checkVersionReferences(root, extensionDir, packageJson, failures);
  checkCommandManifest(packageJson, moduleTexts["extension.js"] || "", failures);
  checkRestrictedWorkspaceTrust(packageJson, failures);
  checkForbiddenPatterns(moduleTexts, failures);
  checkNotificationFlow(moduleTexts, failures);
  checkWebviewSafety(moduleTexts, failures);
  checkModuleBudgets(extensionDir, modules, failures);
  checkModuleTests(extensionDir, failures);
  checkTypecheckConfig(extensionDir, packageJson, moduleTexts, failures);
  checkVscodeIgnore(extensionDir, failures);

  return { failures };
}

function listExtensionModules(extensionDir = EXTENSION_DIR) {
  return fs.readdirSync(extensionDir)
    .filter((name) => /^extension[A-Za-z]*\.js$/.test(name))
    .sort((left, right) => left.localeCompare(right));
}

function checkPackageScripts(packageJson, modules, failures) {
  const scripts = packageJson.scripts || {};
  const checkScript = String(scripts.check || "");
  const syntaxScript = String(scripts["check:syntax"] || "");
  const typecheckScript = String(scripts["check:types"] || "");
  const staticScript = String(scripts["check:static"] || "");
  if (!checkScript.includes("node --check extension.js") || !checkScript.includes("tsc -p tsconfig.json --noEmit") || !checkScript.includes("node ../../tools/vscode_extension_static_audit.js")) {
    failures.push("package.json scripts.check must run syntax, type, and static extension checks directly");
  }
  if (typecheckScript !== "tsc -p tsconfig.json --noEmit") {
    failures.push("package.json scripts.check:types must run tsc -p tsconfig.json --noEmit");
  }
  if (staticScript !== "node ../../tools/vscode_extension_static_audit.js") {
    failures.push("package.json scripts.check:static must run tools/vscode_extension_static_audit.js");
  }
  for (const moduleName of modules) {
    if (!syntaxScript.includes(`node --check ${moduleName}`)) {
      failures.push(`package.json scripts.check:syntax must syntax-check ${moduleName}`);
    }
  }
  if (String(scripts["test:unit"] || "") !== "node --test test/*.test.js") {
    failures.push("package.json scripts.test:unit should run all Node test files with node --test test/*.test.js");
  }
  if (!String(scripts.package || "").includes("node ../../tools/prepare_vscode_python_bundle.js")) {
    failures.push("package.json scripts.package must prepare the bundled Python CLI sources before building the VSIX");
  }
  if (String(scripts["prepare:python-bundle"] || "") !== "node ../../tools/prepare_vscode_python_bundle.js") {
    failures.push("package.json scripts.prepare:python-bundle must run tools/prepare_vscode_python_bundle.js");
  }
}

function checkVersionReferences(root, extensionDir, packageJson, failures) {
  const version = String(packageJson.version || "").trim();
  const expectedVsix = `ghost-test-catcher-${version}.vsix`;
  const packageScript = String(packageJson.scripts?.package || "");
  if (!packageScript.includes(expectedVsix)) {
    failures.push(`package script must build ${expectedVsix}`);
  }

  const expectedFiles = [
    path.join(root, "README.md"),
    path.join(extensionDir, "README.md"),
    path.join(root, "docs", "ghost-test-catcher-release.md"),
    WORKFLOW_PATH,
  ];
  for (const filePath of expectedFiles) {
    const text = readText(filePath);
    if (!text.includes(expectedVsix)) {
      failures.push(`${relative(root, filePath)} must reference ${expectedVsix}`);
    }
  }
}

function checkCommandManifest(packageJson, extensionJs, failures) {
  const activationCommands = new Set(
    (packageJson.activationEvents || [])
      .filter((event) => String(event).startsWith("onCommand:"))
      .map((event) => String(event).slice("onCommand:".length))
  );
  const contributedCommands = new Set(
    ((packageJson.contributes || {}).commands || []).map((command) => String(command.command || ""))
  );
  const registeredCommands = new Set();
  const commandPattern = /registerCommand\(\s*["'`](ghostTestCatcher\.[^"'`]+)["'`]/g;
  let match;
  while ((match = commandPattern.exec(extensionJs))) {
    registeredCommands.add(match[1]);
  }

  for (const command of contributedCommands) {
    if (!activationCommands.has(command)) {
      failures.push(`contributed command ${command} must have a matching activation event`);
    }
    if (!registeredCommands.has(command)) {
      failures.push(`contributed command ${command} must be registered by extension.js`);
    }
  }

  for (const command of activationCommands) {
    if (!registeredCommands.has(command)) {
      failures.push(`activation command ${command} must be registered by extension.js`);
    }
  }

  for (const command of registeredCommands) {
    if (!contributedCommands.has(command) && !INTERNAL_COMMANDS.has(command)) {
      failures.push(`registered command ${command} must be contributed or listed as an internal command`);
    }
  }
}

function checkRestrictedWorkspaceTrust(packageJson, failures) {
  const trust = packageJson.capabilities?.untrustedWorkspaces || {};
  const restricted = new Set(trust.restrictedConfigurations || []);
  if (trust.supported !== "limited") {
    failures.push("package.json must declare limited untrusted workspace support");
  }
  for (const setting of [
    "ghostTestCatcher.executeTests",
    "ghostTestCatcher.pythonPath",
    "ghostTestCatcher.executionBackend",
    "ghostTestCatcher.dockerImage",
  ]) {
    if (!restricted.has(setting)) {
      failures.push(`package.json untrusted workspace restrictions must include ${setting}`);
    }
  }
}

function checkForbiddenPatterns(moduleTexts, failures) {
  const forbidden = [
    {
      pattern: /childProcess\.(exec|execSync)\s*\(/,
      message: "extension modules must not use child_process.exec or execSync",
    },
    {
      pattern: /\bshell\s*:\s*true\b/,
      message: "extension modules must not spawn child processes with shell: true",
    },
    {
      pattern: /\beval\s*\(/,
      message: "extension modules must not use eval",
    },
    {
      pattern: /\bnew\s+Function\s*\(/,
      message: "extension modules must not use new Function",
    },
    {
      pattern: /\b(TODO|FIXME|XXX|HACK)\b|insert text here|add logic later|placeholder implementation|not implemented yet|coming soon/i,
      message: "extension modules must not contain unfinished placeholder markers",
    },
  ];

  for (const [moduleName, text] of Object.entries(moduleTexts)) {
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) {
        failures.push(`${moduleName}: ${rule.message}`);
      }
    }
  }
}

function checkNotificationFlow(moduleTexts, failures) {
  const extensionJs = moduleTexts["extension.js"] || "";
  if (/await\s+vscode\.window\.showErrorMessage\s*\(/.test(extensionJs)) {
    failures.push("extension.js must not await showErrorMessage; actionable error notifications should not block commands or integration tests");
  }
}

function checkWebviewSafety(moduleTexts, failures) {
  const reports = moduleTexts["extensionReports.js"] || "";
  const core = moduleTexts["extensionCore.js"] || "";
  if (reports.includes("enableScripts: true") && !reports.includes("renderReportHtml(selectedReports, { nonce: this.createNonce() })")) {
    failures.push("script-enabled report webview must render with a fresh nonce");
  }
  if (!reports.includes("localResourceRoots: []")) {
    failures.push("webview panels must use empty localResourceRoots");
  }
  if (!core.includes("webviewCspMeta(nonce)") || !core.includes("script-src 'nonce-")) {
    failures.push("report webview HTML must include a nonce-scoped Content Security Policy");
  }
}

function checkModuleBudgets(extensionDir, modules, failures) {
  for (const moduleName of modules) {
    const budget = MODULE_SIZE_BUDGETS.get(moduleName);
    if (!budget) {
      failures.push(`new extension module ${moduleName} needs an explicit size budget in vscode_extension_static_audit.js`);
      continue;
    }
    const bytes = fs.statSync(path.join(extensionDir, moduleName)).size;
    if (bytes > budget) {
      failures.push(`${moduleName} is ${bytes} bytes, above the ${budget} byte maintainability budget`);
    }
  }
}

function checkModuleTests(extensionDir, failures) {
  for (const moduleBase of REQUIRED_TEST_MODULES) {
    const testPath = path.join(extensionDir, "test", `${moduleBase}.test.js`);
    if (!fs.existsSync(testPath)) {
      failures.push(`${moduleBase}.js must have focused unit coverage at test/${moduleBase}.test.js`);
    }
  }
}

function checkTypecheckConfig(extensionDir, packageJson, moduleTexts, failures) {
  const tsconfigPath = path.join(extensionDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    failures.push("packages/vscode-extension/tsconfig.json must exist for checked-JS type validation");
    return;
  }

  const tsconfig = readJson(tsconfigPath);
  const compilerOptions = tsconfig.compilerOptions || {};
  if (compilerOptions.allowJs !== true) {
    failures.push("tsconfig.json must enable allowJs so extension JavaScript can be type-checked");
  }
  if (compilerOptions.noEmit !== true) {
    failures.push("tsconfig.json must set noEmit so type checks never write build output");
  }
  if (!Array.isArray(compilerOptions.types) || !compilerOptions.types.includes("node") || !compilerOptions.types.includes("vscode")) {
    failures.push("tsconfig.json must include node and vscode ambient types");
  }

  const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
  for (const moduleName of TYPECHECKED_MODULES) {
    if (!include.includes(moduleName)) {
      failures.push(`tsconfig.json must include ${moduleName}`);
    }
    const text = moduleTexts[moduleName] || "";
    if (!text.startsWith("// @ts-check")) {
      failures.push(`${moduleName} must opt into checked JavaScript with // @ts-check`);
    }
  }

  const devDependencies = packageJson.devDependencies || {};
  for (const dependency of ["typescript", "@types/node", "@types/vscode"]) {
    if (!devDependencies[dependency]) {
      failures.push(`package.json devDependencies must include ${dependency} for extension type checks`);
    }
  }
}

function checkVscodeIgnore(extensionDir, failures) {
  const ignorePath = path.join(extensionDir, ".vscodeignore");
  const text = readText(ignorePath);
  for (const pattern of [
    "node_modules/**",
    ".vscode-test/**",
    "test/**",
    "tsconfig.json",
    "*.vsix",
    "**/__pycache__/**",
    "**/*.pyc",
  ]) {
    if (!text.includes(pattern)) {
      failures.push(`.vscodeignore must exclude ${pattern}`);
    }
  }
  if (text.includes("python-src")) {
    failures.push(".vscodeignore must not exclude the bundled Python CLI sources in python-src/");
  }
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  checkForbiddenPatterns,
  checkNotificationFlow,
  checkTypecheckConfig,
  listExtensionModules,
  runAudit,
};
