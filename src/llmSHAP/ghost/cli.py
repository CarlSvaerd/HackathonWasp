from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

from llmSHAP.ghost.adapters import available_language_adapters, get_language_adapter
from llmSHAP.ghost.analysis import analyze_existing_tests, generate_and_check
from llmSHAP.ghost.calibration import run_builtin_calibration
from llmSHAP.ghost.config import GhostTestCatcherConfig, load_config
from llmSHAP.ghost.workspace import collect_files, discover_source_specs, discover_test_specs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ghost-test-catcher",
        description="Check whether Python tests are grounded in the source files they claim to exercise.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    analyze = subcommands.add_parser("analyze", help="Analyze existing Python test files against source/context files.")
    _add_common_project_args(analyze)
    analyze.add_argument("--tests", nargs="+", help="Test file or directory paths to analyze.")
    analyze.add_argument("--source", nargs="*", help="Source/context file or directory paths.")
    analyze.add_argument("--no-execution", action="store_true", help="Skip Python test execution and run static checks only.")
    _add_execution_args(analyze)
    analyze.add_argument("--strict-exit", action="store_true", help="Exit 2 for non-reliable results.")
    analyze.set_defaults(handler=_handle_analyze)

    ci = subcommands.add_parser("ci", help="Run a CI/PR gate for existing Python test files.")
    _add_common_project_args(ci)
    ci.add_argument("--tests", nargs="+", help="Test file or directory paths to analyze.")
    ci.add_argument("--source", nargs="*", help="Source/context file or directory paths.")
    ci.add_argument("--changed-from", help="Git ref used to select changed Python test files, for example origin/main.")
    ci.add_argument("--summary", help="Write a Markdown CI summary to this path.")
    ci.add_argument("--no-execution", action="store_true", help="Skip Python test execution and run static checks only.")
    _add_execution_args(ci)
    ci.add_argument(
        "--fail-on",
        choices=["ghost_risk", "needs_review", "never"],
        default="ghost_risk",
        help=(
            "Failure policy: ghost_risk fails only high-risk results; needs_review fails any non-reliable result; "
            "never always exits 0."
        ),
    )
    ci.set_defaults(handler=_handle_ci)

    generate = subcommands.add_parser(
        "generate-and-check",
        help="Generate Python tests with OpenAI, then run the same trust checks.",
    )
    _add_common_project_args(generate)
    generate.add_argument("--source", nargs="*", help="Source/context file or directory paths.")
    generate.add_argument("--api-key", help="OpenAI API key. Defaults to OPENAI_API_KEY.")
    generate.add_argument("--model", help="OpenAI model name.")
    generate.add_argument("--prompt", help="Override the generated-test prompt.")
    generate.add_argument("--instructions", help="Override system instructions for generation.")
    generate.add_argument("--strict-exit", action="store_true", help="Exit 2 for non-reliable results.")
    generate.set_defaults(handler=_handle_generate_and_check)

    doctor = subcommands.add_parser("doctor", help="Print resolved configuration and discovered paths.")
    _add_common_project_args(doctor, include_output=False)
    doctor.set_defaults(handler=_handle_doctor)

    calibrate = subcommands.add_parser("calibrate", help="Run built-in calibration cases.")
    calibrate.add_argument("--format", choices=["pretty", "json"], default="pretty", help="Output format.")
    calibrate.add_argument("--output", help="Write JSON payload to this path.")
    calibrate.add_argument("--no-execution", action="store_true", help="Skip Python test execution and run static checks only.")
    _add_execution_args(calibrate)
    calibrate.set_defaults(handler=_handle_calibrate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except (ImportError, RuntimeError, ValueError, OSError) as exc:
        payload = {"ok": False, "error": str(exc)}
        if getattr(args, "format", "pretty") == "json":
            _emit_json(payload, getattr(args, "output", None))
        else:
            print(f"Ghost Test Catcher error: {exc}", file=sys.stderr)
        return 1


def _add_common_project_args(parser: argparse.ArgumentParser, *, include_output: bool = True) -> None:
    parser.add_argument("--repo", default=".", help="Repository root. Defaults to the current directory.")
    parser.add_argument("--config", help="Optional .ghosttest.toml or pyproject.toml path.")
    parser.add_argument("--test-mode", choices=["unit", "integration", "e2e", "mixed"], help="Expected test style.")
    parser.add_argument("--max-files", type=int, help="Maximum number of files to read.")
    parser.add_argument("--max-chars-per-file", type=int, help="Maximum characters read per file.")
    parser.add_argument("--max-total-chars", type=int, help="Maximum characters read across all files.")
    if include_output:
        parser.add_argument("--format", choices=["pretty", "json"], default="pretty", help="Output format.")
        parser.add_argument("--output", help="Write JSON payload to this path.")


def _add_execution_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--execution-backend",
        choices=["local", "docker"],
        help="Execution backend for Python tests. Docker requires an image with Python and pytest installed.",
    )
    parser.add_argument("--docker-image", help="Docker image used when --execution-backend docker is selected.")


