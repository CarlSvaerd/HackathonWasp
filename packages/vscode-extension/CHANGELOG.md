# Changelog

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
