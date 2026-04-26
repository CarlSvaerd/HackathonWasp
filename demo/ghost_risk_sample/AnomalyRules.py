from __future__ import annotations

from SignalMath import signal_delta


def classify_anomaly(current_value: int, baseline_value: int, threshold: int = 25) -> str:
    if threshold <= 0:
        raise ValueError("threshold_must_be_positive")

    change = abs(signal_delta(current_value, baseline_value))
    if change >= threshold:
        return "alert"
    if change >= threshold // 2:
        return "watch"
    return "normal"


def should_page_operator(severity: str, environment: str) -> bool:
    normalized_environment = environment.strip().lower()
    normalized_severity = severity.strip().lower()
    return normalized_environment == "production" and normalized_severity == "alert"