def _handle_analyze(args: argparse.Namespace) -> int:
    repo_root, config = _resolve_config(args)
    test_specs = args.tests or discover_test_specs(repo_root, config)
    source_specs = args.source if args.source is not None else discover_source_specs(repo_root, config)
    test_files = collect_files(
        repo_root,
        test_specs,
        max_files=_limit(args.max_files, config.max_files),
        max_chars_per_file=_limit(args.max_chars_per_file, config.max_chars_per_file),
        max_total_chars=_limit(args.max_total_chars, config.max_total_chars),
        file_role="test",
    )
    context_files = collect_files(
        repo_root,
        source_specs,
        max_files=_limit(args.max_files, config.max_files),
        max_chars_per_file=_limit(args.max_chars_per_file, config.max_chars_per_file),
        max_total_chars=_limit(args.max_total_chars, config.max_total_chars),
        file_role="source",
    )
    result = analyze_existing_tests(
        test_files=test_files,
        context_files=context_files,
        test_mode=args.test_mode or config.test_mode,
        execute_tests=config.execute_tests and not args.no_execution,
        execution_backend=args.execution_backend or config.execution_backend,
        docker_image=args.docker_image or config.docker_image,
    )
    result["ok"] = True
    result["repo_root"] = str(repo_root)
    result["source_specs"] = source_specs
    result["test_specs"] = test_specs
    _emit_result(result, args)
    return _exit_code(result, strict=args.strict_exit)


def _handle_ci(args: argparse.Namespace) -> int:
    repo_root, config = _resolve_config(args)
    if args.tests:
        test_specs = args.tests
    elif args.changed_from:
        test_specs = _changed_test_specs(repo_root, args.changed_from)
    else:
        test_specs = discover_test_specs(repo_root, config)

    source_specs = args.source if args.source is not None else discover_source_specs(repo_root, config)
    if not test_specs:
        result = _empty_ci_result(repo_root=repo_root, source_specs=source_specs, test_specs=[])
    else:
        test_files = collect_files(
            repo_root,
            test_specs,
            max_files=_limit(args.max_files, config.max_files),
            max_chars_per_file=_limit(args.max_chars_per_file, config.max_chars_per_file),
            max_total_chars=_limit(args.max_total_chars, config.max_total_chars),
            file_role="test",
        )
        context_files = collect_files(
            repo_root,
            source_specs,
            max_files=_limit(args.max_files, config.max_files),
            max_chars_per_file=_limit(args.max_chars_per_file, config.max_chars_per_file),
            max_total_chars=_limit(args.max_total_chars, config.max_total_chars),
            file_role="source",
        )
        result = analyze_existing_tests(
            test_files=test_files,
            context_files=context_files,
            test_mode=args.test_mode or config.test_mode,
            execute_tests=config.execute_tests and not args.no_execution,
            execution_backend=args.execution_backend or config.execution_backend,
            docker_image=args.docker_image or config.docker_image,
        )
        result["repo_root"] = str(repo_root)
        result["source_specs"] = source_specs
        result["test_specs"] = test_specs

    result["ok"] = _ci_passed(result, fail_on=args.fail_on)
    result["ci"] = {
        "fail_on": args.fail_on,
        "summary": _ci_status_message(result, fail_on=args.fail_on),
    }
    if args.summary:
        summary_path = Path(args.summary).expanduser().resolve()
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(_render_markdown_summary(result), encoding="utf-8")
    _emit_result(result, args)
    return 0 if result["ok"] else 2


