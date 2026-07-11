# Contributing to Ghost Test Catcher

Ghost Test Catcher is a developer tool for checking whether Python tests, especially AI-generated tests, are grounded in real source code. Contributions should make that workflow clearer, safer, faster, or easier to trust.

The repository still includes the underlying `llmSHAP` attribution engine that powers parts of the analysis pipeline. Public product work should keep Ghost Test Catcher as the first-class user experience and treat `llmSHAP` internals as supporting implementation unless a change is explicitly about the attribution engine.

## Development Setup

Use Python 3.11 or newer.

```bash
pip install -e ".[codebase,webapp,dev]"
```

For the VS Code extension:

```bash
cd packages/vscode-extension
npm install --ignore-scripts
```

## Required Checks

Run the hygiene audit before committing product-facing changes:

```bash
python tools/repo_hygiene_audit.py
```

Run the zero-cost architecture audit before changes that touch extension runtime behavior, CLI execution, CI, package metadata, release artifacts, telemetry, or optional AI/provider code:

```bash
python tools/zero_cost_architecture_audit.py
```

Run the Python test suite:

```bash
python -m pytest
```

Run the VS Code extension unit checks:

```bash
cd packages/vscode-extension
npm run check
npm test
```

`npm run check` is intentionally split into three gates: `check:syntax` validates every packaged extension module with `node --check`, `check:types` runs checked-JavaScript type validation through `tsc`, and `check:static` runs the repository-specific extension audit for command parity, Workspace Trust restrictions, webview/process safety, module budgets, focused unit coverage, package hygiene, and VSIX version references.

For one-command local confidence when dependencies are already installed:

```bash
make quality PYTHON=python
```

## Repository Hygiene

Do not commit generated package-manager caches, local extension packages, local reports, or duplicate root documentation. In particular, keep these out of Git:

- `.pnpm-store/`
- `packages/vscode-extension/*.vsix`
- `packages/vscode-extension/.vscode-test/`
- `packages/vscode-extension/node_modules/`
- `ghost-test-catcher-report.json`
- `ghost-test-catcher-summary.md`
- `README 2.md` or any other duplicate root README
- `*.egg-info/`

The hygiene audit fails if these show up as tracked files.

## Coding Guidelines

- Keep product copy direct and decision-oriented. Users should understand whether a test is safe to keep, needs review, or is high-risk.
- Prefer small, deterministic tests. Avoid tests that require network calls unless they are explicitly opt-in.
- Keep execution safety visible. Changes that run code should preserve workspace trust checks, confirmation prompts, timeouts, and clear output-channel logs.
- Preserve the zero maintainer-cost architecture. Do not add maintainer-funded LLM calls, shared paid API credentials, telemetry services, hosted backends, automatic paid fallbacks, or usage-based SaaS dependencies without an explicit architecture decision.
- Do not add speculative abstractions unless they have a current caller, test, and user-facing reason to exist.
- Keep generated artifacts out of source control. Release artifacts belong in GitHub Releases, package registries, or the VS Code Marketplace, not normal commits.

## Pull Request Checklist

- [ ] `python tools/repo_hygiene_audit.py` passes.
- [ ] `python tools/zero_cost_architecture_audit.py` passes, and release builds with artifacts also pass `python tools/zero_cost_architecture_audit.py --require-vsix --require-python-artifacts`.
- [ ] `python -m pytest` passes.
- [ ] `npm run check`, including syntax, type, and static extension gates, passes in `packages/vscode-extension`.
- [ ] `npm test` passes in `packages/vscode-extension`.
- [ ] User-facing behavior has tests or a documented manual verification path.
- [ ] Documentation and release notes are updated when commands, settings, reports, or package filenames change.
- [ ] No secrets, local paths, generated caches, or local build outputs are included.

## Reporting Bugs

Please include:

- the command or VS Code action you ran,
- the test file and source paths involved,
- whether execution was local, static-only, or Docker-backed,
- the Ghost Test Catcher output-channel error if the VS Code extension failed,
- your OS, Python version, VS Code version, and extension version.

## License

By contributing, you agree that your contributions are licensed under the repository's MIT License.
