from __future__ import annotations

from pathlib import Path

import pytest

from llmSHAP.codebase import CodeChunk, explain_with_attribution, index_repository, retrieve_chunks


def test_index_repository_ignores_filtered_directories_and_chunks_lines(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / "app.py").write_text("line1\nline2\nline3\nline4\nline5\n", encoding="utf-8")
    (repo_root / "README.md").write_text("# Title\nSome docs\n", encoding="utf-8")
    (repo_root / "node_modules").mkdir()
    (repo_root / "node_modules" / "ignored.js").write_text("console.log('ignore')\n", encoding="utf-8")

    chunks = index_repository(repo_root, chunk_size=3, overlap=1)

    paths = {chunk.path for chunk in chunks}
    assert "app.py" in paths
    assert "README.md" in paths
    assert "node_modules/ignored.js" not in paths
    app_chunks = [chunk for chunk in chunks if chunk.path == "app.py"]
    assert [(chunk.start_line, chunk.end_line) for chunk in app_chunks] == [(1, 3), (3, 5)]


def test_retrieve_chunks_returns_the_most_relevant_match() -> None:
    pytest.importorskip("sklearn")
    chunks = [
        CodeChunk(
            chunk_id="auth.py:1-3",
            path="auth.py",
            start_line=1,
            end_line=3,
            text="def authenticate(user, password):\n    return verify_password(user, password)",
        ),
        CodeChunk(
            chunk_id="billing.py:1-3",
            path="billing.py",
            start_line=1,
            end_line=3,
            text="def charge_customer(invoice):\n    return invoice.total",
        ),
    ]

    retrieved = retrieve_chunks(chunks, "Where is authentication handled?", top_k=1)

    assert [chunk.path for chunk in retrieved] == ["auth.py"]


def test_explain_with_attribution_normalizes_chunk_scores() -> None:
    class FakeLLM:
        def generate(self, prompt: str, tools=None, images=None) -> str:
            if "auth.py:1-3" in prompt and "docs/auth.md:1-2" in prompt:
                return "Authentication is implemented in auth.py and documented in docs/auth.md."
            if "auth.py:1-3" in prompt:
                return "Authentication is implemented in auth.py."
            if "docs/auth.md:1-2" in prompt:
                return "Authentication is documented in docs/auth.md."
            return "I do not know."

    chunks = [
        CodeChunk(
            chunk_id="auth.py:1-3",
            path="auth.py",
            start_line=1,
            end_line=3,
            text="def authenticate(user, password):\n    return verify_password(user, password)",
        ),
        CodeChunk(
            chunk_id="docs/auth.md:1-2",
            path="docs/auth.md",
            start_line=1,
            end_line=2,
            text="# Authentication\nThis file explains the login flow.",
        ),
    ]

    answer, attributions = explain_with_attribution(question="Where is authentication handled?", chunks=chunks, llm=FakeLLM())

    assert "auth.py" in answer
    assert len(attributions) == 2
    assert pytest.approx(sum(item.score for item in attributions), rel=1e-6) == 1.0
    assert {item.path for item in attributions} == {"auth.py", "docs/auth.md"}
