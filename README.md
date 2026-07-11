# Ghost Test Catcher

Ghost Test Catcher is a developer tool for reviewing AI-generated software tests before you trust, keep, or merge them.

Instead of only asking an LLM to create tests, this project checks whether those tests are actually supported by the uploaded source files, whether they run in an isolated Python test workspace, and whether they look worth keeping or like ghost tests.

## Why It Exists

AI-generated tests can look convincing while still being wrong. They may:

- reference symbols that do not exist,
- assume workflows the code does not implement,
- assert the wrong behavior,
- or pass while still being weakly grounded in the files they claim to test.

Ghost Test Catcher is built to answer:

- Are these generated tests grounded in the uploaded code?
- Which tests are reliable, salvageable, or risky?
- Which files influenced the output most?
- Did the model stay inside the codebase, or invent behavior?

## What The App Does

Given a small set of uploaded files, the app:

1. builds a test-generation prompt,
2. extracts a Python API map from the uploaded files,
3. asks the LLM to generate tests,
4. attributes which files influenced that output,
5. verifies grounding and overall context match,
6. runs the generated tests with the Python test runner,
7. returns a trust-oriented verdict.

The core idea is:

> Passing tests are not enough.  
> We also want to know whether those tests are actually supported by the code they claim to test.

## Why Developers Should Try It

Ghost Test Catcher is useful when a developer, team, or reviewer wants the speed of AI-generated tests without blindly trusting them.

It helps answer questions that normal pytest output does not answer:

- Did this test import real modules and real symbols?
- Is the assertion supported by the source files?
- Did the test pass for the right reason?
- Is this test safe to keep, fix, or delete?
- Can this test review run locally in VS Code before code reaches CI?

The default VS Code and CLI review workflow for existing tests uses local analysis and optional local pytest execution. It does not call an LLM, which means it adds **0 estimated LLM tokens** while reviewing tests that already exist in the repository. It also does not use a maintainer-funded backend, shared paid API key, telemetry service, or paid SaaS dependency. In VS Code, teams can copy a decision-first Markdown review summary after analysis and share the exact keep/review/risk counts, verdicts, evidence paths, symbol signals, execution status, true ETV, and cost/cache details in pull requests or team chat.

For repeatable product metrics, token estimates, and marketing-safe claims, see:

- [`docs/ghost-test-catcher-product-metrics.md`](docs/ghost-test-catcher-product-metrics.md)

## Core Concepts

### Reliability

A heuristic trust score built from:

- supported claim ratio,
- groundedness score,
- context relevance score,
- evidence weight coverage,
- execution score.

### Groundedness

Whether specific generated tests can be supported by the uploaded files.

### Context Match

Whether the generated output still looks broadly related to the uploaded codebase as a whole.

### ETV

`ETV` means **Effective Test Value**.

Current definition:

```text
ETV = (keepers + 0.5 * salvageable) / total_tests
```

Where:

- `keepers` are grounded and passing tests,
- `salvageable` are partially useful tests,
- `risky` are weak or ghost-risk tests.

## Product Flow

### Input

The user provides:

- an OpenAI API key,
- a test mode: `unit`, `integration`, `e2e`, or `mixed`,
- a model,
- a set of uploaded files,
- optionally a demo scenario.

### Generation

The backend:

- normalizes uploaded files,
- builds an API map from Python modules, classes, functions, and constants,
- creates a prompt from the uploaded code and selected test mode,
- sends that prompt through the OpenAI interface.

### Verification

After generation, the app:

- parses the generated tests with `ast`,
- checks symbol and import coverage,
- finds supporting snippets in the uploaded files,
- labels tests as `supported`, `borderline`, or `unsupported`.

### Test Execution

The app writes the uploaded files and generated tests into a temporary workspace and runs the pytest runner:

```bash
pytest -vv -rA
```

