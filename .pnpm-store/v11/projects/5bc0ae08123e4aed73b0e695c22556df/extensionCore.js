const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const WEBVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
const GHOST_CLI_MODULE = "ghost_test_catcher.cli";
const GHOST_CLI_COMMAND = "ghost-test-catcher";
const PYPI_PACKAGE_SPEC = "ghost-test-catcher[ghost]";

function buildAnalyzeArgs({ root, testFile, sourcePaths, testMode, maxFiles, executeTests, executionBackend, dockerImage }) {
  const relativeTestFile = toPosixPath(path.relative(root, testFile));
  const args = [
    "-m",
    GHOST_CLI_MODULE,
    "analyze",
    "--repo",
    root,
    "--format",
    "json",
    "--tests",
    relativeTestFile,
    "--test-mode",
    testMode || "mixed",
    "--max-files",
    String(maxFiles || 80),
  ];

  if (sourcePaths && sourcePaths.length) {
    args.push("--source", ...sourcePaths);
  }
  if (!executeTests) {
    args.push("--no-execution");
  }
  if (executionBackend && executionBackend !== "local") {
    args.push("--execution-backend", executionBackend);
  }
  if (dockerImage) {
    args.push("--docker-image", dockerImage);
  }
  return args;
}

function analysisCacheKey({
  root,
  testFile,
  sourcePaths,
  testMode,
  maxFiles,
  executeTests,
  pythonPath,
  executionBackend,
  dockerImage,
}) {
  const payload = {
    root: normalizePath(root),
    testFile: normalizePath(testFile),
    sourcePaths: (sourcePaths || []).map((item) => toPosixPath(String(item))),
    testMode: testMode || "mixed",
    maxFiles: Number(maxFiles || 80),
    executeTests: Boolean(executeTests),
    pythonPath: String(pythonPath || "python"),
    executionBackend: String(executionBackend || "local"),
    dockerImage: String(dockerImage || ""),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function reportTestNames(result) {
  return result?.generated_tests?.test_names || [];
}

function renderGitHubActionsWorkflow({ pythonVersion = "3.11", failOn = "ghost_risk", sourcePaths = ["src"], testPaths = ["tests"] } = {}) {
  const sourceArgs = cliListArgs("--source", sourcePaths);
  const testArgs = cliListArgs("--tests", testPaths);
  return `name: Ghost Test Catcher

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  ghost-test-catcher:
    name: Verify generated Python tests
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "${pythonVersion}"
          cache: pip

      - name: Install Ghost Test Catcher
        run: python -m pip install "${PYPI_PACKAGE_SPEC}"

      - name: Run Ghost Test Catcher CI gate
        run: |
          ${GHOST_CLI_COMMAND} ci \\
            --repo . \\
            ${testArgs} \\
            ${sourceArgs} \\
            --no-execution \\
            --summary ghost-test-catcher-summary.md \\
            --output ghost-test-catcher-report.json \\
            --format json \\
            --fail-on ${failOn}

      - name: Publish job summary
        if: always()
        run: |
          if [ -f ghost-test-catcher-summary.md ]; then
            cat ghost-test-catcher-summary.md >> "$GITHUB_STEP_SUMMARY"
          fi

      - name: Upload Ghost Test Catcher report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ghost-test-catcher-report
          path: |
            ghost-test-catcher-report.json
            ghost-test-catcher-summary.md
`;
}

function cliListArgs(flag, values) {
  const normalized = (values || []).map((value) => String(value).trim()).filter(Boolean);
  if (!normalized.length) {
    return `${flag} .`;
  }
  return `${flag} ${normalized.map(shellArg).join(" ")}`;
}

function shellArg(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultPythonCandidates(configuredPythonPath) {
  const seen = new Set();
  const candidates = [];
  for (const value of [configuredPythonPath, "python", "python3"]) {
    const candidate = String(value || "").trim();
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function setupProfileSettings(profileId) {
  if (profileId === "static") {
    return {
      executeTests: false,
      executionBackend: "local",
      confirmExecution: true,
    };
  }
  if (profileId === "docker") {
    return {
      executeTests: true,
      executionBackend: "docker",
      confirmExecution: true,
    };
  }
  return {
    executeTests: true,
    executionBackend: "local",
    confirmExecution: true,
  };
}

function editableInstallArgs() {
  return ["-m", "pip", "install", "-e", ".[ghost]"];
}

function pypiInstallArgs(packageSpec = PYPI_PACKAGE_SPEC) {
  return ["-m", "pip", "install", packageSpec];
}

function parseTestFunctionLocations(text) {
  const locations = [];
  const lines = text.split(/\r?\n/);
  const classStack = [];
  const classPattern = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
  const testPattern = /^(\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/;
  for (let line = 0; line < lines.length; line += 1) {
    const textLine = lines[line];
    const indent = leadingSpaces(textLine);
    while (classStack.length && indent <= classStack[classStack.length - 1].indent && textLine.trim()) {
      classStack.pop();
    }

    const classMatch = classPattern.exec(textLine);
    if (classMatch) {
      classStack.push({ name: classMatch[2], indent: classMatch[1].length });
      continue;
    }

    const match = testPattern.exec(textLine);
    if (match) {
      const defIndent = match[1].length;
      const classEntry = classStack[classStack.length - 1];
      const classIndent = classEntry?.indent;
      const isTopLevel = defIndent === 0;
      const isDirectClassMethod = classIndent !== undefined && defIndent === classIndent + 4;
      if (!isTopLevel && !isDirectClassMethod) {
        continue;
      }
      const start = textLine.indexOf(match[2]);
      const location = {
        name: match[2],
        qualifiedName: isDirectClassMethod ? `${classEntry.name}.${match[2]}` : match[2],
        line,
        start: Math.max(0, start),
        end: start + match[2].length,
      };
      if (isDirectClassMethod) {
        location.className = classEntry.name;
      }
      locations.push(location);
    }
  }
  return locations;
}

function leadingSpaces(value) {
  const match = /^ */.exec(value);
  return match ? match[0].length : 0;
}

function isTestPath(file) {
  const normalized = toPosixPath(file).toLowerCase();
  const filename = path.basename(normalized);
  return normalized.includes("/tests/") || filename.startsWith("test_") || filename.endsWith("_test.py");
}

function isPythonPath(file) {
  return toPosixPath(file).toLowerCase().endsWith(".py");
}

function extractPythonImportModules(text) {
  const modules = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) {
      continue;
    }

    const importMatch = /^import\s+(.+)$/.exec(line);
    if (importMatch) {
      for (const item of importMatch[1].split(",")) {
        const moduleName = item.trim().split(/\s+as\s+/i)[0].trim();
        addImportModule(modules, moduleName);
      }
      continue;
    }

    const fromMatch = /^from\s+([A-Za-z_][A-Za-z0-9_.]*|\.+[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/.exec(line);
    if (fromMatch && !fromMatch[1].startsWith(".")) {
      addImportModule(modules, fromMatch[1]);
    }
  }
  return Array.from(modules).sort();
}

function addImportModule(modules, moduleName) {
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(moduleName)) {
    modules.add(moduleName);
  }
}

function inferSourcePathsFromImports(root, testFile) {
  if (!fs.existsSync(testFile) || !fs.statSync(testFile).isFile()) {
    return [];
  }
  const text = fs.readFileSync(testFile, "utf-8");
  return resolveImportModulesToSourcePaths(root, extractPythonImportModules(text));
}

function resolveImportModulesToSourcePaths(root, modules) {
  const seen = new Set();
  const resolved = [];
  for (const moduleName of modules || []) {
    const parts = moduleName.split(".");
    const candidates = [];
    for (let count = parts.length; count >= 1; count -= 1) {
      const moduleParts = parts.slice(0, count);
      candidates.push(...moduleCandidatePaths(root, moduleParts));
    }
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        continue;
      }
      const relative = relativePathFromRoot(root, candidate);
      if (!relative || isTestPath(relative) || !isPythonPath(relative) || seen.has(relative)) {
        continue;
      }
      seen.add(relative);
      resolved.push(relative);
      break;
    }
  }
  return resolved.sort();
}

function moduleCandidatePaths(root, moduleParts) {
  const modulePath = path.join(...moduleParts);
  return [
    path.join(root, `${modulePath}.py`),
    path.join(root, modulePath, "__init__.py"),
    path.join(root, "src", `${modulePath}.py`),
    path.join(root, "src", modulePath, "__init__.py"),
  ];
}

function findProjectRootForFile(file, workspaceRoot) {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  let cursor = fs.existsSync(file) && fs.statSync(file).isDirectory()
    ? path.resolve(file)
    : path.dirname(path.resolve(file));

  while (isInsideOrEqual(cursor, resolvedWorkspace)) {
    if (looksLikeGhostProjectRoot(cursor) || looksLikePythonProjectRoot(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return resolvedWorkspace;
}

function looksLikeGhostProjectRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, "src", "llmSHAP", "ghost", "cli.py")) ||
    fs.existsSync(path.join(candidate, ".ghosttest.toml"))
  );
}

function looksLikePythonProjectRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, "pyproject.toml")) ||
    fs.existsSync(path.join(candidate, "setup.py")) ||
    fs.existsSync(path.join(candidate, "setup.cfg"))
  );
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativePathFromRoot(root, file) {
  const relative = path.relative(root, file);
  if (relative === "") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return toPosixPath(relative);
}

