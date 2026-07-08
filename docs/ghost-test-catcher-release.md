# Ghost Test Catcher Release Runbook

This runbook turns the repository into a repeatable product release flow for the Python CLI, the web app, and the VS Code extension.

## Release Readiness Criteria

- The Python package installs with the `ghost` extra.
- `ghost-test-catcher analyze` works against existing pytest-style files and `unittest.TestCase` files.
- `ghost-test-catcher ci` writes both JSON and Markdown reports.
- `ghost-test-catcher calibrate` passes every built-in calibration case.
- The VS Code extension passes syntax checks and unit tests.
- The VS Code extension packages into a `.vsix` that includes the icon, changelog, README, manifest, and extension code.
- The VS Code extension can cancel analysis and Doctor runs without leaving a stuck progress notification.
- The VS Code extension blocks test execution in untrusted workspaces when `ghostTestCatcher.requireWorkspaceTrustForExecution` is enabled and offers static analysis instead.

## Local Verification Commands

```bash
python -m pytest
python -m llmSHAP.ghost.cli calibrate --format pretty
python -m llmSHAP.ghost.cli ci \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --no-execution \
  --summary ghost-test-catcher-summary.md \
  --output ghost-test-catcher-report.json \
  --format json \
  --fail-on ghost_risk
cd packages/vscode-extension
npm install --ignore-scripts
npm run check
npm test
npm run package
```

## VSIX Installation Smoke Test

```bash
code --install-extension packages/vscode-extension/ghost-test-catcher-0.1.0.vsix --force
```

After installation, open a Python repository, open a test file, and run `Ghost Test Catcher: Run Doctor` from the command palette. The Doctor report should show the resolved project root, configured Python path, successful `llmSHAP.ghost.cli` import, source paths, and discovered tests. Then run `Ghost Test Catcher: Analyze Current Test File`. Also select a test file plus a source file in Explorer and run `Ghost Test Catcher: Analyze Selected Files or Folders`. The extension should show diagnostics on risky tests, CodeLens verdicts above tests, and a report panel through `Ghost Test Catcher: Open Last Report`.

Open `View: Toggle Output`, choose the `Ghost Test Catcher` output channel, and confirm process starts, stderr, and failure details are written there. Start a long analysis or Doctor run and click Cancel in the VS Code progress notification; the notification should close cleanly and the output channel should not keep receiving new process output.

For Workspace Trust smoke testing, open the same repository as an untrusted workspace, keep `ghostTestCatcher.requireWorkspaceTrustForExecution` set to `true`, and run `Ghost Test Catcher: Analyze Current Test File`. The extension should warn that test execution is blocked and offer `Run Static Analysis`. Choosing that option should produce a report without executing tests.

## Marketplace Publishing Notes

The package is prepared for Marketplace packaging with:

- `publisher`
- `displayName`
- `description`
- `categories`
- `keywords`
- `repository`
- `homepage`
- `bugs`
- `galleryBanner`
- a PNG icon at `media/icon.png`
- a changelog at `CHANGELOG.md`

The VS Code publishing documentation states that extension icons may not be SVG when publishing. Keep `media/icon.png` as the published icon and regenerate it with `python tools/generate_vscode_extension_icon.py` when the design changes.

## CI Gate Policy

Use `--fail-on ghost_risk` for the first rollout. It blocks only the highest-risk results while still surfacing `needs_review` cases in the report. Once the calibration suite grows and the team trusts the thresholds, move protected branches to `--fail-on needs_review`.

## Release Sequence

1. Run the local verification commands.
2. Confirm `packages/vscode-extension/ghost-test-catcher-0.1.0.vsix` was rebuilt.
3. Install the VSIX locally and run the extension against at least one grounded test and one intentionally ghost-risk test.
4. Push the branch and confirm GitHub Actions produces Python, calibration, CI gate, and extension packaging results.
5. Publish the VSIX manually from the Marketplace publisher management page or with `vsce publish` after publisher authentication is configured.
