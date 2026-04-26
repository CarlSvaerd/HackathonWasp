import React, { useEffect, useState } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function verdictLabel(verdict) {
  if (verdict === "grounded") return "Grounded";
  if (verdict === "ghost_risk") return "Ghost risk";
  return "Mixed";
}

function supportLabel(status) {
  if (status === "supported") return "Grounded";
  if (status === "borderline") return "Borderline";
  if (status === "unsupported") return "Ghost risk";
  return "Unknown";
}

function trustVerdictLabel(verdict) {
  if (verdict === "reliable") return "Reliable";
  if (verdict === "ghost_risk") return "Ghost Test Risk";
  return "Needs Review";
}

function testModeLabel(mode) {
  if (mode === "unit") return "Unit";
  if (mode === "integration") return "Integration";
  if (mode === "e2e") return "End-to-end";
  return "Mixed";
}

function executionLabel(status) {
  if (status === "passed") return "Runnable";
  if (status === "failed") return "Fails in pytest";
  if (status === "timeout") return "Timed out";
  if (status === "invalid_test_code") return "Invalid test code";
  if (status === "no_tests_detected" || status === "no_tests_collected") return "No runnable tests";
  return "Unknown";
}

function firstItems(items, limit = 3) {
  return (items || []).slice(0, limit);
}

function topFailureReason(result) {
  if (result.execution?.primary_failure) return result.execution.primary_failure;
  if (result.preflight?.missing_imports?.length) return `Missing imports: ${result.preflight.missing_imports.join(", ")}`;
  if (result.preflight?.missing_symbols?.length) return `Missing symbols: ${result.preflight.missing_symbols.join(", ")}`;
  if (result.generated_tests?.syntax_error) return result.generated_tests.syntax_error;
  return "";
}

function executionAlert(result) {
  if (result.execution?.status !== "passed") {
    return {
      kicker: "Pytest failure",
      title: topFailureReason(result) || "The generated tests do not line up cleanly with the uploaded files.",
      copy: result.execution?.message,
    };
  }
  return null;
}

function groundingAlert(result) {
  if (result.preflight?.status !== "clear") {
    return {
      kicker: "Grounding warning",
      title: "Generated tests passed, but the static grounding check still found unsupported imports or symbols.",
      copy: result.preflight.message,
    };
  }
  return null;
}

function perTestViewModel(result) {
  const verificationByName = Object.fromEntries(
    (result.verification?.claim_checks || []).map((item) => [item.claim, item])
  );
  const executionByName = Object.fromEntries(
    (result.execution?.per_test_results || []).map((item) => [item.name, item])
  );

  return (result.generated_tests?.test_names || []).map((name) => {
    const verification = verificationByName[name] || null;
    const execution = executionByName[name] || { status: "unknown" };
    return {
      name,
      groundedStatus: verification?.status || "unsupported",
      groundedConfidence: verification?.confidence || 0,
      missingSymbols: verification?.missing_symbols || [],
      evidence: verification?.evidence || null,
      executionStatus: execution.status || "unknown",
    };
  });
}

function perTestSummary(items) {
  return {
    supported: items.filter((item) => item.groundedStatus === "supported").length,
    borderline: items.filter((item) => item.groundedStatus === "borderline").length,
    unsupported: items.filter((item) => item.groundedStatus === "unsupported").length,
  };
}

function loadingStageLabel(progress) {
  if (progress < 0.25) return "Preparing uploaded files";
  if (progress < 0.5) return "Generating candidate tests";
  if (progress < 0.75) return "Scoring groundedness and attribution";
  return "Running pytest and assembling the verdict";
}