Pytest is used as the execution engine because it can collect both pytest-style `def test_*` functions and `unittest.TestCase` methods. That gives the product one isolated execution path while supporting both common Python test styles.

For stricter local isolation, existing-test analysis also supports a Docker execution backend. Build the included pytest runner image first:

```bash
docker build -t ghost-test-catcher-runner:latest docker/ghost-test-catcher-runner

ghost-test-catcher analyze \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --execution-backend docker \
  --docker-image ghost-test-catcher-runner:latest \
  --format pretty
```

The Docker image must include Python and pytest. The included runner image does exactly that. The container runner mounts the temporary test workspace and disables network access.

This produces:

- per-test execution status,
- pass/fail/error counts,
- a primary runtime failure when one exists.

### Trust Output

The UI shows:

- outcome verdict,
- reliability score,
- ETV,
- execution result,
- per-test groundedness and execution,
- Python test failures,
- grounding warnings,
- weighted file influence,
- evidence snippets.

## Architecture

### Frontend

`src/llmSHAP/webapp/static/app.js`

React-based browser UI for:

- file upload,
- demo scenarios,
- loading/progress state,
- verdict rendering,
- per-test cards,
- expandable evidence sections.

### Backend API

`src/llmSHAP/webapp/app.py`

FastAPI server exposing:

- `GET /`
- `GET /api/health`
- `GET /api/demo-presets`
- `GET /api/demo-preset/{preset_id}`
- `POST /api/analyze`

### Analysis Pipeline

`src/llmSHAP/webapp/analysis.py`

Handles:

- file preparation,
- prompt construction,
- API map creation,
- attribution,
- trust scoring,
- preflight checks,
- output assembly.

### Test Parsing

`src/llmSHAP/webapp/test_artifacts.py`

Extracts generated Python tests and parses:

- test names,
- pytest-style functions and `unittest.TestCase` methods,
- imports,
- referenced symbols,
- assertion count,
- assertion style and detected framework.

### Grounding Verification

`src/llmSHAP/webapp/verification.py`

Computes:

- groundedness score,
- context relevance score,
- supported/borderline/unsupported labels,
- supporting snippets and evidence files,
- risk categories and per-test recommendations.

### Python Test Execution

`src/llmSHAP/webapp/execution.py`

Runs generated or selected Python tests against uploaded files and returns:

- per-test status,
- pass/fail/error counts,
- primary failure message,
- raw test runner summary.

## Demo Scenarios

The app includes built-in demo scenarios.

### Grounded Checkout Demo

A connected checkout-style sample intended to produce more grounded tests.

### Ghost-Risk Alert Demo

A smaller alerting sample with a stress prompt intended to make unsupported product-level tests more likely.

## Sample Projects

### `demo/allofem`

Three connected Python files for a checkout and order flow.

### `demo/integration_lab`

Four connected Python files designed for integration testing:

- `CustomerRecords.py`
- `CatalogPricing.py`
- `InvoiceLedger.py`
- `BillingWorkflow.py`

### `demo/ghost_risk_sample`

A small alerting sample used to provoke ghost-risk behavior.

## Quick Start

Use Python 3.11+.

### Install

```bash
make install
```

### Run the web app

```bash
make web
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

### Run with Docker

```bash
make docker-build
make docker-run
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

### Analyze existing tests from the CLI

Ghost Test Catcher can also work as a developer tool without generating new tests.
This is the mode used by the VS Code extension. Existing-test analysis supports pytest-style functions and `unittest.TestCase` classes.

```bash
python -m ghost_test_catcher.cli analyze \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --format pretty
```

For machine-readable output:

```bash
python -m ghost_test_catcher.cli analyze \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --format json
```

The installed command is also available after package installation:

```bash
ghost-test-catcher analyze --repo . --tests tests/test_webapp_execution.py --source src
```

Existing-test analysis is the recommended low-cost workflow: it uses local parsing, source evidence checks, similarity scoring, and optional pytest execution with `0` LLM calls.

