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

## Settings

- `ghostTestCatcher.pythonPath`: Python executable. Defaults to `python`.
- `ghostTestCatcher.sourcePaths`: source/context paths. Defaults to `["src"]`.
- `ghostTestCatcher.smartSourceContext`: include local imports from the selected test file before configured source paths. Defaults to `true`.
- `ghostTestCatcher.executeTests`: run selected Python tests in a temporary workspace. Defaults to `true`.
- `ghostTestCatcher.requireWorkspaceTrustForExecution`: require a trusted VS Code workspace before executing selected Python tests. Defaults to `true`.
- `ghostTestCatcher.confirmExecution`: ask before executing tests. Defaults to `true`.
- `ghostTestCatcher.testMode`: one of `unit`, `integration`, `e2e`, or `mixed`.
- `ghostTestCatcher.maxFiles`: maximum source/context files read.

## Security Model

When execution is enabled, the extension asks the CLI to copy selected tests and source files into a temporary directory and run the pytest runner there with plugin autoloading disabled. Pytest is used as the runner because it collects both pytest-style functions and `unittest.TestCase` methods. This is safer than running in-place, but it still executes Python test code.

The extension declares limited untrusted-workspace support. In an untrusted VS Code workspace, `ghostTestCatcher.executeTests` is treated as restricted when `ghostTestCatcher.requireWorkspaceTrustForExecution` is enabled. If you start analysis there, Ghost Test Catcher offers to run static analysis only and will not execute the selected tests.

Report webviews disable scripts, deny local resource roots, and include a restrictive Content Security Policy. CLI processes have timeouts and are terminated when the user cancels the VS Code progress notification.

## Local Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run package
```

The package command creates `ghost-test-catcher-0.1.0.vsix`, which can be installed in VS Code with `Extensions: Install from VSIX...`.
