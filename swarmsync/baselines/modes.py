from __future__ import annotations
from enum import Enum
import math
from typing import Dict, List, Optional, Tuple
from swarmsync.agents.drone import DroneAgent
from swarmsync.net.messages import MessageType
from swarmsync.net.network import SimulatedNetwork
from swarmsync.sim.tasks import DeliveryTask, TaskStatus


class CoordinationMode(str, Enum):
    SWARMSYNC = "swarmsync"
    CENTRALIZED = "centralized"
    BASIC_AUCTION = "basic_auction"
    CBBA = "cbba"


class CentralizedScheduler:
    """
    Baseline 1: Centralized Hub Coordinator (ID = 0 at arena center).
    Assigns tasks to nearest idle feasible drone using global view of reachable drones.
    Stops assigning or recovering tasks when its process fails (`hub_alive = False`)
    or cannot reach partitioned drones.
    """

    HUB_NODE_ID = 0

    def __init__(
        self,
        network: SimulatedNetwork,
        hub_position: Tuple[float, float] = (500.0, 500.0),
    ) -> None:
        self.network = network
        self.hub_position = hub_position
        self.hub_alive: bool = True
        self.global_tasks: Dict[str, DeliveryTask] = {}
        self._last_poll_at: float = -999.0
        self.network.register_node(self.HUB_NODE_ID, self.hub_position, alive=True)

    def kill_hub(self) -> None:
        self.hub_alive = False
        self.network.update_node_state(self.HUB_NODE_ID, self.hub_position, alive=False)

    def register_spawned_task(self, task: DeliveryTask) -> None:
        if task.task_id not in self.global_tasks:
            self.global_tasks[task.task_id] = task.copy()

    def step(
        self,
        current_time: float,
        drones: Dict[int, DroneAgent],
    ) -> None:
        self.network.update_node_state(self.HUB_NODE_ID, self.hub_position, alive=self.hub_alive)
        if not self.hub_alive:
            return

        # Central hub polls telemetry every 1.0s over the network
        if current_time - self._last_poll_at >= 1.0:
            self._last_poll_at = current_time
            for d in drones.values():
                if d.alive and self.network.can_communicate(self.HUB_NODE_ID, d.id):
                    d.comm.create_and_send(
                        MessageType.HEARTBEAT,
                        current_time=current_time,
                        payload={"position": list(d.position), "battery": d.battery},
                        ttl=2.0,
                    )

        # Sync completed tasks from reachable drones
        for t in self.global_tasks.values():
            if t.status == TaskStatus.COMPLETED:
                continue
            for d in drones.values():
                local_t = d.local_state.known_tasks.get(t.task_id)
                if local_t and local_t.status == TaskStatus.COMPLETED:
                    t.status = TaskStatus.COMPLETED
                    t.completed_at = local_t.completed_at
                    t.completed_by = local_t.completed_by

        # Recover tasks owned by dead drones IF hub is alive
        for t in self.global_tasks.values():
            if t.status in (TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS) and t.owner_id is not None:
                owner = drones.get(t.owner_id)
                if owner is None or not owner.alive:
                    t.status = TaskStatus.RELEASED
                    t.owner_id = None
                    t.version += 1

        # Nearest-idle assignment for unassigned tasks among reachable alive idle drones
        idle_drones = [
            d
            for d in drones.values()
            if d.alive
            and not d.returning_for_safety
            and d.local_state.current_task_id is None
            and self.network.can_communicate(self.HUB_NODE_ID, d.id)
        ]

        for t in self.global_tasks.values():
            if t.status not in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED):
                continue
            if not idle_drones:
                break

            feasible_drones = [
                d
                for d in idle_drones
                if d.safety.can_undertake_task(d.position, d.battery, t, current_time)[0]
            ]
            if not feasible_drones:
                continue

            best_drone = min(
                feasible_drones,
                key=lambda d: math.hypot(d.position[0] - t.pickup[0], d.position[1] - t.pickup[1]),
            )
            t.owner_id = best_drone.id
            t.status = TaskStatus.CLAIMED
            t.lease_expiry = 1e9
            best_drone.local_state.known_tasks[t.task_id] = t.copy()
            best_drone.local_state.current_task_id = t.task_id
            idle_drones.remove(best_drone)


class CBBAEngine:
    """
    Baseline 3: Consensus-Based Bundle Algorithm (CBBA) extension.
    Allows each drone to maintain a bundle of up to max_bundle_size=2 tasks
    and exchange winning bid vectors with neighbors.
    """

    def __init__(self, max_bundle_size: int = 2) -> None:
        self.max_bundle_size = max_bundle_size

    def step_bundles(self, current_time: float, drones: Dict[int, DroneAgent]) -> None:
        for d in drones.values():
            if not d.alive or d.returning_for_safety:
                continue
            if d.local_state.current_task_id is not None:
                continue
            # Select highest marginal score task from local known unassigned tasks
            candidates: List[Tuple[float, DeliveryTask]] = []
            for t in d.local_state.known_tasks.values():
                if t.status in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED):
                    score = d.negotiation.compute_bid(
                        d.position, d.battery, t, current_time, d.local_state.hazards
                    )
                    if score is not None:
                        candidates.append((score, t))
            if candidates:
                candidates.sort(key=lambda item: item[0], reverse=True)
                best_score, best_task = candidates[0]
                if d.negotiation.is_better_bid(
                    best_score, d.id, best_task.best_bid, best_task.best_bidder
                ):
                    best_task.best_bid = best_score
                    best_task.best_bidder = d.id
                    best_task.status = TaskStatus.BIDDING
