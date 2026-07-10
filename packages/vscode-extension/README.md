# Ghost Test Catcher for VS Code

[![Unit Tests](https://github.com/CarlSvaerd/HackathonWasp/actions/workflows/test.yml/badge.svg)](https://github.com/CarlSvaerd/HackathonWasp/actions/workflows/test.yml)

Ghost Test Catcher helps you decide whether Python tests, especially AI-generated tests, are grounded in the source code they claim to verify.

It runs inside VS Code as a review tool for generated or suspicious tests: pick a test file, run analysis, and get per-test diagnostics, source evidence, missing symbols, execution status, and a verdict you can use before keeping, merging, or trusting the tests.

## Why Install It

- Catch tests that reference APIs, workflows, or product behavior that do not exist.
- Separate grounded tests from borderline tests and high-risk ghost tests.
- Review evidence directly in VS Code instead of reading raw JSON.
- Use the Testing panel, diagnostics, CodeLens, Quick Fixes, reports, and CI gates together.
- Keep execution cautious with confirmation prompts, Workspace Trust handling, static-only mode, and optional Docker isolation.

## Screenshots

### Filterable Report Panel

![Ghost Test Catcher report panel](media/screenshot-report.png)

### Inline Diagnostics And Quick Fixes

![Ghost Test Catcher diagnostics](media/screenshot-diagnostics.png)

### Native Testing Panel Integration

![Ghost Test Catcher Testing panel](media/screenshot-testing.png)

## Quick Start

1. Install the Python package in the Python environment used by your workspace.

   ```bash
   pip install "ghost-test-catcher[ghost]"
   ```

2. Open a Python project in VS Code.
3. Run `Ghost Test Catcher: Setup`.
4. Choose local execution, static-only review, or Docker isolation.
5. Open a Python test file and run `Ghost Test Catcher: Analyze Current Test File`.
6. Review diagnostics, CodeLens verdicts, the report panel, and Testing panel results.

The extension also contributes a VS Code walkthrough and shows a one-time setup prompt in workspaces that contain Python tests.

## Core Features

- **Guided setup:** detects Python, validates `ghost_test_catcher.cli`, writes workspace settings, and opens Doctor.
- **Current-file review:** analyze the active Python test file from the command palette, editor title, or context menu.
- **Changed-test review:** analyze changed Python test files in the current Git workspace.
- **Selection review:** analyze selected test files or folders with explicitly selected source context.
- **Smart source context:** automatically includes local source files imported by the selected test file before broader configured folders.
- **Inline diagnostics:** marks pytest-style functions and `unittest.TestCase` methods with groundedness and execution findings.
- **CodeLens summaries:** shows verdict, run status, and confidence above analyzed tests.
- **Filterable report panel:** review reliability, ETV, framework, run status, risk categories, recommendations, source evidence, and missing symbols.
- **Copyable report summaries:** copy a decision-first Markdown summary for pull requests, issues, code reviews, or team chat.
- **Native Testing panel:** discovers Python tests and runs `Analyze with Ghost Test Catcher` as a VS Code test profile.
- **Configurable cache persistence:** restores valid diagnostics, CodeLens, and reports after reloads by default, with an in-memory-only privacy mode for sensitive workspaces.
- **Visible cost and cache signals:** reports and completion messages show LLM call estimates, token estimates, and whether results came from cache.
- **Quick Fix actions:** open evidence files, copy missing symbols, and rerun static-only analysis.
- **CI generator:** writes a ready-to-use GitHub Actions gate with `Ghost Test Catcher: Add GitHub Actions Gate`.
- **Docker backend:** optionally execute tests through a configured Docker image with network disabled.
- **Nested project detection:** finds Python project roots even when VS Code is opened at a parent folder.
- **Doctor report:** checks project root detection, Python importability, CLI config, discovered sources, and discovered tests.
- **Cancellable execution:** analysis and Doctor runs use VS Code progress cancellation plus process timeouts.
- **Output channel:** records CLI starts, stderr, and failure details in `Ghost Test Catcher`.
- **Workspace Trust support:** falls back to static analysis in untrusted workspaces unless execution trust enforcement is disabled.

## Requirements

The workspace must contain this Python package or have it installed in the configured Python environment:

```bash
pip install "ghost-test-catcher[ghost]"
```

During local development from this repository, use an editable install:

```bash
pip install -e ".[ghost]"
```

The extension automatically prepends `<workspace>/src` to `PYTHONPATH` in trusted workspaces, so an editable install is helpful but not required for module discovery while developing this repository.

For normal users, start with `Ghost Test Catcher: Setup`. Setup checks the configured Python executable, writes safe workspace settings, verifies `ghost_test_catcher.cli`, and offers to install the CLI when it is missing. In a local checkout of this repository, setup uses an editable install. In a regular project, setup copies or runs the package install command for the configured Python environment.

## Commands

- `Ghost Test Catcher: Setup`
- `Ghost Test Catcher: Analyze Current Test File`
- `Ghost Test Catcher: Analyze Changed Test Files`
- `Ghost Test Catcher: Analyze Selected Files or Folders`
- `Ghost Test Catcher: Open Setup Guide`
- `Ghost Test Catcher: Run Doctor`
- `Ghost Test Catcher: Open Last Report`
- `Ghost Test Catcher: Refresh Testing Panel`
- `Ghost Test Catcher: Clear Analysis Cache`
- `Ghost Test Catcher: Copy Report Summary`
- `Ghost Test Catcher: Add GitHub Actions Gate`

## Settings

- `ghostTestCatcher.pythonPath`: Python executable. Defaults to `python`.
- `ghostTestCatcher.setupNudgeEnabled`: show a one-time setup prompt in workspaces that contain Python tests. Defaults to `true`.
- `ghostTestCatcher.sourcePaths`: source/context paths. Defaults to `["src"]`.
- `ghostTestCatcher.smartSourceContext`: include local imports from the selected test file before configured source paths. Defaults to `true`.
- `ghostTestCatcher.executeTests`: run selected Python tests in a temporary workspace. Defaults to `true`.
- `ghostTestCatcher.requireWorkspaceTrustForExecution`: require a trusted VS Code workspace before executing selected Python tests. Defaults to `true`.
- `ghostTestCatcher.confirmExecution`: ask before executing tests. Defaults to `true`.
- `ghostTestCatcher.executionBackend`: `local` or `docker`. Defaults to `local`.
- `ghostTestCatcher.dockerImage`: Docker image used when Docker execution is enabled. The image must include Python and pytest. Defaults to `ghost-test-catcher-runner:latest`.
- `ghostTestCatcher.testMode`: one of `unit`, `integration`, `e2e`, or `mixed`.
- `ghostTestCatcher.maxFiles`: maximum source/context files read.
- `ghostTestCatcher.analysisCacheEnabled`: enable report caching when file fingerprints are valid. Defaults to `true`.
- `ghostTestCatcher.persistAnalysisCache`: persist cached report content in VS Code workspace state across reloads. Defaults to `true`; set to `false` to keep cache entries in memory only for the current VS Code session.
- `ghostTestCatcher.cacheFingerprintLimit`: maximum Python files fingerprinted per cached report. Defaults to `300`.
- `ghostTestCatcher.testDiscoveryLimit`: maximum Python files scanned when populating the VS Code Testing panel. Defaults to `500`.
- `ghostTestCatcher.ciFailOn`: generated GitHub Actions failure policy. Defaults to `ghost_risk`.
- `ghostTestCatcher.ciPythonVersion`: generated GitHub Actions Python version. Defaults to `3.11`.
- `ghostTestCatcher.ciTestPaths`: generated GitHub Actions test paths. Defaults to `["tests"]`.

## Testing Panel

Open VS Code's Testing view to see Python test files discovered by Ghost Test Catcher. The extension adds one file-level item per test file and one child item per detected `def test_*`, async test function, or direct `unittest.TestCase` method. If a large workspace reaches `ghostTestCatcher.testDiscoveryLimit`, the extension shows a warning with actions to open the setting or increase the workspace limit.

Use the `Analyze with Ghost Test Catcher` run profile from the Testing panel to run grounding analysis through the same CLI path used by the command palette. Grounded and executed tests are marked as passed, unsupported or borderline tests are marked as failed with a detailed message, and grounded tests with execution disabled are marked as skipped. The run also refreshes diagnostics, CodeLens results, and the last report.

## Review Workflow

Run `Ghost Test Catcher: Setup` first in a new workspace. Choose the recommended local mode for normal development, static-only mode when reviewing untrusted generated tests, or Docker mode when the team wants execution isolation. Setup checks an explicitly configured Python first, then active `VIRTUAL_ENV` or `CONDA_PREFIX`, then workspace `.venv`, `venv`, `.env`, and `env` folders before falling back to `python` and `python3`. Setup updates `ghostTestCatcher.pythonPath`, `ghostTestCatcher.executeTests`, `ghostTestCatcher.executionBackend`, and `ghostTestCatcher.confirmExecution` at workspace scope, then opens Doctor so the result is visible.

Analysis results are cached per workspace using the project root, test path, source context, settings, and file fingerprints. Valid cached reports are restored after a VS Code reload and are reused by command-palette and Testing panel runs. When a relevant Python file changes, stale diagnostics and cache entries are invalidated. Teams that do not want report content persisted in VS Code workspace state can set `ghostTestCatcher.persistAnalysisCache` to `false`; the extension will still reuse valid results during the current session but clears persisted cache storage.

The normal VS Code review path analyzes existing tests with local parsing, source evidence checks, similarity scoring, and optional pytest execution. It does not call an LLM. The report panel displays this as `0 LLM calls` and marks whether each result was fresh or served from cache.

Diagnostics expose Quick Fixes for common review actions: open the best evidence file at the reported line, copy missing symbols to the clipboard, or rerun the selected file with static analysis only. The report panel includes client-side filters and expandable evidence details for larger review sessions. Use `Ghost Test Catcher: Copy Report Summary` after analysis to copy a Markdown summary with decision counts, verdict counts, cost/cache details, per-file results, true ETV, per-test grounding, execution status, symbol signals, evidence locations, and action guidance.

Use `Ghost Test Catcher: Add GitHub Actions Gate` to write `.github/workflows/ghost-test-catcher.yml` for pull-request and main-branch checks. The generated workflow installs the package, runs `ghost-test-catcher ci`, publishes a Markdown summary, and uploads JSON/Markdown artifacts.

## Security Model

When execution is enabled, the extension asks the CLI to copy selected tests and source files into a temporary directory and run the pytest runner there with plugin autoloading disabled. Pytest is used as the runner because it collects both pytest-style functions and `unittest.TestCase` methods. This is safer than running in-place, but it still executes Python test code.

The extension declares limited untrusted-workspace support. In an untrusted VS Code workspace, executable settings are restricted: `ghostTestCatcher.executeTests`, `ghostTestCatcher.pythonPath`, `ghostTestCatcher.executionBackend`, and `ghostTestCatcher.dockerImage`. When `ghostTestCatcher.requireWorkspaceTrustForExecution` is enabled, analysis offers static mode and will not execute selected tests. The extension also avoids prepending workspace paths to `PYTHONPATH` in untrusted workspaces, so the CLI must come from the configured Python environment rather than from code inside the untrusted folder.

Doctor webviews disable scripts, report webviews use a nonce-scoped filtering script, all webviews deny local resource roots, and every webview includes a restrictive Content Security Policy. CLI processes have timeouts and are terminated when the user cancels the VS Code progress notification.

When `ghostTestCatcher.executionBackend` is set to `docker`, the Python CLI runs the temporary test workspace through `docker run --rm --network none`. The configured image must already include Python and pytest. This repository includes `docker/ghost-test-catcher-runner/Dockerfile` for building the default `ghost-test-catcher-runner:latest` image. Local execution remains the default.

```bash
docker build -t ghost-test-catcher-runner:latest docker/ghost-test-catcher-runner
```

## Local Checks

```bash
npm install --ignore-scripts
npm run check
npm run test:unit
npm run test:integration
npm run package
```

`npm run check` runs JavaScript syntax checks plus the static extension audit for command activation parity, Workspace Trust restrictions, webview/process safety, module size budgets, module test coverage, and VSIX version references.

`npm run test:integration` uses `@vscode/test-electron` to download or reuse VS Code, open the fixture workspace in an Extension Development Host, run Doctor, analyze a Python test file, verify diagnostics, and refresh the Testing panel. Set `GHOST_TEST_CATCHER_TEST_PYTHON` when the desired Python executable is not simply `python`.

The package command creates `ghost-test-catcher-0.2.7.vsix`, which can be installed in VS Code with `Extensions: Install from VSIX...`.