function toRelativeSourcePaths(root, sourceFiles) {
  const seen = new Set();
  const relativePaths = [];
  for (const sourceFile of sourceFiles || []) {
    const relative = relativePathFromRoot(root, sourceFile);
    if (relative && !seen.has(relative)) {
      seen.add(relative);
      relativePaths.push(relative);
    }
  }
  return relativePaths;
}

function mergeSourcePaths(...pathGroups) {
  const seen = new Set();
  const merged = [];
  for (const group of pathGroups) {
    for (const value of group || []) {
      const normalized = toPosixPath(String(value)).replace(/^\.\//, "");
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        merged.push(normalized);
      }
    }
  }
  return merged;
}

function summarizeReports(reports) {
  return reports.reduce(
    (summary, result) => {
      const verdict = result.trust_assessment?.verdict;
      if (verdict === "reliable") {
        summary.reliable += 1;
      } else if (verdict === "ghost_risk") {
        summary.ghostRisk += 1;
      } else {
        summary.needsReview += 1;
      }
      return summary;
    },
    { reliable: 0, needsReview: 0, ghostRisk: 0 }
  );
}

function nativeTestOutcome(groundedStatus, executionStatus) {
  if (groundedStatus === "unsupported" || groundedStatus === "borderline") {
    return "failed";
  }
  if (executionStatus === "failed" || executionStatus === "error") {
    return "failed";
  }
  if (executionStatus === "passed") {
    return "passed";
  }
  return "skipped";
}

