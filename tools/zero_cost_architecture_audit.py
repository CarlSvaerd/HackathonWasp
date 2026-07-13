from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
EXTENSION_DIR = ROOT / "packages" / "vscode-extension"
ZERO_COST_DOC = ROOT / "docs" / "zero-cost-architecture.md"

TEXT_FILE_SUFFIXES = {
    "",
    ".cfg",
    ".css",
    ".dockerignore",
    ".gitignore",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".md",
    ".py",
    ".rst",
    ".toml",
    ".txt",
    ".yml",
    ".yaml",
}

BINARY_FILE_SUFFIXES = {
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".pyc",
    ".vsix",
    ".whl",
    ".zip",
}

SOURCE_SCAN_EXCLUDED_PREFIXES = (
    "dist/",
    "packages/vscode-extension/.vscode-test/",
    "packages/vscode-extension/node_modules/",
    "packages/vscode-extension/python-src/",
)

PROVIDER_OR_PAID_RUNTIME_DEPENDENCIES = {
    "openai",
    "anthropic",
    "google-generativeai",
    "google-genai",
    "boto3",
    "botocore",
    "azure-ai-openai",
    "azure-ai-inference",
    "azure-identity",
    "cohere",
    "mistralai",
    "pinecone-client",
    "weaviate-client",
    "qdrant-client",
    "chromadb",
    "sentry-sdk",
    "posthog",
    "mixpanel",
    "segment-analytics-python",
    "datadog",
}

TELEMETRY_NPM_DEPENDENCIES = {
    "@sentry/node",
    "@sentry/electron",
    "applicationinsights",
    "posthog-node",
    "posthog-js",
    "mixpanel",
    "analytics-node",
    "@segment/analytics-node",
    "datadog-metrics",
    "winston-transport-sentry-node",
}

SECRET_PATTERNS = {
    "OpenAI-style secret key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "GitHub classic token": re.compile(r"\bghp_[A-Za-z0-9_]{20,}\b"),
    "GitHub fine-grained token": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    "PyPI token": re.compile(r"\bpypi-[A-Za-z0-9_-]{20,}\b"),
    "GitLab token": re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
}

EXTENSION_RUNTIME_FORBIDDEN_PATTERNS = {
    "fetch() network call": re.compile(r"\bfetch\s*\("),
    "XMLHttpRequest network call": re.compile(r"\bXMLHttpRequest\b"),
    "WebSocket network call": re.compile(r"\bWebSocket\b"),
    "Node http/https client": re.compile(r"require\s*\(\s*['\"]https?['\"]\s*\)"),
    "axios client": re.compile(r"\baxios\b"),
    "node-fetch client": re.compile(r"\bnode-fetch\b"),
    "got client": re.compile(r"require\s*\(\s*['\"]got['\"]\s*\)"),
    "VS Code telemetry logger": re.compile(r"\bcreateTelemetryLogger\s*\("),
    "OpenAI runtime credential in extension": re.compile(r"\bOPENAI_API_KEY\b|\bOpenAI\b"),
    "Anthropic runtime credential in extension": re.compile(r"\bANTHROPIC_API_KEY\b|\bAnthropic\b"),
    "Gemini runtime credential in extension": re.compile(r"\bGEMINI_API_KEY\b|\bGOOGLE_API_KEY\b"),
}

ALLOWED_RUNNER_EXPRESSIONS = {
    "ubuntu-latest",
    "windows-latest",
    "macos-15-intel",
    "${{ matrix.os }}",
}

FORBIDDEN_ARTIFACT_NAME_PARTS = (
    ".env",
    ".pypirc",
    ".npmrc",
    "node_modules/",
    ".vscode-test/",
    "__pycache__/",
)


@dataclass(frozen=True)
class AuditResult:
    failures: list[str]
    notes: list[str]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit Ghost Test Catcher for zero maintainer-cost architecture.")
    parser.add_argument("--require-vsix", action="store_true", help="Fail if the current VSIX artifact is missing.")
    parser.add_argument(
        "--require-python-artifacts",
        action="store_true",
        help="Fail if the current Python wheel and sdist artifacts are missing.",
    )
    parser.add_argument(
        "--artifact-dir",
        default=str(ROOT / "dist"),
        help="Directory to inspect for Python wheel/sdist artifacts. Defaults to dist/.",
    )
    args = parser.parse_args(argv)

    result = run_audit(
        require_vsix=args.require_vsix,
        require_python_artifacts=args.require_python_artifacts,
        artifact_dir=Path(args.artifact_dir),
    )
    if result.failures:
        print("Ghost Test Catcher zero-cost architecture audit failed:\n")
        for failure in result.failures:
            print(f"- {failure}")
        if result.notes:
            print("\nContext:")
            for note in result.notes:
                print(f"- {note}")
        return 1

    print("Ghost Test Catcher zero-cost architecture audit passed.")
    for note in result.notes:
        print(f"- {note}")
    return 0


