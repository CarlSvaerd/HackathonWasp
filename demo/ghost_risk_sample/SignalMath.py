from __future__ import annotations


def moving_average(samples: list[int], window_size: int) -> list[float]:
    if window_size <= 0:
        raise ValueError("window_size_must_be_positive")
    if window_size > len(samples):
        return []

    averages: list[float] = []
    for index in range(len(samples) - window_size + 1):
        window = samples[index : index + window_size]
        averages.append(sum(window) / window_size)
    return averages


def signal_delta(current_value: int, previous_value: int) -> int:
    return current_value - previous_value
