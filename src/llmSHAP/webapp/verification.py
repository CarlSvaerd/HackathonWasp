from __future__ import annotations

import ast
import re
from typing import TYPE_CHECKING, Iterable

from llmSHAP import Generation, TFIDFCosineSimilarity
from llmSHAP.webapp.test_artifacts import GeneratedTestCase, parse_generated_tests, parse_python_test_source

if TYPE_CHECKING:
    from llmSHAP.webapp.analysis import UploadedContextFile


SUPPORTED_THRESHOLD = 0.55
BORDERLINE_THRESHOLD = 0.3
SNIPPET_LINE_COUNT = 8
SNIPPET_OVERLAP = 2


def verify_answer_grounding(answer: str, files: list[UploadedContextFile]) -> dict:
    return _verify_parsed_grounding(answer, parse_generated_tests(answer), files)


def verify_python_test_source_grounding(test_source: str, files: list[UploadedContextFile]) -> dict:
    return _verify_parsed_grounding(test_source, parse_python_test_source(test_source), files)


def _verify_parsed_grounding(answer: str, parsed_tests: dict, files: list[UploadedContextFile]) -> dict:
    if parsed_tests["syntax_error"]:
        return {
            "verdict": "ghost_risk",
            "message": parsed_tests["syntax_error"],
            "groundedness_score": 0.0,
            "context_relevance_score": 0.0,
            "supported_claim_ratio": 0.0,
            "unsupported_claim_ratio": 1.0,
            "supported_claims": 0,
            "borderline_claims": 0,
            "unsupported_claims": 1,
            "total_claims": 1,
            "claim_checks": [
                {
                    "claim": "No runnable Python tests could be verified from the test source.",
                    "status": "unsupported",
                    "confidence": 0.0,
                    "evidence": None,
                    "mentioned_symbols": [],
                    "missing_symbols": [],
                    "framework": "unknown",
                    "assertion_count": 0,
                    "assertion_styles": [],
                    "risk_categories": ["invalid_test_code"],
                    "recommendation": "Fix the Python syntax so Ghost Test Catcher can parse, ground, and execute the tests.",
                }
            ],
            "top_evidence_files": [],
        }

    test_cases: list[GeneratedTestCase] = parsed_tests["test_cases"]
    if not test_cases:
        return {
            "verdict": "ghost_risk",
            "message": "No Python test functions or unittest methods were found in the test source.",
            "groundedness_score": 0.0,
            "context_relevance_score": 0.0,
            "supported_claim_ratio": 0.0,
            "unsupported_claim_ratio": 1.0,
            "supported_claims": 0,
            "borderline_claims": 0,
            "unsupported_claims": 1,
            "total_claims": 1,
            "claim_checks": [
                {
                    "claim": "The test source did not contain collectable Python tests.",
                    "status": "unsupported",
                    "confidence": 0.0,
                    "evidence": None,
                    "mentioned_symbols": [],
                    "missing_symbols": [],
                    "framework": "unknown",
                    "assertion_count": 0,
                    "assertion_styles": [],
                    "risk_categories": ["no_tests_detected"],
                    "recommendation": "Add top-level def test_* functions or unittest.TestCase methods named test_* so the runner can collect them.",
                }
            ],
            "top_evidence_files": [],
        }

    snippets = _build_snippets(files)
    symbol_index = _build_symbol_index(files)
    file_stems = {file.path.rsplit("/", 1)[-1].rsplit(".", 1)[0]: file.path for file in files}
    module_aliases = _build_module_aliases(files)
    similarity = TFIDFCosineSimilarity()

    claim_checks = []
    file_hits: dict[str, dict[str, float | int]] = {}
    for test_case in test_cases:
        best_match = _best_matching_snippet(test_case.source, snippets, similarity)
        tfidf_score = float(best_match["score"]) if best_match is not None else 0.0
        grounded_symbols = [symbol for symbol in test_case.referenced_symbols if symbol in symbol_index]
        missing_symbols = [symbol for symbol in test_case.referenced_symbols if symbol not in symbol_index]
        evidence_symbols = _format_symbol_evidence(grounded_symbols, symbol_index)
        symbol_coverage = len(grounded_symbols) / len(test_case.referenced_symbols) if test_case.referenced_symbols else 0.0
        imported_local_modules = [
            module
            for module in test_case.imported_modules
            if module in module_aliases or module.split(".", 1)[0] in file_stems
        ]
        import_coverage = len(imported_local_modules) / len(test_case.imported_modules) if test_case.imported_modules else 0.0
        assertion_score = 1.0 if test_case.assertion_count > 0 else 0.0
        confidence = (
            0.45 * symbol_coverage
            + 0.25 * import_coverage
            + 0.15 * assertion_score
            + 0.15 * tfidf_score
        )
        label = _support_label(confidence)
        risk_categories = _risk_categories(
            test_case=test_case,
            missing_symbols=missing_symbols,
            tfidf_score=tfidf_score,
            symbol_coverage=symbol_coverage,
            imported_local_modules=imported_local_modules,
            label=label,
        )
        claim_checks.append(
            {
                "claim": test_case.name,
                "status": label,
                "confidence": confidence,
                "evidence": None
                if best_match is None
                else {
                    "path": best_match["path"],
                    "start_line": best_match["start_line"],
                    "end_line": best_match["end_line"],
                    "snippet": best_match["snippet"],
                },
                "mentioned_symbols": test_case.referenced_symbols,
                "missing_symbols": missing_symbols,
                "evidence_symbols": evidence_symbols,
                "framework": test_case.framework,
                "assertion_count": test_case.assertion_count,
                "assertion_styles": test_case.assertion_styles or [],
                "risk_categories": risk_categories,
                "recommendation": _recommendation(risk_categories, missing_symbols),
            }
        )
        if best_match is not None:
            hit = file_hits.setdefault(
                str(best_match["path"]),
                {"claims": 0, "max_confidence": 0.0},
            )
            hit["claims"] = int(hit["claims"]) + 1
            hit["max_confidence"] = max(float(hit["max_confidence"]), confidence)
        for location in _first_symbol_locations(grounded_symbols, symbol_index):
            hit = file_hits.setdefault(
                str(location["path"]),
                {"claims": 0, "max_confidence": 0.0},
            )
            hit["claims"] = int(hit["claims"]) + 1
            hit["max_confidence"] = max(float(hit["max_confidence"]), confidence)

    supported_count = sum(1 for item in claim_checks if item["status"] == "supported")
    borderline_count = sum(1 for item in claim_checks if item["status"] == "borderline")
    unsupported_count = sum(1 for item in claim_checks if item["status"] == "unsupported")
    total_claims = len(claim_checks)

    supported_ratio = supported_count / total_claims if total_claims else 0.0
    unsupported_ratio = unsupported_count / total_claims if total_claims else 0.0
    average_confidence = (
        sum(float(item["confidence"]) for item in claim_checks) / total_claims if total_claims else 0.0
    )
    overall_context_similarity = _overall_context_similarity(answer, files, similarity)
    verdict, message = _trust_verdict(
        supported_ratio=supported_ratio,
        unsupported_ratio=unsupported_ratio,
        average_confidence=average_confidence,
        overall_context_similarity=overall_context_similarity,
    )

    top_evidence_files = [
        {
            "path": path,
            "claims": int(payload["claims"]),
            "max_confidence": float(payload["max_confidence"]),
        }
        for path, payload in sorted(
            file_hits.items(),
            key=lambda item: (-float(item[1]["claims"]), -float(item[1]["max_confidence"]), item[0]),
        )[:3]
    ]

    return {
        "verdict": verdict,
        "message": message,
        "groundedness_score": average_confidence,
        "context_relevance_score": overall_context_similarity,
        "supported_claim_ratio": supported_ratio,
        "unsupported_claim_ratio": unsupported_ratio,
        "supported_claims": supported_count,
        "borderline_claims": borderline_count,
        "unsupported_claims": unsupported_count,
        "total_claims": total_claims,
        "claim_checks": claim_checks,
        "top_evidence_files": top_evidence_files,
    }


