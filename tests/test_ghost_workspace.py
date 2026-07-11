from __future__ import annotations

from llmSHAP.ghost.config import GhostTestCatcherConfig
from llmSHAP.ghost.workspace import collect_files, discover_source_specs, discover_test_specs


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


def test_collect_files_ignores_generated_directories_only_inside_project_root(tmp_path) -> None:
    repo = tmp_path / "dist" / "sample-project"
    source_dir = repo / "src"
    test_dir = repo / "tests"
    generated_dir = repo / "build"
    source_dir.mkdir(parents=True)
    test_dir.mkdir()
    generated_dir.mkdir()
    (source_dir / "calculator.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (test_dir / "test_calculator.py").write_text(
        "from src.calculator import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )
    (generated_dir / "ignored.py").write_text("def generated():\n    return True\n", encoding="utf-8")

    source_files = collect_files(
        repo,
        ["src"],
        max_files=10,
        max_chars_per_file=1000,
        max_total_chars=3000,
        file_role="source",
    )
    test_files = collect_files(
        repo,
        ["tests"],
        max_files=10,
        max_chars_per_file=1000,
        max_total_chars=3000,
        file_role="test",
    )
    discovered_sources = discover_source_specs(
        repo,
        GhostTestCatcherConfig(source_paths=["missing"], test_paths=["tests"]),
    )
    discovered_tests = discover_test_specs(
        repo,
        GhostTestCatcherConfig(source_paths=["src"], test_paths=["missing"]),
    )

    assert [item.path for item in source_files] == ["src/calculator.py"]
    assert [item.path for item in test_files] == ["tests/test_calculator.py"]
    assert discovered_sources == ["src/calculator.py"]
    assert discovered_tests == ["tests/test_calculator.py"]
