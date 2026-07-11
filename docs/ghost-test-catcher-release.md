# Ghost Test Catcher Release Runbook

This runbook turns the repository into a repeatable product release flow for the Python CLI, the web app, and the VS Code extension.

## Release Readiness Criteria

- The Python package installs with the `ghost` extra from the local checkout and from the public GitHub repository install path pinned to the `v0.2.8` release tag used before PyPI publishing.
- `ghost-test-catcher analyze` works against existing pytest-style files and `unittest.TestCase` files.
- `ghost-test-catcher ci` writes both JSON and Markdown reports.
- `ghost-test-catcher calibrate` passes every built-in calibration case.
- The VS Code extension passes syntax checks and unit tests.
- The VS Code extension-host integration smoke suite passes through `@vscode/test-electron` on Windows, macOS, and Linux CI.
- The VS Code extension packages into a `.vsix` that includes the icon, changelog, README, manifest, and extension code.
- The VSIX includes bundled Python analyzer sources under `python-src/` so first-run VS Code analysis can import `ghost_test_catcher.cli` without relying on PyPI or a local checkout.
- The packaged-VSIX integration test installs the built extension into a clean VS Code profile and validates the demo, bundled CLI import path, fixture analysis, bad-Python-path handling, Testing panel refresh, and generated CI workflow.
- `Ghost Test Catcher: Analyze Demo Ghost Test` opens a self-contained report with one grounded test and one high-risk ghost test without writing project files or calling an LLM.
- `Ghost Test Catcher: Setup` detects Python, validates `ghost_test_catcher.cli`, applies a local/static/Docker execution profile, verifies Docker when selected, and opens Doctor.
- The VS Code extension can cancel analysis and Doctor runs without leaving a stuck progress notification.
- The VS Code extension blocks test execution in untrusted workspaces when `ghostTestCatcher.requireWorkspaceTrustForExecution` is enabled, restricts executable settings, and offers static analysis instead.
- The VS Code Testing panel shows discovered Python tests and the `Analyze with Ghost Test Catcher` run profile marks grounded, risky, and skipped tests correctly.
- Valid cached reports restore diagnostics and CodeLens after a VS Code reload, then invalidate when relevant Python files change.
- `ghostTestCatcher.persistAnalysisCache=false` keeps analysis cache entries in memory for the current VS Code session while clearing persisted report content from VS Code workspace state.
- Large-workspace test discovery shows a visible warning when `ghostTestCatcher.testDiscoveryLimit` is reached and offers actions to open or increase the setting.
- The report panel filters by verdict, framework, missing symbols, failed/risky tests, and evidence text.
- The report panel explains `Reliable`, `Needs review`, `Ghost risk`, ETV, and source evidence in the panel itself.
- `Ghost Test Catcher: Copy Report Summary` copies a decision-first Markdown summary containing keep/review/risk counts, verdict counts, cost/cache details, per-file results, true ETV, per-test grounding, symbol signals, evidence locations, execution status, and action guidance.
- Quick Fixes open evidence files, copy missing symbols, and rerun static-only analysis from diagnostics.
- `Ghost Test Catcher: Add GitHub Actions Gate` writes `.github/workflows/ghost-test-catcher.yml`.
- Docker execution works with the included `docker/ghost-test-catcher-runner/Dockerfile` image.
- The zero-cost architecture policy in `docs/zero-cost-architecture.md` remains true: no maintainer-funded LLM usage, paid backend dependency, paid telemetry dependency, shared paid API credentials, automatic paid-service fallback, or per-user infrastructure cost is introduced.
- `tools/zero_cost_architecture_audit.py` passes against source, and release validation passes with `--require-vsix --require-python-artifacts` after artifacts are built.

## Local Verification Commands

```bash
python tools/repo_hygiene_audit.py
python tools/zero_cost_architecture_audit.py
python -m pytest
python -m ghost_test_catcher.cli calibrate --format pretty
python -m ghost_test_catcher.cli doctor --repo .
docker build -t ghost-test-catcher-runner:latest docker/ghost-test-catcher-runner
python -m ghost_test_catcher.cli analyze \
  --repo . \
  --tests tests/test_webapp_execution.py \
  --source src \
  --execution-backend docker \
  --docker-image ghost-test-catcher-runner:latest \
  --format json
python -m ghost_test_catcher.cli ci \
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
npm run test:unit
npm run test:integration
npm run package
cd ../..
python tools/zero_cost_architecture_audit.py --require-vsix --require-python-artifacts
cd packages/vscode-extension
npm run test:integration:packaged
```

