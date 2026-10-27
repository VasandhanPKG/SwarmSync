from __future__ import annotations
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

METRIC_FIELDS = [
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


def run_benchmark_suite() -> Dict[str, Any]:
    results_dir = Path("experiments/results")
    figures_dir = Path("experiments/figures")
    results_dir.mkdir(parents=True, exist_ok=True)
    figures_dir.mkdir(parents=True, exist_ok=True)

    all_runs: List[RunMetrics] = []
    scenario_summary: Dict[str, Dict[str, Dict[str, Any]]] = {}

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
            for mf in METRIC_FIELDS:
                vals = [float(getattr(r, mf)) for r in mode_runs]
                stats_for_mode[mf] = compute_summary_stats(vals)
            scenario_summary[scen_name][mode_str] = stats_for_mode

    # 2. Fleet scaling sweep (3, 5, 10, 20 drones across 10 seeds)
    scale_runs: List[RunMetrics] = []
    scale_summary: Dict[str, Dict[str, Dict[str, Any]]] = {}
    scale_base = (
        load_scenario_config("scale")
        if (Path("configs/scale.json")).exists()
        else dict(DEFAULT_SCENARIOS["dynamic_arrival"])
    )

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
                cfg["dt"] = 1.0
                world = SimulationWorld(config=cfg, mode=mode_enum, seed=seed)
                m = world.run_to_completion()
                f_runs.append(m)
                scale_runs.append(m)

            stats_for_scale: Dict[str, Any] = {}
            for mf in METRIC_FIELDS:
                vals = [float(getattr(r, mf)) for r in f_runs]
                stats_for_scale[mf] = compute_summary_stats(vals)
            scale_summary[f_key][mode_str] = stats_for_scale

    # 3. Ablation Study (SwarmSync Full vs No Leases vs Periodic Broadcast vs No Conflict Resolution)
    # Evaluated under combined stress (drone failure + partition window + packet delay) across 10 seeds
    ablation_variants = [
        {
            "key": "swarmsync_full",
            "label": "SwarmSync (Full)",
            "overrides": {
                "use_leases": True,
                "periodic_broadcast": False,
                "use_conflict_resolution": True,
            },
        },
        {
            "key": "no_leases",
            "label": "w/o Leases",
            "overrides": {
                "use_leases": False,
                "periodic_broadcast": False,
                "use_conflict_resolution": True,
            },
        },
        {
            "key": "periodic_broadcast",
            "label": "w/o Event-Triggered (Periodic)",
            "overrides": {
                "use_leases": True,
                "periodic_broadcast": True,
                "use_conflict_resolution": True,
            },
        },
        {
            "key": "no_conflict_resolution",
            "label": "w/o Conflict Resolution",
            "overrides": {
                "use_leases": True,
                "periodic_broadcast": False,
                "use_conflict_resolution": False,
            },
        },
    ]

    ablation_runs: List[RunMetrics] = []
    ablation_summary: Dict[str, Dict[str, Any]] = {}
    ablation_chart_summary: Dict[str, Dict[str, Dict[str, Any]]] = {"combined_fault_stress": {}}

    for var in ablation_variants:
        v_key = var["key"]
        v_runs: List[RunMetrics] = []
        for seed in range(1, NUM_SEEDS + 1):
            cfg = dict(load_scenario_config("drone_failure"))
            cfg["name"] = f"ablation_{v_key}"
            cfg["dt"] = 0.5
            cfg["partition_window"] = [14.0, 32.0]
            cfg["packet_loss_prob"] = 0.12
            cfg["max_delay"] = 0.45
            cfg.update(var["overrides"])
            world = SimulationWorld(config=cfg, mode=CoordinationMode.SWARMSYNC, seed=seed)
            m = world.run_to_completion()
            m.mode = v_key
            v_runs.append(m)
            ablation_runs.append(m)

        v_stats: Dict[str, Any] = {"label": var["label"]}
        for mf in METRIC_FIELDS:
            vals = [float(getattr(r, mf)) for r in v_runs]
            v_stats[mf] = compute_summary_stats(vals)
        ablation_summary[v_key] = v_stats
        ablation_chart_summary["combined_fault_stress"][v_key] = v_stats

    # 4. Sensitivity Sweep A: Cost Weights (w_t, w_e, w_r)
    weight_configs = [
        {"key": "time_heavy", "label": "Time-Heavy (0.8, 0.1, 0.1)", "w_t": 0.8, "w_e": 0.1, "w_r": 0.1},
        {"key": "balanced", "label": "Balanced (0.5, 0.3, 0.2)", "w_t": 0.5, "w_e": 0.3, "w_r": 0.2},
        {"key": "energy_heavy", "label": "Energy-Heavy (0.1, 0.8, 0.1)", "w_t": 0.1, "w_e": 0.8, "w_r": 0.1},
        {"key": "risk_heavy", "label": "Risk-Heavy (0.1, 0.1, 0.8)", "w_t": 0.1, "w_e": 0.1, "w_r": 0.8},
    ]
    weight_runs: List[RunMetrics] = []
    weight_summary: Dict[str, Dict[str, Any]] = {}
    weight_chart_summary: Dict[str, Dict[str, Dict[str, Any]]] = {}

    for wc in weight_configs:
        w_key = wc["key"]
        w_runs: List[RunMetrics] = []
        for seed in range(1, NUM_SEEDS + 1):
            cfg = dict(load_scenario_config("dynamic_arrival"))
            cfg["name"] = f"weight_{w_key}"
            cfg["dt"] = 0.5
            cfg["w_t"] = wc["w_t"]
            cfg["w_e"] = wc["w_e"]
            cfg["w_r"] = wc["w_r"]
            world = SimulationWorld(config=cfg, mode=CoordinationMode.SWARMSYNC, seed=seed)
            m = world.run_to_completion()
            m.mode = w_key
            w_runs.append(m)
            weight_runs.append(m)

        w_stats: Dict[str, Any] = {
            "label": wc["label"],
            "w_t": wc["w_t"],
            "w_e": wc["w_e"],
            "w_r": wc["w_r"],
        }
        for mf in METRIC_FIELDS:
            vals = [float(getattr(r, mf)) for r in w_runs]
            w_stats[mf] = compute_summary_stats(vals)
        weight_summary[w_key] = w_stats
        weight_chart_summary[w_key] = {CoordinationMode.SWARMSYNC.value: w_stats}

    # 5. Sensitivity Sweep B: Packet Loss Rate (0%, 10%, 25%, 40%, 50%)
    loss_levels = [0.0, 0.10, 0.25, 0.40, 0.50]
    loss_runs: List[RunMetrics] = []
    loss_summary: Dict[str, Dict[str, Dict[str, Any]]] = {}

    for loss_p in loss_levels:
        l_key = f"loss_{int(loss_p * 100)}pct"
        loss_summary[l_key] = {}
        for mode_str in MODE_ORDER:
            mode_enum = CoordinationMode(mode_str)
            l_mode_runs: List[RunMetrics] = []
            for seed in range(1, NUM_SEEDS + 1):
                cfg = dict(load_scenario_config("packet_loss_delay"))
                cfg["name"] = l_key
                cfg["dt"] = 1.0
                cfg["packet_loss_prob"] = loss_p
                world = SimulationWorld(config=cfg, mode=mode_enum, seed=seed)
                m = world.run_to_completion()
                l_mode_runs.append(m)
                loss_runs.append(m)

            l_stats: Dict[str, Any] = {}
            for mf in METRIC_FIELDS:
                vals = [float(getattr(r, mf)) for r in l_mode_runs]
                l_stats[mf] = compute_summary_stats(vals)
            loss_summary[l_key][mode_str] = l_stats

    # 6. Export Benchmark-Faithful Replay Trace (SwarmSync under drone failure + partition)
    replay_cfg = dict(load_scenario_config("drone_failure"))
    replay_cfg["name"] = "benchmark_replay_fault_recovery"
    replay_cfg["dt"] = 0.5
    replay_cfg["max_duration"] = 90.0
    replay_cfg["partition_window"] = [18.0, 32.0]
    replay_world = SimulationWorld(
        config=replay_cfg, mode=CoordinationMode.SWARMSYNC, seed=1
    )
    replay_trace = replay_world.run_and_export_trace()
    (results_dir / "replay_trace.json").write_text(
        json.dumps(replay_trace, indent=2), encoding="utf-8"
    )

    # Save raw CSVs
    save_runs_to_csv(all_runs, results_dir / "scenario_runs_10seeds.csv")
    save_runs_to_csv(scale_runs, results_dir / "scale_runs_10seeds.csv")
    save_runs_to_csv(ablation_runs, results_dir / "ablation_runs_10seeds.csv")
    save_runs_to_csv(weight_runs, results_dir / "weight_sensitivity_10seeds.csv")
    save_runs_to_csv(loss_runs, results_dir / "loss_sensitivity_10seeds.csv")

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
    render_grouped_bar_chart(
        title="Packet Loss Sensitivity (0% to 50% Loss): Delivery Success Rate",
        y_label="Delivery Success Rate (0-1)",
        categories=[f"loss_{int(p * 100)}pct" for p in loss_levels],
        modes=MODE_ORDER,
        summary_data=loss_summary,
        metric_key="delivery_success_rate",
        svg_path=figures_dir / "sensitivity_packet_loss.svg",
        png_path=figures_dir / "sensitivity_packet_loss.png",
        y_max_override=1.15,
    )

    ablations_payload = {
        "num_seeds": NUM_SEEDS,
        "ablation_variants": [v["key"] for v in ablation_variants],
        "ablation_summary": ablation_summary,
        "weight_sweep": weight_summary,
        "loss_levels": [f"loss_{int(p * 100)}pct" for p in loss_levels],
        "loss_sweep": loss_summary,
    }
    (results_dir / "ablations_sensitivity.json").write_text(
        json.dumps(ablations_payload, indent=2), encoding="utf-8"
    )

    payload = {
        "num_seeds": NUM_SEEDS,
        "scenarios": SCENARIO_ORDER,
        "modes": MODE_ORDER,
        "fleet_scales": FLEET_SCALES,
        "scenario_summary": scenario_summary,
        "scale_summary": scale_summary,
        "ablation_summary": ablation_summary,
        "weight_sweep": weight_summary,
        "loss_sweep": loss_summary,
        "figures": [
            "delivery_success_rate.svg",
            "messages_per_delivery.svg",
            "avg_delivery_time.svg",
            "scale_messages_per_delivery.svg",
            "sensitivity_packet_loss.svg",
        ],
    }
    (results_dir / "summary_stats.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )
    total_runs_count = (
        len(all_runs)
        + len(scale_runs)
        + len(ablation_runs)
        + len(weight_runs)
        + len(loss_runs)
    )
    print(
        f"[SwarmSync Benchmark] Completed {total_runs_count} runs "
        f"({NUM_SEEDS} seeds x scenarios, scales, ablations & sweeps). Saved CSVs, JSONs, Replay Trace, and figures."
    )
    return payload


if __name__ == "__main__":
    run_benchmark_suite()
