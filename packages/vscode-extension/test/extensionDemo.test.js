const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../extensionCore");
const demo = require("../extensionDemo");

test("buildDemoGhostReport creates a self-contained ghost-risk teaching report", () => {
  const report = demo.buildDemoGhostReport();
  const decisions = core.summarizeTestDecisions([report]);
  const cost = core.summarizeCost([report]);

  assert.equal(report.__demo, true);
  assert.equal(report.__testFile, demo.DEMO_TEST_FILE);
  assert.deepEqual(report.__sourcePaths, [demo.DEMO_SOURCE_FILE]);
  assert.equal(report.trust_assessment.verdict, "ghost_risk");
  assert.deepEqual(decisions, {
    safe: 1,
    review: 0,
    highRisk: 1,
    total: 2,
  });
  assert.equal(cost.llmCalls, 0);
  assert.equal(cost.estimatedInputTokens, 0);
  assert.equal(report.cost_estimate.notes.some((note) => note.includes("does not call an LLM")), true);
  assert.equal(report.verification.claim_checks[0].status, "supported");
  assert.equal(report.verification.claim_checks[1].status, "unsupported");
  assert.deepEqual(report.verification.claim_checks[1].missing_symbols, [
    "send_magic_link",
    "reset_password_token",
  ]);
  assert.equal(report.execution.status, "failed");
  assert.equal(report.execution.passed, 1);
  assert.equal(report.execution.failed, 1);
});

test("demo report renders with verdict education and no-project-modification copy", () => {
  const html = core.renderReportHtml([demo.buildDemoGhostReport()], { nonce: "demo123" });

  assert.ok(html.includes("Demo mode"));
  assert.ok(html.includes("does not read, write, or modify your project files"));
  assert.ok(html.includes("What does this verdict mean?"));
  assert.ok(html.includes("Ghost risk"));
  assert.ok(html.includes("ETV estimates how much of the test set is worth keeping or repairing"));
  assert.ok(html.includes("Source evidence points to the files, lines, and symbols"));
  assert.ok(html.includes("send_magic_link"));
  assert.ok(html.includes("reset_password_token"));
  assert.ok(html.includes("demo/src/auth_service.py"));
  assert.ok(html.includes("0 LLM calls"));
  assert.ok(html.includes("script-src 'nonce-demo123'"));
});
