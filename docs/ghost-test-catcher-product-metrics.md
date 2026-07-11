# Ghost Test Catcher Product Metrics

Generated: `2026-07-11T13:22:35+02:00`
Commit: `6371fb8`

## Positioning

Ghost Test Catcher reviews Python tests against real source files so developers can spot grounded tests, salvageable tests, and ghost-risk tests before they merge AI-generated code.

Ghost Test Catcher is best positioned as a trust layer for AI-assisted development. It is not another generic test generator. Its strongest product promise is that it checks whether tests are grounded in the real codebase, whether they execute, and whether they are worth keeping before a developer merges them.

## What It Does

- Reviews existing Python tests against source files.
- Detects missing imports, missing symbols, invented workflows, and weakly supported assertions.
- Runs tests through pytest when execution is enabled.
- Produces a trust verdict: `reliable`, `needs_review`, or `ghost_risk`.
- Reports Effective Test Value (ETV), per-test grounding, execution status, and top evidence files.
- Integrates through the VS Code extension, CLI, and CI gate.
- Optionally generates tests with OpenAI, then checks those generated tests with the same trust pipeline.

## Why Developers Should Try It

- It protects teams from merging AI-generated tests that look convincing but reference APIs that do not exist.
- It turns test review into evidence: each result connects back to source files, symbols, execution, and risk categories.
- The default existing-test review path costs 0 LLM tokens because it uses local static analysis and local test execution.
- It can be used locally in VS Code before a commit and again in CI before a pull request lands.
- It gives maintainers a practical way to separate tests to keep, tests to fix, and tests to delete.

## Measured Local Results

| Metric | Result |
| --- | ---: |
| Existing-test review LLM calls | 0 |
| Existing-test review estimated LLM input tokens | 0 |
| Existing-test review estimated LLM output tokens | 0 |
| Built-in calibration pass rate | 7/7 (100.0%) |
| Built-in calibration runtime | 2.435s |
| Demo tests reviewed | 7 |
| Demo source files reviewed | 2 |
| Demo test files reviewed | 2 |
| Demo runtime | 0.473s |
| Demo verdict | `reliable` |
| Demo reliability score | 85.4% |
| Demo ETV | 100.0% |
| Demo execution status | `passed` |
| Demo missing imports | 0 |
| Demo missing symbols | 0 |

## Token Cost Story

The most important token-cost fact is simple: the core VS Code and CLI review workflow for existing tests does not call an LLM. It reads local files, parses tests, checks source evidence, computes local similarity, and optionally runs pytest.

The only LLM-backed path is the optional generate-and-check workflow. That path needs model calls because it asks OpenAI to generate tests first, then verifies the result.

Token estimates below use `ceil(rendered_prompt_characters / 4)` on the rendered request payload for `demo/integration_lab` with 4 files.

| Optional generation policy | LLM calls | Estimated input tokens | Web app output ceiling | CLI output ceiling |
| --- | ---: | ---: | ---: | ---: |
| Previous full-enumeration policy | 16 | 17881 | 11200 | 11200 |
| Current counterfactual-after-2-files policy | 6 | 8198 | 4200 | 4200 |

Estimated reduction from the policy change:

- LLM calls: 62.5% fewer.
- Input tokens: 54.2% fewer estimated tokens.
- Web app requested output ceiling: 62.5% lower.
- CLI requested output ceiling: 62.5% lower.

## Marketing-Safe Claims

- Existing-test review in the VS Code extension, CLI analyze command, and CI gate uses 0 LLM calls and 0 estimated LLM tokens.
- The built-in calibration suite matched expected verdicts on 7/7 scenarios in 2.435 seconds.
- The demo project analysis reviewed 7 Python tests across 2 test files and 2 source files in 0.473 seconds with verdict 'reliable'.
- For the optional 4-file generate-and-check sample, the attribution policy reduces estimated LLM calls from 16 to 6 (62.5% fewer calls).
- For that same optional generation sample, estimated input tokens drop from 17881 to 8198 (54.2% fewer estimated input tokens).

## Copy You Can Use

Ghost Test Catcher helps developers catch ghost tests before they merge. It reviews Python tests against the actual source files, checks whether imports and symbols exist, runs pytest, and labels each result as reliable, needs review, or ghost risk. The default VS Code and CLI review workflow uses zero LLM calls, so teams can check AI-generated tests without sending their code back through a model.

## Limits

- These are repository-local benchmark and demo metrics, not independent third-party benchmarks.
- Token estimates use a conservative character-to-token approximation of ceil(characters / 4).
- Actual OpenAI token accounting depends on the provider tokenizer, model, request metadata, and generated output length.
- The zero-token claim applies to existing-test review through the VS Code extension, CLI analyze, and CLI ci workflows.
- The optional generate-and-check workflow still uses an LLM by design because it generates tests before checking them.

## Reproduce

Run this from the repository root:

```bash
python tools/ghost_test_catcher_product_metrics.py
```

The command refreshes both:

- `docs/ghost-test-catcher-product-metrics.json`
- `docs/ghost-test-catcher-product-metrics.md`