`npm run check` combines JavaScript syntax validation, the checked-JavaScript TypeScript/JSDoc gate, and `tools/vscode_extension_static_audit.js`, which catches command activation drift, unsafe process/webview patterns, Workspace Trust regressions, module size-budget drift, missing module tests, checked-JS drift, package hygiene regressions, and stale VSIX version references.

For local CI parity, run `npm run test:integration:ci`. The wrapper uses `xvfb-run -a` on Linux because VS Code needs a display server in headless runners, captures the integration log, and emits a concise GitHub annotation on failure. The GitHub Actions matrix in `.github/workflows/test.yml` covers `ubuntu-latest`, `windows-latest`, and `macos-15-intel`.

## VSIX Installation Smoke Test

```bash
code --install-extension packages/vscode-extension/ghost-test-catcher-0.2.8.vsix --force
```

After installation, run `Ghost Test Catcher: Analyze Demo Ghost Test` from the command palette. Confirm it opens a report with one safe-to-keep test, one high-risk ghost test, `0 LLM calls`, a visible `What does this verdict mean?` explanation, ETV/source-evidence wording, and demo copy that says no project files were modified.

Then open a Python repository, open a test file, and run `Ghost Test Catcher: Setup` from the command palette. The setup flow should find the intended Python executable, write workspace settings for the selected execution profile, detect whether `ghost_test_catcher.cli` imports from the bundled extension analyzer or configured environment, and open Doctor. The Doctor report should show the resolved project root, configured Python path, successful `ghost_test_catcher.cli` import, source paths, and discovered tests. Then run `Ghost Test Catcher: Analyze Current Test File`. Also select a test file plus a source file in Explorer and run `Ghost Test Catcher: Analyze Selected Files or Folders`. The extension should show diagnostics on risky tests, CodeLens verdicts above tests, and a report panel through `Ghost Test Catcher: Open Last Report`.

Open the VS Code Testing view and run `Ghost Test Catcher: Refresh Testing Panel`. The tree should show Python test files with child items for pytest-style functions and `unittest.TestCase` methods. Run the `Analyze with Ghost Test Catcher` profile from the Testing panel. Grounded executed tests should appear passed, unsupported or borderline tests should appear failed with a Ghost Test Catcher message, and grounded tests should appear skipped when execution is disabled.

Open the report panel and verify the verdict, framework, missing-symbol, failed/risky, and evidence-text filters hide and show the expected rows. Confirm the table uses `Symbol Signal` and `Action` so grounded passing tests with helper or fixture context gaps do not read like ghost-test failures. Run `Ghost Test Catcher: Copy Report Summary`, paste the clipboard into a scratch Markdown file, and confirm it includes keep/review/risk counts, verdict counts, cost/cache details, workspace-relative file paths, file verdicts, true ETV from the report components, per-test grounding, symbol signals, evidence locations, execution status, and action guidance. A reliable all-passing report must not show `ETV: 0.0%` unless the underlying report component is actually zero.

Run `Ghost Test Catcher: Add GitHub Actions Gate` and confirm `.github/workflows/ghost-test-catcher.yml` contains a pinned GitHub-repository package install command, a `ghost-test-catcher ci` job, summary publishing, and artifact upload. Do not keep the generated workflow in unrelated release commits unless the release intentionally enables CI gating.

Reload VS Code after a completed analysis and confirm cached diagnostics and CodeLens reappear. Modify a relevant Python file and confirm the stale diagnostics are cleared until the next analysis. Then set `ghostTestCatcher.persistAnalysisCache` to `false`, run analysis again, reload VS Code, and confirm persisted cached diagnostics are not restored while same-session repeated analysis can still reuse valid in-memory cache entries.

