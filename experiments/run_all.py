from __future__ import annotations
from dataclasses import asdict
import json
from pathlib import Path
from typing import Any, Dict, List
from experiments.plot_metrics import render_grouped_bar_chart
from swarmsync.baselines.modes import CoordinationMode
from swarmsync.metrics.collector import RunMetrics, compute_summary_stats, save_runs_to_csv
from swarmsync.run import DEFAULT_SCENARIOS, load_scenario_config
from swarmsync.sim.world import SimulationWorld


SCENARIO_ORDER = [
    "normal",
    "dynamic_arrival",
    "packet_loss_delay",
    "partition",
    "drone_failure",
    "hub_failure",
]

MODE_ORDER = [
    CoordinationMode.SWARMSYNC.value,
    CoordinationMode.CENTRALIZED.value,
    CoordinationMode.BASIC_AUCTION.value,
    CoordinationMode.CBBA.value,
]

FLEET_SCALES = [3, 5, 10, 20]
NUM_SEEDS = 10


def run_benchmark_suite() -> Dict[str, Any]:
    results_dir = Path("experiments/results")
    figures_dir = Path("experiments/figures")
    results_dir.mkdir(parents=True, exist_ok=True)
    figures_dir.mkdir(parents=True, exist_ok=True)

    all_runs: List[RunMetrics] = []
    scenario_summary: Dict[str, Dict[str, Dict[str, Any]]] = {}

    metric_fields = [
        "delivery_success_rate",
        "avg_delivery_time_s",
        "deadline_success_rate",
        "messages_per_delivery",
        "bytes_per_delivery",
        "avg_recovery_time_s",
        "duplicate_assignment_rate",
        "energy_per_delivery_pct",
        "safety_violations",
        "reconciliations",
    ]

    for scen_name in SCENARIO_ORDER:
        scenario_summary[scen_name] = {}
        base_cfg = load_scenario_config(scen_name)
        base_cfg["dt"] = 0.5
        for mode_str in MODE_ORDER:
            mode_enum = CoordinationMode(mode_str)
            mode_runs: List[RunMetrics] = []
            for seed in range(1, NUM_SEEDS + 1):
                world = SimulationWorld(config=dict(base_cfg), mode=mode_enum, seed=seed)
                metrics = world.run_to_completion()
                mode_runs.append(metrics)
                all_runs.append(metrics)

            stats_for_mode: Dict[str, Any] = {}
            for mf in metric_fields:
                vals = [float(getattr(r, mf)) for r in mode_runs]
                stats_for_mode[mf] = compute_summary_stats(vals)
            scenario_summary[scen_name][mode_str] = stats_for_mode

    # Fleet scaling sweep (3, 5, 10, 20 drones across 10 seeds)
    scale_runs: List[RunMetrics] = []
    scale_summary: Dict[str, Dict[str, Dict[str, Any]]] = {}
    scale_base = load_scenario_config("scale") if (Path("configs/scale.json")).exists() else dict(DEFAULT_SCENARIOS["dynamic_arrival"])

    for fsize in FLEET_SCALES:
        f_key = f"N={fsize}"
        scale_summary[f_key] = {}
        for mode_str in MODE_ORDER:
            mode_enum = CoordinationMode(mode_str)
            f_runs: List[RunMetrics] = []
            for seed in range(1, NUM_SEEDS + 1):
                cfg = dict(scale_base)
                cfg["name"] = f"scale_{fsize}"
                cfg["fleet_size"] = fsize
                cfg["total_tasks"] = max(10, fsize + 6)
                cfg["max_duration"] = 135.0
                cfg["dt"] = 0.5
                world = SimulationWorld(config=cfg, mode=mode_enum, seed=seed)
                m = world.run_to_completion()
                f_runs.append(m)
                scale_runs.append(m)

            stats_for_scale: Dict[str, Any] = {}
            for mf in metric_fields:
                vals = [float(getattr(r, mf)) for r in f_runs]
                stats_for_scale[mf] = compute_summary_stats(vals)
            scale_summary[f_key][mode_str] = stats_for_scale

    # Save raw CSVs
    save_runs_to_csv(all_runs, results_dir / "scenario_runs_10seeds.csv")
    save_runs_to_csv(scale_runs, results_dir / "scale_runs_10seeds.csv")

    # Generate comparison figures (both .svg and .png)
    render_grouped_bar_chart(
        title="Delivery Success Rate Across Fault & Network Scenarios",
        y_label="Delivery Success Rate (0-1)",
        categories=SCENARIO_ORDER,
        modes=MODE_ORDER,
        summary_data=scenario_summary,
        metric_key="delivery_success_rate",
        svg_path=figures_dir / "delivery_success_rate.svg",
        png_path=figures_dir / "delivery_success_rate.png",
        y_max_override=1.15,
    )
    render_grouped_bar_chart(
        title="Communication Overhead: Messages per Completed Delivery",
        y_label="Messages / Delivery",
        categories=SCENARIO_ORDER,
        modes=MODE_ORDER,
        summary_data=scenario_summary,
        metric_key="messages_per_delivery",
        svg_path=figures_dir / "messages_per_delivery.svg",
        png_path=figures_dir / "messages_per_delivery.png",
    )
    render_grouped_bar_chart(
        title="Average Delivery Time Across Scenarios",
        y_label="Delivery Time (seconds)",
        categories=SCENARIO_ORDER,
        modes=MODE_ORDER,
        summary_data=scenario_summary,
        metric_key="avg_delivery_time_s",
        svg_path=figures_dir / "avg_delivery_time.svg",
        png_path=figures_dir / "avg_delivery_time.png",
    )
    render_grouped_bar_chart(
        title="Fleet Scaling Behavior (N = 3, 5, 10, 20 Drones): Messages per Delivery",
        y_label="Messages / Delivery",
        categories=[f"N={n}" for n in FLEET_SCALES],
        modes=MODE_ORDER,
        summary_data=scale_summary,
        metric_key="messages_per_delivery",
        svg_path=figures_dir / "scale_messages_per_delivery.svg",
        png_path=figures_dir / "scale_messages_per_delivery.png",
    )

    payload = {
        "num_seeds": NUM_SEEDS,
        "scenarios": SCENARIO_ORDER,
        "modes": MODE_ORDER,
        "fleet_scales": FLEET_SCALES,
        "scenario_summary": scenario_summary,
        "scale_summary": scale_summary,
        "figures": [
            "delivery_success_rate.svg",
            "messages_per_delivery.svg",
            "avg_delivery_time.svg",
            "scale_messages_per_delivery.svg",
        ],
    }
    (results_dir / "summary_stats.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )
    print(
        f"[SwarmSync Benchmark] Completed {len(all_runs) + len(scale_runs)} runs "
        f"({NUM_SEEDS} seeds x scenarios & fleet scales). Saved CSVs and figures."
    )
    return payload


if __name__ == "__main__":
    run_benchmark_suite()
