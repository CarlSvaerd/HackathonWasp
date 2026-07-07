from __future__ import annotations

import ast
from dataclasses import dataclass
import os
from statistics import mean
import sys

from llmSHAP import DataHandler, Generation, ShapleyAttribution, TFIDFCosineSimilarity
from llmSHAP.attribution_methods import CounterfactualSampler, FullEnumerationSampler
from llmSHAP.llm.llm_interface import LLMInterface
from llmSHAP.prompt_codec import PromptCodec
from llmSHAP.types import IndexSelection
from llmSHAP.webapp.execution import run_generated_tests
from llmSHAP.webapp.test_artifacts import parse_generated_tests
from llmSHAP.webapp.verification import verify_answer_grounding


INSTRUCTIONS_KEY = "__instructions__"
PROMPT_KEY = "__prompt__"
API_MAP_KEY = "__api_map__"
TEST_MODE_PROMPTS = {
    "unit": (
        "Generate runnable pytest unit tests for the uploaded files. "
        "Focus on pure function behavior, edge cases, validation rules, and failure paths. "
        "Return only Python code in a single ```python``` block with pytest-style test functions."
    ),
    "integration": (
        "Generate runnable pytest integration tests for the uploaded files. "
        "Focus on interactions between modules, shared data flow, and cross-file behavior. "
        "Return only Python code in a single ```python``` block with pytest-style test functions."
    ),
    "e2e": (
        "Generate runnable pytest end-to-end style tests for the uploaded files. "
        "Focus on realistic user-facing flows, system outcomes, and multi-step behavior that can be inferred from the code. "
        "Return only Python code in a single ```python``` block with pytest-style test functions."
    ),
    "mixed": (
        "Generate a small mixed pack of runnable pytest tests covering unit, integration, and end-to-end style behavior for the uploaded files. "
        "Return only Python code in a single ```python``` block with pytest-style test functions."
    ),
}
DEFAULT_INSTRUCTIONS = (
    "You are generating software tests and then the system will verify whether they are grounded in the uploaded files. "
    "Use only the provided file context. "
    "Do not invent APIs, symbols, workflows, or assertions that are not supported by the uploaded files."
)
MAX_FILES = 8
MAX_CHARS_PER_FILE = 12000
MAX_TOTAL_CHARS = 48000


@dataclass(frozen=True)
class UploadedContextFile:
    path: str
    content: str
    size_bytes: int
    line_count: int
    is_test_file: bool
    truncated: bool = False


class UploadedFilePromptCodec(PromptCodec):
    def build_prompt(self, data_handler: DataHandler, indexes: IndexSelection):
        view = data_handler.get_data(indexes, mask=False, exclude_permanent_keys=False)
        instructions = str(view.get(INSTRUCTIONS_KEY, DEFAULT_INSTRUCTIONS))
        prompt = str(view.get(PROMPT_KEY, "")).strip()
        api_map = str(view.get(API_MAP_KEY, "")).strip()
        file_blocks = []
        for key, value in view.items():
            if key in {INSTRUCTIONS_KEY, PROMPT_KEY, API_MAP_KEY}:
                continue
            file_blocks.append(f"[{key}]\n{value}")

        context = "\n\n".join(file_blocks) if file_blocks else "[no-files]\nNo uploaded file context."
        return [
            {
                "role": "system",
                "content": instructions,
            },
            {
                "role": "user",
                "content": (
                    "You are analyzing uploaded repository files for testing and impact.\n"
                    "Use only the uploaded files below.\n\n"
                    f"Task:\n{prompt}\n\n"
                    f"Available Python API map:\n{api_map or '[no-python-api-map] No Python modules were detected.'}\n\n"
                    f"Uploaded file context:\n{context}"
                ),
            },
        ]

    def parse_generation(self, model_output: str) -> Generation:
        return Generation(output=model_output)


