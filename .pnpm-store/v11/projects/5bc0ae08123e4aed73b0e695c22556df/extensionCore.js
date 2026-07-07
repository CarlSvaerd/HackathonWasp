const path = require("path");

function buildAnalyzeArgs({ root, testFile, sourcePaths, testMode, maxFiles, executeTests }) {
  const relativeTestFile = toPosixPath(path.relative(root, testFile));
  const args = [
    "-m",
    "llmSHAP.ghost.cli",
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
  return args;
}

function parseTestFunctionLocations(text) {
  const locations = [];
  const lines = text.split(/\r?\n/);
  const classIndents = [];
  const classPattern = /^(\s*)class\s+[A-Za-z_][A-Za-z0-9_]*\b/;
  const testPattern = /^(\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/;
  for (let line = 0; line < lines.length; line += 1) {
    const textLine = lines[line];
    const indent = leadingSpaces(textLine);
    while (classIndents.length && indent <= classIndents[classIndents.length - 1] && textLine.trim()) {
      classIndents.pop();
    }

    const classMatch = classPattern.exec(textLine);
    if (classMatch) {
      classIndents.push(classMatch[1].length);
      continue;
    }

    const match = testPattern.exec(textLine);
    if (match) {
      const defIndent = match[1].length;
      const classIndent = classIndents[classIndents.length - 1];
      const isTopLevel = defIndent === 0;
      const isDirectClassMethod = classIndent !== undefined && defIndent === classIndent + 4;
      if (!isTopLevel && !isDirectClassMethod) {
        continue;
      }
      const start = textLine.indexOf(match[2]);
      locations.push({
        name: match[2],
        line,
        start: Math.max(0, start),
        end: start + match[2].length,
      });
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

function mapBy(items, key) {
  const mapped = new Map();
  for (const item of items || []) {
    if (item && item[key]) {
      mapped.set(item[key], item);
    }
  }
  return mapped;
}

function renderReportHtml(reports) {
  const body = reports.map(renderSingleReport).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 24px; color: #d4d4d4; background: #1e1e1e; font-family: var(--vscode-font-family); }
    h1, h2, h3 { color: #f3f3f3; margin: 0; }
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
    @media (max-width: 820px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <h1>Ghost Test Catcher</h1>
  ${body}
</body>
</html>`;
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
    const missing = (check.missing_symbols || []).join(", ");
    const exactEvidence = (check.evidence_symbols || []).join(", ");
    return `<tr>
      <td><code>${escapeHtml(name)}</code></td>
      <td class="${escapeHtml(check.status || "unsupported")}">${escapeHtml(supportLabel(check.status || "unsupported"))}</td>
      <td>${escapeHtml(percent(Number(check.confidence || 0)))}</td>
      <td class="${escapeHtml(run.status || "unknown")}">${escapeHtml(run.status || "unknown")}</td>
      <td class="evidence">${escapeHtml(evidence)}${exactEvidence ? `<br>${escapeHtml(exactEvidence)}` : ""}</td>
      <td>${escapeHtml(missing)}</td>
    </tr>`;
  }).join("");

  return `<section class="report">
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
        <tr><th>Test</th><th>Grounding</th><th>Confidence</th><th>Pytest</th><th>Evidence</th><th>Missing</th></tr>
      </thead>
      <tbody>${rows || "<tr><td colspan=\"6\">No pytest functions detected.</td></tr>"}</tbody>
    </table>
  </section>`;
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
  buildAnalyzeArgs,
  escapeHtml,
  isTestPath,
  mapBy,
  normalizePath,
  parseTestFunctionLocations,
  percent,
  renderReportHtml,
  summarizeReports,
  supportLabel,
  toPosixPath,
  verdictLabel,
};