function App() {
  const [apiKey, setApiKey] = useState("");
  const [testMode, setTestMode] = useState("mixed");
  const [model, setModel] = useState("gpt-4o-mini");
  const [files, setFiles] = useState([]);
  const [demoOptions, setDemoOptions] = useState([]);
  const [demoPreset, setDemoPreset] = useState(null);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [error, setError] = useState("");
  const perTestItems = result ? perTestViewModel(result) : [];
  const perTestStats = perTestSummary(perTestItems);
  const runtimeAlert = result ? executionAlert(result) : null;
  const preflightAlert = result ? groundingAlert(result) : null;

  useEffect(() => {
    if (!loading) {
      setLoadingProgress(0);
      return undefined;
    }

    setLoadingProgress(0.08);
    const interval = window.setInterval(() => {
      setLoadingProgress((current) => {
        if (current >= 0.92) {
          return current;
        }
        const increment = current < 0.4 ? 0.08 : current < 0.75 ? 0.05 : 0.025;
        return Math.min(0.92, current + increment);
      });
    }, 450);

    return () => window.clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    let active = true;

    async function loadDemoOptions() {
      try {
        const response = await fetch("/api/demo-presets");
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.detail || "Could not load demo scenarios.");
        }
        if (active) {
          setDemoOptions(payload.presets || []);
        }
      } catch (_error) {
        if (active) {
          setDemoOptions([]);
        }
      }
    }

    loadDemoOptions();
    return () => {
      active = false;
    };
  }, []);

  async function loadDemoPreset(presetId) {
    setLoadingDemo(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch(`/api/demo-preset/${presetId}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || "Could not load the demo preset.");
      }

      const demoFiles = (payload.files || []).map(
        (file) => new File([file.content], file.path, { type: "text/plain" })
      );
      setFiles(demoFiles);
      setTestMode(payload.test_mode || "mixed");
      setDemoPreset({
        id: payload.id || presetId,
        name: payload.name || "Demo preset",
        description: payload.description || "",
        expectedOutcome: payload.expected_outcome || "",
        promptOverride: payload.prompt_override || "",
        instructionsOverride: payload.instructions_override || "",
      });
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingDemo(false);
    }
  }

  function handleFileChange(event) {
    setFiles(Array.from(event.target.files || []));
    setDemoPreset(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("api_key", apiKey);
      formData.append("test_mode", testMode);
      formData.append("model", model);
      if (demoPreset?.promptOverride) {
        formData.append("prompt_override", demoPreset.promptOverride);
      }
      if (demoPreset?.instructionsOverride) {
        formData.append("instructions_override", demoPreset.instructionsOverride);
      }
      files.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || "Analysis failed.");
      }
      setLoadingProgress(1);
      setResult(payload);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    React.createElement("main", { className: "page-shell" },
      React.createElement("section", { className: "hero" },
        React.createElement("p", { className: "eyebrow" }, "llmSHAP-powered outcome trustworthiness checker"),
        React.createElement("h1", null, "Ghost Test Catcher"),
        React.createElement("p", { className: "hero-copy" },
          "Upload files, choose a test style, and score whether the generated tests are actually supported by the source files or are ghost outputs."
        )
      ),
      React.createElement("section", { className: "layout" },
        React.createElement("form", { className: "panel form-panel", onSubmit: handleSubmit },
          React.createElement("div", { className: "section-title" }, "Inputs"),
          React.createElement("label", { className: "field" },
            React.createElement("span", null, "OpenAI API key"),
            React.createElement("input", {
              type: "password",
              value: apiKey,
              onChange: (event) => setApiKey(event.target.value),
              placeholder: "sk-...",
              required: true,
            })
          ),
          React.createElement("label", { className: "field" },
            React.createElement("span", null, "Test type"),
            React.createElement("select", {
              value: testMode,
              onChange: (event) => setTestMode(event.target.value),
            },
              React.createElement("option", { value: "unit" }, "Unit tests"),
              React.createElement("option", { value: "integration" }, "Integration tests"),
              React.createElement("option", { value: "e2e" }, "End-to-end tests"),
              React.createElement("option", { value: "mixed" }, "Mixed test pack")
            )
          ),
          React.createElement("label", { className: "field" },
            React.createElement("span", null, "Model"),
            React.createElement("select", {
              value: model,
              onChange: (event) => setModel(event.target.value),
            },
              React.createElement("option", { value: "gpt-4o-mini" }, "gpt-4o-mini"),
              React.createElement("option", { value: "gpt-4.1-mini" }, "gpt-4.1-mini"),
              React.createElement("option", { value: "gpt-4.1" }, "gpt-4.1"),
              React.createElement("option", { value: "gpt-5-mini" }, "gpt-5-mini"),
              React.createElement("option", { value: "gpt-5.2" }, "gpt-5.2"),
              React.createElement("option", { value: "gpt-5.4" }, "gpt-5.4")
            )
          ),
          React.createElement("label", { className: "field upload-field" },
            React.createElement("span", null, "Files"),
            React.createElement("input", {
              type: "file",
              multiple: true,
              onChange: handleFileChange,
              required: files.length === 0,
            })
          ),
          React.createElement("div", { className: "demo-scenarios" },
            React.createElement("div", { className: "demo-scenarios-header" },
              React.createElement("span", { className: "field-label" }, "Demo scenarios"),
              React.createElement("p", { className: "demo-scenarios-copy" },
                "Use these one-click setups to show a likely grounded run versus a likely ghost-risk run."
              )
            ),
            React.createElement("div", { className: "demo-scenario-grid" },
              demoOptions.map((option) =>
                React.createElement("button", {
                  key: option.id,
                  className: `demo-option ${demoPreset?.id === option.id ? "demo-option-active" : ""}`,
                  type: "button",
                  onClick: () => loadDemoPreset(option.id),
                  disabled: loadingDemo || loading,
                },
                  React.createElement("strong", null, option.name),
                  React.createElement("span", { className: "demo-option-mode" }, `${testModeLabel(option.test_mode)} mode`),
                  React.createElement("p", null, option.description),
                  React.createElement("em", null, option.expected_outcome)
                )
              )
            )
          ),
          demoPreset
            ? React.createElement("div", { className: "demo-banner" },
                React.createElement("strong", null, demoPreset.name),
                React.createElement("p", null,
                  `${demoPreset.description} Test mode is set to ${testModeLabel(testMode)}.`
                ),
                demoPreset.promptOverride
                  ? React.createElement("p", { className: "demo-banner-outcome" },
                      "Stress prompt enabled: this scenario intentionally asks the model for a broader product workflow than the files fully define."
                    )
                  : null,
                React.createElement("p", { className: "demo-banner-outcome" },
                  `Expected outcome: ${demoPreset.expectedOutcome}`
                )
              )
            : null,
          React.createElement("div", { className: "file-list" },
            files.length === 0
              ? React.createElement("p", { className: "empty-state" }, "No files selected yet.")
              : files.map((file) =>
                  React.createElement("div", { className: "file-chip", key: `${file.name}-${file.size}` },
                    React.createElement("strong", null, file.name),
                    React.createElement("span", null, formatBytes(file.size))
                  )
                )
          ),
          React.createElement("button", { className: "primary-button", type: "submit", disabled: loading },
            loading ? "Checking trustworthiness..." : "Check outcome trustworthiness"
          ),
          error ? React.createElement("p", { className: "error-banner" }, error) : null
        ),
        React.createElement("section", { className: "results-column" },
          React.createElement("div", { className: "panel" },
            React.createElement("div", { className: "section-title" }, "Outputs"),
            loading
              ? React.createElement("div", { className: "loading-panel" },
                  React.createElement("div", { className: "loading-panel-header" },
                    React.createElement("strong", null, "Analyzing uploaded files"),
                    React.createElement("span", null, formatPercent(loadingProgress))
                  ),
                  React.createElement("p", { className: "loading-copy" }, loadingStageLabel(loadingProgress)),
                  React.createElement("div", { className: "loading-track", "aria-hidden": "true" },
                    React.createElement("div", {
                      className: "loading-fill",
                      style: { width: `${Math.max(loadingProgress * 100, 8)}%` },
                    })
                  ),
                  React.createElement("p", { className: "loading-footnote" },
                    "This includes generation, grounding checks, llmSHAP attribution, and pytest execution."
                  )
                )
              : !result
              ? React.createElement("p", { className: "empty-state" },
                  "Run a trust check to see whether generated tests are grounded in the uploaded files."
                )
              : React.createElement(React.Fragment, null,
                  React.createElement("div", { className: `decision-card decision-${result.trust_assessment.verdict}` },
                    React.createElement("div", { className: "decision-main" },
                      React.createElement("span", { className: "trust-kicker" }, "Outcome verdict"),
                      React.createElement("h2", null, trustVerdictLabel(result.trust_assessment.verdict)),
                      React.createElement("p", null, result.trust_assessment.message)
                    ),
                    React.createElement("div", { className: "decision-metrics" },
                      React.createElement(StatCard, {
                        label: "Reliability",
                        value: formatPercent(result.trust_assessment.reliability_score),
                      }),
                      React.createElement(StatCard, {
                        label: "ETV",
                        value: formatPercent(result.trust_assessment.components.etv_score),
                      }),
                      React.createElement(StatCard, {
                        label: "Execution",
                        value: executionLabel(result.execution.status),
                      }),
                      React.createElement(StatCard, {
                        label: "Test type",
                        value: testModeLabel(result.test_mode),
                      })
                    )
                  ),
                  runtimeAlert
                    ? React.createElement("div", { className: "failure-card" },
                        React.createElement("span", { className: "trust-kicker" }, runtimeAlert.kicker),
                        React.createElement("strong", { className: "failure-title" },
                          runtimeAlert.title
                        ),
                        React.createElement("p", { className: "failure-copy" },
                          runtimeAlert.copy
                        )
                      )
                    : null,
                  preflightAlert
                    ? React.createElement("div", { className: "failure-card warning-card" },
                        React.createElement("span", { className: "trust-kicker" }, preflightAlert.kicker),
                        React.createElement("strong", { className: "failure-title" },
                          preflightAlert.title
                        ),
                        React.createElement("p", { className: "failure-copy" },
                          preflightAlert.copy
                        ),
                        React.createElement("div", { className: "failure-tags" },
                          firstItems(result.preflight.missing_imports, 3).map((item) =>
                            React.createElement("span", { className: "failure-tag", key: `import-${item}` }, `import: ${item}`)
                          ),
                          firstItems(result.preflight.missing_symbols, 3).map((item) =>
                            React.createElement("span", { className: "failure-tag", key: `symbol-${item}` }, `symbol: ${item}`)
                          )
                        )
                      )
                    : null,
                  React.createElement("div", { className: "summary-strip" },
                    React.createElement(SummaryPill, {
                      label: "Supported tests",
                      value: `${result.verification.supported_claims}/${result.verification.total_claims}`,
                    }),
                    React.createElement(SummaryPill, {
                      label: "Detected tests",
                      value: String(result.generated_tests.test_count),
                    }),
                    React.createElement(SummaryPill, {
                      label: "Pytest pass rate",
                      value: `${result.execution.passed}/${result.execution.test_count || result.generated_tests.test_count}`,
                    }),
                    React.createElement(SummaryPill, {
                      label: "Files analyzed",
                      value: String(result.statistics.total_files),
                    })
                  ),
                  React.createElement("div", { className: "formula-box" },
                    React.createElement("div", { className: "formula-grid" },
                      React.createElement("div", { className: "formula-card" },
                        React.createElement("span", { className: "formula-label" }, "ETV"),
                        React.createElement("pre", { className: "formula-pre" },
                          "ETV = (keepers + 0.5 * salvageable)\n    / total_tests"
                        )
                      ),
                      React.createElement("div", { className: "formula-card" },
                        React.createElement("span", { className: "formula-label" }, "Reliability"),
                        React.createElement("pre", { className: "formula-pre" },
                          "0.28 * supported_claim_ratio\n+ 0.22 * groundedness_score\n+ 0.15 * context_relevance_score\n+ 0.15 * evidence_weight_coverage\n+ 0.20 * execution_score"
                        )
                      ),
                      React.createElement("div", { className: "formula-card" },
                        React.createElement("span", { className: "formula-label" }, "Thresholds"),
                        React.createElement("pre", { className: "formula-pre" },
                          "reliable >= 0.62\nneeds_review >= 0.38\nghost_risk < 0.38"
                        )
                      )
                    ),
                    React.createElement("p", { className: "formula-note" },
                      `ETV now means Effective Test Value: tests that are both grounded and passing count as keepers, grounded-but-failing or borderline-passing tests count as salvageable. Current run: ${result.trust_assessment.components.etv_breakdown.keepers} keepers, ${result.trust_assessment.components.etv_breakdown.salvageable} salvageable, ${result.trust_assessment.components.etv_breakdown.risky} risky. Prototype thresholds: the reliability cutoffs are heuristic defaults for the demo and should be calibrated on labeled benchmark runs before production use.`
                    )
                  ),
                  React.createElement("div", { className: "summary-grid" },
                    React.createElement(ListCard, {
                      title: "Strongest evidence",
                      items: firstItems(result.verification.top_evidence_files.map(
                        (item) => `${item.path} (${item.claims} claims, ${formatPercent(item.max_confidence)})`
                      )),
                    }),
                    React.createElement(ListCard, {
                      title: "Biggest issues",
                      items: firstItems(
                        result.verification.claim_checks
                          .filter((item) => item.status !== "supported")
                          .map((item) => `${item.claim}${item.missing_symbols?.length ? ` (missing: ${item.missing_symbols.join(", ")})` : ""}`),
                        3
                      ),
                    })
                  ),
                  React.createElement("div", { className: "per-test-section" },
                    React.createElement("div", { className: "per-test-heading" },
                      React.createElement("div", null,
                        React.createElement("h2", { className: "per-test-title" }, "Per-test verdicts"),
                        React.createElement("p", { className: "per-test-subtitle" },
                          "Groundedness is shown first so you can quickly see which tests are supported by the uploaded files."
                        )
                      ),
                      React.createElement("div", { className: "per-test-summary" },
                        React.createElement(SummaryBadge, {
                          label: "Grounded",
                          value: `${perTestStats.supported}/${perTestItems.length}`,
                          tone: "supported",
                        }),
                        React.createElement(SummaryBadge, {
                          label: "Borderline",
                          value: `${perTestStats.borderline}/${perTestItems.length}`,
                          tone: "borderline",
                        }),
                        React.createElement(SummaryBadge, {
                          label: "Ghost risk",
                          value: `${perTestStats.unsupported}/${perTestItems.length}`,
                          tone: "unsupported",
                        })
                      )
                    ),
                    React.createElement("div", { className: "per-test-grid" },
                      perTestItems.map((item) =>
                        React.createElement("div", { className: `per-test-card card-${item.groundedStatus}`, key: item.name },
                          React.createElement("div", { className: "per-test-header" },
                            React.createElement("div", { className: "per-test-title-block" },
                              React.createElement("span", { className: `support-chip support-${item.groundedStatus}` },
                                supportLabel(item.groundedStatus)
                              ),
                              React.createElement("strong", null, item.name)
                            ),
                            React.createElement("span", { className: `per-test-chip chip-${item.executionStatus}` },
                              executionLabel(item.executionStatus)
                            )
                          ),
                          React.createElement("div", { className: "per-test-support" },
                            React.createElement("div", { className: "per-test-support-copy" },
                              React.createElement("span", { className: "per-test-support-label" }, "Groundedness confidence"),
                              React.createElement("strong", { className: "per-test-score" },
                                formatPercent(item.groundedConfidence)
                              )
                            ),
                            React.createElement("div", { className: "confidence-track" },
                              React.createElement("div", {
                                className: `confidence-fill fill-${item.groundedStatus}`,
                                style: { width: `${Math.max(item.groundedConfidence * 100, 6)}%` },
                              })
                            )
                          ),
                          item.missingSymbols.length
                            ? React.createElement("p", { className: "per-test-copy" },
                                `Missing symbols: ${item.missingSymbols.join(", ")}`
                              )
                            : React.createElement("p", { className: "per-test-copy" },
                                item.evidence
                                  ? `Best evidence: ${item.evidence.path}:${item.evidence.start_line}-${item.evidence.end_line}`
                                  : "No evidence snippet found."
                              )
                        )
                      )
                    )
                  ),
                  React.createElement(DetailSection, {
                    title: "Generated Tests",
                    content: React.createElement("pre", { className: "code-block code-block-large" }, result.generated_tests.code || result.answer),
                  }),
                  React.createElement(DetailSection, {
                    title: "Execution Details",
                    content: React.createElement(React.Fragment, null,
                      React.createElement("div", { className: `trust-banner trust-execution-${result.execution.status}` },
                        React.createElement("div", { className: "trust-banner-main" },
                          React.createElement("span", { className: "trust-kicker" }, "Execution viability"),
                          React.createElement("h2", null, executionLabel(result.execution.status)),
                          React.createElement("p", null, result.execution.message)
                        ),
                        React.createElement("div", { className: "trust-banner-metrics" },
                          React.createElement(TrustMetric, {
                            label: "Detected tests",
                            value: String(result.generated_tests.test_count),
                          }),
                          React.createElement(TrustMetric, {
                            label: "Passed",
                            value: `${result.execution.passed}/${result.execution.test_count || result.generated_tests.test_count}`,
                          }),
                          React.createElement(TrustMetric, {
                            label: "Failed/Errors",
                            value: `${result.execution.failed + result.execution.errors}/${result.execution.test_count || result.generated_tests.test_count}`,
                          })
                        )
                      ),
                      result.execution.pytest_summary
                        ? React.createElement("pre", { className: "detail-pre code-block code-block-medium" }, result.execution.pytest_summary)
                        : React.createElement("p", { className: "empty-state compact" },
                            "No pytest summary is available for this run."
                          )
                    ),
                  }),
                  React.createElement(DetailSection, {
                    title: "Preflight Checks",
                    content: React.createElement("div", { className: "summary-grid" },
                      React.createElement(ListCard, {
                        title: "Missing imports",
                        items: result.preflight.missing_imports,
                      }),
                      React.createElement(ListCard, {
                        title: "Missing symbols",
                        items: result.preflight.missing_symbols,
                      })
                    ),
                  }),
                  React.createElement(DetailSection, {
                    title: "Grounding Details",
                    content: React.createElement(React.Fragment, null,
                      React.createElement("div", { className: `trust-banner trust-${result.verification.verdict}` },
                        React.createElement("div", { className: "trust-banner-main" },
                          React.createElement("span", { className: "trust-kicker" }, "Grounding check"),
                          React.createElement("h2", null, verdictLabel(result.verification.verdict)),
                          React.createElement("p", null, result.verification.message)
                        ),
                        React.createElement("div", { className: "trust-banner-metrics" },
                          React.createElement(TrustMetric, {
                            label: "Groundedness",
                            value: formatPercent(result.verification.groundedness_score),
                          }),
                          React.createElement(TrustMetric, {
                            label: "Supported",
                            value: `${result.verification.supported_claims}/${result.verification.total_claims}`,
                          }),
                          React.createElement(TrustMetric, {
                            label: "Context match",
                            value: formatPercent(result.verification.context_relevance_score),
                          })
                        )
                      ),
                      React.createElement("div", { className: "claim-list" },
                        result.verification.claim_checks.map((item, index) =>
                          React.createElement("div", { className: "claim-card", key: `${index}-${item.claim}` },
                            React.createElement("div", { className: "claim-header" },
                              React.createElement("span", { className: `claim-status claim-${item.status}` }, item.status),
                              React.createElement("strong", null, formatPercent(item.confidence))
                            ),
                            React.createElement("p", { className: "claim-text" }, item.claim),
                            item.missing_symbols && item.missing_symbols.length
                              ? React.createElement("p", { className: "claim-missing" },
                                  `Missing symbols: ${item.missing_symbols.join(", ")}`
                                )
                              : null,
                            item.evidence
                              ? React.createElement("div", { className: "evidence-box" },
                                  React.createElement("div", { className: "evidence-meta" },
                                    `${item.evidence.path}:${item.evidence.start_line}-${item.evidence.end_line}`
                                  ),
                                  React.createElement("pre", { className: "code-block code-block-small" }, item.evidence.snippet)
                                )
                              : React.createElement("p", { className: "empty-state compact" },
                                  "No supporting snippet found in the uploaded files."
                                )
                          )
                        )
                      )
                    ),
                  }),
                  React.createElement(DetailSection, {
                    title: "llmSHAP Details",
                    content: React.createElement(React.Fragment, null,
                      React.createElement("div", { className: "summary-grid" },
                        React.createElement(ListCard, {
                          title: "Top attributed files",
                          items: result.statistics.top_supporting_files,
                        }),
                        React.createElement(ListCard, {
                          title: "Most impacted test files",
                          items: result.statistics.top_test_files,
                        })
                      ),
                      React.createElement("div", { className: "distribution-list" },
                        result.files.map((item) =>
                          React.createElement("div", { className: "distribution-row", key: item.path },
                            React.createElement("div", { className: "distribution-meta" },
                              React.createElement("strong", null, item.path),
                              React.createElement("span", null,
                                `${formatPercent(item.weight)} | ${item.line_count} lines | ${item.is_test_file ? "test" : "code"}`
                              )
                            ),
                            React.createElement("div", { className: "bar-track" },
                              React.createElement("div", {
                                className: "bar-fill",
                                style: { width: `${Math.max(item.weight * 100, 2)}%` },
                              })
                            )
                          )
                        )
                      )
                    ),
                  })
                )
          )
        )
      )
    )
  );
}

function StatCard({ label, value }) {
  return React.createElement("div", { className: "stat-card" },
    React.createElement("span", { className: "stat-label" }, label),
    React.createElement("strong", { className: "stat-value" }, value)
  );
}

function SummaryPill({ label, value }) {
  return React.createElement("div", { className: "summary-pill" },
    React.createElement("span", { className: "summary-pill-label" }, label),
    React.createElement("strong", { className: "summary-pill-value" }, value)
  );
}

function SummaryBadge({ label, value, tone }) {
  return React.createElement("div", { className: `summary-badge badge-${tone}` },
    React.createElement("span", { className: "summary-badge-label" }, label),
    React.createElement("strong", { className: "summary-badge-value" }, value)
  );
}

function TrustMetric({ label, value }) {
  return React.createElement("div", { className: "trust-metric" },
    React.createElement("span", { className: "stat-label" }, label),
    React.createElement("strong", { className: "stat-value" }, value)
  );
}

function ListCard({ title, items }) {
  return React.createElement("div", { className: "list-card" },
    React.createElement("h3", null, title),
    items && items.length
      ? React.createElement("ul", null, items.map((item) => React.createElement("li", { key: item }, item)))
      : React.createElement("p", { className: "empty-state compact" }, "No matching files in this run.")
  );
}

function DetailSection({ title, content, defaultOpen = false }) {
  return React.createElement("details", { className: "detail-section", open: defaultOpen },
    React.createElement("summary", { className: "detail-summary" }, title),
    React.createElement("div", { className: "detail-body" }, content)
  );
}

createRoot(document.getElementById("root")).render(React.createElement(App));
