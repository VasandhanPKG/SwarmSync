from __future__ import annotations
from dataclasses import dataclass
import math
import random
from typing import Dict, List, Optional, Set, Tuple
from swarmsync.net.messages import ForumMessage


@dataclass
class InFlightPacket:
    deliver_at: float
    sender_id: int
    receiver_id: int
    message: ForumMessage


class SimulatedNetwork:
    """
    Simulated peer-to-peer wireless network layer.
    Enforces communication range, per-message stochastic delay, packet loss,
    network partitions, and node failure isolation.
    Agents may ONLY communicate through this layer.
    """

    def __init__(
        self,
        rng: random.Random,
        comm_range: float = 450.0,
        packet_loss_prob: float = 0.0,
        min_delay: float = 0.0,
        max_delay: float = 0.1,
        partition_enabled: bool = False,
        partition_x_boundary: float = 500.0,
    ) -> None:
        self.rng = rng
        self.comm_range = comm_range
        self.packet_loss_prob = packet_loss_prob
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.partition_enabled = partition_enabled
        self.partition_x_boundary = partition_x_boundary

        self._positions: Dict[int, Tuple[float, float]] = {}
        self._alive: Dict[int, bool] = {}
        self._queue: List[InFlightPacket] = []
        self._inbox: Dict[int, List[ForumMessage]] = {}
        self._previous_neighbors: Dict[int, Set[int]] = {}

        # Telemetry counters (strictly observer-only)
        self.total_messages_sent: int = 0
        self.total_bytes_sent: int = 0
        self.total_packets_dropped: int = 0
        self.total_packets_delivered: int = 0

    def register_node(self, node_id: int, position: Tuple[float, float], alive: bool = True) -> None:
        self._positions[node_id] = position
        self._alive[node_id] = alive
        self._inbox.setdefault(node_id, [])
        self._previous_neighbors.setdefault(node_id, set())

    def update_node_state(self, node_id: int, position: Tuple[float, float], alive: bool) -> None:
        self._positions[node_id] = position
        self._alive[node_id] = alive

    def set_partition(self, enabled: bool) -> None:
        self.partition_enabled = enabled

    def are_in_same_partition(self, id_a: int, id_b: int) -> bool:
        if not self.partition_enabled:
            return True
        pos_a = self._positions.get(id_a)
        pos_b = self._positions.get(id_b)
        if pos_a is None or pos_b is None:
            return False
        side_a = pos_a[0] < self.partition_x_boundary
        side_b = pos_b[0] < self.partition_x_boundary
        return side_a == side_b

    def can_communicate(self, id_a: int, id_b: int) -> bool:
        if id_a == id_b:
            return False
        if not self._alive.get(id_a, False) or not self._alive.get(id_b, False):
            return False
        if not self.are_in_same_partition(id_a, id_b):
            return False
        pos_a = self._positions[id_a]
        pos_b = self._positions[id_b]
        dist = math.hypot(pos_a[0] - pos_b[0], pos_a[1] - pos_b[1])
        return dist <= self.comm_range

    def get_neighbors(self, node_id: int) -> List[int]:
        if not self._alive.get(node_id, False):
            return []
        return [
            other_id
            for other_id in sorted(self._positions.keys())
            if self.can_communicate(node_id, other_id)
        ]

    def detect_link_changes(self, node_id: int) -> Tuple[Set[int], Set[int]]:
        """Returns (newly_connected_peers, lost_peers) since last check for node_id."""
        current = set(self.get_neighbors(node_id))
        prev = self._previous_neighbors.get(node_id, set())
        added = current - prev
        removed = prev - current
        self._previous_neighbors[node_id] = current
        return added, removed

    def broadcast(self, sender_id: int, message: ForumMessage, current_time: float) -> int:
        """Broadcasts a message from sender_id to all currently reachable neighbors."""
        if not self._alive.get(sender_id, False):
            return 0
        neighbors = self.get_neighbors(sender_id)
        self.total_messages_sent += 1
        self.total_bytes_sent += message.byte_size

        enqueued = 0
        for peer_id in neighbors:
            if self.packet_loss_prob > 0.0 and self.rng.random() < self.packet_loss_prob:
                self.total_packets_dropped += 1
                continue
            delay = (
                self.rng.uniform(self.min_delay, self.max_delay)
                if self.max_delay > self.min_delay
                else self.min_delay
            )
            self._queue.append(
                InFlightPacket(
                    deliver_at=current_time + delay,
                    sender_id=sender_id,
                    receiver_id=peer_id,
                    message=message,
                )
            )
            enqueued += 1
        return enqueued

    def step(self, current_time: float) -> None:
        """Advances the network queue and delivers due packets if receiver is still alive & reachable."""
        remaining: List[InFlightPacket] = []
        for pkt in self._queue:
            if pkt.deliver_at <= current_time + 1e-9:
                # Verify receiver is still alive and not partitioned at delivery instant
                if self._alive.get(pkt.receiver_id, False) and self.are_in_same_partition(
                    pkt.sender_id, pkt.receiver_id
                ):
                    self._inbox.setdefault(pkt.receiver_id, []).append(pkt.message)
                    self.total_packets_delivered += 1
                else:
                    self.total_packets_dropped += 1
            else:
                remaining.append(pkt)
        self._queue = remaining

    def pop_messages(self, receiver_id: int) -> List[ForumMessage]:
        msgs = self._inbox.get(receiver_id, [])
        self._inbox[receiver_id] = []
        return msgs