def _build_snippets(files: list[UploadedContextFile]) -> list[dict]:
    snippets = []
    step = max(1, SNIPPET_LINE_COUNT - SNIPPET_OVERLAP)
    for uploaded_file in files:
        lines = uploaded_file.content.splitlines()
        if not lines:
            continue
        for start_index in range(0, len(lines), step):
            end_index = min(len(lines), start_index + SNIPPET_LINE_COUNT)
            snippet = "\n".join(lines[start_index:end_index]).strip()
            if snippet:
                snippets.append(
                    {
                        "path": uploaded_file.path,
                        "start_line": start_index + 1,
                        "end_line": end_index,
                        "snippet": snippet,
                    }
                )
            if end_index >= len(lines):
                break
    return snippets


def _build_symbol_index(files: list[UploadedContextFile]) -> dict[str, list[dict]]:
    symbol_index: dict[str, list[dict]] = {}
    for uploaded_file in files:
        path = uploaded_file.path
        if path.endswith(".py"):
            try:
                tree = ast.parse(uploaded_file.content)
            except SyntaxError:
                tree = None
            if tree is not None:
                _index_python_symbols(symbol_index, tree, path)
                continue
        for symbol in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b", uploaded_file.content):
            _add_symbol_location(symbol_index, symbol, path=path, line=1, kind="text")
    return symbol_index


