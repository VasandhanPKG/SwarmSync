from __future__ import annotations
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys
from typing import Any, Dict
from swarmsync.baselines.modes import CoordinationMode
from swarmsync.metrics.collector import save_runs_to_csv
from swarmsync.sim.visualizer import run_live_visualizer
from swarmsync.sim.world import SimulationWorld


DEFAULT_SCENARIOS: Dict[str, Dict[str, Any]] = {
    "normal": {
        "name": "normal",
        "description": "Nominal operation with 5 drones and 12 delivery tasks",
        "fleet_size": 5,
        "total_tasks": 12,
        "comm_range": 520.0,
        "packet_loss_prob": 0.0,
        "min_delay": 0.0,
        "max_delay": 0.05,
        "dynamic_arrival": False,
        "max_duration": 150.0,
    },
    "dynamic_arrival": {
        "name": "dynamic_arrival",
        "description": "Continuous dynamic task arrival across mission horizon",
        "fleet_size": 5,
        "total_tasks": 14,
        "comm_range": 500.0,
        "packet_loss_prob": 0.03,
        "min_delay": 0.0,
        "max_delay": 0.15,
        "dynamic_arrival": True,
        "spawn_interval": 6.0,
        "max_duration": 180.0,
    },
    "packet_loss_delay": {
        "name": "packet_loss_delay",
        "description": "25% packet loss probability and 0.25s-1.25s stochastic message delay",
        "fleet_size": 5,
        "total_tasks": 12,
        "comm_range": 480.0,
        "packet_loss_prob": 0.25,
        "min_delay": 0.25,
        "max_delay": 1.25,
        "dynamic_arrival": False,
        "max_duration": 170.0,
    },
    "partition": {
        "name": "partition",
        "description": "East-West network partition from t=12s to t=60s followed by reconnection and reconciliation",
        "fleet_size": 5,
        "total_tasks": 12,
        "comm_range": 500.0,
        "packet_loss_prob": 0.05,
        "min_delay": 0.05,
        "max_delay": 0.25,
        "partition_window": [12.0, 60.0],
        "dynamic_arrival": True,
        "spawn_interval": 5.0,
        "max_duration": 170.0,
    },
    "drone_failure": {
        "name": "drone_failure",
        "description": "Two drones suffer sudden mid-delivery failures at t=14s and t=32s",
        "fleet_size": 5,
        "total_tasks": 12,
        "comm_range": 520.0,
        "packet_loss_prob": 0.02,
        "min_delay": 0.0,
        "max_delay": 0.10,
        "kill_drone_events": [{"time": 14.0}, {"time": 32.0}],
        "dynamic_arrival": False,
        "max_duration": 170.0,
    },
    "hub_failure": {
        "name": "hub_failure",
        "description": "Centralized coordinator fails at t=18s while tasks continue arriving",
        "fleet_size": 5,
        "total_tasks": 12,
        "comm_range": 520.0,
        "packet_loss_prob": 0.02,
        "min_delay": 0.0,
        "max_delay": 0.10,
        "hub_failure_at": 18.0,
        "kill_drone_events": [{"time": 24.0}],
        "dynamic_arrival": True,
        "spawn_interval": 5.5,
        "max_duration": 175.0,
    },
}


def load_scenario_config(scenario_arg: str) -> Dict[str, Any]:
    cfg_path = Path("configs") / f"{scenario_arg}.json"
    if cfg_path.exists():
        return json.loads(cfg_path.read_text(encoding="utf-8"))
    if scenario_arg in DEFAULT_SCENARIOS:
        return dict(DEFAULT_SCENARIOS[scenario_arg])
    raise ValueError(f"Unknown scenario '{scenario_arg}'. Available: {list(DEFAULT_SCENARIOS.keys())}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="SwarmSync: Decentralized Drone Logistics Simulator CLI"
    )
    parser.add_argument(
        "--scenario",
        type=str,
        default="partition",
        help="Scenario name or config file stem (normal, dynamic_arrival, packet_loss_delay, partition, drone_failure, hub_failure)",
    )
    parser.add_argument(
        "--mode",
        type=str,
        default="swarmsync",
        choices=[m.value for m in CoordinationMode],
        help="Coordination mode: swarmsync, centralized, basic_auction, cbba",
    )
    parser.add_argument("--seed", type=int, default=1, help="Deterministic RNG seed")
    parser.add_argument("--fleet-size", type=int, default=None, help="Override fleet size")
    parser.add_argument("--visualize", action="store_true", help="Launch live Matplotlib animation")
    parser.add_argument(
        "--csv-out",
        type=str,
        default="experiments/results/last_cli_run.csv",
        help="Output CSV path for run metrics",
    )
    args = parser.parse_args(argv)

    config = load_scenario_config(args.scenario)
    if args.fleet_size is not None:
        config["fleet_size"] = args.fleet_size

    mode = CoordinationMode(args.mode)
    world = SimulationWorld(config=config, mode=mode, seed=args.seed)

    if args.visualize:
        run_live_visualizer(world)
        return 0

    metrics = world.run_to_completion()
    save_runs_to_csv([metrics], Path(args.csv_out))
    print(json.dumps(asdict(metrics), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
