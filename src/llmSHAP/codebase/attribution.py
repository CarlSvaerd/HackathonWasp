from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from llmSHAP.codebase.indexer import CodeChunk
from llmSHAP.codebase.prompting import build_repository_prompt
from llmSHAP.generation import Generation
from llmSHAP.value_functions import TFIDFCosineSimilarity


class SupportsGenerate(Protocol):
    def generate(self, prompt: str, tools=None, images=None) -> str: ...


@dataclass(frozen=True)
class ChunkAttribution:
    chunk_id: str
    path: str
    start_line: int
    end_line: int
    score: float


def explain_with_attribution(
    *,
    question: str,
    chunks: list[CodeChunk],
    llm: SupportsGenerate,
) -> tuple[str, list[ChunkAttribution]]:
    full_answer = llm.generate(build_repository_prompt(question, chunks))
    if not chunks:
        return full_answer, []

    similarity = TFIDFCosineSimilarity()
    full_generation = Generation(output=full_answer)

    raw_scores: list[float] = []
    for chunk_index, chunk in enumerate(chunks):
        perturbed_chunks = chunks[:chunk_index] + chunks[chunk_index + 1 :]
        perturbed_answer = llm.generate(build_repository_prompt(question, perturbed_chunks))
        perturbed_generation = Generation(output=perturbed_answer)
        score = max(0.0, 1.0 - similarity(full_generation, perturbed_generation))
        raw_scores.append(score)

    normalized_scores = _normalize_scores(raw_scores)
    ranked_attributions = [
        ChunkAttribution(
            chunk_id=chunk.chunk_id,
            path=chunk.path,
            start_line=chunk.start_line,
            end_line=chunk.end_line,
            score=score,
        )
        for chunk, score in zip(chunks, normalized_scores)
    ]
    ranked_attributions.sort(key=lambda item: item.score, reverse=True)
    return full_answer, ranked_attributions


def _normalize_scores(scores: list[float]) -> list[float]:
    if not scores:
        return []

    total = sum(scores)
    if total <= 0.0:
        uniform_score = 1.0 / len(scores)
        return [uniform_score for _ in scores]
    return [score / total for score in scores]
