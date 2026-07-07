# Ghost Test Catcher for VS Code

Ghost Test Catcher checks whether pytest files are grounded in the source code they claim to test. It is designed for reviewing AI-generated tests before you keep, merge, or trust them.

## Features

- Analyze the current pytest file from the command palette or editor title.
- Analyze changed pytest files in the current Git workspace.
- Run the Python Ghost Test Catcher CLI with JSON output.
- Show per-test diagnostics directly on `def test_*` functions.
- Add CodeLens summaries above analyzed tests.
- Open a report panel with reliability, ETV, pytest status, evidence, and missing symbols.

## Requirements

The workspace must contain this Python package or have it installed in the configured Python environment:

```bash
pip install -e ".[ghost]"
```

During local development from this repository, the extension automatically prepends `<workspace>/src` to `PYTHONPATH`, so an editable install is helpful but not required for module discovery.

## Commands

- `Ghost Test Catcher: Analyze Current Test File`
- `Ghost Test Catcher: Analyze Changed Test Files`
- `Ghost Test Catcher: Open Last Report`

## Settings

- `ghostTestCatcher.pythonPath`: Python executable. Defaults to `python`.
- `ghostTestCatcher.sourcePaths`: source/context paths. Defaults to `["src"]`.
- `ghostTestCatcher.executeTests`: run pytest in a temporary workspace. Defaults to `true`.
- `ghostTestCatcher.confirmExecution`: ask before executing tests. Defaults to `true`.
- `ghostTestCatcher.testMode`: one of `unit`, `integration`, `e2e`, or `mixed`.
- `ghostTestCatcher.maxFiles`: maximum source/context files read.

## Security Model

When execution is enabled, the extension asks the CLI to copy selected tests and source files into a temporary directory and run pytest there with plugin autoloading disabled. This is safer than running in-place, but it still executes Python test code. Keep confirmation enabled for untrusted files.

## Local Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run package
```

The package command creates `ghost-test-catcher-0.1.0.vsix`, which can be installed in VS Code with `Extensions: Install from VSIX...`.