def run_audit(
    *,
    require_vsix: bool = False,
    require_python_artifacts: bool = False,
    artifact_dir: Path | None = None,
) -> AuditResult:
    failures: list[str] = []
    notes: list[str] = []

    package_json = load_json(EXTENSION_DIR / "package.json")
    version = str(package_json.get("version", "")).strip()

    checks = (
        check_policy_document,
        check_python_package_metadata,
        check_extension_manifest,
        check_extension_runtime_surface,
        check_workflows,
        check_generated_ci_workflow,
        check_existing_test_zero_llm_invariant,
        check_tracked_source_for_secret_patterns,
    )

    for check in checks:
        failures.extend(check())

    artifact_failures, artifact_notes = check_release_artifacts(
        version=version,
        require_vsix=require_vsix,
        require_python_artifacts=require_python_artifacts,
        artifact_dir=artifact_dir or (ROOT / "dist"),
    )
    failures.extend(artifact_failures)
    notes.extend(artifact_notes)

    notes.append("Maintainer variable cost per existing-test analysis remains EUR 0.")
    notes.append("Normal VS Code and CLI existing-test review paths have no LLM provider call and no maintainer backend.")
    return AuditResult(failures=failures, notes=notes)


def check_policy_document() -> list[str]:
    failures: list[str] = []
    if not ZERO_COST_DOC.exists():
        return ["docs/zero-cost-architecture.md must document the zero maintainer-cost architecture policy"]

    text = read_text(ZERO_COST_DOC)
    required_phrases = [
        "Maintainer Cost Policy",
        "Maintainer variable cost per analysis: EUR 0.",
        "Maintainer-funded LLM usage",
        "A paid backend dependency",
        "Shared paid API credentials",
        "Automatic paid-service fallback",
        "The maintainer must never supply a shared paid API key",
        "tools/zero_cost_architecture_audit.py",
    ]
    for phrase in required_phrases:
        if phrase not in text:
            failures.append(f"docs/zero-cost-architecture.md must include policy phrase: {phrase}")
    return failures


def check_python_package_metadata() -> list[str]:
    failures: list[str] = []
    pyproject = load_toml(ROOT / "pyproject.toml")
    project = pyproject.get("project", {})
    core_dependencies = dependency_names(project.get("dependencies", []))
    optional_dependencies = project.get("optional-dependencies", {})
    ghost_dependencies = dependency_names(optional_dependencies.get("ghost", []))

    forbidden_core = sorted(core_dependencies & PROVIDER_OR_PAID_RUNTIME_DEPENDENCIES)
    if forbidden_core:
        failures.append(
            "pyproject core dependencies must not require provider, paid SaaS, telemetry, or hosted-service packages: "
            + ", ".join(forbidden_core)
        )

    forbidden_ghost = sorted(ghost_dependencies & PROVIDER_OR_PAID_RUNTIME_DEPENDENCIES)
    if forbidden_ghost:
        failures.append(
            "pyproject ghost extra must stay local-first and must not require provider, paid SaaS, telemetry, or hosted-service packages: "
            + ", ".join(forbidden_ghost)
        )

    if "pytest" not in ghost_dependencies:
        failures.append("pyproject ghost extra should include pytest for local existing-test execution")

    return failures


def check_extension_manifest() -> list[str]:
    failures: list[str] = []
    package = load_json(EXTENSION_DIR / "package.json")
    dependencies = package.get("dependencies") or {}
    dev_dependencies = package.get("devDependencies") or {}

    if dependencies:
        failures.append(
            "VS Code extension package.json must not add production dependencies without a cost/privacy review; found: "
            + ", ".join(sorted(dependencies))
        )

    telemetry_deps = sorted((set(dependencies) | set(dev_dependencies)) & TELEMETRY_NPM_DEPENDENCIES)
    if telemetry_deps:
        failures.append("VS Code extension must not include telemetry/analytics dependencies: " + ", ".join(telemetry_deps))

    if str(package.get("pricing", "")).lower() != "free":
        failures.append("VS Code extension package.json pricing must remain Free")

    readme = read_text(EXTENSION_DIR / "README.md")
    for phrase in [
        "Telemetry-free",
        "does not send existing-test review content to an LLM provider",
        "0 LLM calls",
    ]:
        if phrase not in readme:
            failures.append(f"VS Code extension README must document cost/privacy phrase: {phrase}")

    return failures


