from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Iterator, Union


IGNORED_DIRECTORIES = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    ".next",
    "target",
}

INCLUDED_FILE_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".go",
    ".rs",
    ".java",
}

DEFAULT_CHUNK_SIZE = 80
DEFAULT_CHUNK_OVERLAP = 20


@dataclass(frozen=True)
class CodeChunk:
    chunk_id: str
    path: str
    start_line: int
    end_line: int
    text: str


def index_repository(
    repo_path: Union[str, Path],
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[CodeChunk]:
    repo_root = Path(repo_path).expanduser().resolve()
    if not repo_root.is_dir():
        raise ValueError(f"Repository path does not exist or is not a directory: {repo_root}")
    _validate_chunking(chunk_size=chunk_size, overlap=overlap)

    chunks: list[CodeChunk] = []
    for file_path in _iter_repository_files(repo_root):
        chunks.extend(
            _chunk_file(
                file_path=file_path,
                repo_root=repo_root,
                chunk_size=chunk_size,
                overlap=overlap,
            )
        )
    return chunks


def _validate_chunking(*, chunk_size: int, overlap: int) -> None:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than 0.")
    if overlap < 0:
        raise ValueError("overlap cannot be negative.")
    if overlap >= chunk_size:
        raise ValueError("overlap must be smaller than chunk_size.")


def _iter_repository_files(repo_root: Path) -> Iterator[Path]:
    for current_root, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = sorted(name for name in dirnames if name not in IGNORED_DIRECTORIES)
        for filename in sorted(filenames):
            file_path = Path(current_root, filename)
            if file_path.suffix.lower() in INCLUDED_FILE_EXTENSIONS:
                yield file_path


def _chunk_file(
    *,
    file_path: Path,
    repo_root: Path,
    chunk_size: int,
    overlap: int,
) -> list[CodeChunk]:
    try:
        text = file_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    lines = text.splitlines()
    if not lines:
        return []

    relative_path = file_path.relative_to(repo_root).as_posix()
    step = chunk_size - overlap
    chunks: list[CodeChunk] = []
    for start_index in range(0, len(lines), step):
        end_index = min(len(lines), start_index + chunk_size)
        chunk_text = "\n".join(lines[start_index:end_index]).strip("\n")
        if chunk_text.strip():
            start_line = start_index + 1
            end_line = end_index
            chunks.append(
                CodeChunk(
                    chunk_id=f"{relative_path}:{start_line}-{end_line}",
                    path=relative_path,
                    start_line=start_line,
                    end_line=end_line,
                    text=chunk_text,
                )
            )
        if end_index >= len(lines):
            break
    return chunks
