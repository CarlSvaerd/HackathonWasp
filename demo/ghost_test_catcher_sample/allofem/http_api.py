from __future__ import annotations

from auth_service import AuthService, SessionStore, UserRepository


auth_service = AuthService(UserRepository(), SessionStore())


def login_handler(request_body: dict[str, str]) -> dict[str, object]:
    email = request_body.get("email", "")
    password = request_body.get("password", "")

    try:
        session = auth_service.login(email=email, password=password)
    except ValueError:
        return {"status": 404, "error": "User was not found."}
    except PermissionError as exc:
        if str(exc) == "locked_account":
            return {"status": 423, "error": "Account is locked."}
        return {"status": 401, "error": "Email or password is invalid."}

    return {
        "status": 200,
        "json": {
            "message": "Signed in successfully.",
            "email": session["email"],
            "role": session["role"],
        },
        "set_cookie": f"session={session['session_token']}; HttpOnly; Path=/",
    }


def me_handler(cookies: dict[str, str]) -> dict[str, object]:
    session_token = cookies.get("session", "")
    try:
        session = auth_service.require_session(session_token)
    except PermissionError:
        return {"status": 401, "error": "You need to sign in."}

    return {
        "status": 200,
        "json": {
            "email": session["email"],
            "role": session["role"],
        },
    }


def logout_handler(cookies: dict[str, str]) -> dict[str, object]:
    session_token = cookies.get("session", "")
    auth_service.logout(session_token)
    return {
        "status": 204,
        "clear_cookie": "session=; HttpOnly; Path=/; Max-Age=0",
    }
