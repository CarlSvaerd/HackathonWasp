# Ghost Test Catcher Zero-Cost Architecture

Ghost Test Catcher is intended to remain a free, local-first developer tool. The product may use public package registries and user-owned compute, but normal use must not create a usage-based bill for the maintainer.

## Maintainer Cost Policy

Ghost Test Catcher must not introduce:

- Maintainer-funded LLM usage.
- A paid backend dependency.
- A usage-based SaaS dependency.
- A paid telemetry dependency.
- Shared paid API credentials.
- Automatic paid-service fallback.
- Per-user infrastructure cost.

Any future feature capable of creating maintainer cost must receive an explicit architecture decision before implementation. The decision must identify the billing owner, user consent flow, fallback behavior, and failure mode before code is merged.

Maintainer variable cost per analysis: EUR 0.

## Allowed AI Models

Optional AI features are allowed only when the user controls the billing and execution boundary:

- A user supplies their own API key with explicit opt-in.
- A user runs a local model.
- A user points Ghost Test Catcher at a user-controlled external service.

The maintainer must never supply a shared paid API key for end-user usage. The extension must not embed trial keys, proxy user prompts through a maintainer-funded backend, or silently fall back from local analysis to paid inference.

## Current Runtime Cost Map

| Runtime path | Network required | Credential required | Billing owner | Maintainer variable cost |
| --- | --- | --- | --- | --- |
| VS Code extension install from Marketplace or VSIX | Marketplace or local VSIX distribution only | None for installed use | Microsoft/package registry for distribution; user for download bandwidth | EUR 0 per install |
| Analyze Demo Ghost Test | No | None | Local machine | EUR 0 |
| Run Doctor | No | None | Local machine | EUR 0 |
| Analyze existing Python test | No | None | Local machine, or user-selected Docker daemon | EUR 0 |
| Generate report, diagnostics, CodeLens, Testing panel results, Quick Fixes, summaries | No | None | Local machine | EUR 0 |
| Add GitHub Actions Gate | No network during generation | None | User's repository if they commit and run the generated workflow | EUR 0 for the maintainer |
| CLI doctor, calibrate, analyze, ci | No | None | Local machine or user-owned CI runner | EUR 0 |
| Optional CLI `generate-and-check` | Yes, only when explicitly invoked | User-provided OpenAI key or user environment key | User's provider account | EUR 0 for the maintainer |
| Optional local web app generation | Yes, through the local FastAPI app to OpenAI when submitted | User-entered API key | User's provider account | EUR 0 for the maintainer |
| Optional embedding API endpoint in llmSHAP internals | Yes, only when code explicitly passes an endpoint | User environment key | User's provider account | EUR 0 for the maintainer |

## CI And Release Cost Boundaries

Repository CI may use standard GitHub-hosted runners for pushes and pull requests. That usage belongs to the repository owner or GitHub plan, not to end-user analysis. CI must stay predictable and bounded:

- Do not add scheduled workflows without a specific release or maintenance reason.
- Do not use larger runners or self-hosted infrastructure without an explicit cost decision.
- Keep matrix sizes intentional.
- Set artifact retention for generated reports and VSIX artifacts.
- Prefer trusted publishing or short-lived release credentials over long-lived tokens.

Generated user CI workflows must run in the user's repository and must install Ghost Test Catcher from a pinned public release or versioned package. They must not call a maintainer backend.

## Telemetry And Hosted Services

The current VS Code extension is telemetry-free. It must not send usage events, crash reports, source code, test contents, file paths, device identifiers, or workspace identifiers to a hosted analytics or error-reporting service.

If optional telemetry is ever proposed, it must be opt-in, privacy-reviewed, cost-reviewed, and disabled by default. This release does not implement telemetry.

## Distribution

Distribution should use public package infrastructure:

- VS Code Marketplace or direct VSIX files for the extension.
- PyPI after the Python package is published.
- Immutable GitHub tags as the temporary CLI install fallback while PyPI publishing is pending.

Do not introduce a custom download server, hosted database, queue, vector database, analytics project, logging service, or inference proxy for normal product operation.

## Automated Guardrails

The repository includes `tools/zero_cost_architecture_audit.py`. It checks the source tree, extension manifest, CI workflow cost boundaries, generated CI workflow, zero-LLM existing-test invariant, package metadata, secret patterns, and release artifacts when present.

Run it before cost-sensitive changes:

```bash
python tools/zero_cost_architecture_audit.py
```

For release validation after packaging artifacts exist:

```bash
python tools/zero_cost_architecture_audit.py --require-vsix --require-python-artifacts
```
