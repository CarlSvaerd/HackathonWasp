from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
from itertools import combinations
import json
import math
from pathlib import Path
import subprocess
import sys
from time import perf_counter


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from llmSHAP import DataHandler  # noqa: E402
from llmSHAP.ghost.analysis import analyze_existing_tests  # noqa: E402
from llmSHAP.ghost.calibration import builtin_calibration_cases  # noqa: E402
from llmSHAP.ghost.config import (  # noqa: E402
    DEFAULT_MAX_CHARS_PER_FILE,
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_TOTAL_CHARS,
)
from llmSHAP.ghost.workspace import collect_files  # noqa: E402
from llmSHAP.webapp.analysis import (  # noqa: E402
    API_MAP_KEY,
    DEFAULT_INSTRUCTIONS,
    INSTRUCTIONS_KEY,
    PROMPT_KEY,
    TEST_MODE_PROMPTS,
    UploadedContextFile,
    UploadedFilePromptCodec,
    _build_api_map,
    _format_uploaded_file,
)


WEBAPP_OUTPUT_TOKEN_CEILING_PER_CALL = 700
CLI_OUTPUT_TOKEN_CEILING_PER_CALL = 700


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate repeatable Ghost Test Catcher product and token metrics.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--output-json",
        default=str(REPO_ROOT / "docs" / "ghost-test-catcher-product-metrics.json"),
        help="Path where the machine-readable metrics payload will be written.",
    )
    parser.add_argument(
        "--output-markdown",
        default=str(REPO_ROOT / "docs" / "ghost-test-catcher-product-metrics.md"),
        help="Path where the human-readable product metrics report will be written.",
    )
    parser.add_argument(
        "--skip-execution",
        action="store_true",
        help="Skip local pytest execution inside the calibration and demo analysis runs.",
    )
    args = parser.parse_args(argv)

    payload = build_metrics_payload(execute_tests=not args.skip_execution)

    output_json = Path(args.output_json).expanduser().resolve()
    output_markdown = Path(args.output_markdown).expanduser().resolve()
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_markdown.parent.mkdir(parents=True, exist_ok=True)

    output_json.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    output_markdown.write_text(render_markdown_report(payload), encoding="utf-8")

    print(f"Wrote JSON metrics to {output_json}")
    print(f"Wrote Markdown report to {output_markdown}")
    return 0


def build_metrics_payload(*, execute_tests: bool) -> dict:
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    calibration = measure_builtin_calibration(execute_tests=execute_tests)
    demo_project = measure_demo_existing_tests(execute_tests=execute_tests)
    optional_generation = estimate_optional_generation_costs()

    return {
        "generated_at": generated_at,
        "commit": git_short_sha(),
        "product": {
            "name": "Ghost Test Catcher",
            "one_sentence_pitch": (
                "Ghost Test Catcher reviews Python tests against real source files so developers can spot "
                "grounded tests, salvageable tests, and ghost-risk tests before they merge AI-generated code."
            ),
            "primary_workflows": [
                "VS Code extension commands and Testing panel integration",
                "CLI analysis for existing tests",
                "CI gate for pull requests",
                "Optional OpenAI-backed generate-and-check workflow",
            ],
        },
        "metrics": {
            "existing_test_review": {
                "workflow": "VS Code extension, CLI analyze, and CLI ci for existing Python tests",
                "llm_calls": 0,
                "estimated_input_tokens": 0,
                "estimated_output_tokens": 0,
                "token_cost_summary": (
                    "The core review path uses local AST parsing, source-symbol checks, TF-IDF similarity, "
                    "and optional pytest execution. It does not call OpenAI or any other LLM."
                ),
            },
            "built_in_calibration": calibration,
            "demo_project": demo_project,
            "optional_generation_token_estimate": optional_generation,
        },
        "safe_claims": build_safe_claims(calibration, demo_project, optional_generation),
        "limits": [
            "These are repository-local benchmark and demo metrics, not independent third-party benchmarks.",
            "Token estimates use a conservative character-to-token approximation of ceil(characters / 4).",
            "Actual OpenAI token accounting depends on the provider tokenizer, model, request metadata, and generated output length.",
            "The zero-token claim applies to existing-test review through the VS Code extension, CLI analyze, and CLI ci workflows.",
            "The optional generate-and-check workflow still uses an LLM by design because it generates tests before checking them.",
        ],
    }


