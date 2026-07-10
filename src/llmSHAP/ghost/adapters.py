from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class LanguageAdapter(Protocol):
    language_id: str
    display_name: str
    source_extensions: tuple[str, ...]
    test_extensions: tuple[str, ...]

    def is_source_path(self, path: str | Path) -> bool:
        ...

    def is_test_path(self, path: str | Path) -> bool:
        ...

    def execution_backend_names(self) -> tuple[str, ...]:
        ...


@dataclass(frozen=True)
class PythonAdapter:
    language_id: str = "python"
    display_name: str = "Python"
    source_extensions: tuple[str, ...] = (".py",)
    test_extensions: tuple[str, ...] = (".py",)

    def is_source_path(self, path: str | Path) -> bool:
        normalized = _normalize_path(path)
        return normalized.endswith(self.source_extensions) and not self.is_test_path(normalized)

    def is_test_path(self, path: str | Path) -> bool:
        normalized = _normalize_path(path)
        filename = normalized.rsplit("/", 1)[-1]
        return (
            normalized.endswith(self.test_extensions)
            and (
                normalized.startswith("tests/")
                or "/tests/" in normalized
                or filename.startswith("test_")
                or filename.endswith("_test.py")
            )
        )

    def execution_backend_names(self) -> tuple[str, ...]:
        return ("local", "docker")


PYTHON_ADAPTER = PythonAdapter()
_ADAPTERS: dict[str, LanguageAdapter] = {
    PYTHON_ADAPTER.language_id: PYTHON_ADAPTER,
}


def available_language_adapters() -> list[LanguageAdapter]:
    return list(_ADAPTERS.values())


def get_language_adapter(language_id: str = "python") -> LanguageAdapter:
    try:
        return _ADAPTERS[language_id]
    except KeyError as exc:
        supported = ", ".join(sorted(_ADAPTERS))
        raise ValueError(f"Unsupported language adapter '{language_id}'. Supported adapters: {supported}") from exc


def _normalize_path(path: str | Path) -> str:
    return str(path).replace("\\", "/").lower().lstrip("./")