Optional LLM-backed generation is available when you explicitly want Ghost Test Catcher to generate tests before checking them:

```bash
ghost-test-catcher generate-and-check \
  --repo . \
  --source src \
  --test-mode mixed \
  --max-output-tokens 700
```

Use `--max-output-tokens` to cap the requested output tokens per model call. The default is `700`, which keeps optional generation cheaper while still leaving enough room for a small pytest pack.

Run the built-in calibration suite to confirm the checker still separates grounded tests from ghost-risk tests:

```bash
ghost-test-catcher calibrate --format pretty
```

### Run the CI gate

The CI command is intended for pull requests, release checks, and generated-test review gates.
It writes a JSON report, optionally writes a Markdown summary, and exits non-zero when the selected failure policy is violated.

```bash
ghost-test-catcher ci \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --no-execution \
  --summary ghost-test-catcher-summary.md \
  --output ghost-test-catcher-report.json \
  --format json \
  --fail-on ghost_risk
```

Failure policies:

- `ghost_risk`: fail only when the result is high-risk.
- `needs_review`: fail unless the result is fully reliable.
- `never`: always exit 0 while still producing reports.

### VS Code extension

The editor extension lives in:

`packages/vscode-extension`

It provides:

- `Ghost Test Catcher: Setup`
- `Ghost Test Catcher: Analyze Current Test File`
- `Ghost Test Catcher: Analyze Changed Test Files`
- `Ghost Test Catcher: Analyze Selected Files or Folders`
- `Ghost Test Catcher: Run Doctor`
- inline diagnostics on `def test_*` functions and class-based test methods
- CodeLens verdict summaries
- native VS Code Testing panel discovery for pytest-style functions and `unittest.TestCase` methods
- an `Analyze with Ghost Test Catcher` Testing panel run profile
- a filterable report panel with reliability, ETV, framework, test-run status, risk categories, recommendations, evidence, and missing symbols
- persistent workspace report caching that restores diagnostics and CodeLens after reloads
- Quick Fix actions to open evidence files, copy missing symbols, and rerun static analysis
- a GitHub Actions gate generator for `ghost-test-catcher ci`
- optional Docker-backed execution from the extension
- smart source context that resolves local imports from the active test before broader configured source folders
- nested Python project detection when VS Code is opened at a parent folder
- a Doctor report for Python path, module importability, CLI config, discovered source paths, and discovered test paths
- cancellable analysis and Doctor runs with timeout-backed Python process termination
- a `Ghost Test Catcher` output channel for CLI stderr and failure details
- limited VS Code Workspace Trust support that offers static analysis instead of test execution in untrusted workspaces

Run `Ghost Test Catcher: Setup` first in a new workspace. Setup detects the configured Python executable, validates `ghost_test_catcher.cli` from the bundled analyzer or configured environment, offers a GitHub-based install path if the CLI is still missing, writes workspace settings for local/static/Docker execution, verifies Docker when selected, and opens Doctor.

For local development, open `packages/vscode-extension` in VS Code and run the extension host.
The extension shells out to:

```bash
python -m ghost_test_catcher.cli analyze
```

The packaged VS Code extension includes the analyzer sources needed for `ghost_test_catcher.cli`, so normal VS Code review does not require the Python package to be published on PyPI or preinstalled. Install `pytest` in the configured Python environment when you want selected tests to execute instead of static-only review:

```bash
python -m pip install pytest
```

For standalone CLI usage or generated CI workflows, install from the public GitHub repository pinned to the `v0.2.8` release tag until PyPI publishing is completed:

```bash
python -m pip install "ghost-test-catcher[ghost] @ git+https://github.com/CarlSvaerd/HackathonWasp.git@v0.2.8"
```

When developing this repository, use an editable install instead:

```bash
pip install -e ".[ghost]"
```

