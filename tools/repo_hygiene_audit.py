from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN_TRACKED_PREFIXES = (
    ".pnpm-store/",
    "node_modules/",
    "packages/vscode-extension/node_modules/",
    "packages/vscode-extension/.vscode-test/",
    "src/ghost_test_catcher.egg-info/",
    "src/llmSHAP.egg-info/",
)

FORBIDDEN_TRACKED_EXACT = {
    "README 2.md",
    "ghost-test-catcher-report.json",
    "ghost-test-catcher-summary.md",
    "packages/vscode-extension/pnpm-lock.yaml",
    "packages/vscode-extension/pnpm-workspace.yaml",
    "packages/vscode-extension/vscode-integration.log",
}

FORBIDDEN_TRACKED_SUFFIXES = (
    ".vsix",
    ".pyc",
    ".pyo",
)

PUBLIC_TEXT_FILES = (
    "pyproject.toml",
    "CONTRIBUTING.md",
    "Makefile",
)

STALE_PUBLIC_MARKERS = (
    "/Users/carlhyllen",
    "C:\\Users\\carlh",
    "filipnaudot.github.io/llmSHAP",
    "small browser MVP",
)


def main() -> int:
    failures: list[str] = []
    tracked_files = git_ls_files()

    failures.extend(check_forbidden_tracked_files(tracked_files))
    failures.extend(check_public_identity())
    failures.extend(check_extension_version_alignment())
    failures.extend(check_public_text_markers())

    if failures:
        print("Ghost Test Catcher repo hygiene audit failed:\n")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Ghost Test Catcher repo hygiene audit passed.")
    return 0


def git_ls_files() -> list[str]:
    completed = subprocess.run(
        ["git", "ls-files"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return [line.strip().replace("\\", "/") for line in completed.stdout.splitlines() if line.strip()]


def check_forbidden_tracked_files(tracked_files: list[str]) -> list[str]:
    failures: list[str] = []
    root_readmes = [path for path in tracked_files if "/" not in path and path.lower().startswith("readme")]
    for path in tracked_files:
        if path in FORBIDDEN_TRACKED_EXACT:
            failures.append(f"forbidden generated or duplicate file is tracked: {path}")
        if path.endswith(FORBIDDEN_TRACKED_SUFFIXES):
            failures.append(f"generated binary/cache artifact is tracked: {path}")
        for prefix in FORBIDDEN_TRACKED_PREFIXES:
            if path.startswith(prefix):
                failures.append(f"forbidden generated/cache directory is tracked: {path}")
                break

    unexpected_readmes = sorted(path for path in root_readmes if path != "README.md")
    for path in unexpected_readmes:
        failures.append(f"duplicate root README is tracked: {path}")
    return failures


def check_public_identity() -> list[str]:
    failures: list[str] = []
    pyproject = load_toml(ROOT / "pyproject.toml")
    project = pyproject.get("project", {})
    urls = project.get("urls", {})

    if project.get("name") != "ghost-test-catcher":
        failures.append("pyproject project.name must stay ghost-test-catcher")

    description = str(project.get("description", ""))
    if "Ghost Test Catcher" not in description or "LLM attribution plus" in description:
        failures.append("pyproject description should describe Ghost Test Catcher directly, not a mixed llmSHAP bundle")

    docs_url = str(urls.get("Documentation", ""))
    if "CarlSvaerd/HackathonWasp" not in docs_url:
        failures.append("pyproject Documentation URL should point at the Ghost Test Catcher docs in this repository")

    contributing = read_text(ROOT / "CONTRIBUTING.md")
    if not contributing.startswith("# Contributing to Ghost Test Catcher"):
        failures.append("CONTRIBUTING.md should present Ghost Test Catcher as the public project")

    return failures


def check_extension_version_alignment() -> list[str]:
    failures: list[str] = []
    package_path = ROOT / "packages" / "vscode-extension" / "package.json"
    package = json.loads(read_text(package_path))
    version = str(package.get("version", "")).strip()
    expected_vsix = f"ghost-test-catcher-{version}.vsix"
    package_script = str(package.get("scripts", {}).get("package", ""))

    if expected_vsix not in package_script:
        failures.append(f"VS Code package script should build {expected_vsix}")

    docs_to_check = (
        ROOT / "README.md",
        ROOT / "packages" / "vscode-extension" / "README.md",
        ROOT / "docs" / "ghost-test-catcher-release.md",
    )
    for path in docs_to_check:
        text = read_text(path)
        if expected_vsix not in text:
            failures.append(f"{relative(path)} should reference {expected_vsix}")

    return failures


def check_public_text_markers() -> list[str]:
    failures: list[str] = []
    for relative_path in PUBLIC_TEXT_FILES:
        path = ROOT / relative_path
        text = read_text(path)
        for marker in STALE_PUBLIC_MARKERS:
            if marker in text:
                failures.append(f"{relative_path} contains stale public marker: {marker}")
    return failures


def load_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
