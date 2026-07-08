from __future__ import annotations

import json

from llmSHAP.ghost.adapters import available_language_adapters, get_language_adapter
from llmSHAP.ghost.analysis import analyze_existing_tests
from llmSHAP.ghost.calibration import run_builtin_calibration
from llmSHAP.ghost.cli import main
from llmSHAP.webapp.analysis import UploadedContextFile


def test_analyze_existing_tests_scores_grounded_pytest_file() -> None:
    source = UploadedContextFile(
        path="calculator.py",
        content="def add(a, b):\n    return a + b\n",
        size_bytes=32,
        line_count=2,
        is_test_file=False,
    )
    test = UploadedContextFile(
        path="tests/test_calculator.py",
        content="from calculator import add\n\n\ndef test_add_returns_sum():\n    assert add(2, 3) == 5\n",
        size_bytes=86,
        line_count=5,
        is_test_file=True,
    )

    result = analyze_existing_tests(test_files=[test], context_files=[source])

    assert result["analysis_mode"] == "analyze_existing_tests"
    assert result["generated_tests"]["test_names"] == ["test_add_returns_sum"]
    assert result["execution"]["status"] == "passed"
    assert result["trust_assessment"]["components"]["etv_score"] == 1.0
    assert result["files"][0]["path"] == "calculator.py"


def test_analyze_existing_tests_scores_grounded_unittest_testcase() -> None:
    source = UploadedContextFile(
        path="calculator.py",
        content="def add(a, b):\n    return a + b\n",
        size_bytes=32,
        line_count=2,
        is_test_file=False,
    )
    test = UploadedContextFile(
        path="tests/test_calculator_unittest.py",
        content=(
            "import unittest\n"
            "from calculator import add\n\n\n"
            "class CalculatorTests(unittest.TestCase):\n"
            "    def test_add_returns_sum(self):\n"
            "        self.assertEqual(add(2, 3), 5)\n"
        ),
        size_bytes=150,
        line_count=7,
        is_test_file=True,
    )

    result = analyze_existing_tests(test_files=[test], context_files=[source])
    claim = result["verification"]["claim_checks"][0]

    assert result["analysis_mode"] == "analyze_existing_tests"
    assert result["generated_tests"]["test_names"] == ["CalculatorTests.test_add_returns_sum"]
    assert result["generated_tests"]["frameworks"] == ["unittest"]
    assert result["execution"]["status"] == "passed"
    assert result["execution"]["per_test_results"][0]["status"] == "passed"
    assert claim["framework"] == "unittest"
    assert claim["assertion_count"] == 1
    assert claim["missing_symbols"] == []


