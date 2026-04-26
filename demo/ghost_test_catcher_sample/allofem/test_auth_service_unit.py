from auth_service import AuthService, SessionStore, UserRepository, normalize_email
import pytest


def test_normalize_email_strips_whitespace_and_lowercases() -> None:
    assert normalize_email("  ADA@EXAMPLE.COM ") == "ada@example.com"


def test_login_rejects_wrong_password() -> None:
    service = AuthService(UserRepository(), SessionStore())

    with pytest.raises(PermissionError, match="invalid_password"):
        service.login("ada@example.com", "wrong-password")


def test_login_rejects_locked_accounts() -> None:
    service = AuthService(UserRepository(), SessionStore())

    with pytest.raises(PermissionError, match="locked_account"):
        service.login("sam@example.com", "sunrise")


def test_login_returns_role_and_session_token() -> None:
    service = AuthService(UserRepository(), SessionStore())

    result = service.login("ada@example.com", "correct horse battery staple")

    assert result["email"] == "ada@example.com"
    assert result["role"] == "admin"
    assert result["session_token"]
