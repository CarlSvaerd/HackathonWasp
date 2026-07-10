from __future__ import annotations

import ast
import builtins
from dataclasses import dataclass
import re


CODE_BLOCK_PATTERN = re.compile(r"```(?:python)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
COMMON_TEST_HELPERS = {
    "pytest",
    "unittest",
    "TestCase",
    "raises",
    "parametrize",
    "mark",
    "fixture",
    "tmp_path",
    "monkeypatch",
    "capsys",
    "self",
    "cls",
}
COMMON_VALUE_METHODS = {
    "add",
    "append",
    "clear",
    "copy",
    "count",
    "discard",
    "endswith",
    "extend",
    "format",
    "get",
    "index",
    "insert",
    "items",
    "join",
    "keys",
    "lower",
    "pop",
    "remove",
    "replace",
    "setdefault",
    "split",
    "startswith",
    "strip",
    "upper",
    "values",
}
BUILTIN_NAMES = set(dir(builtins))
UNITTEST_ASSERTION_PREFIX = "assert"


@dataclass(frozen=True)
class GeneratedTestCase:
    name: str
    source: str
    referenced_symbols: list[str]
    imported_modules: list[str]
    assertion_count: int
    framework: str = "pytest"
    class_name: str | None = None
    function_name: str = ""
    assertion_styles: list[str] | None = None


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
    return parse_python_test_source(code)


def parse_python_test_source(code: str) -> dict:
    if not code.strip():
        return {
            "code": "",
            "syntax_error": "No Python test source was provided.",
            "test_cases": [],
            "module_imports": [],
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
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
            test_cases.append(_build_test_case(code, lines, node, module_imports=module_imports))
        elif isinstance(node, ast.ClassDef):
            test_cases.extend(_collect_class_test_cases(code, lines, node, module_imports=module_imports))

    return {
        "code": code,
        "syntax_error": None,
        "test_cases": test_cases,
        "module_imports": module_imports,
        "frameworks": sorted({test_case.framework for test_case in test_cases}) or ["unknown"],
    }


def _build_test_case(
    code: str,
    lines: list[str],
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    module_imports: list[str],
    class_name: str | None = None,
    framework: str | None = None,
) -> GeneratedTestCase:
    segment = ast.get_source_segment(code, node)
    if not segment:
        start = max(0, node.lineno - 1)
        end = getattr(node, "end_lineno", node.lineno)
        segment = "\n".join(lines[start:end])
    assertion_styles = _assertion_styles(node)
    inferred_framework = framework or ("unittest" if any(style.startswith("unittest.") for style in assertion_styles) else "pytest")
    return GeneratedTestCase(
        name=f"{class_name}.{node.name}" if class_name else node.name,
        source=segment.strip(),
        referenced_symbols=_collect_symbols(node),
        imported_modules=sorted(set(_collect_imports(node) + module_imports)),
        assertion_count=len(assertion_styles),
        framework=inferred_framework,
        class_name=class_name,
        function_name=node.name,
        assertion_styles=assertion_styles,
    )


def _collect_class_test_cases(
    code: str,
    lines: list[str],
    node: ast.ClassDef,
    *,
    module_imports: list[str],
) -> list[GeneratedTestCase]:
    class_is_unittest = _is_unittest_testcase(node)
    class_looks_like_test = class_is_unittest or node.name.startswith("Test") or node.name.endswith("TestCase")
    if not class_looks_like_test:
        return []
    cases = []
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name.startswith("test_"):
            cases.append(
                _build_test_case(
                    code,
                    lines,
                    child,
                    module_imports=module_imports,
                    class_name=node.name,
                    framework="unittest" if class_is_unittest else None,
                )
            )
    return cases


def _is_unittest_testcase(node: ast.ClassDef) -> bool:
    for base in node.bases:
        if isinstance(base, ast.Name) and base.id == "TestCase":
            return True
        if isinstance(base, ast.Attribute) and base.attr == "TestCase":
            return True
    return False


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
    local_names = _collect_local_names(node)
    project_like_locals = _collect_project_like_locals(node)
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            if _is_interesting_symbol(child.id) and child.id not in local_names:
                symbols.add(child.id)
        elif isinstance(child, ast.Attribute):
            if _is_unittest_assertion_attribute(child):
                continue
            if child.attr in COMMON_VALUE_METHODS and _attribute_root_name(child) not in project_like_locals:
                continue
            if _is_interesting_symbol(child.attr):
                symbols.add(child.attr)
    return sorted(symbols)


def _collect_local_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
            names.add(arg.arg)
        if node.args.vararg:
            names.add(node.args.vararg.arg)
        if node.args.kwarg:
            names.add(node.args.kwarg.arg)
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
            names.add(child.id)
        elif isinstance(child, ast.ExceptHandler) and child.name:
            names.add(child.name)
        elif isinstance(child, (ast.Import, ast.ImportFrom)):
            for alias in child.names:
                names.add(alias.asname or alias.name.split(".", 1)[0])
    return names


def _collect_imports(node: ast.AST) -> list[str]:
    imports: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Import):
            for alias in child.names:
                imports.add(alias.name)
        elif isinstance(child, ast.ImportFrom) and child.module:
            imports.add(child.module)
    return sorted(imports)


def _collect_project_like_locals(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Assign) and _is_project_like_constructor_call(child.value):
            for target in child.targets:
                names.update(_assignment_target_names(target))
        elif isinstance(child, ast.AnnAssign) and _is_project_like_constructor_call(child.value):
            names.update(_assignment_target_names(child.target))
    return names


def _assignment_target_names(target: ast.AST) -> set[str]:
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names: set[str] = set()
        for item in target.elts:
            names.update(_assignment_target_names(item))
        return names
    return set()


def _is_project_like_constructor_call(node: ast.AST | None) -> bool:
    if not isinstance(node, ast.Call):
        return False
    name = _callable_leaf_name(node.func)
    return bool(name and name[:1].isupper() and _is_interesting_symbol(name))


def _callable_leaf_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _attribute_root_name(node: ast.Attribute) -> str:
    value = node.value
    while isinstance(value, ast.Attribute):
        value = value.value
    return value.id if isinstance(value, ast.Name) else ""


def _count_assertions(node: ast.AST) -> int:
    return len(_assertion_styles(node))


def _assertion_styles(node: ast.AST) -> list[str]:
    styles: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            styles.append("assert")
        elif isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
            if child.func.attr == "raises":
                styles.append("pytest.raises")
            elif _is_unittest_assertion_attribute(child.func):
                styles.append(f"unittest.{child.func.attr}")
    return styles


def _is_unittest_assertion_attribute(node: ast.Attribute) -> bool:
    if not node.attr.startswith(UNITTEST_ASSERTION_PREFIX) and node.attr != "fail":
        return False
    return isinstance(node.value, ast.Name) and node.value.id in {"self", "cls"}


def _is_interesting_symbol(symbol: str) -> bool:
    return (
        symbol not in COMMON_TEST_HELPERS
        and symbol not in BUILTIN_NAMES
        and len(symbol) > 2
        and not symbol.startswith("test_")
    )