def check_extension_runtime_surface() -> list[str]:
    failures: list[str] = []
    for module_path in sorted(EXTENSION_DIR.glob("extension*.js")):
        text = read_text(module_path)
        for label, pattern in EXTENSION_RUNTIME_FORBIDDEN_PATTERNS.items():
            if pattern.search(text):
                failures.append(f"{relative(module_path)} contains forbidden runtime surface for zero-cost extension: {label}")
    return failures


def check_workflows() -> list[str]:
    failures: list[str] = []
    workflow_paths = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    workflow_paths.extend(sorted((ROOT / ".github" / "workflows").glob("*.yaml")))
    for workflow_path in workflow_paths:
        text = read_text(workflow_path)
        rel = relative(workflow_path)
        if re.search(r"^\s*schedule\s*:", text, flags=re.MULTILINE):
            failures.append(f"{rel} must not add scheduled CI without an explicit cost decision")
        if re.search(r"\bcron\s*:", text):
            failures.append(f"{rel} must not add cron CI without an explicit cost decision")
        if re.search(r"\bself-hosted\b", text):
            failures.append(f"{rel} must not use self-hosted runners without an explicit cost decision")
        if re.search(r"\b(?:2xlarge|4xlarge|8xlarge|xlarge|large)\b", text):
            failures.append(f"{rel} must not use larger/premium runner labels without an explicit cost decision")

        for runner in re.findall(r"^\s*runs-on:\s*(.+?)\s*$", text, flags=re.MULTILINE):
            runner_value = runner.strip().strip("\"'")
            if runner_value not in ALLOWED_RUNNER_EXPRESSIONS:
                failures.append(f"{rel} uses unreviewed runner expression: {runner_value}")

        failures.extend(check_upload_artifact_retention(workflow_path, text))
    return failures


def check_upload_artifact_retention(path: Path, text: str) -> list[str]:
    failures: list[str] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if "uses: actions/upload-artifact@" not in line:
            continue
        window = "\n".join(lines[index : index + 14])
        if "retention-days:" not in window:
            failures.append(f"{relative(path)} upload-artifact step at line {index + 1} must set retention-days")
    return failures


def check_generated_ci_workflow() -> list[str]:
    failures: list[str] = []
    expected_ref = 'REPOSITORY_PACKAGE_REF = "v0.2.9"'
    core_path = EXTENSION_DIR / "extensionCore.js"
    text = read_text(core_path)
    if '@${REPOSITORY_PACKAGE_REF}' not in text:
        failures.append("extensionCore.js generated CI install must pin to REPOSITORY_PACKAGE_REF")
    if expected_ref not in text:
        failures.append("extensionCore.js generated CI install must remain pinned to the verified immutable analyzer release tag: v0.2.9")
    if "@main" in text or "@master" in text:
        failures.append("extensionCore.js generated CI install must not use moving branch refs")
    if "uses: actions/upload-artifact@v4" in text and "retention-days:" not in text:
        failures.append("extensionCore.js generated CI workflow upload step must set retention-days")
    return failures


def check_existing_test_zero_llm_invariant() -> list[str]:
    failures: list[str] = []
    analysis_path = ROOT / "src" / "llmSHAP" / "ghost" / "analysis.py"
    text = read_text(analysis_path)
    for snippet in [
        '"llm_calls": 0',
        '"estimated_input_tokens": 0',
        '"estimated_output_tokens": 0',
        '"token_estimator": "none"',
        "No LLM provider is called for the VS Code, CLI analyze, or CLI ci review path.",
    ]:
        if snippet not in text:
            failures.append(f"src/llmSHAP/ghost/analysis.py must preserve zero-LLM existing-test invariant: {snippet}")
    return failures


def check_tracked_source_for_secret_patterns() -> list[str]:
    failures: list[str] = []
    for rel_path in git_ls_files():
        if not should_scan_source_file(rel_path):
            continue
        path = ROOT / rel_path
        text = read_text(path, errors="ignore")
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                failures.append(f"{rel_path} appears to contain a {label}")
    return failures