def test_cli_analyze_outputs_json_for_existing_tests(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "src").mkdir()
    (repo / "tests").mkdir()
    (repo / "src" / "calculator.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (repo / "tests" / "test_calculator.py").write_text(
        "from src.calculator import add\n\n\ndef test_add_returns_sum():\n    assert add(2, 3) == 5\n",
        encoding="utf-8",
    )

    exit_code = main(
        [
            "analyze",
            "--repo",
            str(repo),
            "--tests",
            "tests/test_calculator.py",
            "--source",
            "src",
            "--format",
            "json",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["analysis_mode"] == "analyze_existing_tests"
    assert payload["generated_tests"]["test_count"] == 1
    assert payload["execution"]["status"] == "passed"


def test_cli_analyze_accepts_docker_backend_for_static_analysis(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "src").mkdir()
    (repo / "tests").mkdir()
    (repo / "src" / "calculator.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (repo / "tests" / "test_calculator.py").write_text(
        "from src.calculator import add\n\n\ndef test_add_returns_sum():\n    assert add(2, 3) == 5\n",
        encoding="utf-8",
    )

    exit_code = main(
        [
            "analyze",
            "--repo",
            str(repo),
            "--tests",
            "tests/test_calculator.py",
            "--source",
            "src",
            "--no-execution",
            "--execution-backend",
            "docker",
            "--docker-image",
            "python:3.11-slim",
            "--format",
            "json",
        ]
    )

    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert payload["execution"]["status"] == "skipped"
    assert payload["execution"]["execution_backend"] == "docker"


def test_python_language_adapter_identifies_supported_paths() -> None:
    adapter = get_language_adapter("python")

    assert adapter.is_test_path("tests/test_checkout.py") is True
    assert adapter.is_test_path("src/checkout_test.py") is True
    assert adapter.is_test_path("src/checkout.py") is False
    assert adapter.is_source_path("src/checkout.py") is True
    assert adapter.is_source_path("tests/test_checkout.py") is False
    assert adapter.execution_backend_names() == ("local", "docker")
    assert [item.language_id for item in available_language_adapters()] == ["python"]


def test_cli_doctor_lists_language_adapters(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()

    exit_code = main(["doctor", "--repo", str(repo)])

    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert payload["language_adapters"][0]["language_id"] == "python"
    assert "docker" in payload["language_adapters"][0]["execution_backends"]


def test_cli_ci_writes_markdown_summary_and_passes_grounded_tests(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "src").mkdir()
    (repo / "tests").mkdir()
    (repo / "src" / "calculator.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (repo / "tests" / "test_calculator.py").write_text(
        "from src.calculator import add\n\n\n"
        "def test_add_returns_sum():\n"
        "    assert add(2, 3) == 5\n",
        encoding="utf-8",
    )
    summary_path = repo / "ghost-summary.md"
    report_path = repo / "ghost-report.json"

    exit_code = main(
        [
            "ci",
            "--repo",
            str(repo),
            "--tests",
            "tests/test_calculator.py",
            "--source",
            "src",
            "--no-execution",
            "--summary",
            str(summary_path),
            "--output",
            str(report_path),
            "--format",
            "json",
            "--fail-on",
            "ghost_risk",
        ]
    )

    payload = json.loads(capsys.readouterr().out)
    summary = summary_path.read_text(encoding="utf-8")

    assert exit_code == 0
    assert payload["ok"] is True
    assert payload["ci"]["fail_on"] == "ghost_risk"
    assert payload["generated_tests"]["test_count"] == 1
    assert "# Ghost Test Catcher CI Report" in summary
    assert "`test_add_returns_sum`" in summary
    assert report_path.exists()


def test_cli_ci_fails_ghost_risk_when_policy_requires_it(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "src").mkdir()
    (repo / "tests").mkdir()
    (repo / "src" / "calculator.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (repo / "tests" / "test_billing.py").write_text(
        "from billing import charge_customer\n\n\n"
        "def test_charge_customer_collects_payment():\n"
        "    assert charge_customer('cust_123') == 'paid'\n",
        encoding="utf-8",
    )

    exit_code = main(
        [
            "ci",
            "--repo",
            str(repo),
            "--tests",
            "tests/test_billing.py",
            "--source",
            "src",
            "--no-execution",
            "--format",
            "json",
            "--fail-on",
            "ghost_risk",
        ]
    )

    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 2
    assert payload["ok"] is False
    assert payload["trust_assessment"]["verdict"] == "ghost_risk"


def test_existing_test_analysis_reports_exact_symbol_evidence() -> None:
    source = UploadedContextFile(
        path="src/auth.py",
        content=(
            "class AuthService:\n"
            "    def login(self, email, password):\n"
            "        return {'email': email, 'token': 'session'}\n"
        ),
        size_bytes=110,
        line_count=3,
        is_test_file=False,
    )
    test = UploadedContextFile(
        path="tests/test_auth.py",
        content=(
            "from src.auth import AuthService\n\n\n"
            "def test_login_returns_session_token():\n"
            "    service = AuthService()\n"
            "    session = service.login('ada@example.com', 'secret')\n"
            "    assert session['token'] == 'session'\n"
        ),
        size_bytes=180,
        line_count=7,
        is_test_file=True,
    )

    result = analyze_existing_tests(test_files=[test], context_files=[source])
    claim = result["verification"]["claim_checks"][0]

    assert claim["status"] == "supported"
    assert any("AuthService -> src/auth.py:1" in item for item in claim["evidence_symbols"])
    assert any("login -> src/auth.py:2" in item for item in claim["evidence_symbols"])
    assert claim["missing_symbols"] == []


def test_builtin_exception_names_are_not_missing_project_symbols() -> None:
    source = UploadedContextFile(
        path="src/auth.py",
        content=(
            "def login(username, password):\n"
            "    if password != 'secret':\n"
            "        raise ValueError('bad password')\n"
            "    return True\n"
        ),
        size_bytes=120,
        line_count=4,
        is_test_file=False,
    )
    test = UploadedContextFile(
        path="tests/test_auth.py",
        content=(
            "import pytest\n"
            "from src.auth import login\n\n\n"
            "def test_login_rejects_invalid_credentials():\n"
            "    with pytest.raises(ValueError):\n"
            "        login('demo', 'wrong')\n"
        ),
        size_bytes=150,
        line_count=7,
        is_test_file=True,
    )

    result = analyze_existing_tests(test_files=[test], context_files=[source])
    claim = result["verification"]["claim_checks"][0]

    assert claim["status"] == "supported"
    assert "ValueError" not in claim["mentioned_symbols"]
    assert claim["missing_symbols"] == []


def test_builtin_calibration_cases_match_expected_verdicts() -> None:
    result = run_builtin_calibration()

    assert result["ok"] is True
    assert result["pass_count"] == result["total_count"]
    assert {case["name"] for case in result["cases"]} == {
        "grounded_add",
        "missing_import",
        "grounded_exception_path",
        "private_helper_import",
        "class_method_flow",
        "local_variables_not_missing_symbols",
        "invented_workflow",
    }