def _handle_generate_and_check(args: argparse.Namespace) -> int:
    from llmSHAP.llm.openai import OpenAIInterface

    repo_root, config = _resolve_config(args)
    source_specs = args.source if args.source is not None else discover_source_specs(repo_root, config)
    files = collect_files(
        repo_root,
        source_specs,
        max_files=_limit(args.max_files, config.max_files),
        max_chars_per_file=_limit(args.max_chars_per_file, config.max_chars_per_file),
        max_total_chars=_limit(args.max_total_chars, config.max_total_chars),
        file_role="source",
    )
    llm = OpenAIInterface(
        model_name=args.model or config.model,
        api_key=args.api_key,
        max_tokens=900,
    )
    result = generate_and_check(
        files=files,
        test_mode=args.test_mode or config.test_mode,
        llm=llm,
        prompt_override=args.prompt,
        instructions_override=args.instructions,
    )
    result["ok"] = True
    result["repo_root"] = str(repo_root)
    result["source_specs"] = source_specs
    _emit_result(result, args)
    return _exit_code(result, strict=args.strict_exit)


def _handle_doctor(args: argparse.Namespace) -> int:
    repo_root, config = _resolve_config(args)
    payload = {
        "repo_root": str(repo_root),
        "config": {
            "source_paths": config.source_paths,
            "test_paths": config.test_paths,
            "test_mode": config.test_mode,
            "model": config.model,
            "max_files": config.max_files,
            "max_chars_per_file": config.max_chars_per_file,
            "max_total_chars": config.max_total_chars,
            "execute_tests": config.execute_tests,
            "execution_backend": config.execution_backend,
            "docker_image": config.docker_image,
        },
        "language_adapters": [
            {
                "language_id": adapter.language_id,
                "display_name": adapter.display_name,
                "source_extensions": list(adapter.source_extensions),
                "test_extensions": list(adapter.test_extensions),
                "execution_backends": list(adapter.execution_backend_names()),
            }
            for adapter in available_language_adapters()
        ],
        "discovered_source_specs": discover_source_specs(repo_root, config),
        "discovered_test_specs": discover_test_specs(repo_root, config),
    }
    print(json.dumps(payload, indent=2))
    return 0


def _handle_calibrate(args: argparse.Namespace) -> int:
    result = run_builtin_calibration(
        execute_tests=not args.no_execution,
        execution_backend=args.execution_backend or "local",
        docker_image=args.docker_image or "ghost-test-catcher-runner:latest",
    )
    if args.format == "json" or args.output:
        _emit_json(result, args.output)
    else:
        print("Ghost Test Catcher Calibration")
        print("==============================")
        print(f"Passed: {result['pass_count']}/{result['total_count']}")
        for case in result["cases"]:
            marker = "PASS" if case["passed"] else "FAIL"
            print(
                f"- {marker} {case['name']}: expected={case['expected_verdict']} "
                f"actual={case['actual_verdict']} reliability={_pct(case['reliability_score'])} "
                f"execution={case['execution_status']}"
            )
    return 0 if result["ok"] else 2


def _resolve_config(args: argparse.Namespace) -> tuple[Path, GhostTestCatcherConfig]:
    repo_root = Path(args.repo).expanduser().resolve()
    if not repo_root.is_dir():
        raise ValueError(f"Repository root does not exist or is not a directory: {repo_root}")
    return repo_root, load_config(repo_root, args.config)


def _emit_result(result: dict[str, Any], args: argparse.Namespace) -> None:
    if args.format == "json" or args.output:
        _emit_json(result, args.output)
    else:
        _emit_pretty(result)


def _emit_json(payload: dict[str, Any], output: str | None) -> None:
    rendered = json.dumps(payload, indent=2)
    if output:
        output_path = Path(output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered, encoding="utf-8")
    print(rendered)