def prepare_uploaded_files(
    raw_files: list[tuple[str, bytes]],
    *,
    max_files: int = MAX_FILES,
    max_chars_per_file: int = MAX_CHARS_PER_FILE,
    max_total_chars: int = MAX_TOTAL_CHARS,
) -> list[UploadedContextFile]:
    if not raw_files:
        raise ValueError("Please upload at least one file.")
    if len(raw_files) > max_files:
        raise ValueError(f"Please upload at most {max_files} files for this MVP.")

    prepared: list[UploadedContextFile] = []
    total_chars = 0
    for original_path, raw_content in raw_files:
        path = (original_path or "uploaded-file").strip() or "uploaded-file"
        decoded_content = raw_content.decode("utf-8", errors="ignore")
        remaining_budget = max(0, max_total_chars - total_chars)
        if remaining_budget == 0:
            raise ValueError("Uploaded content is too large for this MVP. Reduce file size or file count.")

        allowed_chars = min(max_chars_per_file, remaining_budget)
        truncated = len(decoded_content) > allowed_chars
        content = decoded_content[:allowed_chars]
        if truncated:
            content += "\n\n[truncated for MVP]"

        total_chars += len(content)
        prepared.append(
            UploadedContextFile(
                path=path,
                content=content,
                size_bytes=len(raw_content),
                line_count=content.count("\n") + (1 if content else 0),
                is_test_file=_is_test_file(path),
                truncated=truncated,
            )
        )
    return prepared


def analyze_uploaded_files(
    *,
    files: list[UploadedContextFile],
    test_mode: str,
    llm: LLMInterface,
    prompt_override: str | None = None,
    instructions_override: str | None = None,
) -> dict:
    if not files:
        raise ValueError("Please upload at least one file.")
    if test_mode not in TEST_MODE_PROMPTS:
        raise ValueError(f"Unsupported test mode: {test_mode}")

    resolved_prompt = (prompt_override or TEST_MODE_PROMPTS[test_mode]).strip()
    resolved_instructions = (instructions_override or DEFAULT_INSTRUCTIONS).strip()

    data = {
        INSTRUCTIONS_KEY: resolved_instructions,
        PROMPT_KEY: resolved_prompt,
        API_MAP_KEY: _build_api_map(files),
    }
    for uploaded_file in files:
        data[uploaded_file.path] = _format_uploaded_file(uploaded_file)

    data_handler = DataHandler(data, permanent_keys={INSTRUCTIONS_KEY, PROMPT_KEY, API_MAP_KEY})
    sampler, sampler_name = _select_sampler(len(files))
    attribution = ShapleyAttribution(
        model=llm,
        data_handler=data_handler,
        prompt_codec=UploadedFilePromptCodec(),
        sampler=sampler,
        use_cache=True,
        verbose=False,
        num_threads=min(8, max(2, len(files) + 1)),
        value_function=TFIDFCosineSimilarity(),
    ).attribution()

    weighted_files = _build_weighted_files(files, attribution.attribution)
    statistics = _build_statistics(
        weighted_files=weighted_files,
        answer=attribution.output,
        sampler_name=sampler_name,
    )
    extracted_tests = parse_generated_tests(attribution.output)
    verification = verify_answer_grounding(attribution.output, files)
    execution = run_generated_tests(attribution.output, files)
    preflight = _build_preflight_assessment(extracted_tests, verification, files)
    trust_assessment = _build_trust_assessment(
        weighted_files=weighted_files,
        verification=verification,
        execution=execution,
    )
    return {
        "test_mode": test_mode,
        "prompt": resolved_prompt,
        "api_map": data[API_MAP_KEY],
        "answer": attribution.output,
        "sampler": sampler_name,
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
        "top_test_files": [item for item in weighted_files if item["is_test_file"]][:3],
    }


def _format_uploaded_file(uploaded_file: UploadedContextFile) -> str:
    return (
        f"path: {uploaded_file.path}\n"
        f"lines: {uploaded_file.line_count}\n"
        f"is_test_file: {uploaded_file.is_test_file}\n\n"
        f"{uploaded_file.content}"
    )


def _build_api_map(files: list[UploadedContextFile]) -> str:
    modules = []
    for uploaded_file in files:
        if not uploaded_file.path.endswith(".py"):
            continue
        module_name = _python_module_name(uploaded_file.path)
        if not module_name:
            continue
        exports = _python_exports(uploaded_file.content)
        modules.append(
            {
                "module": module_name,
                "path": uploaded_file.path,
                "functions": exports["functions"],
                "classes": exports["classes"],
                "constants": exports["constants"],
            }
        )

    if not modules:
        return "[no-python-api-map] No Python modules were detected."

    lines = ["Use these exact import paths and symbol names when generating pytest code."]
    for module in sorted(modules, key=lambda item: item["module"]):
        lines.append(f"- module: {module['module']} ({module['path']})")
        lines.append(f"  functions: {', '.join(module['functions']) if module['functions'] else '[none]'}")
        lines.append(f"  classes: {', '.join(module['classes']) if module['classes'] else '[none]'}")
        lines.append(f"  constants: {', '.join(module['constants']) if module['constants'] else '[none]'}")
    return "\n".join(lines)


