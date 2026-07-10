from __future__ import annotations

from dataclasses import dataclass

from llmSHAP.ghost.analysis import analyze_existing_tests
from llmSHAP.webapp.analysis import UploadedContextFile


@dataclass(frozen=True)
class CalibrationCase:
    name: str
    description: str
    source_files: list[UploadedContextFile]
    test_files: list[UploadedContextFile]
    expected_verdict: str


def builtin_calibration_cases() -> list[CalibrationCase]:
    return [
        CalibrationCase(
            name="grounded_add",
            description="A simple test imports and asserts behavior that exists in the source file.",
            expected_verdict="reliable",
            source_files=[
                _file(
                    "calculator.py",
                    "def add(a, b):\n"
                    "    return a + b\n",
                    is_test_file=False,
                )
            ],
            test_files=[
                _file(
                    "tests/test_calculator.py",
                    "from calculator import add\n\n\n"
                    "def test_add_returns_sum():\n"
                    "    assert add(2, 3) == 5\n",
                    is_test_file=True,
                )
            ],
        ),
        CalibrationCase(
            name="missing_import",
            description="A test imports a module that is not present in the source context.",
            expected_verdict="ghost_risk",
            source_files=[
                _file(
                    "calculator.py",
                    "def add(a, b):\n"
                    "    return a + b\n",
                    is_test_file=False,
                )
            ],
            test_files=[
                _file(
                    "tests/test_billing.py",
                    "from billing import charge_customer\n\n\n"
                    "def test_charge_customer_collects_payment():\n"
                    "    assert charge_customer('cust_123') == 'paid'\n",
                    is_test_file=True,
                )
            ],
        ),
        CalibrationCase(
            name="grounded_exception_path",
            description="A test asserts a real failure path with pytest.raises and a built-in exception class.",
            expected_verdict="reliable",
            source_files=[
                _file(
                    "src/auth.py",
                    "def login(username, password):\n"
                    "    if password != 'secret':\n"
                    "        raise ValueError('bad password')\n"
                    "    return {'username': username, 'token': 'session'}\n",
                    is_test_file=False,
                )
            ],
            test_files=[
                _file(
                    "tests/test_auth.py",
                    "import pytest\n"
                    "from src.auth import login\n\n\n"
                    "def test_login_rejects_invalid_password():\n"
                    "    with pytest.raises(ValueError):\n"
                    "        login('demo', 'wrong')\n",
                    is_test_file=True,
                )
            ],
        ),
        CalibrationCase(
            name="private_helper_import",
            description="A repository test imports an existing private helper; this should be flagged as real evidence, not a missing symbol.",
            expected_verdict="reliable",
            source_files=[
                _file(
                    "src/reports.py",
                    "def _summary_count(output, label):\n"
                    "    return output.count(label)\n",
                    is_test_file=False,
                )
            ],
            test_files=[
                _file(
                    "tests/test_reports.py",
                    "from src.reports import _summary_count\n\n\n"
                    "def test_summary_count_counts_error_label():\n"
                    "    assert _summary_count('1 error, 6 passed', 'error') == 1\n",
                    is_test_file=True,
                )
            ],
        ),
        CalibrationCase(
            name="class_method_flow",
            description="A test constructs a real class and calls a real method on the instance.",
            expected_verdict="reliable",
            source_files=[
                _file(
                    "src/auth_service.py",
                    "class AuthService:\n"
                    "    def login(self, email, password):\n"
                    "        return {'email': email, 'token': 'session'}\n",
                    is_test_file=False,
                )
            ],
            test_files=[
                _file(
                    "tests/test_auth_service.py",
                    "from src.auth_service import AuthService\n\n\n"
                    "def test_login_returns_session_token():\n"
                    "    service = AuthService()\n"
                    "    session = service.login('ada@example.com', 'secret')\n"
                    "    assert session['token'] == 'session'\n",
                    is_test_file=True,
                )
            ],
        ),
        CalibrationCase(
            name="local_variables_not_missing_symbols",
            description="A test uses local variable names around a real source function; local names must not be treated as missing APIs.",
            expected_verdict="reliable",
            source_files=[
                _file(
                    "src/emails.py",
                    "def normalize_email(email):\n"
                    "    return email.strip().lower()\n",
                    is_test_file=False,
                )
            ],
            test_files=[
                _file(
                    "tests/test_emails.py",
                    "from src.emails import normalize_email\n\n\n"
                    "def test_normalize_email_strips_and_lowercases():\n"
                    "    messy_email = ' Ada@Example.COM '\n"
                    "    normalized_email = normalize_email(messy_email)\n"
                    "    assert normalized_email == 'ada@example.com'\n",
                    is_test_file=True,
                )
            ],
        ),
        CalibrationCase(
            name="invented_workflow",
            description="A product-level test invents orchestration that low-level source helpers do not implement.",
            expected_verdict="ghost_risk",
            source_files=[
                _file(
                    "signals.py",
                    "def signal_delta(current_value, previous_value):\n"
                    "    return current_value - previous_value\n",
                    is_test_file=False,
                ),
                _file(
                    "alerts.py",
                    "def should_page_operator(severity, environment):\n"
                    "    return severity == 'critical' and environment == 'production'\n",
                    is_test_file=False,
                ),
            ],
            test_files=[
                _file(
                    "tests/test_incident_workflow.py",
                    "def test_incident_dashboard_pages_operator_and_records_resolution():\n"
                    "    incident = ingest_alert({'severity': 'critical'})\n"
                    "    dashboard = open_dashboard(incident.id)\n"
                    "    page = page_on_call_operator(dashboard)\n"
                    "    assert page.delivered is True\n"
                    "    assert dashboard.resolution_history[-1].status == 'resolved'\n",
                    is_test_file=True,
                )
            ],
        ),
    ]


def run_builtin_calibration(
    *,
    execute_tests: bool = True,
    execution_backend: str = "local",
    docker_image: str = "ghost-test-catcher-runner:latest",
) -> dict:
    cases = []
    for case in builtin_calibration_cases():
        result = analyze_existing_tests(
            test_files=case.test_files,
            context_files=case.source_files,
            execute_tests=execute_tests,
            execution_backend=execution_backend,
            docker_image=docker_image,
        )
        actual = result["trust_assessment"]["verdict"]
        cases.append(
            {
                "name": case.name,
                "description": case.description,
                "expected_verdict": case.expected_verdict,
                "actual_verdict": actual,
                "passed": actual == case.expected_verdict,
                "reliability_score": result["trust_assessment"]["reliability_score"],
                "etv_score": result["trust_assessment"]["components"]["etv_score"],
                "execution_status": result["execution"]["status"],
                "missing_imports": result["preflight"]["missing_imports"],
                "missing_symbols": result["preflight"]["missing_symbols"],
            }
        )
    pass_count = sum(1 for item in cases if item["passed"])
    return {
        "ok": pass_count == len(cases),
        "pass_count": pass_count,
        "total_count": len(cases),
        "cases": cases,
    }


def _file(path: str, content: str, *, is_test_file: bool) -> UploadedContextFile:
    return UploadedContextFile(
        path=path,
        content=content,
        size_bytes=len(content.encode("utf-8")),
        line_count=content.count("\n") + (1 if content else 0),
        is_test_file=is_test_file,
    )
