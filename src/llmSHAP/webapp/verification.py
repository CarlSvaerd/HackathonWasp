from __future__ import annotations

import re
from typing import TYPE_CHECKING, Iterable

from llmSHAP import Generation, TFIDFCosineSimilarity
from llmSHAP.webapp.test_artifacts import GeneratedTestCase, parse_generated_tests

if TYPE_CHECKING:
    from llmSHAP.webapp.analysis import UploadedContextFile


SUPPORTED_THRESHOLD = 0.55
BORDERLINE_THRESHOLD = 0.3
SNIPPET_LINE_COUNT = 8
SNIPPET_OVERLAP = 2


def verify_answer_grounding(answer: str, files: list[UploadedContextFile]) -> dict:
    parsed_tests = parse_generated_tests(answer)
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
                    "claim": "No runnable pytest tests could be verified from the generated output.",
                    "status": "unsupported",
                    "confidence": 0.0,
                    "evidence": None,
                    "mentioned_symbols": [],
                    "missing_symbols": [],
                }
            ],
            "top_evidence_files": [],
        }

    test_cases: list[GeneratedTestCase] = parsed_tests["test_cases"]
    if not test_cases:
        return {
            "verdict": "ghost_risk",
            "message": "No pytest-style tests were found in the generated output.",
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
                    "claim": "The generated output did not contain pytest test functions.",
                    "status": "unsupported",
                    "confidence": 0.0,
                    "evidence": None,
                    "mentioned_symbols": [],
                    "missing_symbols": [],
                }
            ],
            "top_evidence_files": [],
        }

    snippets = _build_snippets(files)
    symbol_index = _build_symbol_index(files)
    file_stems = {file.path.rsplit("/", 1)[-1].rsplit(".", 1)[0]: file.path for file in files}
    similarity = TFIDFCosineSimilarity()

    claim_checks = []
    file_hits: dict[str, dict[str, float | int]] = {}
    for test_case in test_cases:
        best_match = _best_matching_snippet(test_case.source, snippets, similarity)
        tfidf_score = float(best_match["score"]) if best_match is not None else 0.0
        grounded_symbols = [symbol for symbol in test_case.referenced_symbols if symbol in symbol_index]
        missing_symbols = [symbol for symbol in test_case.referenced_symbols if symbol not in symbol_index]
        symbol_coverage = len(grounded_symbols) / len(test_case.referenced_symbols) if test_case.referenced_symbols else 0.0
        imported_local_modules = [module for module in test_case.imported_modules if module in file_stems]
        import_coverage = len(imported_local_modules) / len(test_case.imported_modules) if test_case.imported_modules else 0.0
        assertion_score = 1.0 if test_case.assertion_count > 0 else 0.0
        confidence = (
            0.45 * symbol_coverage
            + 0.25 * import_coverage
            + 0.15 * assertion_score
            + 0.15 * tfidf_score
        )
        label = _support_label(confidence)
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
            }
        )
        if best_match is not None:
            hit = file_hits.setdefault(
                str(best_match["path"]),
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


def _build_symbol_index(files: list[UploadedContextFile]) -> dict[str, set[str]]:
    symbol_index: dict[str, set[str]] = {}
    for uploaded_file in files:
        path = uploaded_file.path
        for symbol in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b", uploaded_file.content):
            symbol_index.setdefault(symbol, set()).add(path)
    return symbol_index


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
