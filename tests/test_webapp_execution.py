from llmSHAP.webapp.analysis import UploadedContextFile
from llmSHAP.webapp.execution import _summary_count, run_generated_tests


def test_run_generated_tests_passes_for_valid_pytest_output() -> None:
    files = [
        UploadedContextFile(
            path="calculator.py",
            content="def add(a, b):\n    return a + b\n",
            size_bytes=32,
            line_count=2,
            is_test_file=False,
        )
    ]

    answer = """```python
from calculator import add

def test_add_returns_sum():
    assert add(2, 3) == 5
```"""

    result = run_generated_tests(answer, files)

    assert result["status"] == "passed"
    assert result["test_count"] == 1
    assert result["passed"] >= 1
    assert result["per_test_results"] == [
        {
            "name": "test_add_returns_sum",
            "status": "passed",
        }
    ]


def test_run_generated_tests_flags_invalid_code() -> None:
    files = [
        UploadedContextFile(
            path="calculator.py",
            content="def add(a, b):\n    return a + b\n",
            size_bytes=32,
            line_count=2,
            is_test_file=False,
        )
    ]

    answer = """```python
from calculator import add

def test_add_returns_sum(
    assert add(2, 3) == 5
```"""

    result = run_generated_tests(answer, files)

    assert result["status"] == "invalid_test_code"
    assert result["per_test_results"] == []


def test_summary_count_does_not_double_count_plural_errors() -> None:
    output = "========================= 1 error, 6 passed in 0.12s ========================="

    assert _summary_count(output, "error") == 1
    assert _summary_count(output, "passed") == 6
