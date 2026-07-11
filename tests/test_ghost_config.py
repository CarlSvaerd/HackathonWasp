from __future__ import annotations

from llmSHAP.ghost.config import load_config


def test_load_config_accepts_utf8_bom_pyproject(tmp_path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "pyproject.toml").write_text(
        "\ufeff[tool.ghost-test-catcher]\n"
        'source_paths = ["app"]\n'
        'test_paths = ["specs"]\n'
        'test_mode = "integration"\n'
        "execute_tests = false\n",
        encoding="utf-8",
    )

    config = load_config(repo)

    assert config.source_paths == ["app"]
    assert config.test_paths == ["specs"]
    assert config.test_mode == "integration"
    assert config.execute_tests is False