def _emit_pretty(result: dict[str, Any]) -> None:
    trust = result["trust_assessment"]
    execution = result["execution"]
    components = trust["components"]
    print("Ghost Test Catcher")
    print("==================")
    print(f"Mode: {result['analysis_mode']}")
    print(f"Verdict: {trust['verdict']} ({_pct(trust['reliability_score'])} reliability)")
    print(f"ETV: {_pct(components['etv_score'])}")
    print(f"Execution: {execution['status']} ({execution.get('passed', 0)}/{execution.get('test_count', 0)} passed)")
    if execution.get("primary_failure"):
        print(f"Primary failure: {execution['primary_failure']}")
    print()
    print("Per-test verdicts:")
    checks = {item.get("claim"): item for item in result["verification"].get("claim_checks", [])}
    runs = {item.get("name"): item for item in result["execution"].get("per_test_results", [])}
    for name in result["generated_tests"].get("test_names", []):
        check = checks.get(name, {})
        run = runs.get(name, {})
        missing = check.get("missing_symbols") or []
        categories = check.get("risk_categories") or []
        suffix = f" missing={', '.join(missing)}" if missing else ""
        category_suffix = f" categories={', '.join(categories)}" if categories else ""
        print(
            f"- {name}: grounding={check.get('status', 'unknown')} "
            f"confidence={_pct(float(check.get('confidence', 0.0)))} "
            f"framework={check.get('framework', 'unknown')} "
            f"run={run.get('status', 'unknown')}{suffix}{category_suffix}"
        )
        recommendation = check.get("recommendation")
        if recommendation:
            print(f"  recommendation={recommendation}")
    print()
    print("Top evidence/source files:")
    for item in result.get("files", [])[:5]:
        print(f"- {item['path']}: {_pct(float(item['weight']))}")


def _exit_code(result: dict[str, Any], *, strict: bool) -> int:
    if not strict:
        return 0
    return 0 if result.get("trust_assessment", {}).get("verdict") == "reliable" else 2


def _ci_passed(result: dict[str, Any], *, fail_on: str) -> bool:
    if fail_on == "never":
        return True
    verdict = result.get("trust_assessment", {}).get("verdict", "reliable")
    if fail_on == "needs_review":
        return verdict == "reliable"
    return verdict != "ghost_risk"


def _ci_status_message(result: dict[str, Any], *, fail_on: str) -> str:
    if not result.get("generated_tests", {}).get("test_count"):
        return "No Python test files were selected for Ghost Test Catcher analysis."
    verdict = result.get("trust_assessment", {}).get("verdict", "unknown")
    if _ci_passed(result, fail_on=fail_on):
        return f"Ghost Test Catcher passed with verdict '{verdict}' under fail-on policy '{fail_on}'."
    return f"Ghost Test Catcher failed with verdict '{verdict}' under fail-on policy '{fail_on}'."


def _empty_ci_result(*, repo_root: Path, source_specs: list[str], test_specs: list[str]) -> dict[str, Any]:
    return {
        "analysis_mode": "ci",
        "test_mode": "mixed",
        "prompt": "No Python test files were selected for analysis.",
        "api_map": "",
        "answer": "",
        "sampler": "none",
        "statistics": {
            "sampler": "none",
            "total_files": 0,
            "test_file_count": 0,
            "total_lines": 0,
            "total_weight_on_tests": 0.0,
            "total_weight_on_non_tests": 0.0,
            "max_weight": 0.0,
            "mean_weight": 0.0,
            "top_supporting_files": [],
            "top_test_files": [],
            "answer_characters": 0,
        },
        "generated_tests": {
            "code": "",
            "syntax_error": None,
            "test_names": [],
            "test_count": 0,
            "frameworks": ["unknown"],
        },
        "verification": {
            "verdict": "grounded",
            "message": "No changed Python test files were selected.",
            "groundedness_score": 1.0,
            "context_relevance_score": 1.0,
            "supported_claim_ratio": 1.0,
            "unsupported_claim_ratio": 0.0,
            "supported_claims": 0,
            "borderline_claims": 0,
            "unsupported_claims": 0,
            "total_claims": 0,
            "claim_checks": [],
            "top_evidence_files": [],
        },
        "preflight": {
            "status": "clear",
            "message": "No Python test files were selected.",
            "missing_imports": [],
            "missing_symbols": [],
            "total_generated_tests": 0,
        },
        "execution": {
            "status": "skipped",
            "message": "No Python test files were selected.",
            "primary_failure": "",
            "pytest_summary": "",
            "per_test_results": [],
            "passed": 0,
            "failed": 0,
            "errors": 0,
            "test_count": 0,
            "extracted_code": "",
        },
        "trust_assessment": {
            "verdict": "reliable",
            "message": "No changed Python test files were selected.",
            "reliability_score": 1.0,
            "thresholds": {
                "reliable_min": 0.62,
                "needs_review_min": 0.38,
            },
            "components": {
                "supported_claim_ratio": 1.0,
                "groundedness_score": 1.0,
                "context_relevance_score": 1.0,
                "evidence_weight_coverage": 1.0,
                "execution_score": 1.0,
                "etv_score": 1.0,
                "etv_breakdown": {
                    "total_tests": 0,
                    "keepers": 0,
                    "salvageable": 0,
                    "risky": 0,
                },
            },
        },
        "files": [],
        "top_test_files": [],
        "input_test_files": [],
        "context_files": [],
        "repo_root": str(repo_root),
        "source_specs": source_specs,
        "test_specs": test_specs,
    }


