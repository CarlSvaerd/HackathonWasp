from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import TYPE_CHECKING

from llmSHAP.webapp.test_artifacts import parse_generated_tests, parse_python_test_source

if TYPE_CHECKING:
    from llmSHAP.webapp.analysis import UploadedContextFile


SUMMARY_PATTERN = re.compile(r"(\d+)\s+(passed|failed|errors?)")
PER_TEST_STATUS_PATTERN = re.compile(
    r"test_generated_output\.py::(?:(?P<class_name>[A-Za-z_][A-Za-z0-9_]*)::)?"
    r"(?P<name>test_[A-Za-z0-9_]+)\s+(?P<status>PASSED|FAILED|ERROR)",
    re.MULTILINE,
)
PRIMARY_FAILURE_PATTERNS = [
    re.compile(r"^E\s+(.+)$", re.MULTILINE),
    re.compile(r"^(ModuleNotFoundError:.+)$", re.MULTILINE),
    re.compile(r"^(ImportError:.+)$", re.MULTILINE),
    re.compile(r"^(NameError:.+)$", re.MULTILINE),
    re.compile(r"^(AttributeError:.+)$", re.MULTILINE),
    re.compile(r"^(AssertionError.*)$", re.MULTILINE),
]


def run_generated_tests(
    answer: str,
    files: list[UploadedContextFile],
    *,
    execution_backend: str = "local",
    docker_image: str = "ghost-test-catcher-runner:latest",
) -> dict:
    return _run_parsed_tests(
        parse_generated_tests(answer),
        files,
        execution_backend=execution_backend,
        docker_image=docker_image,
    )


def run_python_test_source(
    test_source: str,
    files: list[UploadedContextFile],
    *,
    execution_backend: str = "local",
    docker_image: str = "ghost-test-catcher-runner:latest",
) -> dict:
    return _run_parsed_tests(
        parse_python_test_source(test_source),
        files,
        execution_backend=execution_backend,
        docker_image=docker_image,
    )


def _run_parsed_tests(
    parsed: dict,
    files: list[UploadedContextFile],
    *,
    execution_backend: str,
    docker_image: str,
) -> dict:
    if parsed["syntax_error"]:
        return {
            "status": "invalid_test_code",
            "message": parsed["syntax_error"],
            "pytest_summary": "",
            "per_test_results": [],
            "passed": 0,
            "failed": 0,
            "errors": 0,
            "test_count": 0,
            "extracted_code": parsed["code"],
        }

    test_code = parsed["code"]
    if not parsed["test_cases"]:
        return {
            "status": "no_tests_detected",
            "message": "No Python test functions or unittest methods were found in the test source.",
            "pytest_summary": "",
            "per_test_results": [],
            "passed": 0,
            "failed": 0,
            "errors": 0,
            "test_count": 0,
            "extracted_code": test_code,
        }

    with tempfile.TemporaryDirectory(prefix="ghost-test-catcher-") as temp_dir:
        root = Path(temp_dir)
        for uploaded_file in files:
            destination = root / uploaded_file.path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(uploaded_file.content, encoding="utf-8")

        generated_test_path = root / "generated_tests" / "test_generated_output.py"
        generated_test_path.parent.mkdir(parents=True, exist_ok=True)
        generated_test_path.write_text(test_code, encoding="utf-8")

        env = dict(os.environ)
        existing_pythonpath = env.get("PYTHONPATH", "")
        pythonpath_entries = [str(root)]
        src_root = root / "src"
        if src_root.exists():
            pythonpath_entries.append(str(src_root))
        if existing_pythonpath:
            pythonpath_entries.append(existing_pythonpath)
        env["PYTHONPATH"] = os.pathsep.join(pythonpath_entries)
        env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
        try:
            completed = _run_pytest(
                generated_test_path,
                root,
                env,
                execution_backend=execution_backend,
                docker_image=docker_image,
            )
        except subprocess.TimeoutExpired:
            return {
                "status": "timeout",
                "message": "Python test execution timed out.",
                "execution_backend": execution_backend,
                "pytest_summary": "",
                "per_test_results": [],
                "passed": 0,
                "failed": 0,
                "errors": 0,
                "test_count": len(parsed["test_cases"]),
                "extracted_code": test_code,
            }
        except (OSError, ValueError) as exc:
            return {
                "status": "error",
                "message": f"Python test execution could not start with backend '{execution_backend}': {exc}",
                "execution_backend": execution_backend,
                "pytest_summary": "",
                "per_test_results": [
                    {
                        "name": test_case.name,
                        "status": "error",
                    }
                    for test_case in parsed["test_cases"]
                ],
                "passed": 0,
                "failed": 0,
                "errors": len(parsed["test_cases"]),
                "test_count": len(parsed["test_cases"]),
                "extracted_code": test_code,
            }

    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    combined_output = "\n".join(part for part in [stdout, stderr] if part).strip()
    per_test_results = _extract_per_test_results(combined_output, parsed["test_cases"])
    passed, failed, errors = _status_counts(per_test_results)
    if not per_test_results or (passed + failed + errors) == 0:
        passed = _summary_count(combined_output, "passed")
        failed = _summary_count(combined_output, "failed")
        errors = _summary_count(combined_output, "error")

    if completed.returncode == 0:
        status = "passed"
        message = "Python tests executed successfully against the uploaded files."
    elif completed.returncode == 5:
        status = "no_tests_collected"
        message = "The pytest runner did not collect any tests from the test source."
    else:
        status = "failed"
        message = "Python tests did not run cleanly against the uploaded files."

    return {
        "status": status,
        "message": message,
        "execution_backend": execution_backend,
        "primary_failure": "" if status == "passed" else _extract_primary_failure(combined_output),
        "pytest_summary": combined_output,
        "per_test_results": per_test_results,
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "test_count": len(parsed["test_cases"]),
        "extracted_code": test_code,
    }


