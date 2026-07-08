# Ghost Test Catcher for VS Code

Ghost Test Catcher checks whether Python test files are grounded in the source code they claim to test. It is designed for reviewing AI-generated tests before you keep, merge, or trust them.

## Features

- Analyze the current Python test file from the command palette or editor title.
- Analyze changed Python test files in the current Git workspace.
- Analyze selected files or folders from Explorer, including a test file plus specific source files as explicit context.
- Automatically include local source files imported by the selected test file before broader configured source folders.
- Run the Python Ghost Test Catcher CLI with JSON output.
- Show per-test diagnostics directly on `def test_*` functions and `unittest.TestCase` methods.
- Add CodeLens summaries above analyzed tests.
- Open a report panel with reliability, ETV, framework, run status, risk categories, recommendations, evidence, and missing symbols.
- Filter the report by verdict, framework, missing symbols, failed/risky tests, and evidence text.
- Expand evidence details directly in the report table.
- Populate VS Code's native Testing panel with discovered pytest-style functions and `unittest.TestCase` methods.
- Run `Analyze with Ghost Test Catcher` directly from the Testing panel and show native pass/fail/skipped results for each test.
- Restore valid previous reports from a workspace cache so diagnostics and CodeLens survive reloads.
- Offer Quick Fixes to open evidence files, copy missing symbols, and rerun static-only analysis.
- Generate a ready-to-use GitHub Actions gate with `Ghost Test Catcher: Add GitHub Actions Gate`.
- Optionally execute tests through a Docker backend for teams that want container isolation.
- Detect nested Python project roots when VS Code is opened at a parent folder.
- Run a setup Doctor report that checks project root detection, Python importability, CLI config, discovered sources, and discovered tests.
- Cancel long-running analysis and Doctor runs from the VS Code progress notification.
- Write CLI stderr, process starts, and failure details to the `Ghost Test Catcher` output channel.
- Respect VS Code Workspace Trust by falling back to static analysis in untrusted workspaces unless execution trust enforcement is disabled.

## Requirements

The workspace must contain this Python package or have it installed in the configured Python environment:

```bash
pip install -e ".[ghost]"
```

During local development from this repository, the extension automatically prepends `<workspace>/src` to `PYTHONPATH`, so an editable install is helpful but not required for module discovery.

## Commands

- `Ghost Test Catcher: Analyze Current Test File`
- `Ghost Test Catcher: Analyze Changed Test Files`
- `Ghost Test Catcher: Analyze Selected Files or Folders`
- `Ghost Test Catcher: Run Doctor`
- `Ghost Test Catcher: Open Last Report`
- `Ghost Test Catcher: Refresh Testing Panel`
- `Ghost Test Catcher: Clear Analysis Cache`
- `Ghost Test Catcher: Add GitHub Actions Gate`

## Settings

- `ghostTestCatcher.pythonPath`: Python executable. Defaults to `python`.
- `ghostTestCatcher.sourcePaths`: source/context paths. Defaults to `["src"]`.
- `ghostTestCatcher.smartSourceContext`: include local imports from the selected test file before configured source paths. Defaults to `true`.
- `ghostTestCatcher.executeTests`: run selected Python tests in a temporary workspace. Defaults to `true`.
- `ghostTestCatcher.requireWorkspaceTrustForExecution`: require a trusted VS Code workspace before executing selected Python tests. Defaults to `true`.
- `ghostTestCatcher.confirmExecution`: ask before executing tests. Defaults to `true`.
- `ghostTestCatcher.executionBackend`: `local` or `docker`. Defaults to `local`.
- `ghostTestCatcher.dockerImage`: Docker image used when Docker execution is enabled. The image must include Python and pytest. Defaults to `ghost-test-catcher-runner:latest`.
- `ghostTestCatcher.testMode`: one of `unit`, `integration`, `e2e`, or `mixed`.
- `ghostTestCatcher.maxFiles`: maximum source/context files read.
- `ghostTestCatcher.analysisCacheEnabled`: cache valid reports in VS Code workspace state. Defaults to `true`.
- `ghostTestCatcher.cacheFingerprintLimit`: maximum Python files fingerprinted per cached report. Defaults to `300`.
- `ghostTestCatcher.testDiscoveryLimit`: maximum Python files scanned when populating the VS Code Testing panel. Defaults to `500`.
- `ghostTestCatcher.ciFailOn`: generated GitHub Actions failure policy. Defaults to `ghost_risk`.
- `ghostTestCatcher.ciPythonVersion`: generated GitHub Actions Python version. Defaults to `3.11`.
- `ghostTestCatcher.ciTestPaths`: generated GitHub Actions test paths. Defaults to `["tests"]`.

## Testing Panel

Open VS Code's Testing view to see Python test files discovered by Ghost Test Catcher. The extension adds one file-level item per test file and one child item per detected `def test_*`, async test function, or direct `unittest.TestCase` method.

Use the `Analyze with Ghost Test Catcher` run profile from the Testing panel to run grounding analysis through the same CLI path used by the command palette. Grounded and executed tests are marked as passed, unsupported or borderline tests are marked as failed with a detailed message, and grounded tests with execution disabled are marked as skipped. The run also refreshes diagnostics, CodeLens results, and the last report.

## Review Workflow

Analysis results are cached per workspace using the project root, test path, source context, settings, and file fingerprints. Valid cached reports are restored after a VS Code reload and are reused by command-palette and Testing panel runs. When a relevant Python file changes, stale diagnostics and cache entries are invalidated.

Diagnostics expose Quick Fixes for common review actions: open the best evidence file at the reported line, copy missing symbols to the clipboard, or rerun the selected file with static analysis only. The report panel includes client-side filters and expandable evidence details for larger review sessions.

Use `Ghost Test Catcher: Add GitHub Actions Gate` to write `.github/workflows/ghost-test-catcher.yml` for pull-request and main-branch checks. The generated workflow installs the package, runs `ghost-test-catcher ci`, publishes a Markdown summary, and uploads JSON/Markdown artifacts.

## Security Model

When execution is enabled, the extension asks the CLI to copy selected tests and source files into a temporary directory and run the pytest runner there with plugin autoloading disabled. Pytest is used as the runner because it collects both pytest-style functions and `unittest.TestCase` methods. This is safer than running in-place, but it still executes Python test code.

The extension declares limited untrusted-workspace support. In an untrusted VS Code workspace, `ghostTestCatcher.executeTests` is treated as restricted when `ghostTestCatcher.requireWorkspaceTrustForExecution` is enabled. If you start analysis there, Ghost Test Catcher offers to run static analysis only and will not execute the selected tests.

Doctor webviews disable scripts, report webviews use a nonce-scoped filtering script, all webviews deny local resource roots, and every webview includes a restrictive Content Security Policy. CLI processes have timeouts and are terminated when the user cancels the VS Code progress notification.

When `ghostTestCatcher.executionBackend` is set to `docker`, the Python CLI runs the temporary test workspace through `docker run --rm --network none`. The configured image must already include Python and pytest. This repository includes `docker/ghost-test-catcher-runner/Dockerfile` for building the default `ghost-test-catcher-runner:latest` image. Local execution remains the default.

```bash
docker build -t ghost-test-catcher-runner:latest docker/ghost-test-catcher-runner
```

## Local Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run package
```

The package command creates `ghost-test-catcher-0.1.0.vsix`, which can be installed in VS Code with `Extensions: Install from VSIX...`.
