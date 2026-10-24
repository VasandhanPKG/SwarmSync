from __future__ import annotations
import csv
from dataclasses import asdict, dataclass
import math
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class RunMetrics:
    scenario: str
    mode: str
    seed: int
    fleet_size: int
    total_tasks: int
    completed_tasks: int
    delivery_success_rate: float
    avg_delivery_time_s: float
    deadline_success_rate: float
    total_messages: int
    total_bytes: int
    messages_per_delivery: float
    bytes_per_delivery: float
    avg_recovery_time_s: float
    duplicate_assignment_rate: float
    energy_per_delivery_pct: float
    safety_violations: int
    reconciliations: int


def compute_summary_stats(values: List[float]) -> Dict[str, float]:
    """Computes Mean, Standard Deviation, and 95% Confidence Interval half-width."""
    n = len(values)
    if n == 0:
        return {"mean": 0.0, "std": 0.0, "ci95": 0.0, "min": 0.0, "max": 0.0}
    mean = sum(values) / n
    if n > 1:
        variance = sum((x - mean) ** 2 for x in values) / (n - 1)
        std = math.sqrt(variance)
        # t-critical for df=9 (10 seeds) at 95% two-sided is 2.262; use 1.96 for large n
        t_val = 2.262 if n == 10 else 1.96
        ci95 = t_val * (std / math.sqrt(n))
    else:
        std = 0.0
        ci95 = 0.0
    return {
        "mean": round(mean, 4),
        "std": round(std, 4),
        "ci95": round(ci95, 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def save_runs_to_csv(runs: List[RunMetrics], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not runs:
        return
    fieldnames = list(asdict(runs[0]).keys())
    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in runs:
            writer.writerow(asdict(r))