def _run_pytest(
    test_path: Path,
    root: Path,
    env: dict[str, str],
    *,
    execution_backend: str,
    docker_image: str,
) -> subprocess.CompletedProcess[str]:
    if execution_backend == "local":
        return _run_local_pytest(test_path, root, env)
    if execution_backend == "docker":
        return _run_docker_pytest(test_path, root, docker_image)
    raise ValueError(f"Unsupported execution backend: {execution_backend}")


def _run_local_pytest(test_path: Path, root: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-vv", "-rA", str(test_path.name)],
        cwd=str(test_path.parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
    )


def _run_docker_pytest(test_path: Path, root: Path, docker_image: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "-e",
            "PYTHONPATH=/workspace:/workspace/src",
            "-e",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
            "-v",
            f"{root.resolve()}:/workspace",
            "-w",
            "/workspace/generated_tests",
            docker_image,
            "python",
            "-m",
            "pytest",
            "-vv",
            "-rA",
            test_path.name,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )


def _summary_count(output: str, label: str) -> int:
    normalized_label = label.rstrip("s")
    total = 0
    for count, matched_label in SUMMARY_PATTERN.findall(output):
        if matched_label.rstrip("s") == normalized_label:
            total += int(count)
    return total


def _extract_primary_failure(output: str) -> str:
    if not output.strip():
        return ""
    for pattern in PRIMARY_FAILURE_PATTERNS:
        match = pattern.search(output)
        if match:
            return match.group(1).strip()
    first_line = output.splitlines()[0].strip()
    return first_line


def _extract_per_test_results(output: str, test_cases: list) -> list[dict]:
    per_test_status = {}
    for match in PER_TEST_STATUS_PATTERN.finditer(output):
        status = match.group("status").lower()
        function_name = match.group("name")
        class_name = match.group("class_name")
        if class_name:
            per_test_status[f"{class_name}.{function_name}"] = status
        per_test_status[function_name] = status
    results = []
    for test_case in test_cases:
        fallback_name = getattr(test_case, "function_name", "") or test_case.name.rsplit(".", 1)[-1]
        results.append(
            {
                "name": test_case.name,
                "status": per_test_status.get(test_case.name, per_test_status.get(fallback_name, "unknown")),
            }
        )
    return results


def _status_counts(per_test_results: list[dict]) -> tuple[int, int, int]:
    passed = sum(1 for item in per_test_results if item.get("status") == "passed")
    failed = sum(1 for item in per_test_results if item.get("status") == "failed")
    errors = sum(1 for item in per_test_results if item.get("status") == "error")
    return passed, failed, errors
