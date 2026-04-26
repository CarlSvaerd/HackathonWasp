from __future__ import annotations

from AnomalyRules import classify_anomaly, should_page_operator


def build_alert_summary(metric_name: str, current_value: int, baseline_value: int) -> dict[str, object]:
    severity = classify_anomaly(current_value, baseline_value)
    return {
        "metric_name": metric_name.strip().lower(),
        "severity": severity,
        "current_value": current_value,
        "baseline_value": baseline_value,
    }


def render_console_message(metric_name: str, current_value: int, baseline_value: int, environment: str) -> str:
    summary = build_alert_summary(metric_name, current_value, baseline_value)
    should_page = should_page_operator(str(summary["severity"]), environment)
    action = "page-operator" if should_page else "log-only"
    return f"{summary['metric_name']}::{summary['severity']}::{action}"
