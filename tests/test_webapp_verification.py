from llmSHAP.webapp.analysis import UploadedContextFile
from llmSHAP.webapp.verification import verify_answer_grounding


def test_verify_answer_grounding_marks_supported_claims() -> None:
    files = [
        UploadedContextFile(
            path="tests/test_auth_service_unit.py",
            content=(
                "def test_login_rejects_wrong_password():\n"
                "    with pytest.raises(PermissionError, match='invalid_password'):\n"
                "        service.login('ada@example.com', 'wrong-password')\n"
            ),
            size_bytes=128,
            line_count=3,
            is_test_file=True,
        ),
        UploadedContextFile(
            path="src/auth_service.py",
            content=(
                "def login(self, email: str, password: str) -> dict[str, str]:\n"
                "    if user.password_hash != _hash_password(password):\n"
                "        raise PermissionError('invalid_password')\n"
            ),
            size_bytes=142,
            line_count=3,
            is_test_file=False,
        ),
    ]

    result = verify_answer_grounding(
        """```python
import pytest
from src.auth_service import login

def test_login_rejects_wrong_password():
    with pytest.raises(PermissionError):
        login('ada@example.com', 'wrong-password')
```""",
        files,
    )

    assert result["verdict"] in {"grounded", "mixed"}
    assert result["supported_claims"] >= 1
    assert result["top_evidence_files"]


def test_verify_answer_grounding_flags_ghost_risk_for_unrelated_claims() -> None:
    files = [
        UploadedContextFile(
            path="src/auth_service.py",
            content="def login(email, password):\n    return {'role': 'admin'}\n",
            size_bytes=64,
            line_count=2,
            is_test_file=False,
        )
    ]

    result = verify_answer_grounding(
        """```python
def test_login_triggers_stripe_invoice_and_cluster_bootstrap():
    invoice = send_stripe_invoice()
    cluster = provision_kubernetes_cluster()
    assert invoice and cluster
```""",
        files,
    )

    assert result["verdict"] == "ghost_risk"
    assert result["unsupported_claims"] >= 1