The extension always prepends its packaged analyzer source path to `PYTHONPATH`. When running from a trusted workspace, it also prepends `<workspace>/src` and the workspace root so local project imports resolve.

When execution is enabled, the Python test runner runs against a temporary copy of the selected tests and source files.
The extension asks for confirmation before executing tests by default.
If VS Code marks the workspace as untrusted, the extension will not execute tests while `ghostTestCatcher.requireWorkspaceTrustForExecution` is enabled. It offers to run static grounding analysis instead.
The extension also treats `ghostTestCatcher.pythonPath`, `ghostTestCatcher.executionBackend`, and `ghostTestCatcher.dockerImage` as restricted settings in untrusted workspaces because they control executable behavior.
In untrusted workspaces, the extension permits its own packaged analyzer source path but does not prepend the workspace root or `src` directory to `PYTHONPATH`.
The Testing panel uses the same execution and trust rules as the command palette commands.
The extension caches valid reports using source/test file fingerprints and invalidates that cache when relevant Python files change.

Package the extension locally with:

```bash
python tools/repo_hygiene_audit.py
python -m pytest
cd packages/vscode-extension
npm install --ignore-scripts
npm run check
npm run test:unit
npm run test:integration
npm run package
```

`npm run check` runs JavaScript syntax checks, the checked-JavaScript TypeScript/JSDoc gate, and the VS Code extension static audit. The audit guards command activation parity, Workspace Trust restrictions, webview/process safety, module size budgets, focused module test coverage, package hygiene, checked-JS coverage, and VSIX version references.

`npm run test:integration` launches VS Code with `@vscode/test-electron`, opens the fixture Python workspace, activates the extension, runs Doctor, analyzes the active test file, checks Ghost Test Catcher diagnostics, and refreshes the Testing panel. Set `GHOST_TEST_CATCHER_TEST_PYTHON` if your desired Python executable is not named `python`.

That produces `ghost-test-catcher-0.2.8.vsix`, installable through `Extensions: Install from VSIX...`.

The extension package includes Marketplace metadata, a PNG icon, a changelog, and a `.vscodeignore` that excludes local build artifacts.
The icon is reproducible:

```bash
python tools/generate_vscode_extension_icon.py
```

## Development

### Install dev dependencies

```bash
make install-dev
```

### Run tests

```bash
.venv/bin/python -m pytest
```

### Clean local artifacts

```bash
make clean
```

## Optional Codebase Q&A CLI

This repo also includes a lightweight CLI for codebase attribution:

`tools/codebase_rag_explain.py`

Example:

```bash
python tools/codebase_rag_explain.py \
  --repo . \
  --question "Where is the OpenAI model interface implemented?" \
  --top-k 6
```

## Attribution Engine

This project uses the underlying attribution framework in the codebase as an internal explainability engine for:

- attributing which uploaded files influenced the generated output,
- exposing weighted file impact,
- supporting the trust and evidence analysis.

The product focus of this repo is now Ghost Test Catcher itself:

> a trust and verification workflow for AI-generated software tests.

## Language Adapter Boundary

The analyzer is Python-first, but the ghost package now exposes a language adapter boundary through `llmSHAP.ghost.adapters`. The active `PythonAdapter` owns Python source/test path detection and supported execution backend names. Future JavaScript or TypeScript support should add a new adapter with parser, test discovery, runner, grounding extractor, and execution result normalization behind the same interface.

## Product Status

Ghost Test Catcher is an active developer-tool product with a working CLI, web app, CI mode, and VS Code extension.

The default trust thresholds are conservative heuristic defaults. For strict organizational policy, calibrate them with representative labeled tests before using them as a hard compliance gate.

The product is designed for:

- local review of AI-generated or suspicious tests,
- CI gates for generated-test pull requests,
- VS Code diagnostics and Testing panel workflows,
- audit trails for AI-assisted development,
- team policies around verification before trust.
