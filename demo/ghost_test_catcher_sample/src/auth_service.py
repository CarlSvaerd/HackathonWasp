from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import secrets


@dataclass(frozen=True)
class User:
    email: str
    password_hash: str
    is_locked: bool = False
    role: str = "user"


class UserRepository:
    def __init__(self) -> None:
        self._users = {
            "ada@example.com": User(
                email="ada@example.com",
                password_hash=_hash_password("correct horse battery staple"),
                role="admin",
            ),
            "sam@example.com": User(
                email="sam@example.com",
                password_hash=_hash_password("sunrise"),
                is_locked=True,
            ),
        }

    def find_by_email(self, email: str) -> User | None:
        return self._users.get(email)


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, str]] = {}

    def create(self, user: User) -> str:
        token = secrets.token_urlsafe(18)
        self._sessions[token] = {"email": user.email, "role": user.role}
        return token

    def get(self, token: str) -> dict[str, str] | None:
        return self._sessions.get(token)

    def revoke(self, token: str) -> None:
        self._sessions.pop(token, None)


class AuthService:
    def __init__(self, user_repository: UserRepository, session_store: SessionStore) -> None:
        self.user_repository = user_repository
        self.session_store = session_store

    def login(self, email: str, password: str) -> dict[str, str]:
        normalized_email = normalize_email(email)
        user = self.user_repository.find_by_email(normalized_email)
        if user is None:
            raise ValueError("unknown_user")
        if user.is_locked:
            raise PermissionError("locked_account")
        if user.password_hash != _hash_password(password):
            raise PermissionError("invalid_password")

        session_token = self.session_store.create(user)
        return {
            "session_token": session_token,
            "email": user.email,
            "role": user.role,
        }

    def require_session(self, session_token: str) -> dict[str, str]:
        session = self.session_store.get(session_token)
        if session is None:
            raise PermissionError("missing_session")
        return session

    def logout(self, session_token: str) -> None:
        self.session_store.revoke(session_token)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _hash_password(password: str) -> str:
    return sha256(password.encode("utf-8")).hexdigest()
