from __future__ import annotations

from llmSHAP.codebase.indexer import CodeChunk


PROMPT_TEMPLATE = """You are answering questions about a software repository.
Use only the provided repository context.
If the answer is not supported by the context, say you do not know.

Question:
{question}

Repository context:
{context}
"""


def format_chunk_reference(chunk: CodeChunk) -> str:
    return f"{chunk.path}:{chunk.start_line}-{chunk.end_line}"


def build_repository_prompt(question: str, chunks: list[CodeChunk]) -> str:
    context_blocks = [
        f"[{chunk.chunk_id} | {format_chunk_reference(chunk)}]\n{chunk.text}"
        for chunk in chunks
    ]
    context = "\n\n".join(context_blocks) if context_blocks else "[no-context]\nNo repository context was retrieved."
    return PROMPT_TEMPLATE.format(question=question.strip(), context=context)