def _index_python_symbols(symbol_index: dict[str, list[dict]], tree: ast.Module, path: str) -> None:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "private_function" if node.name.startswith("_") else "function"
            _add_symbol_location(symbol_index, node.name, path=path, line=node.lineno, kind=kind)
        elif isinstance(node, ast.ClassDef):
            class_kind = "private_class" if node.name.startswith("_") else "class"
            _add_symbol_location(symbol_index, node.name, path=path, line=node.lineno, kind=class_kind)
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    method_kind = "private_method" if child.name.startswith("_") else f"method:{node.name}"
                    _add_symbol_location(symbol_index, child.name, path=path, line=child.lineno, kind=method_kind)
                    _add_symbol_location(
                        symbol_index,
                        f"{node.name}.{child.name}",
                        path=path,
                        line=child.lineno,
                        kind="method",
                    )
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                for name in _target_names(target):
                    _add_symbol_location(symbol_index, name, path=path, line=node.lineno, kind="variable")
        elif isinstance(node, ast.AnnAssign):
            for name in _target_names(node.target):
                _add_symbol_location(symbol_index, name, path=path, line=node.lineno, kind="variable")
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                exposed_name = alias.asname or alias.name.split(".", 1)[0]
                _add_symbol_location(symbol_index, exposed_name, path=path, line=node.lineno, kind="import")


def _target_names(target: ast.AST) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names: list[str] = []
        for item in target.elts:
            names.extend(_target_names(item))
        return names
    return []


def _add_symbol_location(symbol_index: dict[str, list[dict]], symbol: str, *, path: str, line: int, kind: str) -> None:
    if not symbol or len(symbol) <= 2:
        return
    location = {"path": path, "line": line, "kind": kind}
    locations = symbol_index.setdefault(symbol, [])
    if location not in locations:
        locations.append(location)


def _format_symbol_evidence(grounded_symbols: list[str], symbol_index: dict[str, list[dict]]) -> list[str]:
    evidence = []
    for symbol in grounded_symbols:
        locations = symbol_index.get(symbol) or []
        if locations:
            location = locations[0]
            evidence.append(f"{symbol} -> {location['path']}:{location['line']} ({location['kind']})")
    return evidence


def _first_symbol_locations(grounded_symbols: list[str], symbol_index: dict[str, list[dict]]) -> list[dict]:
    locations = []
    seen_paths: set[str] = set()
    for symbol in grounded_symbols:
        symbol_locations = symbol_index.get(symbol) or []
        if not symbol_locations:
            continue
        location = symbol_locations[0]
        path = str(location["path"])
        if path not in seen_paths:
            locations.append(location)
            seen_paths.add(path)
    return locations


def _build_module_aliases(files: list[UploadedContextFile]) -> set[str]:
    aliases: set[str] = set()
    for uploaded_file in files:
        normalized = uploaded_file.path.replace("\\", "/").strip("/")
        if not normalized.endswith(".py"):
            continue
        module = normalized[:-3].replace("/", ".")
        _add_module_aliases(aliases, module)
        if module.startswith("src."):
            _add_module_aliases(aliases, module.removeprefix("src."))
    return aliases


