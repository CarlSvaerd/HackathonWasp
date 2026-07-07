from http_api import login_handler, logout_handler, me_handler


def test_login_handler_sets_session_cookie_and_me_handler_reads_it() -> None:
    login_response = login_handler(
        {"email": "ada@example.com", "password": "correct horse battery staple"}
    )

    assert login_response["status"] == 200
    session_cookie = str(login_response["set_cookie"])
    token = session_cookie.split("session=")[1].split(";")[0]

    profile_response = me_handler({"session": token})

    assert profile_response["status"] == 200
    assert profile_response["json"]["email"] == "ada@example.com"
    assert profile_response["json"]["role"] == "admin"


def test_locked_accounts_return_423() -> None:
    response = login_handler({"email": "sam@example.com", "password": "sunrise"})

    assert response["status"] == 423
    assert response["error"] == "Account is locked."


def test_logout_clears_the_cookie() -> None:
    login_response = login_handler(
        {"email": "ada@example.com", "password": "correct horse battery staple"}
    )
    token = str(login_response["set_cookie"]).split("session=")[1].split(";")[0]

    logout_response = logout_handler({"session": token})
    me_response = me_handler({"session": token})

    assert logout_response["status"] == 204
    assert "Max-Age=0" in str(logout_response["clear_cookie"])
    assert me_response["status"] == 401