def check_release_artifacts(
    *,
    version: str,
    require_vsix: bool,
    require_python_artifacts: bool,
    artifact_dir: Path,
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    notes: list[str] = []

    vsix_path = EXTENSION_DIR / f"ghost-test-catcher-{version}.vsix"
    if vsix_path.exists():
        failures.extend(scan_zip_artifact(vsix_path, artifact_label="VSIX"))
        notes.append(f"VSIX artifact scanned: {relative(vsix_path)}")
    elif require_vsix:
        failures.append(f"Expected VSIX artifact is missing: {relative(vsix_path)}")
    else:
        notes.append(f"VSIX artifact not present, artifact scan skipped: {relative(vsix_path)}")

    artifact_root = artifact_dir if artifact_dir.is_absolute() else ROOT / artifact_dir
    wheel_paths = sorted(artifact_root.glob(f"**/ghost_test_catcher-{version}-*.whl"))
    sdist_paths = sorted(artifact_root.glob(f"**/ghost_test_catcher-{version}.tar.gz"))
    if require_python_artifacts and (wheel_paths or sdist_paths):
        for wheel_path in wheel_paths:
            failures.extend(scan_zip_artifact(wheel_path, artifact_label="Python wheel"))
            notes.append(f"Python wheel scanned: {relative(wheel_path)}")
        for sdist_path in sdist_paths:
            failures.extend(scan_tar_artifact(sdist_path, artifact_label="Python sdist"))
            notes.append(f"Python sdist scanned: {relative(sdist_path)}")
    elif require_python_artifacts:
        failures.append(f"Expected Python wheel/sdist artifacts for version {version} are missing under {artifact_root}")
    elif wheel_paths or sdist_paths:
        notes.append(
            f"Python wheel/sdist artifacts are present for version {version}; pass --require-python-artifacts to scan them."
        )
    else:
        notes.append(f"Python wheel/sdist artifacts not present, artifact scan skipped for version {version}.")

    return failures, notes


def scan_zip_artifact(path: Path, *, artifact_label: str) -> list[str]:
    failures: list[str] = []
    try:
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                failures.extend(check_artifact_member_name(path, info.filename, artifact_label))
                if info.file_size > 2_000_000 or not should_scan_artifact_member(info.filename):
                    continue
                data = archive.read(info.filename)
                failures.extend(check_text_blob_for_secret_patterns(path, info.filename, data, artifact_label))
    except (OSError, zipfile.BadZipFile) as exc:
        failures.append(f"Could not inspect {artifact_label} artifact {relative(path)}: {exc}")
    return failures


def scan_tar_artifact(path: Path, *, artifact_label: str) -> list[str]:
    failures: list[str] = []
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for member in archive.getmembers():
                failures.extend(check_artifact_member_name(path, member.name, artifact_label))
                if not member.isfile() or member.size > 2_000_000 or not should_scan_artifact_member(member.name):
                    continue
                extracted = archive.extractfile(member)
                if extracted is None:
                    continue
                failures.extend(check_text_blob_for_secret_patterns(path, member.name, extracted.read(), artifact_label))
    except (OSError, tarfile.TarError) as exc:
        failures.append(f"Could not inspect {artifact_label} artifact {relative(path)}: {exc}")
    return failures


def check_artifact_member_name(path: Path, member_name: str, artifact_label: str) -> list[str]:
    normalized = member_name.replace("\\", "/")
    failures: list[str] = []
    for forbidden in FORBIDDEN_ARTIFACT_NAME_PARTS:
        if forbidden in normalized:
            failures.append(f"{artifact_label} {relative(path)} contains forbidden packaged path: {normalized}")
    return failures


def check_text_blob_for_secret_patterns(path: Path, member_name: str, data: bytes, artifact_label: str) -> list[str]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return []

    failures: list[str] = []
    for label, pattern in SECRET_PATTERNS.items():
        if pattern.search(text):
            failures.append(f"{artifact_label} {relative(path)} member {member_name} appears to contain a {label}")
    return failures


def dependency_names(requirements: Iterable[str]) -> set[str]:
    names: set[str] = set()
    for requirement in requirements:
        raw = str(requirement).strip()
        if not raw:
            continue
        match = re.match(r"([A-Za-z0-9_.-]+)", raw)
        if match:
            names.add(match.group(1).lower().replace("_", "-"))
    return names


def should_scan_source_file(rel_path: str) -> bool:
    normalized = rel_path.replace("\\", "/")
    if any(normalized.startswith(prefix) for prefix in SOURCE_SCAN_EXCLUDED_PREFIXES):
        return False
    suffix = Path(normalized).suffix.lower()
    if suffix in BINARY_FILE_SUFFIXES:
        return False
    if suffix not in TEXT_FILE_SUFFIXES and Path(normalized).name not in {"Makefile", "Dockerfile", "LICENSE"}:
        return False
    try:
        path = ROOT / normalized
        return path.is_file() and path.stat().st_size <= 2_000_000
    except OSError:
        return False


def should_scan_artifact_member(member_name: str) -> bool:
    suffix = Path(member_name).suffix.lower()
    if suffix in BINARY_FILE_SUFFIXES:
        return False
    return suffix in TEXT_FILE_SUFFIXES or suffix in {".dist-info"}


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


def load_json(path: Path) -> dict:
    return json.loads(read_text(path))


def load_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def read_text(path: Path, *, errors: str = "strict") -> str:
    return path.read_text(encoding="utf-8", errors=errors)


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