def measure_builtin_calibration(*, execute_tests: bool) -> dict:
    cases = []
    started = perf_counter()
    for case in builtin_calibration_cases():
        case_started = perf_counter()
        result = analyze_existing_tests(
            test_files=case.test_files,
            context_files=case.source_files,
            execute_tests=execute_tests,
        )
        trust = result["trust_assessment"]
        execution = result["execution"]
        preflight = result["preflight"]
        actual_verdict = trust["verdict"]
        cases.append(
            {
                "name": case.name,
                "description": case.description,
                "expected_verdict": case.expected_verdict,
                "actual_verdict": actual_verdict,
                "passed": actual_verdict == case.expected_verdict,
                "duration_seconds": rounded_seconds(perf_counter() - case_started),
                "reliability_score": rounded_float(trust["reliability_score"]),
                "etv_score": rounded_float(trust["components"]["etv_score"]),
                "execution_status": execution["status"],
                "test_count": result["generated_tests"]["test_count"],
                "missing_imports": preflight["missing_imports"],
                "missing_symbols": preflight["missing_symbols"],
            }
        )

    pass_count = sum(1 for item in cases if item["passed"])
    total_count = len(cases)
    return {
        "ok": pass_count == total_count,
        "pass_count": pass_count,
        "total_count": total_count,
        "pass_rate": rounded_float(pass_count / total_count if total_count else 0.0),
        "duration_seconds": rounded_seconds(perf_counter() - started),
        "execute_tests": execute_tests,
        "llm_calls": 0,
        "estimated_input_tokens": 0,
        "estimated_output_tokens": 0,
        "cases": cases,
    }


def measure_demo_existing_tests(*, execute_tests: bool) -> dict:
    demo_root = REPO_ROOT / "demo" / "ghost_test_catcher_sample"
    source_files = collect_files(
        demo_root,
        ["src"],
        max_files=DEFAULT_MAX_FILES,
        max_chars_per_file=DEFAULT_MAX_CHARS_PER_FILE,
        max_total_chars=DEFAULT_MAX_TOTAL_CHARS,
        file_role="source",
    )
    test_files = collect_files(
        demo_root,
        ["tests"],
        max_files=DEFAULT_MAX_FILES,
        max_chars_per_file=DEFAULT_MAX_CHARS_PER_FILE,
        max_total_chars=DEFAULT_MAX_TOTAL_CHARS,
        file_role="test",
    )

    started = perf_counter()
    result = analyze_existing_tests(
        test_files=test_files,
        context_files=source_files,
        execute_tests=execute_tests,
    )
    duration_seconds = rounded_seconds(perf_counter() - started)

    trust = result["trust_assessment"]
    execution = result["execution"]
    verification = result["verification"]
    preflight = result["preflight"]
    claim_status_counts = Counter(item.get("status", "unknown") for item in verification.get("claim_checks", []))
    run_status_counts = Counter(item.get("status", "unknown") for item in execution.get("per_test_results", []))
    test_count = result["generated_tests"]["test_count"]

    return {
        "name": "demo/ghost_test_catcher_sample",
        "source_file_count": len(source_files),
        "test_file_count": len(test_files),
        "source_line_count": sum(item.line_count for item in source_files),
        "test_line_count": sum(item.line_count for item in test_files),
        "test_count": test_count,
        "duration_seconds": duration_seconds,
        "tests_per_second": rounded_float(test_count / duration_seconds if duration_seconds > 0 else 0.0),
        "execute_tests": execute_tests,
        "verdict": trust["verdict"],
        "reliability_score": rounded_float(trust["reliability_score"]),
        "etv_score": rounded_float(trust["components"]["etv_score"]),
        "etv_breakdown": trust["components"]["etv_breakdown"],
        "execution_status": execution["status"],
        "execution_counts": {
            "passed": execution.get("passed", 0),
            "failed": execution.get("failed", 0),
            "errors": execution.get("errors", 0),
            "reported_test_count": execution.get("test_count", 0),
        },
        "per_test_execution_status_counts": dict(sorted(run_status_counts.items())),
        "grounding_status_counts": dict(sorted(claim_status_counts.items())),
        "preflight_status": preflight["status"],
        "missing_import_count": len(preflight["missing_imports"]),
        "missing_symbol_count": len(preflight["missing_symbols"]),
        "top_evidence_files": [item["path"] for item in result["files"][:3]],
        "llm_calls": 0,
        "estimated_input_tokens": 0,
        "estimated_output_tokens": 0,
    }