function nativeTestMessage({ name, groundedStatus, executionStatus, confidence, missingSymbols, riskCategories, recommendation }) {
  const details = [
    `Grounding: ${supportLabel(groundedStatus || "unsupported")}`,
    `Confidence: ${percent(Number(confidence || 0))}`,
    `Execution: ${executionStatus || "unknown"}`,
  ];
  if (missingSymbols && missingSymbols.length) {
    details.push(`Missing symbols: ${missingSymbols.join(", ")}`);
  }
  if (riskCategories && riskCategories.length) {
    details.push(`Risk categories: ${riskCategories.join(", ")}`);
  }
  if (recommendation) {
    details.push(`Recommendation: ${recommendation}`);
  }
  return `Ghost Test Catcher result for ${name}.\n${details.join("\n")}`;
}

function mapBy(items, key) {
  const mapped = new Map();
  for (const item of items || []) {
    if (item && item[key]) {
      mapped.set(item[key], item);
    }
  }
  return mapped;
}

function renderReportHtml(reports, options = {}) {
  const nonce = options.nonce || "";
  const frameworks = uniqueFrameworks(reports);
  const body = reports.map(renderSingleReport).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  ${webviewCspMeta(nonce)}
  <style>
    body { margin: 0; padding: 24px; color: #d4d4d4; background: #1e1e1e; font-family: var(--vscode-font-family); }
    h1, h2, h3 { color: #f3f3f3; margin: 0; }
    .toolbar { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin: 16px 0 18px; padding: 12px; background: #252526; border: 1px solid #3c3c3c; border-radius: 6px; }
    .toolbar label { display: grid; gap: 5px; color: #bdbdbd; font-size: 12px; }
    .toolbar select, .toolbar input { background: #1e1e1e; color: #f3f3f3; border: 1px solid #3c3c3c; border-radius: 4px; padding: 7px; font-family: var(--vscode-font-family); min-width: 0; }
    .toolbar .check { display: flex; align-items: end; gap: 7px; padding-bottom: 7px; }
    .toolbar .check input { margin: 0; }
    .report { border: 1px solid #3c3c3c; border-radius: 6px; margin-bottom: 18px; overflow: hidden; }
    .hero { padding: 18px; background: #252526; border-left: 5px solid #6796e6; }
    .hero.reliable { border-left-color: #4ec97a; }
    .hero.needs_review { border-left-color: #d7a642; }
    .hero.ghost_risk { border-left-color: #e06c75; }
    .path { margin-top: 8px; color: #9cdcfe; font-family: var(--vscode-editor-font-family); word-break: break-all; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 14px 18px; }
    .metric { border: 1px solid #3c3c3c; border-radius: 6px; padding: 12px; background: #202020; }
    .metric span { display: block; color: #9e9e9e; font-size: 12px; margin-bottom: 6px; }
    .metric strong { color: #f3f3f3; }
    table { width: calc(100% - 36px); margin: 4px 18px 18px; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #333; padding: 9px 6px; text-align: left; vertical-align: top; }
    th { color: #bdbdbd; font-weight: 600; }
    .supported, .passed, .reliable { color: #4ec97a; }
    .borderline, .skipped, .needs_review { color: #d7a642; }
    .unsupported, .failed, .error, .ghost_risk { color: #e06c75; }
    .evidence { color: #9cdcfe; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .recommendation { min-width: 220px; }
    .muted { color: #9e9e9e; }
    details summary { cursor: pointer; color: #9cdcfe; }
    mark { background: #614b14; color: #f3f3f3; }
    .hidden { display: none; }
    .empty-state { border: 1px solid #3c3c3c; border-radius: 6px; padding: 16px; color: #bdbdbd; background: #252526; }
    @media (max-width: 980px) { .toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 820px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 620px) { .toolbar { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Ghost Test Catcher</h1>
  ${renderReportToolbar(frameworks)}
  <div id="ghost-empty" class="empty-state hidden">No tests match the current filters.</div>
  ${body}
  ${nonce ? renderReportScript(nonce) : ""}
</body>
</html>`;
}

function renderDoctorHtml(report) {
  const sourceItems = listItems(report.sourcePaths || []);
  const inferredItems = listItems(report.inferredSourcePaths || []);
  const discoveredSourceItems = listItems(report.doctor?.discovered_source_specs || []);
  const discoveredTestItems = listItems(report.doctor?.discovered_test_specs || []);
  const config = report.doctor?.config || {};
  const doctorError = report.doctor?.error
    ? `<div class="panel"><h2 class="bad">CLI Doctor Error</h2><p>${escapeHtml(report.doctor.error)}</p></div>`
    : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  ${webviewCspMeta()}
  <style>
    body { margin: 0; padding: 24px; color: #d4d4d4; background: #1e1e1e; font-family: var(--vscode-font-family); }
    h1, h2, h3 { color: #f3f3f3; margin: 0; }
    .panel { border: 1px solid #3c3c3c; border-radius: 6px; margin-top: 16px; padding: 16px; background: #252526; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
    .metric { border: 1px solid #3c3c3c; border-radius: 6px; padding: 12px; background: #202020; }
    .metric span { display: block; color: #9e9e9e; font-size: 12px; margin-bottom: 6px; }
    code, pre { font-family: var(--vscode-editor-font-family); }
    code { color: #9cdcfe; }
    ul { margin: 10px 0 0; padding-left: 18px; }
    li { margin: 4px 0; word-break: break-all; }
    .ok { color: #4ec97a; }
    .bad { color: #e06c75; }
    .muted { color: #9e9e9e; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Ghost Test Catcher Doctor</h1>
  <div class="panel">
    <h2 class="${report.importOk ? "ok" : "bad"}">${report.importOk ? "Ready" : "Needs Setup"}</h2>
    <p>${escapeHtml(report.importMessage || "")}</p>
  </div>
  ${doctorError}
  <div class="grid">
    ${metric("Project Root", report.root || "unknown")}
    ${metric("Python", report.pythonPath || "python")}
    ${metric("Test Mode", config.test_mode || "mixed")}
    ${metric("Execution", config.execute_tests ? "enabled" : "disabled")}
  </div>
  <div class="panel">
    <h2>Configured Source Paths</h2>
    <ul>${sourceItems || "<li class=\"muted\">No configured source paths.</li>"}</ul>
  </div>
  <div class="panel">
    <h2>Inferred Imported Source Files</h2>
    <ul>${inferredItems || "<li class=\"muted\">No local imports resolved for the active test file.</li>"}</ul>
  </div>
  <div class="grid">
    <div class="panel">
      <h2>Discovered Sources</h2>
      <ul>${discoveredSourceItems || "<li class=\"muted\">No sources discovered.</li>"}</ul>
    </div>
    <div class="panel">
      <h2>Discovered Tests</h2>
      <ul>${discoveredTestItems || "<li class=\"muted\">No tests discovered.</li>"}</ul>
    </div>
  </div>
</body>
</html>`;
}

function webviewCspMeta(nonce = "") {
  const scriptPolicy = nonce ? ` script-src 'nonce-${nonce}';` : "";
  return `<meta http-equiv="Content-Security-Policy" content="${WEBVIEW_CSP}${scriptPolicy}">`;
}

function listItems(items) {
  return (items || []).map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("");
}

function renderReportToolbar(frameworks) {
  const frameworkOptions = frameworks.map((framework) => `<option value="${escapeHtml(framework)}">${escapeHtml(framework)}</option>`).join("");
  return `<div class="toolbar">
    <label>Verdict
      <select id="filter-verdict">
        <option value="">All verdicts</option>
        <option value="reliable">Reliable</option>
        <option value="needs_review">Needs review</option>
        <option value="ghost_risk">Ghost risk</option>
      </select>
    </label>
    <label>Framework
      <select id="filter-framework">
        <option value="">All frameworks</option>
        ${frameworkOptions}
      </select>
    </label>
    <label>Evidence
      <input id="filter-evidence" type="search" placeholder="Path, symbol, or test">
    </label>
    <label class="check"><input id="filter-missing" type="checkbox"> Missing symbols</label>
    <label class="check"><input id="filter-failed" type="checkbox"> Failed or risky</label>
  </div>`;
}

function renderReportScript(nonce) {
  return `<script nonce="${escapeHtml(nonce)}">
(() => {
  const verdict = document.getElementById("filter-verdict");
  const framework = document.getElementById("filter-framework");
  const evidence = document.getElementById("filter-evidence");
  const missing = document.getElementById("filter-missing");
  const failed = document.getElementById("filter-failed");
  const empty = document.getElementById("ghost-empty");
  const controls = [verdict, framework, evidence, missing, failed];

  function matchesRow(row, reportVerdict) {
    const evidenceQuery = evidence.value.trim().toLowerCase();
    if (verdict.value && reportVerdict !== verdict.value) {
      return false;
    }
    if (framework.value && row.dataset.framework !== framework.value) {
      return false;
    }
    if (missing.checked && row.dataset.missing !== "true") {
      return false;
    }
    if (failed.checked && row.dataset.failed !== "true") {
      return false;
    }
    if (evidenceQuery && !row.dataset.search.includes(evidenceQuery)) {
      return false;
    }
    return true;
  }

  function applyFilters() {
    let visibleReports = 0;
    for (const report of document.querySelectorAll(".report")) {
      let visibleRows = 0;
      for (const row of report.querySelectorAll("tbody tr[data-test-row='true']")) {
        const visible = matchesRow(row, report.dataset.verdict || "");
        row.classList.toggle("hidden", !visible);
        if (visible) {
          visibleRows += 1;
        }
      }
      report.classList.toggle("hidden", visibleRows === 0);
      if (visibleRows > 0) {
        visibleReports += 1;
      }
    }
    empty.classList.toggle("hidden", visibleReports !== 0);
  }

  for (const control of controls) {
    control.addEventListener("input", applyFilters);
    control.addEventListener("change", applyFilters);
  }
  applyFilters();
})();
  </script>`;
}

function renderSingleReport(result) {
  const trust = result.trust_assessment || {};
  const execution = result.execution || {};
  const components = trust.components || {};
  const checks = mapBy(result.verification?.claim_checks || [], "claim");
  const runs = mapBy(result.execution?.per_test_results || [], "name");
  const rows = (result.generated_tests?.test_names || []).map((name) => {
    const check = checks.get(name) || {};
    const run = runs.get(name) || {};
    const evidence = check.evidence ? `${check.evidence.path}:${check.evidence.start_line}-${check.evidence.end_line}` : "No evidence";
    const missing = (check.missing_symbols || []).join(", ") || "-";
    const exactEvidence = (check.evidence_symbols || []).join(", ");
    const categories = (check.risk_categories || []).join(", ") || "-";
    const recommendation = check.recommendation || "-";
    const framework = check.framework || "unknown";
    const status = check.status || "unsupported";
    const runStatus = run.status || "unknown";
    const hasMissing = (check.missing_symbols || []).length > 0;
    const failedOrRisky = status !== "supported" || ["failed", "error"].includes(runStatus);
    const search = [
      name,
      framework,
      status,
      runStatus,
      evidence,
      exactEvidence,
      missing,
      categories,
      recommendation,
    ].join(" ").toLowerCase();
    return `<tr data-test-row="true" data-framework="${escapeHtml(framework)}" data-missing="${hasMissing ? "true" : "false"}" data-failed="${failedOrRisky ? "true" : "false"}" data-search="${escapeHtml(search)}">
      <td><code>${escapeHtml(name)}</code></td>
      <td>${escapeHtml(framework)}</td>
      <td class="${escapeHtml(status)}">${escapeHtml(supportLabel(status))}</td>
      <td>${escapeHtml(percent(Number(check.confidence || 0)))}</td>
      <td class="${escapeHtml(runStatus)}">${escapeHtml(runStatus)}</td>
      <td class="muted">${escapeHtml(categories)}</td>
      <td class="evidence"><details><summary>${escapeHtml(evidence)}</summary>${exactEvidence ? `<div>${escapeHtml(exactEvidence)}</div>` : "<div>No exact evidence symbols.</div>"}</details></td>
      <td>${escapeHtml(missing)}</td>
      <td class="recommendation">${escapeHtml(recommendation)}</td>
    </tr>`;
  }).join("");

  return `<section class="report" data-verdict="${escapeHtml(trust.verdict || "needs_review")}">
    <div class="hero ${escapeHtml(trust.verdict || "needs_review")}">
      <h2>${escapeHtml(verdictLabel(trust.verdict || "needs_review"))}</h2>
      <div class="path">${escapeHtml(result.__testFile || (result.input_test_files || []).map((item) => item.path).join(", "))}</div>
      <p>${escapeHtml(trust.message || "")}</p>
    </div>
    <div class="grid">
      ${metric("Reliability", percent(Number(trust.reliability_score || 0)))}
      ${metric("ETV", percent(Number(components.etv_score || 0)))}
      ${metric("Execution", execution.status || "unknown")}
      ${metric("Passed", `${execution.passed || 0}/${execution.test_count || 0}`)}
    </div>
    <table>
      <thead>
        <tr><th>Test</th><th>Framework</th><th>Grounding</th><th>Confidence</th><th>Run</th><th>Categories</th><th>Evidence</th><th>Missing</th><th>Recommendation</th></tr>
      </thead>
      <tbody>${rows || "<tr><td colspan=\"9\">No Python tests detected.</td></tr>"}</tbody>
    </table>
  </section>`;
}

function uniqueFrameworks(reports) {
  const frameworks = new Set();
  for (const result of reports || []) {
    for (const check of result.verification?.claim_checks || []) {
      frameworks.add(check.framework || "unknown");
    }
  }
  return Array.from(frameworks).sort();
}

function supportLabel(status) {
  if (status === "supported") {
    return "Grounded";
  }
  if (status === "borderline") {
    return "Needs review";
  }
  return "Ghost risk";
}

function verdictLabel(verdict) {
  if (verdict === "reliable") {
    return "Reliable";
  }
  if (verdict === "ghost_risk") {
    return "Ghost Test Risk";
  }
  return "Needs Review";
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  GHOST_CLI_COMMAND,
  GHOST_CLI_MODULE,
  analysisCacheKey,
  buildAnalyzeArgs,
  defaultPythonCandidates,
  editableInstallArgs,
  escapeHtml,
  extractPythonImportModules,
  findProjectRootForFile,
  inferSourcePathsFromImports,
  isTestPath,
  isPythonPath,
  mapBy,
  mergeSourcePaths,
  nativeTestMessage,
  nativeTestOutcome,
  normalizePath,
  parseTestFunctionLocations,
  percent,
  pypiInstallArgs,
  reportTestNames,
  renderGitHubActionsWorkflow,
  renderReportHtml,
  renderDoctorHtml,
  relativePathFromRoot,
  resolveImportModulesToSourcePaths,
  summarizeReports,
  setupProfileSettings,
  supportLabel,
  toRelativeSourcePaths,
  toPosixPath,
  verdictLabel,
};
