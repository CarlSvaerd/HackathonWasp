from __future__ import annotations

from pathlib import Path
from typing import Iterable

from llmSHAP.ghost.config import GhostTestCatcherConfig
from llmSHAP.webapp.analysis import UploadedContextFile, prepare_uploaded_files


PYTHON_EXTENSIONS = {".py"}
IGNORED_DIRECTORIES = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "site-packages",
    "venv",
}


def discover_source_specs(repo_root: str | Path, config: GhostTestCatcherConfig) -> list[str]:
    root = Path(repo_root).expanduser().resolve()
    existing = [spec for spec in config.source_paths if (root / spec).exists()]
    if existing:
        return existing
    return [
        path.relative_to(root).as_posix()
        for path in _iter_python_files(root)
        if not _is_test_path(path.relative_to(root).as_posix())
    ]


def discover_test_specs(repo_root: str | Path, config: GhostTestCatcherConfig) -> list[str]:
    root = Path(repo_root).expanduser().resolve()
    existing = [spec for spec in config.test_paths if (root / spec).exists()]
    if existing:
        return existing
    return [
        path.relative_to(root).as_posix()
        for path in _iter_python_files(root)
        if _is_test_path(path.relative_to(root).as_posix())
    ]


def collect_files(
    repo_root: str | Path,
    specs: Iterable[str],
    *,
    max_files: int,
    max_chars_per_file: int,
    max_total_chars: int,
    file_role: str = "auto",
) -> list[UploadedContextFile]:
    root = Path(repo_root).expanduser().resolve()
    paths = list(_resolve_specs(root, specs))
    raw_files = [
        (
            path.relative_to(root).as_posix(),
            path.read_bytes(),
        )
        for path in paths[:max_files]
    ]
    prepared = prepare_uploaded_files(
        raw_files,
        max_files=max_files,
        max_chars_per_file=max_chars_per_file,
        max_total_chars=max_total_chars,
    )
    if file_role == "auto":
        return prepared
    if file_role not in {"source", "test"}:
        raise ValueError("file_role must be 'auto', 'source', or 'test'.")
    return [
        UploadedContextFile(
            path=item.path,
            content=item.content,
            size_bytes=item.size_bytes,
            line_count=item.line_count,
            is_test_file=file_role == "test",
            truncated=item.truncated,
        )
        for item in prepared
    ]


def _resolve_specs(root: Path, specs: Iterable[str]) -> list[Path]:
    paths: dict[str, Path] = {}
    for spec in specs:
        if not str(spec).strip():
            continue
        candidate = (root / spec).resolve()
        if not _is_inside(candidate, root) or not candidate.exists():
            continue
        if candidate.is_file() and candidate.suffix in PYTHON_EXTENSIONS:
            paths[candidate.as_posix()] = candidate
        elif candidate.is_dir():
            for path in sorted(_iter_python_files(candidate), key=lambda item: item.as_posix()):
                if _is_inside(path, root):
                    paths[path.as_posix()] = path
    return list(paths.values())


def _iter_python_files(root: Path):
    root = root.resolve()
    for path in root.rglob("*.py"):
        try:
            relative_parts = path.relative_to(root).parts
        except ValueError:
            relative_parts = path.parts
        if any(part in IGNORED_DIRECTORIES for part in relative_parts[:-1]):
            continue
        if path.suffix in PYTHON_EXTENSIONS:
            yield path


def _is_inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _is_test_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lower()
    filename = normalized.rsplit("/", 1)[-1]
    return (
        normalized.startswith("tests/")
        or "/tests/" in normalized
        or filename.startswith("test_")
        or filename.endswith("_test.py")
    )