def estimate_optional_generation_costs() -> dict:
    generation_files = collect_files(
        REPO_ROOT,
        ["demo/integration_lab"],
        max_files=8,
        max_chars_per_file=12_000,
        max_total_chars=48_000,
        file_role="source",
    )
    old_policy = estimate_generation_policy(
        generation_files,
        policy_name="previous_policy_full_enumeration_up_to_four_files",
        sampler_name="full_enumeration",
    )
    current_policy = estimate_generation_policy(
        generation_files,
        policy_name="current_policy_counterfactual_after_two_files",
        sampler_name="counterfactual",
    )

    return {
        "sample_context": "demo/integration_lab",
        "file_count": len(generation_files),
        "file_paths": [item.path for item in generation_files],
        "test_mode": "mixed",
        "estimator": "ceil(rendered_prompt_characters / 4)",
        "previous_policy": old_policy,
        "current_policy": current_policy,
        "reduction": {
            "llm_call_reduction_percent": percent_reduction(old_policy["llm_calls"], current_policy["llm_calls"]),
            "estimated_input_token_reduction_percent": percent_reduction(
                old_policy["estimated_input_tokens"],
                current_policy["estimated_input_tokens"],
            ),
            "webapp_output_ceiling_reduction_percent": percent_reduction(
                old_policy["requested_output_token_ceiling_webapp"],
                current_policy["requested_output_token_ceiling_webapp"],
            ),
            "cli_output_ceiling_reduction_percent": percent_reduction(
                old_policy["requested_output_token_ceiling_cli"],
                current_policy["requested_output_token_ceiling_cli"],
            ),
        },
        "why_this_matters": (
            "The optional generation workflow estimates file influence by re-running the model against different "
            "coalitions of uploaded files. Exact full enumeration is useful for tiny contexts, but it grows as 2^n. "
            "Counterfactual attribution keeps the request count roughly linear by comparing the full context to "
            "leave-one-file-out contexts plus the empty baseline."
        ),
    }


def estimate_generation_policy(
    files: list[UploadedContextFile],
    *,
    policy_name: str,
    sampler_name: str,
) -> dict:
    codec = UploadedFilePromptCodec()
    data = {
        INSTRUCTIONS_KEY: DEFAULT_INSTRUCTIONS,
        PROMPT_KEY: TEST_MODE_PROMPTS["mixed"],
        API_MAP_KEY: _build_api_map(files),
    }
    for uploaded_file in files:
        data[uploaded_file.path] = _format_uploaded_file(uploaded_file)

    data_handler = DataHandler(data, permanent_keys={INSTRUCTIONS_KEY, PROMPT_KEY, API_MAP_KEY})
    variable_indexes = data_handler.get_keys(exclude_permanent_keys=True)
    if sampler_name == "full_enumeration":
        coalitions = sorted(full_enumeration_coalitions(variable_indexes), key=coalition_sort_key)
    elif sampler_name == "counterfactual":
        coalitions = sorted(counterfactual_coalitions(variable_indexes), key=coalition_sort_key)
    else:
        raise ValueError(f"Unsupported sampler for token estimate: {sampler_name}")

    prompt_character_counts = [
        len(render_prompt(codec.build_prompt(data_handler, set(coalition))))
        for coalition in coalitions
    ]
    estimated_input_tokens_by_call = [approx_tokens(count) for count in prompt_character_counts]
    estimated_input_tokens = sum(estimated_input_tokens_by_call)

    return {
        "policy_name": policy_name,
        "sampler": sampler_name,
        "llm_calls": len(coalitions),
        "estimated_input_tokens": estimated_input_tokens,
        "estimated_input_tokens_by_call": estimated_input_tokens_by_call,
        "mean_estimated_input_tokens_per_call": rounded_float(
            estimated_input_tokens / len(coalitions) if coalitions else 0.0
        ),
        "max_estimated_input_tokens_per_call": max(estimated_input_tokens_by_call, default=0),
        "rendered_prompt_characters": sum(prompt_character_counts),
        "requested_output_token_ceiling_webapp": len(coalitions) * WEBAPP_OUTPUT_TOKEN_CEILING_PER_CALL,
        "requested_output_token_ceiling_cli": len(coalitions) * CLI_OUTPUT_TOKEN_CEILING_PER_CALL,
        "coalition_sizes": [len(coalition) for coalition in coalitions],
    }


def full_enumeration_coalitions(keys: list[int]) -> set[frozenset[int]]:
    coalitions: set[frozenset[int]] = set()
    for size in range(len(keys) + 1):
        for coalition in combinations(keys, size):
            coalitions.add(frozenset(coalition))
    return coalitions


