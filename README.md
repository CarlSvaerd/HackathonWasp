# Ghost Test Catcher

Ghost Test Catcher is a proof-of-concept trust checker for AI-generated software tests.

Instead of only asking an LLM to create tests, this project checks whether those tests are actually supported by the uploaded source files, whether they run in `pytest`, and whether they look worth keeping or like ghost tests.

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
6. runs the generated tests in `pytest`,
7. returns a trust-oriented verdict.

The core idea is:

> Passing tests are not enough.  
> We also want to know whether those tests are actually supported by the code they claim to test.

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

### Execution

The app writes the uploaded files and generated tests into a temporary workspace and runs:

```bash
pytest -vv -rA
```

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
- pytest failures,
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
- imports,
- referenced symbols,
- assertion count.

### Grounding Verification

`src/llmSHAP/webapp/verification.py`

Computes:

- groundedness score,
- context relevance score,
- supported/borderline/unsupported labels,
- supporting snippets and evidence files.

### Pytest Execution

`src/llmSHAP/webapp/execution.py`

Runs generated tests against uploaded files and returns:

- per-test status,
- pass/fail/error counts,
- primary failure message,
- raw pytest summary.

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
This is the mode used by the VS Code extension.

```bash
python -m llmSHAP.ghost.cli analyze \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --format pretty
```

For machine-readable output:

```bash
python -m llmSHAP.ghost.cli analyze \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --format json
```

The installed command is also available after package installation:

```bash
ghost-test-catcher analyze --repo . --tests tests/test_webapp_execution.py --source src
```

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

- `Ghost Test Catcher: Analyze Current Test File`
- `Ghost Test Catcher: Analyze Changed Test Files`
- inline diagnostics on `def test_*` functions
- CodeLens verdict summaries
- a report panel with reliability, ETV, pytest status, evidence, and missing symbols

For local development, open `packages/vscode-extension` in VS Code and run the extension host.
The extension shells out to:

```bash
python -m llmSHAP.ghost.cli analyze
```

When running from this repository, the extension prepends `<workspace>/src` to `PYTHONPATH`.
In another project, install the package into the configured Python environment:

```bash
pip install -e ".[ghost]"
```

When execution is enabled, pytest runs against a temporary copy of the selected tests and source files.
The extension asks for confirmation before executing tests by default.

Package the extension locally with:

```bash
cd packages/vscode-extension
npm install --ignore-scripts
npm run check
npm test
npm run package
```

That produces `ghost-test-catcher-0.1.0.vsix`, installable through `Extensions: Install from VSIX...`.

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

## Current Status

This is a hackathon proof of concept.

The trust thresholds and score cutoffs are prototype heuristics, not calibrated benchmark values.

The project is best understood as:

- a product demo,
- a devtool concept,
- and a research direction around verification before trust.

## Suggested Uses

Potential future directions include:

- CI gates for AI-generated tests,
- IDE plugins for trust scoring,
- pull request review assistants,
- auditability tools for AI-assisted development,
- enterprise governance for generated code and tests.
