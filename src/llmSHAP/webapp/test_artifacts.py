from __future__ import annotations

import ast
from dataclasses import dataclass
import re


CODE_BLOCK_PATTERN = re.compile(r"```(?:python)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
COMMON_TEST_HELPERS = {
    "pytest",
    "raises",
    "parametrize",
    "mark",
    "fixture",
    "tmp_path",
    "monkeypatch",
    "capsys",
    "self",
}
BUILTIN_NAMES = set(dir(__builtins__))


@dataclass(frozen=True)
class GeneratedTestCase:
    name: str
    source: str
    referenced_symbols: list[str]
    imported_modules: list[str]
    assertion_count: int


def extract_test_code(answer: str) -> str:
    match = CODE_BLOCK_PATTERN.search(answer)
    if match:
        return match.group(1).strip()
    if "def test_" in answer or "import pytest" in answer:
        return answer.strip()
    return ""


def parse_generated_tests(answer: str) -> dict:
    code = extract_test_code(answer)
    if not code:
        return {
            "code": "",
            "syntax_error": "No Python test code block was found in the model output.",
            "test_cases": [],
        }

    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {
            "code": code,
            "syntax_error": f"Generated tests contain invalid Python syntax: {exc.msg}",
            "test_cases": [],
        }

    lines = code.splitlines()
    module_imports = _collect_module_level_imports(tree)
    test_cases: list[GeneratedTestCase] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
            segment = ast.get_source_segment(code, node)
            if not segment:
                start = max(0, node.lineno - 1)
                end = getattr(node, "end_lineno", node.lineno)
                segment = "\n".join(lines[start:end])
            test_cases.append(
                GeneratedTestCase(
                    name=node.name,
                    source=segment.strip(),
                    referenced_symbols=_collect_symbols(node),
                    imported_modules=sorted(set(_collect_imports(node) + module_imports)),
                    assertion_count=_count_assertions(node),
                )
            )

    return {
        "code": code,
        "syntax_error": None,
        "test_cases": test_cases,
        "module_imports": module_imports,
    }


def _collect_module_level_imports(tree: ast.Module) -> list[str]:
    imports: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module)
    return sorted(imports)


def _collect_symbols(node: ast.AST) -> list[str]:
    symbols: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            if _is_interesting_symbol(child.id):
                symbols.add(child.id)
        elif isinstance(child, ast.Attribute):
            if _is_interesting_symbol(child.attr):
                symbols.add(child.attr)
    return sorted(symbols)


def _collect_imports(node: ast.AST) -> list[str]:
    imports: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Import):
            for alias in child.names:
                imports.add(alias.name)
        elif isinstance(child, ast.ImportFrom) and child.module:
            imports.add(child.module)
    return sorted(imports)


def _count_assertions(node: ast.AST) -> int:
    count = 0
    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            count += 1
        elif isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
            if child.func.attr == "raises":
                count += 1
    return count


def _is_interesting_symbol(symbol: str) -> bool:
    return (
        symbol not in COMMON_TEST_HELPERS
        and symbol not in BUILTIN_NAMES
        and len(symbol) > 2
        and not symbol.startswith("test_")
    )
