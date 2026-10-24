from __future__ import annotations
import math
import random
from typing import Any, Dict, List, Optional, Set, Tuple
from swarmsync.agents.drone import DroneAgent
from swarmsync.baselines.modes import CBBAEngine, CentralizedScheduler, CoordinationMode
from swarmsync.metrics.collector import RunMetrics
from swarmsync.net.network import SimulatedNetwork
from swarmsync.sim.tasks import DeliveryTask, TaskSource, TaskStatus


class SimulationWorld:
    """
    Discrete-time 2D multi-agent simulator with fixed timestep and seeded RNG.
    Supports all 4 coordination modes (`swarmsync`, `centralized`, `basic_auction`, `cbba`)
    under identical tasks, physics, and fault schedules.
    """

    def __init__(
        self,
        config: Dict[str, Any],
        mode: CoordinationMode = CoordinationMode.SWARMSYNC,
        seed: int = 1,
    ) -> None:
        self.config = config
        self.mode = mode
        self.seed = seed
        self.rng = random.Random(seed)

        self.scenario_name: str = str(config.get("name", "normal"))
        self.dt: float = float(config.get("dt", 0.25))
        self.max_duration: float = float(config.get("max_duration", 160.0))
        self.fleet_size: int = int(config.get("fleet_size", 5))
        self.total_tasks: int = int(config.get("total_tasks", 12))
        self.world_size: Tuple[float, float] = (1000.0, 1000.0)
        self.base_pos: Tuple[float, float] = (500.0, 500.0)
        self.current_time: float = 0.0

        # Network layer
        self.network = SimulatedNetwork(
            rng=random.Random(seed + 1000),
            comm_range=float(config.get("comm_range", 520.0)),
            packet_loss_prob=float(config.get("packet_loss_prob", 0.0)),
            min_delay=float(config.get("min_delay", 0.0)),
            max_delay=float(config.get("max_delay", 0.1)),
            partition_enabled=False,
            partition_x_boundary=500.0,
        )

        # Task source (identical schedule across modes for same seed)
        self.task_source = TaskSource(
            rng=random.Random(seed + 2000),
            world_size=self.world_size,
            total_tasks=self.total_tasks,
            dynamic_arrival=bool(config.get("dynamic_arrival", False)),
            spawn_interval=float(config.get("spawn_interval", 7.0)),
        )

        # Configure mode flags
        periodic_broadcast = mode == CoordinationMode.BASIC_AUCTION
        use_leases = mode in (CoordinationMode.SWARMSYNC, CoordinationMode.CBBA)

        self.drones: Dict[int, DroneAgent] = {}
        for i in range(1, self.fleet_size + 1):
            angle = (2.0 * math.pi * (i - 1)) / max(self.fleet_size, 1)
            radius = 120.0
            pos = (
                round(self.base_pos[0] + radius * math.cos(angle), 2),
                round(self.base_pos[1] + radius * math.sin(angle), 2),
            )
            drone = DroneAgent(
                agent_id=i,
                initial_position=pos,
                network=self.network,
                base_position=self.base_pos,
                max_payload=3.5,
                speed=float(config.get("drone_speed", 24.0)),
                periodic_broadcast=periodic_broadcast,
                use_leases=use_leases,
            )
            self.drones[i] = drone
            self.network.register_node(i, pos, alive=True)

        self.central_hub: Optional[CentralizedScheduler] = (
            CentralizedScheduler(self.network, self.base_pos)
            if mode == CoordinationMode.CENTRALIZED
            else None
        )
        self.cbba_engine: Optional[CBBAEngine] = (
            CBBAEngine(max_bundle_size=2) if mode == CoordinationMode.CBBA else None
        )

        # Fault schedule tracking
        self.partition_window: Optional[Tuple[float, float]] = config.get("partition_window")
        self.kill_drone_events: List[Dict[str, Any]] = list(config.get("kill_drone_events", []))
        self._fired_kill_indices: Set[int] = set()
        self.hub_failure_at: Optional[float] = config.get("hub_failure_at")

        # Metrics tracking
        self._task_failure_timestamps: Dict[str, float] = {}
        self._recovery_durations: List[float] = []
        self._duplicate_claim_steps: int = 0
        self._total_claim_steps: int = 0

    def kill_drone(self, drone_id: int) -> Optional[str]:
        """Injects a drone failure and returns the task_id it was carrying if any."""
        drone = self.drones.get(drone_id)
        if drone is None or not drone.alive:
            return None
        orphaned_task_id = drone.local_state.current_task_id
        drone.alive = False
        self.network.update_node_state(drone.id, drone.position, alive=False)
        if orphaned_task_id is not None:
            self._task_failure_timestamps[orphaned_task_id] = self.current_time
        return orphaned_task_id

    def _apply_fault_schedule(self) -> None:
        # 1. Partition schedule
        if self.partition_window is not None:
            start_t, end_t = float(self.partition_window[0]), float(self.partition_window[1])
            should_partition = start_t <= self.current_time <= end_t
            self.network.set_partition(should_partition)

        # 2. Central hub failure
        if (
            self.hub_failure_at is not None
            and self.central_hub is not None
            and self.central_hub.hub_alive
            and self.current_time >= float(self.hub_failure_at)
        ):
            self.central_hub.kill_hub()

        # 3. Drone mid-delivery failure injection
        for idx, ev in enumerate(self.kill_drone_events):
            if idx in self._fired_kill_indices:
                continue
            trigger_time = float(ev.get("time", 25.0))
            if self.current_time >= trigger_time:
                # Prefer killing an active drone that currently owns a task mid-delivery
                active_owners = [
                    d
                    for d in self.drones.values()
                    if d.alive and d.local_state.current_task_id is not None
                ]
                if active_owners:
                    victim = active_owners[0]
                    self.kill_drone(victim.id)
                    self._fired_kill_indices.add(idx)
                elif self.current_time >= trigger_time + 10.0:
                    alive_list = [d for d in self.drones.values() if d.alive]
                    if alive_list:
                        self.kill_drone(alive_list[0].id)
                    self._fired_kill_indices.add(idx)

    def step(self) -> None:
        self._apply_fault_schedule()

        # Update node positions in network
        for d in self.drones.values():
            self.network.update_node_state(d.id, d.position, d.alive)

        # Spawn new tasks and hand ONLY to nearest reachable alive agent
        positions = {d.id: d.position for d in self.drones.values()}
        alive_map = {d.id: d.alive for d in self.drones.values()}
        newly_spawned = self.task_source.step(self.current_time, positions, alive_map)
        for recipient_id, task_copy in newly_spawned:
            if self.central_hub is not None:
                self.central_hub.register_spawned_task(task_copy)
            else:
                self.drones[recipient_id].receive_direct_task_from_source(
                    task_copy, self.current_time
                )

        # Advance network message delivery queue
        self.network.step(self.current_time)

        # Advance coordinator or decentralized agents
        if self.central_hub is not None:
            self.central_hub.step(self.current_time, self.drones)
            for d in self.drones.values():
                if d.alive:
                    d._step_kinematics(self.current_time, self.dt)
        else:
            if self.cbba_engine is not None:
                self.cbba_engine.step_bundles(self.current_time, self.drones)
            for d in self.drones.values():
                d.step(self.current_time, self.dt)

        # Observe recovery times and duplicate active claims (observer-only metrics)
        active_claims_by_task: Dict[str, List[int]] = {}
        for d in self.drones.values():
            if not d.alive:
                continue
            tid = d.local_state.current_task_id
            if tid is not None:
                active_claims_by_task.setdefault(tid, []).append(d.id)
                if tid in self._task_failure_timestamps:
                    rec_dt = self.current_time - self._task_failure_timestamps.pop(tid)
                    self._recovery_durations.append(max(0.25, rec_dt))

        for tid, owners in active_claims_by_task.items():
            self._total_claim_steps += 1
            # Count duplicate committed ownership if 2+ drones still hold the task after 1 propagation step
            if len(owners) > 1 and self.network.partition_enabled:
                self._duplicate_claim_steps += 1

        self.current_time = round(self.current_time + self.dt, 4)

    def get_consolidated_task_outcomes(self) -> Dict[str, DeliveryTask]:
        """Observer-only consolidation of task outcomes across the simulation."""
        outcomes: Dict[str, DeliveryTask] = {
            tid: t.copy() for tid, t in self.task_source.all_tasks.items()
        }
        if self.central_hub is not None:
            for tid, gt in self.central_hub.global_tasks.items():
                if gt.status == TaskStatus.COMPLETED:
                    outcomes[tid] = gt.copy()
        for d in self.drones.values():
            for tid, lt in d.local_state.known_tasks.items():
                if lt.status == TaskStatus.COMPLETED:
                    if outcomes[tid].status != TaskStatus.COMPLETED or (
                        lt.completed_at is not None
                        and (
                            outcomes[tid].completed_at is None
                            or lt.completed_at < outcomes[tid].completed_at
                        )
                    ):
                        outcomes[tid] = lt.copy()
        return outcomes

    def run_to_completion(self) -> RunMetrics:
        max_steps = int(self.max_duration / self.dt)
        for _ in range(max_steps):
            self.step()
            outcomes = self.get_consolidated_task_outcomes()
            if all(t.status == TaskStatus.COMPLETED for t in outcomes.values()):
                break

        outcomes = self.get_consolidated_task_outcomes()
        completed = [t for t in outcomes.values() if t.status == TaskStatus.COMPLETED]
        n_total = len(outcomes)
        n_comp = len(completed)

        delivery_times = [
            (t.completed_at - t.spawn_time)
            for t in completed
            if t.completed_at is not None
        ]
        on_time = [
            t
            for t in completed
            if t.completed_at is not None and t.completed_at <= t.deadline
        ]

        avg_deliv_time = sum(delivery_times) / len(delivery_times) if delivery_times else self.max_duration
        deliv_rate = n_comp / max(n_total, 1)
        deadline_rate = len(on_time) / max(n_total, 1)

        total_msgs = self.network.total_messages_sent
        total_bytes = self.network.total_bytes_sent
        msgs_per_deliv = total_msgs / max(n_comp, 1)
        bytes_per_deliv = total_bytes / max(n_comp, 1)

        avg_recovery = (
            sum(self._recovery_durations) / len(self._recovery_durations)
            if self._recovery_durations
            else 0.0
        )
        dup_rate = self._duplicate_claim_steps / max(self._total_claim_steps, 1)
        total_energy = sum(d.energy_consumed_total for d in self.drones.values())
        energy_per_deliv = total_energy / max(n_comp, 1)
        safety_violations = sum(d.safety.safety_violations for d in self.drones.values())
        reconciliations = sum(d.recovery.reconciliations_completed for d in self.drones.values())

        return RunMetrics(
            scenario=self.scenario_name,
            mode=self.mode.value,
            seed=self.seed,
            fleet_size=self.fleet_size,
            total_tasks=n_total,
            completed_tasks=n_comp,
            delivery_success_rate=round(deliv_rate, 4),
            avg_delivery_time_s=round(avg_deliv_time, 3),
            deadline_success_rate=round(deadline_rate, 4),
            total_messages=total_msgs,
            total_bytes=total_bytes,
            messages_per_delivery=round(msgs_per_deliv, 2),
            bytes_per_delivery=round(bytes_per_deliv, 1),
            avg_recovery_time_s=round(avg_recovery, 3),
            duplicate_assignment_rate=round(dup_rate, 5),
            energy_per_delivery_pct=round(energy_per_deliv, 3),
            safety_violations=safety_violations,
            reconciliations=reconciliations,
        )
