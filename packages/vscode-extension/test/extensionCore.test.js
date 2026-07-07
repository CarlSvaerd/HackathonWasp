const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const core = require("../extensionCore");

test("buildAnalyzeArgs creates the CLI contract used by the extension", () => {
  const root = path.join("C:", "workspace", "project");
  const testFile = path.join(root, "tests", "test_auth.py");

  const args = core.buildAnalyzeArgs({
    root,
    testFile,
    sourcePaths: ["src", "lib"],
    testMode: "integration",
    maxFiles: 42,
    executeTests: false,
  });

  assert.deepEqual(args.slice(0, 8), [
    "-m",
    "llmSHAP.ghost.cli",
    "analyze",
    "--repo",
    root,
    "--format",
    "json",
    "--tests",
  ]);
  assert.equal(args[8], "tests/test_auth.py");
  assert.ok(args.includes("--no-execution"));
  assert.ok(args.includes("integration"));
  assert.ok(args.includes("42"));
  assert.deepEqual(args.slice(args.indexOf("--source"), args.indexOf("--source") + 3), ["--source", "src", "lib"]);
});

test("parseTestFunctionLocations returns stable line ranges", () => {
  const locations = core.parseTestFunctionLocations([
    "def helper():",
    "    pass",
    "",
    "def test_login_accepts_user():",
    "    assert True",
    "    def test_nested_is_not_collected():",
    "        assert False",
    "",
    "async def test_async_is_supported():",
    "    pass",
    "",
    "class TestAccountFlow:",
    "    def test_class_method_is_supported(self):",
    "        assert True",
  ].join("\n"));

  assert.deepEqual(locations, [
    {
      name: "test_login_accepts_user",
      line: 3,
      start: 4,
      end: 27,
    },
    {
      name: "test_async_is_supported",
      line: 8,
      start: 10,
      end: 33,
    },
    {
      name: "test_class_method_is_supported",
      line: 12,
      start: 8,
      end: 38,
    },
  ]);
});

test("isTestPath recognizes pytest naming and tests directories", () => {
  assert.equal(core.isTestPath("/repo/tests/test_auth.py"), true);
  assert.equal(core.isTestPath("/repo/src/auth_test.py"), true);
  assert.equal(core.isTestPath("/repo/src/test_auth.py"), true);
  assert.equal(core.isTestPath("/repo/src/auth.py"), false);
});

test("summarizeReports groups report verdicts for notifications", () => {
  const summary = core.summarizeReports([
    { trust_assessment: { verdict: "reliable" } },
    { trust_assessment: { verdict: "needs_review" } },
    { trust_assessment: { verdict: "ghost_risk" } },
    {},
  ]);

  assert.deepEqual(summary, {
    reliable: 1,
    needsReview: 2,
    ghostRisk: 1,
  });
});

test("renderReportHtml escapes user-controlled text and includes exact evidence symbols", () => {
  const html = core.renderReportHtml([
    {
      __testFile: "tests/test_<auth>.py",
      trust_assessment: {
        verdict: "ghost_risk",
        message: "Review <script>alert(1)</script>",
        reliability_score: 0.1,
        components: { etv_score: 0 },
      },
      execution: {
        status: "failed",
        passed: 0,
        test_count: 1,
        per_test_results: [{ name: "test_login", status: "failed" }],
      },
      generated_tests: { test_names: ["test_login"] },
      verification: {
        claim_checks: [
          {
            claim: "test_login",
            status: "unsupported",
            confidence: 0.12,
            evidence: { path: "src/auth.py", start_line: 1, end_line: 8 },
            evidence_symbols: ["login -> src/auth.py:1"],
            missing_symbols: ["chargeCustomer"],
          },
        ],
      },
    },
  ]);

  assert.ok(html.includes("Ghost Test Catcher"));
  assert.ok(html.includes("tests/test_&lt;auth&gt;.py"));
  assert.ok(html.includes("Review &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("login -&gt; src/auth.py:1"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
});
