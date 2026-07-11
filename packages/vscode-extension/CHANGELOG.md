# Changelog

## 0.2.8

- Added `Ghost Test Catcher: Analyze Demo Ghost Test`, a self-contained first-run report that shows one source-backed passing test and one high-risk ghost test without modifying the user's project.
- Added a report-panel explanation for `Reliable`, `Needs review`, `Ghost risk`, ETV, and source evidence so first-time users can understand verdicts without reading the README first.
- Added checked-JavaScript TypeScript/JSDoc validation through `npm run check:types`, wired it into `npm run check`, and documented the syntax/type/static quality gates.
- Added static-audit coverage for the checked-JS gate, extension module budgets, package hygiene, and command activation drift.
- Added unit and integration coverage for the demo command, report education copy, and release-facing manifest behavior.
- Refreshed product metrics around the current zero-LLM existing-test review path and kept Marketplace claims tied to repository-local measurements.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.8.vsix`.

## 0.2.7

- Added a dependency-free VS Code extension static audit to guard package script coverage, command activation parity, Workspace Trust restrictions, webview safety, process-spawn safety, module size budgets, and VSIX version references.
- Wired the static audit into `npm run check` so CI catches maintainability and security regressions before packaging.
- Added unit coverage for the static audit itself.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.7.vsix`.

## 0.2.6

- Split setup, Doctor, and analysis-cache persistence/fingerprinting logic out of the main extension host file.
- Added unit coverage for cache persistence, fingerprint invalidation, setup profile choices, install-command rendering, and Doctor fallback reports.
- Kept the extension host focused on command wiring, analysis orchestration, and small VS Code command wrappers.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.6.vsix`.

## 0.2.5

- Split diagnostics, CodeLens, Quick Fix, report webview, Doctor webview, and native Testing panel logic out of the main extension host file.
- Added focused unit coverage for extracted diagnostic severity/context helpers and Testing panel item grouping/lookup helpers.
- Tightened VS Code Testing discovery excludes so generated `.pnpm-store` folders are skipped during workspace scans.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.5.vsix`.

## 0.2.4

- Split process execution, cancellation, path, nonce, and environment helpers out of the main extension host file into `extensionUtils.js`.
- Added unit coverage for extracted extension utilities, including command execution, cancellation handling, path containment, and trusted-workspace `PYTHONPATH` construction.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.4.vsix`.

## 0.2.3

- Fixed copied report summaries to display Effective Test Value from `trust_assessment.components.etv_score` instead of a stale legacy field.
- Reworked copied summaries around a decision-first review block: safe to keep, review recommended, and high-risk ghost tests.
- Shortened copied report paths to workspace-relative paths when invoked from VS Code.
- Replaced misleading raw recommendations for grounded passing tests with clearer symbol-signal and action wording that distinguishes context gaps from ghost-test risk.
- Updated the report panel table wording from `Missing`/`Recommendation` to `Symbol Signal`/`Action`.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.3.vsix`.

## 0.2.2

- Added `Ghost Test Catcher: Copy Report Summary`, which copies a Markdown review summary with verdict counts, cost/cache details, per-file results, per-test grounding, missing symbols, evidence locations, execution status, and recommendations.
- Added `ghostTestCatcher.persistAnalysisCache` so sensitive workspaces can keep analysis caching in memory for the current VS Code session without persisting report content in VS Code workspace state.
- Added a visible Testing panel discovery warning when `ghostTestCatcher.testDiscoveryLimit` is reached, including actions to open the setting or increase the workspace limit.
- Updated the VSIX output filename to `ghost-test-catcher-0.2.2.vsix`.

## 0.2.1

- Added visible report and notification cost summaries for LLM calls, estimated input tokens, output token ceilings, and analysis cache hits.
- Added clearer first-run setup profile details that explain local, static-only, and Docker modes in terms of safety and cost.
- Added first-run Python detection for active virtual environments, Conda environments, and workspace `.venv`/`venv` folders before generic `python` fallback.
- Documented that existing-test review in VS Code uses local analysis and optional pytest execution with `0` LLM calls.

## 0.2.0

- Added Marketplace-ready README screenshots for the report panel, inline diagnostics, and native Testing panel integration.
- Added a VS Code Getting Started walkthrough with setup, review, and CI-gate steps.
- Added `Ghost Test Catcher: Open Setup Guide`.
- Added a one-time setup prompt for workspaces that contain Python tests, controlled by `ghostTestCatcher.setupNudgeEnabled`.
- Updated the extension package version and VSIX output filename to `0.2.0`.
- Added a reproducible `tools/generate_vscode_marketplace_assets.py` script for regenerating README screenshots.
- Kept CI integration stable across Windows, Ubuntu, and Intel macOS with the short VS Code test profile path and annotated integration failure logs.

## 0.1.0

- Added `Ghost Test Catcher: Analyze Current Test File`.
- Added `Ghost Test Catcher: Setup` for Python detection, CLI validation, install guidance, execution-mode setup, Docker verification, and Doctor launch.
- Added `@vscode/test-electron` integration smoke coverage for activation, Doctor, current-file analysis, diagnostics, report opening, and Testing panel refresh.
- Added `Ghost Test Catcher: Analyze Changed Test Files`.
- Added `Ghost Test Catcher: Analyze Selected Files or Folders` for Explorer and editor selections.
- Added `Ghost Test Catcher: Run Doctor` for project root, Python path, importability, and config diagnostics.
- Added native VS Code Testing panel discovery and an `Analyze with Ghost Test Catcher` test run profile.
- Added persistent workspace analysis caching with mtime/size invalidation and cache restore after reload.
- Added report filtering for verdict, framework, missing symbols, failed/risky tests, and evidence text.
- Added Quick Fix actions for opening evidence files, copying missing symbols, and rerunning static analysis.
- Added `Ghost Test Catcher: Add GitHub Actions Gate` to generate a CI workflow.
- Added optional Docker execution backend settings.
- Added public `ghost_test_catcher.cli` module support for product-facing CLI execution.
- Added cancellable analysis and Doctor progress with timeout-backed Python process termination.
- Added a `Ghost Test Catcher` output channel for CLI process starts, stderr, and failure details.
- Added limited VS Code Workspace Trust support that blocks test execution in untrusted workspaces, restricts executable settings, and offers static analysis instead.
- Added hardened report webviews with scripts disabled, no local resource roots, and a restrictive Content Security Policy.
- Added smart source context that resolves local imports from the selected test file before configured source folders.
- Added inline diagnostics on pytest-style functions and `unittest.TestCase` methods.
- Added CodeLens verdict summaries above analyzed tests.
- Added an HTML report panel with reliability, Effective Test Value, framework, run status, risk categories, recommendations, missing symbols, and evidence symbols.
- Added configuration for Python path, source paths, smart source context, execution confirmation, test mode, and max files.
- Added nested Python project root detection for workspaces opened above the actual package root.
- Added local packaging with `npm run package`.
