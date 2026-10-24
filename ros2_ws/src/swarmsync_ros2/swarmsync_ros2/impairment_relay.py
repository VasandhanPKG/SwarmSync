from __future__ import annotations
from dataclasses import dataclass
import math
import random
from typing import Any, Callable, Dict, List, Set, Tuple


@dataclass
class DelayedRosPacket:
    deliver_at: float
    target_agent_id: int
    wire_dict: Dict[str, Any]


class Ros2NetworkImpairmentLayer:
    """
    Stage 2 Network-Impairment Layer for ROS 2 single-host / multi-container testing.
    Because DDS loopback on a single machine does not naturally experience wireless range
    attenuation, packet loss, stochastic delay, or East/West network partitions,
    this layer enforces:
      1. Euclidean range check (comm_range)
      2. Per-link packet loss probability (packet_loss_prob)
      3. Uniform or jittered latency queue [min_delay, max_delay]
      4. Dynamic Partition Groups (e.g., Group A = {1, 2}, Group B = {3, 4, 5})
    Does NOT inspect task semantics or perform any task allocation.
    """

    def __init__(
        self,
        seed: int = 42,
        comm_range: float = 500.0,
        packet_loss_prob: float = 0.10,
        min_delay: float = 0.05,
        max_delay: float = 0.35,
    ) -> None:
        self.rng = random.Random(seed)
        self.comm_range = comm_range
        self.packet_loss_prob = packet_loss_prob
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.partition_groups: List[Set[int]] = []

        self.agent_positions: Dict[int, Tuple[float, float]] = {}
        self.agent_alive: Dict[int, bool] = {}
        self.delay_queue: List[DelayedRosPacket] = []

        self.packets_forwarded: int = 0
        self.packets_dropped_loss: int = 0
        self.packets_dropped_partition: int = 0

    def set_partition_groups(self, groups: List[Set[int]]) -> None:
        """Example: [{1, 2}, {3, 4, 5}] isolates {1,2} from {3,4,5}."""
        self.partition_groups = groups

    def clear_partition(self) -> None:
        self.partition_groups = []

    def _in_same_partition(self, a: int, b: int) -> bool:
        if not self.partition_groups:
            return True
        for grp in self.partition_groups:
            if a in grp and b in grp:
                return True
            if (a in grp) != (b in grp):
                return False
        return True

    def on_agent_tx(self, wire_dict: Dict[str, Any], current_time: float) -> None:
        sender_id = int(wire_dict["sender_id"])
        pos = wire_dict.get("sender_pos", [500.0, 500.0])
        self.agent_positions[sender_id] = (float(pos[0]), float(pos[1]))
        self.agent_alive[sender_id] = bool(wire_dict.get("sender_alive", True))
        if not self.agent_alive[sender_id]:
            return

        for peer_id, peer_pos in self.agent_positions.items():
            if peer_id == sender_id or not self.agent_alive.get(peer_id, True):
                continue
            if not self._in_same_partition(sender_id, peer_id):
                self.packets_dropped_partition += 1
                continue
            dist = math.hypot(pos[0] - peer_pos[0], pos[1] - peer_pos[1])
            if dist > self.comm_range:
                continue
            if self.rng.random() < self.packet_loss_prob:
                self.packets_dropped_loss += 1
                continue
            delay = self.rng.uniform(self.min_delay, self.max_delay)
            self.delay_queue.append(
                DelayedRosPacket(
                    deliver_at=current_time + delay,
                    target_agent_id=peer_id,
                    wire_dict=dict(wire_dict),
                )
            )

    def flush_due_packets(
        self,
        current_time: float,
        deliver_fn: Callable[[int, Dict[str, Any]], None],
    ) -> int:
        delivered = 0
        remaining: List[DelayedRosPacket] = []
        for item in self.delay_queue:
            if item.deliver_at <= current_time + 1e-9:
                deliver_fn(item.target_agent_id, item.wire_dict)
                self.packets_forwarded += 1
                delivered += 1
            else:
                remaining.append(item)
        self.delay_queue = remaining
        return delivered
