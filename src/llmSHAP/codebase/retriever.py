from __future__ import annotations

from llmSHAP.codebase.indexer import CodeChunk


SKLEARN_INSTALL_MESSAGE = (
    "Codebase retrieval requires scikit-learn.\n"
    "Install it with: pip install scikit-learn"
)


class TfidfChunkRetriever:
    def __init__(self, chunks: list[CodeChunk]):
        self._chunks = chunks

    def retrieve(self, question: str, *, top_k: int = 6) -> list[CodeChunk]:
        if not question.strip() or top_k <= 0 or not self._chunks:
            return []

        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.metrics.pairwise import cosine_similarity
        except ImportError as exc:
            raise ImportError(SKLEARN_INSTALL_MESSAGE) from exc

        vectorizer = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5))
        chunk_texts = [f"{chunk.path}\n{chunk.text}" for chunk in self._chunks]
        tfidf_matrix = vectorizer.fit_transform([*chunk_texts, question])
        similarities = cosine_similarity(tfidf_matrix[-1], tfidf_matrix[:-1]).ravel()
        ranked_indices = similarities.argsort()[::-1]

        limit = min(top_k, len(self._chunks))
        return [self._chunks[int(index)] for index in ranked_indices[:limit]]


def retrieve_chunks(chunks: list[CodeChunk], question: str, *, top_k: int = 6) -> list[CodeChunk]:
    return TfidfChunkRetriever(chunks).retrieve(question, top_k=top_k)
