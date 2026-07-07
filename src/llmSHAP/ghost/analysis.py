from __future__ import annotations

from llmSHAP import Generation, TFIDFCosineSimilarity
from llmSHAP.llm.llm_interface import LLMInterface
from llmSHAP.webapp.analysis import (
    TEST_MODE_PROMPTS,
    UploadedContextFile,
    _build_api_map,
    _build_preflight_assessment,
    _build_statistics,
    _build_trust_assessment,
    analyze_uploaded_files,
)
from llmSHAP.webapp.execution import run_generated_tests, run_python_test_source
from llmSHAP.webapp.test_artifacts import parse_generated_tests, parse_python_test_source
from llmSHAP.webapp.verification import verify_answer_grounding, verify_python_test_source_grounding


def generate_and_check(
    *,
    files: list[UploadedContextFile],
    test_mode: str,
    llm: LLMInterface,
    prompt_override: str | None = None,
    instructions_override: str | None = None,
) -> dict:
    result = analyze_uploaded_files(
        files=files,
        test_mode=test_mode,
        llm=llm,
        prompt_override=prompt_override,
        instructions_override=instructions_override,
    )
    result["analysis_mode"] = "generate_and_check"
    return result


def analyze_existing_tests(
    *,
    test_files: list[UploadedContextFile],
    context_files: list[UploadedContextFile],
    test_mode: str = "mixed",
    execute_tests: bool = True,
) -> dict:
    if not test_files:
        raise ValueError("At least one test file is required.")
    if not context_files:
        raise ValueError("At least one source/context file is required.")
    if test_mode not in TEST_MODE_PROMPTS:
        raise ValueError(f"Unsupported test mode: {test_mode}")

    answer = _combine_test_files(test_files)
    extracted_tests = parse_python_test_source(answer)
    verification = verify_python_test_source_grounding(answer, context_files)
    execution = run_python_test_source(answer, context_files) if execute_tests else _skipped_execution(extracted_tests)
    preflight = _build_preflight_assessment(extracted_tests, verification, context_files)
    weighted_files = _build_static_weighted_files(context_files, answer)
    statistics = _build_statistics(
        weighted_files=weighted_files,
        answer=answer,
        sampler_name="static_similarity",
    )
    trust_assessment = _build_trust_assessment(
        weighted_files=weighted_files,
        verification=verification,
        execution=execution,
    )

    return {
        "analysis_mode": "analyze_existing_tests",
        "test_mode": test_mode,
        "prompt": "Analyze existing pytest tests against the provided source/context files.",
        "api_map": _build_api_map(context_files),
        "answer": answer,
        "sampler": "static_similarity",
        "statistics": statistics,
        "generated_tests": {
            "code": extracted_tests["code"],
            "syntax_error": extracted_tests["syntax_error"],
            "test_names": [test_case.name for test_case in extracted_tests["test_cases"]],
            "test_count": len(extracted_tests["test_cases"]),
        },
        "verification": verification,
        "preflight": preflight,
        "execution": execution,
        "trust_assessment": trust_assessment,
        "files": weighted_files,
        "top_test_files": [],
        "input_test_files": [
            {
                "path": item.path,
                "line_count": item.line_count,
                "size_bytes": item.size_bytes,
                "truncated": item.truncated,
            }
            for item in test_files
        ],
        "context_files": [item.path for item in context_files],
    }


def _combine_test_files(test_files: list[UploadedContextFile]) -> str:
    blocks = []
    for test_file in test_files:
        blocks.append(f"# file: {test_file.path}\n{test_file.content.strip()}")
    return "\n\n".join(block for block in blocks if block.strip())


def _build_static_weighted_files(files: list[UploadedContextFile], answer: str) -> list[dict]:
    similarity = TFIDFCosineSimilarity()
    answer_generation = Generation(output=answer)
    raw_scores = [
        similarity(answer_generation, Generation(output=f"{item.path}\n{item.content}"))
        for item in files
    ]
    total_score = sum(raw_scores)
    if total_score <= 0 and files:
        weights = [1.0 / len(files) for _ in files]
    else:
        weights = [score / total_score if total_score > 0 else 0.0 for score in raw_scores]

    weighted_files = []
    for uploaded_file, raw_score, weight in zip(files, raw_scores, weights):
        weighted_files.append(
            {
                "path": uploaded_file.path,
                "line_count": uploaded_file.line_count,
                "size_bytes": uploaded_file.size_bytes,
                "is_test_file": uploaded_file.is_test_file,
                "truncated": uploaded_file.truncated,
                "raw_score": raw_score,
                "weight": weight,
            }
        )
    weighted_files.sort(key=lambda item: item["weight"], reverse=True)
    return weighted_files


def _skipped_execution(extracted_tests: dict) -> dict:
    return {
        "status": "skipped",
        "message": "Pytest execution was skipped by configuration.",
        "primary_failure": "",
        "pytest_summary": "",
        "per_test_results": [
            {
                "name": test_case.name,
                "status": "skipped",
            }
            for test_case in extracted_tests.get("test_cases", [])
        ],
        "passed": 0,
        "failed": 0,
        "errors": 0,
        "test_count": len(extracted_tests.get("test_cases", [])),
        "extracted_code": extracted_tests.get("code", ""),
    }
