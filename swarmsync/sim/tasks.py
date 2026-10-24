from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
import math
import random
from typing import Any, Dict, List, Optional, Tuple


class TaskStatus(str, Enum):
    ANNOUNCED = "ANNOUNCED"
    BIDDING = "BIDDING"
    CLAIMED = "CLAIMED"
    IN_PROGRESS = "IN_PROGRESS"
    RELEASED = "RELEASED"
    COMPLETED = "COMPLETED"
    EXPIRED = "EXPIRED"


@dataclass
class DeliveryTask:
    task_id: str
    pickup: Tuple[float, float]
    dropoff: Tuple[float, float]
    payload: float
    spawn_time: float
    deadline: float
    status: TaskStatus = TaskStatus.ANNOUNCED
    owner_id: Optional[int] = None
    version: int = 1
    lease_expiry: float = 0.0
    best_bid: float = -1e9
    best_bidder: Optional[int] = None
    auction_opened_at: float = 0.0
    picked_up: bool = False
    completed_at: Optional[float] = None
    completed_by: Optional[int] = None
    initial_recipient_id: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "pickup": list(self.pickup),
            "dropoff": list(self.dropoff),
            "payload": self.payload,
            "spawn_time": self.spawn_time,
            "deadline": self.deadline,
            "status": self.status.value,
            "owner_id": self.owner_id,
            "version": self.version,
            "lease_expiry": self.lease_expiry,
            "best_bid": self.best_bid,
            "best_bidder": self.best_bidder,
            "auction_opened_at": self.auction_opened_at,
            "picked_up": self.picked_up,
            "completed_at": self.completed_at,
            "completed_by": self.completed_by,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> DeliveryTask:
        return cls(
            task_id=str(data["task_id"]),
            pickup=(float(data["pickup"][0]), float(data["pickup"][1])),
            dropoff=(float(data["dropoff"][0]), float(data["dropoff"][1])),
            payload=float(data["payload"]),
            spawn_time=float(data["spawn_time"]),
            deadline=float(data["deadline"]),
            status=TaskStatus(data.get("status", "ANNOUNCED")),
            owner_id=data.get("owner_id"),
            version=int(data.get("version", 1)),
            lease_expiry=float(data.get("lease_expiry", 0.0)),
            best_bid=float(data.get("best_bid", -1e9)),
            best_bidder=data.get("best_bidder"),
            auction_opened_at=float(data.get("auction_opened_at", 0.0)),
            picked_up=bool(data.get("picked_up", False)),
            completed_at=data.get("completed_at"),
            completed_by=data.get("completed_by"),
        )

    def copy(self) -> DeliveryTask:
        return DeliveryTask.from_dict(self.to_dict())


class TaskSource:
    """
    Spawns delivery tasks and hands each new task ONLY to the nearest reachable alive agent.
    Does not act as a central broker or task allocator.
    """

    def __init__(
        self,
        rng: random.Random,
        world_size: Tuple[float, float] = (1000.0, 1000.0),
        total_tasks: int = 12,
        dynamic_arrival: bool = False,
        spawn_interval: float = 8.0,
    ) -> None:
        self.rng = rng
        self.world_size = world_size
        self.total_tasks = total_tasks
        self.dynamic_arrival = dynamic_arrival
        self.spawn_interval = spawn_interval

        self._schedule: List[DeliveryTask] = []
        self._spawned_ids: set[str] = set()
        self.all_tasks: Dict[str, DeliveryTask] = {}
        self._build_schedule()

    def _build_schedule(self) -> None:
        w, h = self.world_size
        margin = 90.0
        for idx in range(1, self.total_tasks + 1):
            spawn_t = (idx - 1) * self.spawn_interval if self.dynamic_arrival else (idx - 1) * 1.5
            px = round(self.rng.uniform(margin, w - margin), 1)
            py = round(self.rng.uniform(margin, h - margin), 1)
            dx = round(self.rng.uniform(margin, w - margin), 1)
            dy = round(self.rng.uniform(margin, h - margin), 1)
            while math.hypot(dx - px, dy - py) < 180.0:
                dx = round(self.rng.uniform(margin, w - margin), 1)
                dy = round(self.rng.uniform(margin, h - margin), 1)
            dist = math.hypot(dx - px, dy - py)
            payload = round(self.rng.uniform(0.8, 3.2), 2)
            # Generous but realistic deadline so multi-wave tasks are feasible across 3 waves
            deadline = round(spawn_t + 135.0 + dist * 0.15, 1)
            task = DeliveryTask(
                task_id=f"T-{idx:02d}",
                pickup=(px, py),
                dropoff=(dx, dy),
                payload=payload,
                spawn_time=spawn_t,
                deadline=deadline,
                auction_opened_at=spawn_t,
            )
            self._schedule.append(task)
            self.all_tasks[task.task_id] = task

    def step(
        self,
        current_time: float,
        agent_positions: Dict[int, Tuple[float, float]],
        alive_agents: Dict[int, bool],
    ) -> List[Tuple[int, DeliveryTask]]:
        """
        Returns list of (nearest_reachable_agent_id, task_copy) for tasks due at current_time.
        """
        injected: List[Tuple[int, DeliveryTask]] = []
        available_agents = [aid for aid, is_alive in alive_agents.items() if is_alive]
        if not available_agents:
            return injected

        for task in self._schedule:
            if task.task_id in self._spawned_ids:
                continue
            if task.spawn_time <= current_time + 1e-9:
                # Find nearest alive agent to the task pickup location
                nearest_id = min(
                    available_agents,
                    key=lambda aid: math.hypot(
                        agent_positions[aid][0] - task.pickup[0],
                        agent_positions[aid][1] - task.pickup[1],
                    ),
                )
                task.initial_recipient_id = nearest_id
                self._spawned_ids.add(task.task_id)
                injected.append((nearest_id, task.copy()))
        return injected
