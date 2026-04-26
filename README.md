# Ghost Test Catcher

Ghost Test Catcher is a proof-of-concept trust layer for AI-generated software tests.

Instead of only asking an LLM to write tests, this project checks whether those tests are actually supported by the uploaded source files, whether they run in `pytest`, and whether they look like useful tests or ghost tests.

## What It Does

Given a small set of uploaded files, the app:

1. builds a prompt for test generation,
2. gives the LLM an API map of the uploaded Python files,
3. generates tests,
4. uses llmSHAP-style attribution to see which files influenced the output,
5. checks groundedness and context relevance,
6. runs the generated tests in `pytest`,
7. returns a trust-oriented verdict.

The main idea is simple:

> Passing tests are not enough.  
> We also want to know whether those tests are actually grounded in the code they claim to test.

## Why This Exists

AI coding tools can generate plausible-looking tests that:

- reference symbols that do not exist,
- assume workflows the codebase does not implement,
- assert the wrong behavior,
- or pass while still being weakly grounded.

Ghost Test Catcher is meant to help developers answer:

- Which generated tests are worth keeping?
- Which tests are risky or ghosty?
- Which files influenced the output most?
- Did the AI stay inside the uploaded codebase, or invent things?

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

Whether the overall generated output still looks related to the uploaded codebase as a whole.

### ETV

`ETV` means **Effective Test Value**.

It answers:

> How much of this generated test set is actually worth keeping?

Current definition:

```text
ETV = (keepers + 0.5 * salvageable) / total_tests
```

Where:

- `keepers` are grounded and passing tests,
- `salvageable` are partially useful tests,
- `risky` are ghost-risk or otherwise weak tests.

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
- creates a prompt using the uploaded code and the selected test mode,
- sends the prompt through the OpenAI interface.

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

This gives:

- per-test execution status,
- pass/fail/error counts,
- a primary runtime failure if one exists.

### Trust Output

The UI shows:

- outcome verdict,
- reliability score,
- ETV,
- execution result,
- per-test groundedness and execution,
- pytest failures,
- grounding warnings,
- llmSHAP-style file influence,
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
- detailed evidence sections.

### Backend API

`src/llmSHAP/webapp/app.py`

FastAPI server that exposes:

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
- llmSHAP attribution,
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
- evidence snippets and evidence files.

### Pytest Execution

`src/llmSHAP/webapp/execution.py`

Runs generated tests against uploaded files and returns:

- per-test status,
- pass/fail/error counts,
- primary failure message,
- raw pytest summary.

### LLM Interface

`src/llmSHAP/llm/openai.py`

Wraps the OpenAI Responses API with:

- API key handling,
- timeout defaults,
- retry behavior.

## Demo Scenarios

The app includes built-in demo scenarios.

### Grounded Checkout Demo

A connected checkout/billing-style mini project intended to produce more grounded tests.

### Ghost-Risk Alert Demo

A lower-level alerting sample with a stress prompt intended to make unsupported product-level tests more likely.

## Sample Projects

### `demo/allofem`

Three connected Python files for a checkout/order flow.

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

Then open:

[http://127.0.0.1:8000](http://127.0.0.1:8000)

### Run with Docker

```bash
make docker-build
make docker-run
```

Then open:

[http://127.0.0.1:8000](http://127.0.0.1:8000)

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

## Optional CLI

This repo also includes a lightweight CLI for codebase RAG attribution:

`tools/codebase_rag_explain.py`

Example:

```bash
python tools/codebase_rag_explain.py \
  --repo . \
  --question "Where is the OpenAI model interface implemented?" \
  --top-k 6
```

## How llmSHAP Fits In

This project is built on top of the original `llmSHAP` framework.

In Ghost Test Catcher, llmSHAP is used as the explainability engine for:

- attributing which uploaded files influenced the generated output,
- exposing weighted file impact,
- supporting trust and evidence analysis.

The product focus of this repo is no longer “generic llmSHAP examples”.
It is specifically:

> a trust and verification workflow for AI-generated software tests.

## Current Status

This is a hackathon-grade proof of concept.

The thresholds and trust cutoffs are prototype heuristics, not calibrated benchmark values.

The project is best understood as:

- a product demo,
- a research direction,
- and a devtool concept for “verification before trust”.

## Suggested Uses

Potential future directions include:

- CI gates for AI-generated tests,
- IDE plugins for trust scoring,
- pull request review assistants,
- auditability tools for AI-assisted development,
- enterprise governance for generated code and tests.