def _add_module_aliases(aliases: set[str], module: str) -> None:
    aliases.add(module)
    parts = module.split(".")
    for index in range(1, len(parts)):
        aliases.add(".".join(parts[:index]))


def _best_matching_snippet(claim: str, snippets: list[dict], similarity: TFIDFCosineSimilarity) -> dict | None:
    best_match = None
    best_score = -1.0
    claim_generation = Generation(output=claim)
    for snippet in snippets:
        score = similarity(claim_generation, Generation(output=str(snippet["snippet"])))
        if score > best_score:
            best_score = score
            best_match = {
                "path": snippet["path"],
                "start_line": snippet["start_line"],
                "end_line": snippet["end_line"],
                "snippet": snippet["snippet"],
                "score": score,
            }
    return best_match


def _support_label(score: float) -> str:
    if score >= SUPPORTED_THRESHOLD:
        return "supported"
    if score >= BORDERLINE_THRESHOLD:
        return "borderline"
    return "unsupported"


def _risk_categories(
    *,
    test_case: GeneratedTestCase,
    missing_symbols: list[str],
    tfidf_score: float,
    symbol_coverage: float,
    imported_local_modules: list[str],
    label: str,
) -> list[str]:
    categories: list[str] = []
    if missing_symbols:
        categories.append("missing_symbols")
    if test_case.assertion_count <= 0:
        categories.append("weak_assertion")
    if test_case.referenced_symbols and symbol_coverage < 0.5:
        categories.append("low_symbol_coverage")
    if tfidf_score < 0.15:
        categories.append("weak_context_match")
    if test_case.imported_modules and not imported_local_modules:
        categories.append("no_local_import")
    source = test_case.source.lower()
    if (
        any(marker in source for marker in ["mock(", "magicmock", "patch(", "monkeypatch"])
        and symbol_coverage < 0.75
    ):
        categories.append("heavy_mocking")
    if not categories and label == "supported":
        categories.append("grounded")
    return categories or ["needs_review"]


def _recommendation(risk_categories: list[str], missing_symbols: list[str]) -> str:
    if "missing_symbols" in risk_categories:
        missing = ", ".join(missing_symbols[:4])
        suffix = f" Missing symbols: {missing}." if missing else ""
        return (
            "Point the test at APIs that exist in the selected source context, or include the implementation files "
            f"that define the missing APIs.{suffix}"
        )
    if "no_local_import" in risk_categories:
        return "Verify that the test imports project modules from the selected source paths, not only external or invented modules."
    if "weak_assertion" in risk_categories:
        return "Add a concrete assertion or expected exception check so the test proves behavior instead of only executing code."
    if "heavy_mocking" in risk_categories:
        return "Reduce mocks or connect the test to a real project symbol so the behavior remains grounded in implementation code."
    if "low_symbol_coverage" in risk_categories:
        return "Rewrite the test to call source symbols that Ghost Test Catcher can locate, or expand the source context."
    if "weak_context_match" in risk_categories:
        return "Review the nearest evidence snippet and tighten the test name, imports, or assertions to match the implementation."
    if "grounded" in risk_categories:
        return "Keep this test candidate; it imports real project code, asserts behavior, and has supporting source evidence."
    return "Manually review this test before trusting it; the available evidence is not strong enough for an automatic keep decision."


def _overall_context_similarity(
    answer: str,
    files: Iterable[UploadedContextFile],
    similarity: TFIDFCosineSimilarity,
) -> float:
    combined_context = "\n\n".join(f"{item.path}\n{item.content}" for item in files).strip()
    if not answer.strip() or not combined_context:
        return 0.0
    return similarity(Generation(output=answer), Generation(output=combined_context))


def _trust_verdict(
    *,
    supported_ratio: float,
    unsupported_ratio: float,
    average_confidence: float,
    overall_context_similarity: float,
) -> tuple[str, str]:
    if supported_ratio >= 0.75 and average_confidence >= 0.35 and overall_context_similarity >= 0.2:
        return "grounded", "Most claims appear to be supported by the uploaded files."
    if unsupported_ratio >= 0.5 or average_confidence < 0.18 or overall_context_similarity < 0.1:
        return "ghost_risk", "Large parts of the answer are weakly grounded or unrelated to the uploaded files."
    return "mixed", "Some parts of the answer are grounded, but a few claims need manual verification."