def _changed_test_specs(repo_root: Path, base_ref: str) -> list[str]:
    changed = _git_changed_paths(repo_root, f"{base_ref}...HEAD")
    if not changed:
        changed = _git_changed_paths(repo_root, base_ref)
    return [path for path in changed if _looks_like_test_path(path)]


def _git_changed_paths(repo_root: Path, revision_range: str) -> list[str]:
    completed = subprocess.run(
        ["git", "-C", str(repo_root), "diff", "--name-only", "--diff-filter=ACMR", revision_range],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return []
    return [line.strip().replace("\\", "/") for line in completed.stdout.splitlines() if line.strip()]


def _looks_like_test_path(path: str) -> bool:
    return get_language_adapter("python").is_test_path(path)


def _render_markdown_summary(result: dict[str, Any]) -> str:
    trust = result["trust_assessment"]
    execution = result["execution"]
    components = trust["components"]
    lines = [
        "# Ghost Test Catcher CI Report",
        "",
        f"**Verdict:** `{trust['verdict']}`",
        f"**Reliability:** `{_pct(float(trust['reliability_score']))}`",
        f"**Effective Test Value:** `{_pct(float(components['etv_score']))}`",
        f"**Execution:** `{execution['status']}` with `{execution.get('passed', 0)}/{execution.get('test_count', 0)}` tests passed",
        f"**Gate:** {result.get('ci', {}).get('summary', 'No CI gate status was recorded.')}",
        "",
        "## Selected Files",
        "",
    ]
    input_files = result.get("input_test_files", [])
    if input_files:
        for item in input_files:
            lines.append(f"- `{item['path']}` ({item['line_count']} lines)")
    else:
        lines.append("- No Python test files were selected.")

    lines.extend(
        [
            "",
            "## Per-Test Results",
            "",
            "| Test | Framework | Grounding | Confidence | Run | Categories | Missing symbols | Recommendation |",
            "| --- | --- | --- | ---: | --- | --- | --- | --- |",
        ]
    )
    checks = {item.get("claim"): item for item in result["verification"].get("claim_checks", [])}
    runs = {item.get("name"): item for item in result["execution"].get("per_test_results", [])}
    test_names = result["generated_tests"].get("test_names", [])
    if test_names:
        for name in test_names:
            check = checks.get(name, {})
            run = runs.get(name, {})
            missing = ", ".join(f"`{symbol}`" for symbol in check.get("missing_symbols", [])) or "-"
            categories = ", ".join(f"`{category}`" for category in check.get("risk_categories", [])) or "-"
            recommendation = str(check.get("recommendation") or "-").replace("|", "\\|")
            lines.append(
                "| "
                f"`{name}` | "
                f"`{check.get('framework', 'unknown')}` | "
                f"`{check.get('status', 'unknown')}` | "
                f"{_pct(float(check.get('confidence', 0.0)))} | "
                f"`{run.get('status', 'unknown')}` | "
                f"{categories} | "
                f"{missing} | "
                f"{recommendation} |"
            )
    else:
        lines.append("| - | - | - | - | - | - | - | - |")

    lines.extend(
        [
            "",
            "## Top Evidence Files",
            "",
        ]
    )
    weighted_files = result.get("files", [])[:5]
    if weighted_files:
        for item in weighted_files:
            lines.append(f"- `{item['path']}`: {_pct(float(item['weight']))}")
    else:
        lines.append("- No evidence files were ranked.")
    return "\n".join(lines) + "\n"


def _limit(cli_value: int | None, config_value: int) -> int:
    return cli_value if cli_value is not None else config_value


def _pct(value: float) -> str:
    return f"{value * 100:.1f}%"


if __name__ == "__main__":
    raise SystemExit(main())