def counterfactual_coalitions(keys: list[int]) -> set[frozenset[int]]:
    if not keys:
        return {frozenset()}
    coalitions = {frozenset(), frozenset(keys)}
    for key in keys:
        coalitions.add(frozenset(item for item in keys if item != key))
    return coalitions


def coalition_sort_key(coalition: frozenset[int]) -> tuple[int, list[int]]:
    return (len(coalition), sorted(coalition))


def render_prompt(prompt: object) -> str:
    if isinstance(prompt, str):
        return prompt
    return json.dumps(prompt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def approx_tokens(character_count: int) -> int:
    return int(math.ceil(character_count / 4))


def build_safe_claims(calibration: dict, demo_project: dict, optional_generation: dict) -> list[str]:
    previous = optional_generation["previous_policy"]
    current = optional_generation["current_policy"]
    reduction = optional_generation["reduction"]
    return [
        (
            "Existing-test review in the VS Code extension, CLI analyze command, and CI gate uses 0 LLM calls "
            "and 0 estimated LLM tokens."
        ),
        (
            f"The built-in calibration suite matched expected verdicts on {calibration['pass_count']}/"
            f"{calibration['total_count']} scenarios in {calibration['duration_seconds']} seconds."
        ),
        (
            f"The demo project analysis reviewed {demo_project['test_count']} Python tests across "
            f"{demo_project['test_file_count']} test files and {demo_project['source_file_count']} source files "
            f"in {demo_project['duration_seconds']} seconds with verdict '{demo_project['verdict']}'."
        ),
        (
            f"For the optional 4-file generate-and-check sample, the attribution policy reduces estimated LLM calls "
            f"from {previous['llm_calls']} to {current['llm_calls']} "
            f"({pct_points(reduction['llm_call_reduction_percent'])} fewer calls)."
        ),
        (
            f"For that same optional generation sample, estimated input tokens drop from "
            f"{previous['estimated_input_tokens']} to {current['estimated_input_tokens']} "
            f"({pct_points(reduction['estimated_input_token_reduction_percent'])} fewer estimated input tokens)."
        ),
    ]


def render_markdown_report(payload: dict) -> str:
    metrics = payload["metrics"]
    calibration = metrics["built_in_calibration"]
    demo = metrics["demo_project"]
    generation = metrics["optional_generation_token_estimate"]
    previous = generation["previous_policy"]
    current = generation["current_policy"]
    reduction = generation["reduction"]

    lines = [
        "# Ghost Test Catcher Product Metrics",
        "",
        f"Generated: `{payload['generated_at']}`",
        f"Commit: `{payload['commit']}`",
        "",
        "## Positioning",
        "",
        payload["product"]["one_sentence_pitch"],
        "",
        "Ghost Test Catcher is best positioned as a trust layer for AI-assisted development. "
        "It is not another generic test generator. Its strongest product promise is that it checks whether tests "
        "are grounded in the real codebase, whether they execute, and whether they are worth keeping before a "
        "developer merges them.",
        "",
        "## What It Does",
        "",
        "- Reviews existing Python tests against source files.",
        "- Detects missing imports, missing symbols, invented workflows, and weakly supported assertions.",
        "- Runs tests through pytest when execution is enabled.",
        "- Produces a trust verdict: `reliable`, `needs_review`, or `ghost_risk`.",
        "- Reports Effective Test Value (ETV), per-test grounding, execution status, and top evidence files.",
        "- Integrates through the VS Code extension, CLI, and CI gate.",
        "- Optionally generates tests with OpenAI, then checks those generated tests with the same trust pipeline.",
        "",
        "## Why Developers Should Try It",
        "",
        "- It protects teams from merging AI-generated tests that look convincing but reference APIs that do not exist.",
        "- It turns test review into evidence: each result connects back to source files, symbols, execution, and risk categories.",
        "- The default existing-test review path costs 0 LLM tokens because it uses local static analysis and local test execution.",
        "- It can be used locally in VS Code before a commit and again in CI before a pull request lands.",
        "- It gives maintainers a practical way to separate tests to keep, tests to fix, and tests to delete.",
        "",
        "## Measured Local Results",
        "",
        "| Metric | Result |",
        "| --- | ---: |",
        f"| Existing-test review LLM calls | {metrics['existing_test_review']['llm_calls']} |",
        f"| Existing-test review estimated LLM input tokens | {metrics['existing_test_review']['estimated_input_tokens']} |",
        f"| Existing-test review estimated LLM output tokens | {metrics['existing_test_review']['estimated_output_tokens']} |",
        f"| Built-in calibration pass rate | {calibration['pass_count']}/{calibration['total_count']} ({pct(calibration['pass_rate'])}) |",
        f"| Built-in calibration runtime | {calibration['duration_seconds']}s |",
        f"| Demo tests reviewed | {demo['test_count']} |",
        f"| Demo source files reviewed | {demo['source_file_count']} |",
        f"| Demo test files reviewed | {demo['test_file_count']} |",
        f"| Demo runtime | {demo['duration_seconds']}s |",
        f"| Demo verdict | `{demo['verdict']}` |",
        f"| Demo reliability score | {pct(demo['reliability_score'])} |",
        f"| Demo ETV | {pct(demo['etv_score'])} |",
        f"| Demo execution status | `{demo['execution_status']}` |",
        f"| Demo missing imports | {demo['missing_import_count']} |",
        f"| Demo missing symbols | {demo['missing_symbol_count']} |",
        "",
        "## Token Cost Story",
        "",
        "The most important token-cost fact is simple: the core VS Code and CLI review workflow for existing tests "
        "does not call an LLM. It reads local files, parses tests, checks source evidence, computes local similarity, "
        "and optionally runs pytest.",
        "",
        "The only LLM-backed path is the optional generate-and-check workflow. That path needs model calls because it "
        "asks OpenAI to generate tests first, then verifies the result.",
        "",
        f"Token estimates below use `{generation['estimator']}` on the rendered request payload for "
        f"`{generation['sample_context']}` with {generation['file_count']} files.",
        "",
        "| Optional generation policy | LLM calls | Estimated input tokens | Web app output ceiling | CLI output ceiling |",
        "| --- | ---: | ---: | ---: | ---: |",
        (
            f"| Previous full-enumeration policy | {previous['llm_calls']} | "
            f"{previous['estimated_input_tokens']} | {previous['requested_output_token_ceiling_webapp']} | "
            f"{previous['requested_output_token_ceiling_cli']} |"
        ),
        (
            f"| Current counterfactual-after-2-files policy | {current['llm_calls']} | "
            f"{current['estimated_input_tokens']} | {current['requested_output_token_ceiling_webapp']} | "
            f"{current['requested_output_token_ceiling_cli']} |"
        ),
        "",
        "Estimated reduction from the policy change:",
        "",
        f"- LLM calls: {pct_points(reduction['llm_call_reduction_percent'])} fewer.",
        f"- Input tokens: {pct_points(reduction['estimated_input_token_reduction_percent'])} fewer estimated tokens.",
        f"- Web app requested output ceiling: {pct_points(reduction['webapp_output_ceiling_reduction_percent'])} lower.",
        f"- CLI requested output ceiling: {pct_points(reduction['cli_output_ceiling_reduction_percent'])} lower.",
        "",
        "## Marketing-Safe Claims",
        "",
        *[f"- {claim}" for claim in payload["safe_claims"]],
        "",
        "## Copy You Can Use",
        "",
        "Ghost Test Catcher helps developers catch ghost tests before they merge. It reviews Python tests against "
        "the actual source files, checks whether imports and symbols exist, runs pytest, and labels each result as "
        "reliable, needs review, or ghost risk. The default VS Code and CLI review workflow uses zero LLM calls, so "
        "teams can check AI-generated tests without sending their code back through a model.",
        "",
        "## Limits",
        "",
        *[f"- {item}" for item in payload["limits"]],
        "",
        "## Reproduce",
        "",
        "Run this from the repository root:",
        "",
        "```bash",
        "python tools/ghost_test_catcher_product_metrics.py",
        "```",
        "",
        "The command refreshes both:",
        "",
        "- `docs/ghost-test-catcher-product-metrics.json`",
        "- `docs/ghost-test-catcher-product-metrics.md`",
        "",
    ]
    return "\n".join(lines)


def git_short_sha() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    sha = completed.stdout.strip()
    return sha or "unknown"


def rounded_seconds(value: float) -> float:
    return round(value, 3)


def rounded_float(value: float) -> float:
    return round(float(value), 4)


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def pct_points(value: float) -> str:
    return f"{value:.1f}%"


def percent_reduction(before: int | float, after: int | float) -> float:
    if before <= 0:
        return 0.0
    return rounded_float(((before - after) / before) * 100)


if __name__ == "__main__":
    raise SystemExit(main())
