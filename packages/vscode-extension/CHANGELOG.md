# Changelog

## 0.1.0

- Added `Ghost Test Catcher: Analyze Current Test File`.
- Added `Ghost Test Catcher: Setup` for Python detection, CLI validation, install guidance, execution-mode setup, Docker verification, and Doctor launch.
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
