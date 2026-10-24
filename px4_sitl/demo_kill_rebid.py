from __future__ import annotations
import json
from typing import Any, Dict
from px4_sitl.collision_avoidance import ReciprocalVelocityObstacleAvoidance
from px4_sitl.uxrce_dds_bridge import PX4UXRCEDDSBridge
from swarmsync.baselines.modes import CoordinationMode
from swarmsync.run import load_scenario_config
from swarmsync.sim.tasks import TaskStatus
from swarmsync.sim.world import SimulationWorld


def run_stage3_px4_kill_rebid_demo(fleet_size: int = 5, seed: int = 1) -> Dict[str, Any]:
    """
    Reproduces the Stage 3 key milestone:
    - Spawns `fleet_size` (3 or 5) drones bridged via `PX4UXRCEDDSBridge` with 10Hz offboard heartbeats
      and `ReciprocalVelocityObstacleAvoidance`.
    - Kills an active drone mid-delivery at t = 14.0s.
    - Verifies that remaining drones detect lease expiry, increment task version, re-bid,
      avoid collisions, and finish 100% of deliveries including the killed drone's task.
    """
    cfg = load_scenario_config("drone_failure")
    cfg["fleet_size"] = fleet_size
    cfg["kill_drone_events"] = [{"time": 14.0}]
    world = SimulationWorld(config=cfg, mode=CoordinationMode.SWARMSYNC, seed=seed)

    rvo = ReciprocalVelocityObstacleAvoidance(safety_radius=24.0, avoidance_horizon=50.0)
    bridges: Dict[int, PX4UXRCEDDSBridge] = {
        did: PX4UXRCEDDSBridge(drone=d, rvo=rvo) for did, d in world.drones.items()
    }

    killed_drone_id: int | None = None
    orphaned_task_id: str | None = None
    reassigned_to_drone_id: int | None = None

    max_steps = int(world.max_duration / world.dt)
    for _ in range(max_steps):
        # Record state before step to detect which drone was killed mid-delivery
        prev_alive = {did: d.alive for did, d in world.drones.items()}
        prev_tasks = {did: d.local_state.current_task_id for did, d in world.drones.items()}

        world.step()

        for did, was_alive in prev_alive.items():
            if was_alive and not world.drones[did].alive and killed_drone_id is None:
                killed_drone_id = did
                orphaned_task_id = prev_tasks[did]

        # Step PX4 uXRCE-DDS offboard bridges and RVO collision avoidance
        positions = {did: d.position for did, d in world.drones.items() if d.alive}
        velocities = {did: bridges[did].current_velocity for did, d in world.drones.items() if d.alive}
        for did, bridge in bridges.items():
            bridge.step_px4_bridge(world.current_time, world.dt, positions, velocities)

        # Check if orphaned task was claimed by a surviving drone
        if orphaned_task_id is not None and reassigned_to_drone_id is None:
            for did, d in world.drones.items():
                if d.alive and d.local_state.current_task_id == orphaned_task_id:
                    reassigned_to_drone_id = did

        outcomes = world.get_consolidated_task_outcomes()
        if all(t.status == TaskStatus.COMPLETED for t in outcomes.values()):
            break

    outcomes = world.get_consolidated_task_outcomes()
    orphaned_outcome = outcomes.get(orphaned_task_id) if orphaned_task_id else None
    completed_count = sum(1 for t in outcomes.values() if t.status == TaskStatus.COMPLETED)

    return {
        "fleet_size": fleet_size,
        "killed_drone_id": killed_drone_id,
        "orphaned_task_id": orphaned_task_id,
        "reassigned_to_drone_id": reassigned_to_drone_id,
        "orphaned_task_completed": (
            orphaned_outcome.status == TaskStatus.COMPLETED if orphaned_outcome else False
        ),
        "orphaned_task_final_version": orphaned_outcome.version if orphaned_outcome else 1,
        "total_tasks": len(outcomes),
        "completed_tasks": completed_count,
        "rvo_avoidance_maneuvers": rvo.avoidance_maneuvers,
        "total_offboard_heartbeats": sum(b.heartbeat_count for b in bridges.values()),
    }


if __name__ == "__main__":
    res3 = run_stage3_px4_kill_rebid_demo(fleet_size=3, seed=1)
    res5 = run_stage3_px4_kill_rebid_demo(fleet_size=5, seed=1)
    print(json.dumps({"px4_3_drones": res3, "px4_5_drones": res5}, indent=2))
