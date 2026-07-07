from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import tomllib


DEFAULT_SOURCE_PATHS = ["src"]
DEFAULT_TEST_PATHS = ["tests"]
DEFAULT_TEST_MODE = "mixed"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_MAX_FILES = 80
DEFAULT_MAX_CHARS_PER_FILE = 24000
DEFAULT_MAX_TOTAL_CHARS = 240000


@dataclass(frozen=True)
class GhostTestCatcherConfig:
    source_paths: list[str]
    test_paths: list[str]
    test_mode: str = DEFAULT_TEST_MODE
    model: str = DEFAULT_MODEL
    max_files: int = DEFAULT_MAX_FILES
    max_chars_per_file: int = DEFAULT_MAX_CHARS_PER_FILE
    max_total_chars: int = DEFAULT_MAX_TOTAL_CHARS
    execute_tests: bool = True


def load_config(repo_root: str | Path, config_path: str | Path | None = None) -> GhostTestCatcherConfig:
    root = Path(repo_root).expanduser().resolve()
    payload = _read_config_payload(root, config_path)
    return GhostTestCatcherConfig(
        source_paths=_as_string_list(payload.get("source_paths"), DEFAULT_SOURCE_PATHS),
        test_paths=_as_string_list(payload.get("test_paths"), DEFAULT_TEST_PATHS),
        test_mode=str(payload.get("test_mode", DEFAULT_TEST_MODE)),
        model=str(payload.get("model", DEFAULT_MODEL)),
        max_files=_as_int(payload.get("max_files"), DEFAULT_MAX_FILES),
        max_chars_per_file=_as_int(payload.get("max_chars_per_file"), DEFAULT_MAX_CHARS_PER_FILE),
        max_total_chars=_as_int(payload.get("max_total_chars"), DEFAULT_MAX_TOTAL_CHARS),
        execute_tests=_as_bool(payload.get("execute_tests"), True),
    )


def _read_config_payload(root: Path, config_path: str | Path | None) -> dict[str, Any]:
    candidates = [Path(config_path).expanduser().resolve()] if config_path else [
        root / ".ghosttest.toml",
        root / "pyproject.toml",
    ]

    for path in candidates:
        if not path.exists():
            continue
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        if path.name == "pyproject.toml":
            section = data.get("tool", {}).get("ghost-test-catcher", {})
            if isinstance(section, dict):
                return section
            return {}
        if isinstance(data, dict):
            return data
    return {}


def _as_string_list(value: Any, default: list[str]) -> list[str]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return list(default)


def _as_int(value: Any, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)
