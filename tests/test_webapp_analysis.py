from llmSHAP.webapp.analysis import (
    UploadedContextFile,
    _effective_test_value,
    analyze_uploaded_files,
    prepare_uploaded_files,
)


def test_prepare_uploaded_files_marks_test_files_and_truncation() -> None:
    raw_files = [
        ("tests/test_auth.py", b"assert login()\n"),
        ("src/auth.py", b"a" * 13000),
    ]

    prepared = prepare_uploaded_files(raw_files, max_files=4, max_chars_per_file=32, max_total_chars=100)

    assert prepared[0].is_test_file is True
    assert prepared[1].is_test_file is False
    assert prepared[1].truncated is True


def test_analyze_uploaded_files_returns_ranked_weights() -> None:
    class FakeLLM:
        def __init__(self) -> None:
            self.prompt = None

        def generate(self, prompt, tools=None, images=None):
            self.prompt = prompt
            return """```python
import pytest
from src.auth import login

def test_login_accepts_valid_credentials():
    assert login("demo", "secret") is True

def test_login_rejects_invalid_credentials():
    with pytest.raises(ValueError):
        login("demo", "wrong")
```"""

    files = [
        UploadedContextFile(
            path="tests/test_auth.py",
            content="def test_login():\n    assert login('demo', 'secret') is True\n",
            size_bytes=32,
            line_count=2,
            is_test_file=True,
        ),
        UploadedContextFile(
            path="src/auth.py",
            content="def login(username, password):\n    if password != 'secret':\n        raise ValueError('bad password')\n    return True\n",
            size_bytes=26,
            line_count=4,
            is_test_file=False,
        ),
    ]

    fake_llm = FakeLLM()

    result = analyze_uploaded_files(
        files=files,
        test_mode="integration",
        llm=fake_llm,
    )

    assert "answer" in result
    assert len(result["files"]) == 2
    assert result["statistics"]["total_files"] == 2
    assert result["top_test_files"][0]["path"] == "tests/test_auth.py"
    assert result["test_mode"] == "integration"
    assert "integration tests" in result["prompt"]
    assert "module: src.auth (src/auth.py)" in result["api_map"]
    assert "functions: login" in result["api_map"]
    assert fake_llm.prompt is not None
    assert "Available Python API map:" in fake_llm.prompt[1]["content"]
    assert "module: src.auth (src/auth.py)" in fake_llm.prompt[1]["content"]
    assert result["generated_tests"]["test_count"] == 2
    assert "verification" in result
    assert result["verification"]["total_claims"] >= 1
    assert result["execution"]["status"] == "passed"
    assert "trust_assessment" in result
    assert result["trust_assessment"]["verdict"] in {"reliable", "needs_review", "ghost_risk"}
    assert result["trust_assessment"]["components"]["etv_score"] == 1.0
    assert result["trust_assessment"]["components"]["etv_breakdown"] == {
        "total_tests": 2,
        "keepers": 2,
        "salvageable": 0,
        "risky": 0,
    }


def test_effective_test_value_scores_keepers_and_salvageable_tests() -> None:
    score, breakdown = _effective_test_value(
        verification={
            "claim_checks": [
                {"claim": "test_ready_to_keep", "status": "supported"},
                {"claim": "test_fixable", "status": "supported"},
                {"claim": "test_borderline_but_passing", "status": "borderline"},
                {"claim": "test_ghost", "status": "unsupported"},
            ]
        },
        execution={
            "per_test_results": [
                {"name": "test_ready_to_keep", "status": "passed"},
                {"name": "test_fixable", "status": "failed"},
                {"name": "test_borderline_but_passing", "status": "passed"},
                {"name": "test_ghost", "status": "failed"},
            ]
        },
    )

    assert score == 0.5
    assert breakdown == {
        "total_tests": 4,
        "keepers": 1,
        "salvageable": 2,
        "risky": 1,
    }