def _python_module_name(path: str) -> str:
    normalized = path.replace("\\", "/").strip("/")
    if not normalized.endswith(".py"):
        return ""
    module_path = normalized[:-3]
    if module_path.endswith("/__init__"):
        module_path = module_path[: -len("/__init__")]
    return module_path.replace("/", ".")


def _python_exports(content: str) -> dict[str, list[str]]:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return {
            "functions": [],
            "classes": [],
            "constants": [],
        }

    functions: list[str] = []
    classes: list[str] = []
    constants: list[str] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            functions.append(node.name)
        elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
            classes.append(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    constants.append(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id.isupper():
            constants.append(node.target.id)

    return {
        "functions": sorted(set(functions)),
        "classes": sorted(set(classes)),
        "constants": sorted(set(constants)),
    }


def _select_sampler(file_count: int):
    if file_count <= 4:
        return FullEnumerationSampler(file_count), "full_enumeration"
    return CounterfactualSampler(), "counterfactual"


def _build_weighted_files(files: list[UploadedContextFile], raw_attribution: dict) -> list[dict]:
    scores_by_path = {
        path: float(payload.get("score", 0.0))
        for path, payload in raw_attribution.items()
        if path not in {INSTRUCTIONS_KEY, PROMPT_KEY, API_MAP_KEY}
    }
    total_abs_score = sum(abs(score) for score in scores_by_path.values())

    weighted_files = []
    for uploaded_file in files:
        raw_score = scores_by_path.get(uploaded_file.path, 0.0)
        weight = abs(raw_score) / total_abs_score if total_abs_score > 0 else 0.0
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


def _build_statistics(*, weighted_files: list[dict], answer: str, sampler_name: str) -> dict:
    total_weight_on_tests = sum(item["weight"] for item in weighted_files if item["is_test_file"])
    top_supporting_files = [item["path"] for item in weighted_files[:3]]
    top_test_files = [item["path"] for item in weighted_files if item["is_test_file"]][:3]
    weights = [item["weight"] for item in weighted_files]

    return {
        "sampler": sampler_name,
        "total_files": len(weighted_files),
        "test_file_count": sum(1 for item in weighted_files if item["is_test_file"]),
        "total_lines": sum(item["line_count"] for item in weighted_files),
        "total_weight_on_tests": total_weight_on_tests,
        "total_weight_on_non_tests": max(0.0, 1.0 - total_weight_on_tests) if weights else 0.0,
        "max_weight": max(weights) if weights else 0.0,
        "mean_weight": mean(weights) if weights else 0.0,
        "top_supporting_files": top_supporting_files,
        "top_test_files": top_test_files,
        "answer_characters": len(answer),
    }


def _build_trust_assessment(*, weighted_files: list[dict], verification: dict, execution: dict) -> dict:
    weight_by_path = {item["path"]: float(item["weight"]) for item in weighted_files}
    evidence_weight_coverage = sum(
        weight_by_path.get(item["path"], 0.0)
        for item in verification.get("top_evidence_files", [])
    )
    evidence_weight_coverage = min(1.0, evidence_weight_coverage)

    supported_claim_ratio = float(verification.get("supported_claim_ratio", 0.0))
    groundedness_score = float(verification.get("groundedness_score", 0.0))
    context_relevance_score = float(verification.get("context_relevance_score", 0.0))
    execution_score = _execution_score(execution)
    etv_score, etv_breakdown = _effective_test_value(verification, execution)

    reliability_score = (
        0.28 * supported_claim_ratio
        + 0.22 * groundedness_score
        + 0.15 * context_relevance_score
        + 0.15 * evidence_weight_coverage
        + 0.20 * execution_score
    )

    if reliability_score >= 0.62:
        verdict = "reliable"
        message = "The generated tests look well-grounded in the uploaded files."
    elif reliability_score >= 0.38:
        verdict = "needs_review"
        message = "Some evidence supports the generated tests, but they still need manual review."
    else:
        verdict = "ghost_risk"
        message = "The generated tests look weakly supported and may be ghost tests."

    return {
        "verdict": verdict,
        "message": message,
        "reliability_score": reliability_score,
        "thresholds": {
            "reliable_min": 0.62,
            "needs_review_min": 0.38,
        },
        "components": {
            "supported_claim_ratio": supported_claim_ratio,
            "groundedness_score": groundedness_score,
            "context_relevance_score": context_relevance_score,
            "evidence_weight_coverage": evidence_weight_coverage,
            "execution_score": execution_score,
            "etv_score": etv_score,
            "etv_breakdown": etv_breakdown,
        },
    }


def _execution_score(execution: dict) -> float:
    status = execution.get("status")
    if status == "passed":
        return 1.0
    if status == "failed":
        test_count = max(1, int(execution.get("test_count", 0)))
        passed = int(execution.get("passed", 0))
        return passed / test_count
    if status in {"invalid_test_code", "no_tests_detected", "timeout"}:
        return 0.0
    if status == "no_tests_collected":
        return 0.05
    return 0.0


def _effective_test_value(verification: dict, execution: dict) -> tuple[float, dict]:
    claim_checks = {item.get("claim"): item for item in verification.get("claim_checks", [])}
    execution_results = {item.get("name"): item for item in execution.get("per_test_results", [])}
    test_names = sorted({*claim_checks.keys(), *execution_results.keys()} - {None})

    if not test_names:
        return 0.0, {
            "total_tests": 0,
            "keepers": 0,
            "salvageable": 0,
            "risky": 0,
        }

    keepers = 0
    salvageable = 0
    risky = 0

    for test_name in test_names:
        grounded_status = str(claim_checks.get(test_name, {}).get("status", "unsupported"))
        execution_status = str(execution_results.get(test_name, {}).get("status", "unknown"))

        if grounded_status == "supported" and execution_status == "passed":
            keepers += 1
        elif (
            grounded_status == "supported"
            or (grounded_status == "borderline" and execution_status == "passed")
        ):
            salvageable += 1
        else:
            risky += 1

    total_tests = len(test_names)
    score = (keepers + (0.5 * salvageable)) / total_tests
    return score, {
        "total_tests": total_tests,
        "keepers": keepers,
        "salvageable": salvageable,
        "risky": risky,
    }


def _build_preflight_assessment(extracted_tests: dict, verification: dict, files: list[UploadedContextFile]) -> dict:
    if extracted_tests.get("syntax_error"):
        return {
            "status": "invalid",
            "message": extracted_tests["syntax_error"],
            "missing_imports": [],
            "missing_symbols": [],
            "total_generated_tests": 0,
        }

    available_modules = _available_modules(files)
    stdlib_modules = set(getattr(sys, "stdlib_module_names", set()))
    allowed_modules = available_modules | stdlib_modules | {"pytest"}
    imported_modules = set(extracted_tests.get("module_imports", []))
    missing_imports = sorted(module for module in imported_modules if module not in allowed_modules)

    missing_symbols = sorted(
        {
            symbol
            for claim in verification.get("claim_checks", [])
            for symbol in claim.get("missing_symbols", [])
        }
    )

    if missing_imports or missing_symbols:
        status = "issues_found"
        message = "Some generated tests reference imports or symbols that were not found in the uploaded files."
    else:
        status = "clear"
        message = "No obvious missing imports or symbols were found before execution."

    return {
        "status": status,
        "message": message,
        "missing_imports": missing_imports,
        "missing_symbols": missing_symbols,
        "total_generated_tests": int(extracted_tests.get("test_count", len(extracted_tests.get("test_cases", [])))),
    }


def _available_modules(files: list[UploadedContextFile]) -> set[str]:
    modules: set[str] = set()
    for uploaded_file in files:
        normalized = uploaded_file.path.replace("\\", "/")
        if not normalized.endswith(".py"):
            continue
        module = normalized[:-3].replace("/", ".")
        _add_module_with_parents(modules, module)
        if module.startswith("src."):
            _add_module_with_parents(modules, module.removeprefix("src."))
    return modules


def _add_module_with_parents(modules: set[str], module: str) -> None:
    modules.add(module)
    parts = module.split(".")
    for index in range(1, len(parts)):
        modules.add(".".join(parts[:index]))


def _is_test_file(path: str) -> bool:
    normalized = path.replace("\\", "/").lower()
    filename = os.path.basename(normalized)
    return (
        "/tests/" in normalized
        or normalized.startswith("tests/")
        or filename.startswith("test_")
        or filename.endswith("_test.py")
        or ".spec." in filename
        or ".test." in filename
    )