For large-workspace discovery smoke testing, temporarily set `ghostTestCatcher.testDiscoveryLimit` to a low value such as `1`, run `Ghost Test Catcher: Refresh Testing Panel`, and confirm the warning offers `Increase Limit` and `Open Settings`. Choose `Increase Limit`, verify the workspace setting updates, then restore the intended limit before committing.

Open `View: Toggle Output`, choose the `Ghost Test Catcher` output channel, and confirm process starts, stderr, and failure details are written there. Start a long analysis or Doctor run and click Cancel in the VS Code progress notification; the notification should close cleanly and the output channel should not keep receiving new process output.

For Workspace Trust smoke testing, open the same repository as an untrusted workspace, keep `ghostTestCatcher.requireWorkspaceTrustForExecution` set to `true`, and run `Ghost Test Catcher: Analyze Current Test File`. The extension should warn that test execution is blocked and offer `Run Static Analysis`. Choosing that option should produce a report without executing tests through the packaged analyzer source path. The output channel should show that workspace paths were not prepended to `PYTHONPATH` for the CLI process.

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
- Marketplace README screenshots in `media/screenshot-report.png`, `media/screenshot-diagnostics.png`, and `media/screenshot-testing.png`
- VS Code walkthrough Markdown in `media/walkthrough-demo.md`, `media/walkthrough-setup.md`, `media/walkthrough-review.md`, and `media/walkthrough-ci.md`
- a changelog at `CHANGELOG.md`
- bundled Python analyzer sources generated into `python-src/` at package time

The VS Code publishing documentation states that extension icons may not be SVG when publishing. Keep `media/icon.png` as the published icon and regenerate it with `python tools/generate_vscode_extension_icon.py` when the design changes. Regenerate Marketplace screenshots with `python tools/generate_vscode_marketplace_assets.py` when the report, diagnostics, or Testing panel story changes. This release uses real PNG screenshots already checked into `packages/vscode-extension/media`. No GIF is packaged; if a GIF is added later, capture a real flow of `Ghost Test Catcher: Analyze Demo Ghost Test` followed by `Ghost Test Catcher: Analyze Current Test File` and place it at `packages/vscode-extension/media/demo-flow.gif`, then reference it from the extension README.

The public PyPI project name `ghost-test-catcher` is not published as of the v0.2.8 release-prep validation. The VS Code extension works around that by bundling analyzer sources, and generated CI workflows install from the public GitHub repository pinned to the immutable `v0.2.8` git tag. Publishing the Python package to PyPI remains a Marketplace-readiness follow-up for teams that want `pip install "ghost-test-catcher[ghost]"` instead of a GitHub direct-reference install.

Before creating a public Python package release, publish the matching wheel and sdist from the exact commit tagged `v0.2.8`. Once PyPI is live, update the generated CI install command from the tagged GitHub direct reference to a versioned PyPI install such as `python -m pip install "ghost-test-catcher[ghost]==0.2.8"`.

## CI Gate Policy

Use `--fail-on ghost_risk` for the first rollout. It blocks only the highest-risk results while still surfacing `needs_review` cases in the report. Once the calibration suite grows and the team trusts the thresholds, move protected branches to `--fail-on needs_review`.

## Release Sequence

1. Run the local verification commands.
2. Confirm `python tools/repo_hygiene_audit.py` and `python tools/zero_cost_architecture_audit.py` pass before packaging or publishing.
3. Confirm `packages/vscode-extension/ghost-test-catcher-0.2.8.vsix` was rebuilt.
4. Run `python tools/zero_cost_architecture_audit.py --require-vsix --require-python-artifacts` from the repository root to inspect the VSIX, wheel, and sdist for secrets and cost-risk regressions.
5. Run `npm run test:integration:packaged` from `packages/vscode-extension` to validate the rebuilt VSIX in a clean VS Code profile.
6. Install the VSIX locally and run the extension against at least one grounded test and one intentionally ghost-risk test.
7. Push the branch and confirm GitHub Actions produces Python, calibration, CI gate, zero-cost architecture audit, extension packaging, packaged-VSIX validation, and extension-host integration results.
8. Publish the VSIX manually from the Marketplace publisher management page or with `vsce publish` after publisher authentication is configured.
