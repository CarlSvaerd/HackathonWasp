from __future__ import annotations

from llmSHAP.ghost.workspace import collect_files


def test_collect_files_preserves_explicit_source_priority(tmp_path) -> None:
    repo = tmp_path / "repo"
    source_dir = repo / "src"
    source_dir.mkdir(parents=True)
    (source_dir / "a.py").write_text("def a():\n    return 'a'\n", encoding="utf-8")
    (source_dir / "b.py").write_text("def b():\n    return 'b'\n", encoding="utf-8")

    files = collect_files(
        repo,
        ["src/b.py", "src"],
        max_files=2,
        max_chars_per_file=1000,
        max_total_chars=2000,
        file_role="source",
    )

    assert [item.path for item in files] == ["src/b.py", "src/a.py"]
