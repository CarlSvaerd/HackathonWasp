from fastapi.testclient import TestClient

from llmSHAP.webapp.app import app


def test_demo_presets_return_grounded_and_ghost_options() -> None:
    client = TestClient(app)

    response = client.get("/api/demo-presets")

    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload["presets"]] == ["grounded", "ghost"]
    assert payload["presets"][0]["test_mode"] == "mixed"
    assert payload["presets"][1]["test_mode"] == "e2e"
    assert payload["presets"][0]["has_prompt_override"] is False
    assert payload["presets"][1]["has_prompt_override"] is True


def test_grounded_demo_preset_returns_checkout_files() -> None:
    client = TestClient(app)

    response = client.get("/api/demo-preset/grounded")

    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == "Grounded Checkout Demo"
    assert payload["test_mode"] == "mixed"
    assert len(payload["files"]) == 3
    assert [item["path"] for item in payload["files"]] == [
        "TestCreation1.py",
        "TestCreation2.py",
        "TestCreation3.py",
    ]


def test_ghost_demo_preset_returns_alerting_files() -> None:
    client = TestClient(app)

    response = client.get("/api/demo-preset/ghost")

    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == "Ghost-Risk Alert Demo"
    assert payload["test_mode"] == "e2e"
    assert "incident management workflow" in payload["prompt_override"]
    assert "stress-test mode" in payload["instructions_override"]
    assert len(payload["files"]) == 3
    assert [item["path"] for item in payload["files"]] == [
        "AlertFormatting.py",
        "AnomalyRules.py",
        "SignalMath.py",
    ]
