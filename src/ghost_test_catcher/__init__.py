"""Public package alias for the Ghost Test Catcher product surface."""

from llmSHAP.ghost import (
    PythonAdapter,
    analyze_existing_tests,
    available_language_adapters,
    generate_and_check,
    get_language_adapter,
)

__all__ = [
    "PythonAdapter",
    "analyze_existing_tests",
    "available_language_adapters",
    "generate_and_check",
    "get_language_adapter",
]
