// @ts-check

const DEMO_TEST_FILE = "demo/tests/test_auth_service.py";
const DEMO_SOURCE_FILE = "demo/src/auth_service.py";

function buildDemoGhostReport() {
  return {
    __demo: true,
    __testFile: DEMO_TEST_FILE,
    __sourcePaths: [DEMO_SOURCE_FILE],
    __inferredSourcePaths: [],
    __cacheHit: false,
    analysis_mode: "demo_existing_test_review",
    test_mode: "mixed",
    prompt: "Self-contained Ghost Test Catcher demo report.",
    answer: demoTestSource(),
    sampler: "static_similarity",
    statistics: {
      sampler: "static_similarity",
      total_files: 1,
      test_file_count: 1,
      total_lines: 32,
      total_weight_on_tests: 0,
      total_weight_on_non_tests: 1,
      max_weight: 1,
      mean_weight: 1,
      top_supporting_files: [DEMO_SOURCE_FILE],
      top_test_files: [DEMO_TEST_FILE],
      answer_characters: demoTestSource().length,
    },
    generated_tests: {
      code: demoTestSource(),
      test_count: 2,
      test_names: [
        "test_login_accepts_known_user",
        "test_password_reset_sends_magic_link",
      ],
    },
    verification: {
      total_claims: 2,
      supported_claims: 1,
      borderline_claims: 0,
      unsupported_claims: 1,
      claim_checks: [
        {
          claim: "test_login_accepts_known_user",
          status: "supported",
          confidence: 0.94,
          framework: "pytest",
          risk_categories: [],
          missing_symbols: [],
          evidence: {
            path: DEMO_SOURCE_FILE,
            start_line: 1,
            end_line: 11,
          },
          evidence_symbols: [
            "authenticate_user -> demo/src/auth_service.py:1",
            "KNOWN_USERS -> demo/src/auth_service.py:8",
          ],
          recommendation: "Keep this test; it imports real source behavior and has direct source evidence.",
        },
        {
          claim: "test_password_reset_sends_magic_link",
          status: "unsupported",
          confidence: 0.08,
          framework: "pytest",
          risk_categories: ["missing_symbols", "invented_workflow"],
          missing_symbols: ["send_magic_link", "reset_password_token"],
          evidence: {
            path: DEMO_SOURCE_FILE,
            start_line: 1,
            end_line: 14,
          },
          evidence_symbols: [
            "nearest source only exposes authenticate_user",
            "no password reset or magic-link API found",
          ],
          recommendation: "Rewrite this test against APIs that exist in the selected source context.",
        },
      ],
    },
    execution: {
      status: "failed",
      message: "Demo execution shows one grounded passing test and one failing ghost-risk test.",
      execution_backend: "demo",
      primary_failure: "ImportError: cannot import name 'send_magic_link' from demo.auth_service",
      pytest_summary: "1 failed, 1 passed",
      per_test_results: [
        {
          name: "test_login_accepts_known_user",
          status: "passed",
        },
        {
          name: "test_password_reset_sends_magic_link",
          status: "failed",
        },
      ],
      passed: 1,
      failed: 1,
      errors: 0,
      test_count: 2,
      extracted_code: demoTestSource(),
    },
    trust_assessment: {
      verdict: "ghost_risk",
      message: "Demo report: one test is grounded in source evidence, while one invents password-reset APIs that the source does not provide. No project files were modified.",
      reliability_score: 0.46,
      thresholds: {
        reliable_min: 0.62,
        needs_review_min: 0.38,
      },
      components: {
        supported_claim_ratio: 0.5,
        groundedness_score: 0.51,
        context_relevance_score: 0.82,
        evidence_weight_coverage: 0.5,
        execution_score: 0.5,
        etv_score: 0.5,
        etv_breakdown: {
          total_tests: 2,
          keepers: 1,
          salvageable: 0,
          risky: 1,
        },
      },
    },
    cost_estimate: {
      llm_call_path: "existing_test_review",
      llm_calls: 0,
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      output_token_ceiling_per_call: 0,
      estimated_output_token_ceiling: 0,
      token_estimator: "none",
      sampler: "static_similarity",
      notes: [
        "This demo is a deterministic local report and does not call an LLM.",
        "Normal existing-test review uses local parsing, source-symbol checks, similarity scoring, and optional pytest execution.",
      ],
    },
    files: [
      {
        path: DEMO_SOURCE_FILE,
        line_count: 14,
        size_bytes: demoSource().length,
        is_test_file: false,
        truncated: false,
        raw_score: 1,
        weight: 1,
      },
    ],
    top_test_files: [
      {
        path: DEMO_TEST_FILE,
        line_count: 12,
        size_bytes: demoTestSource().length,
        is_test_file: true,
        truncated: false,
        weight: 1,
      },
    ],
    input_test_files: [
      {
        path: DEMO_TEST_FILE,
        line_count: 12,
        size_bytes: demoTestSource().length,
        truncated: false,
      },
    ],
    context_files: [DEMO_SOURCE_FILE],
    ok: true,
    repo_root: "self-contained demo",
    source_specs: [DEMO_SOURCE_FILE],
    test_specs: [DEMO_TEST_FILE],
  };
}

function demoSource() {
  return [
    "def authenticate_user(username: str, password: str) -> bool:",
    "    if username not in KNOWN_USERS:",
    "        return False",
    "    return KNOWN_USERS[username] == password",
    "",
    "",
    "KNOWN_USERS = {",
    "    \"demo@example.com\": \"correct-password\",",
    "}",
  ].join("\n");
}

function demoTestSource() {
  return [
    "from demo.auth_service import authenticate_user, send_magic_link",
    "",
    "",
    "def test_login_accepts_known_user():",
    "    assert authenticate_user(\"demo@example.com\", \"correct-password\") is True",
    "",
    "",
    "def test_password_reset_sends_magic_link():",
    "    token = send_magic_link(\"demo@example.com\")",
    "    assert token.reset_password_token",
  ].join("\n");
}

module.exports = {
  DEMO_SOURCE_FILE,
  DEMO_TEST_FILE,
  buildDemoGhostReport,
  demoSource,
  demoTestSource,
};
