from __future__ import annotations
from dataclasses import dataclass, field
import logging
import math
from typing import Any, Dict, List, Optional, Set, Tuple
from swarmsync.net.messages import ForumMessage, MessageType
from swarmsync.net.network import SimulatedNetwork
from swarmsync.sim.tasks import DeliveryTask, TaskStatus

logger = logging.getLogger("swarmsync.agents")


@dataclass
class HazardZone:
    hazard_id: str
    center: Tuple[float, float]
    radius: float
    severity: float
    reported_at: float


# ============================================================================
# 1. LocalStateManager
# ============================================================================
class LocalStateManager:
    """
    Maintains the agent's local view of all known tasks, peer heartbeats,
    hazard zones, and event digest for partition reconciliation.
    Never accesses global state or other agents' memory.
    """

    def __init__(self, agent_id: int, base_pos: Tuple[float, float] = (500.0, 500.0)) -> None:
        self.agent_id = agent_id
        self.base_pos = base_pos
        self.known_tasks: Dict[str, DeliveryTask] = {}
        self.peer_heartbeats: Dict[int, float] = {}
        self.peer_positions: Dict[int, Tuple[float, float]] = {}
        self.peer_Load: Dict[int, Optional[str]] = {}
        self.hazards: Dict[str, HazardZone] = {}
        self.current_task_id: Optional[str] = None

    def upsert_task(self, task: DeliveryTask) -> bool:
        """Inserts a newly discovered task if unknown. Returns True if newly added."""
        if task.task_id not in self.known_tasks:
            self.known_tasks[task.task_id] = task.copy()
            return True
        return False

    def record_heartbeat(
        self, peer_id: int, timestamp: float, position: Tuple[float, float], current_task: Optional[str]
    ) -> None:
        if timestamp >= self.peer_heartbeats.get(peer_id, -1.0):
            self.peer_heartbeats[peer_id] = timestamp
            self.peer_positions[peer_id] = position
            self.peer_Load[peer_id] = current_task

    def record_hazard(self, hazard: HazardZone) -> bool:
        if hazard.hazard_id not in self.hazards:
            self.hazards[hazard.hazard_id] = hazard
            return True
        return False

    def build_reconciliation_digest(self) -> Dict[str, Dict[str, Any]]:
        """Builds a compact digest of local task states for post-partition convergence."""
        return {
            tid: t.to_dict()
            for tid, t in self.known_tasks.items()
        }


# ============================================================================
# 2. CommunicationManager
# ============================================================================
class CommunicationManager:
    """
    Handles sending, receiving, schema validation, message_id deduplication,
    expiry filtering, hop-limited gossip forwarding, and event-triggered vs
    periodic broadcast control.
    """

    def __init__(
        self,
        agent_id: int,
        network: SimulatedNetwork,
        periodic_broadcast: bool = False,
        default_ttl: float = 18.0,
        max_hops: int = 3,
    ) -> None:
        self.agent_id = agent_id
        self.network = network
        self.periodic_broadcast = periodic_broadcast
        self.default_ttl = default_ttl
        self.max_hops = max_hops

        self.sequence_number: int = 0
        self.seen_message_ids: Set[str] = set()
        self.dropped_expired_count: int = 0
        self.deduped_count: int = 0
        self.forwarded_count: int = 0

    def create_and_send(
        self,
        message_type: MessageType,
        current_time: float,
        task_id: Optional[str] = None,
        payload: Optional[Dict[str, Any]] = None,
        ttl: Optional[float] = None,
    ) -> ForumMessage:
        self.sequence_number += 1
        msg_id = f"M-{self.agent_id:02d}-{self.sequence_number:05d}"
        effective_ttl = ttl if ttl is not None else self.default_ttl
        msg = ForumMessage(
            message_id=msg_id,
            sender_id=self.agent_id,
            message_type=message_type,
            task_id=task_id,
            sequence_number=self.sequence_number,
            timestamp=current_time,
            expiry_time=current_time + effective_ttl,
            payload=payload or {},
            hop_count=0,
            max_hops=self.max_hops,
            origin_id=self.agent_id,
        )
        self.seen_message_ids.add(msg.message_id)
        self.network.broadcast(self.agent_id, msg, current_time)
        return msg

    def validate_message(self, msg: ForumMessage) -> bool:
        if not msg.message_id or msg.sender_id < 0 or msg.sequence_number <= 0:
            return False
        if msg.expiry_time < msg.timestamp:
            return False
        return True

    def receive_valid_messages(self, current_time: float) -> List[ForumMessage]:
        raw_messages = self.network.pop_messages(self.agent_id)
        accepted: List[ForumMessage] = []
        for msg in raw_messages:
            if not self.validate_message(msg):
                continue
            if current_time > msg.expiry_time + 1e-9:
                self.dropped_expired_count += 1
                continue
            if msg.message_id in self.seen_message_ids:
                self.deduped_count += 1
                continue
            self.seen_message_ids.add(msg.message_id)
            accepted.append(msg)
        return accepted

    def gossip_forward(self, msg: ForumMessage, current_time: float) -> bool:
        """Forwards a newly seen message once to neighbors if within hop limit and not expired."""
        if msg.hop_count >= msg.max_hops:
            return False
        if current_time > msg.expiry_time:
            return False
        # Heartbeats are direct 1-hop neighbor beacons; task/recovery/hazard events gossip multi-hop
        if msg.message_type == MessageType.HEARTBEAT:
            return False
        forwarded = msg.forwarded_by(self.agent_id)
        self.network.broadcast(self.agent_id, forwarded, current_time)
        self.forwarded_count += 1
        return True


# ============================================================================
# 6. SafetyMonitor (Evaluated before Negotiation can bid or execute)
# ============================================================================
class SafetyMonitor:
    """
    Enforces hard physical and operational safety constraints:
    - Battery reserve (including return-to-base energy + reserve threshold)
    - Payload capacity
    - Deadline feasibility
    Negotiation and assignment can NEVER override SafetyMonitor.
    """

    def __init__(
        self,
        max_payload: float = 3.5,
        battery_reserve: float = 15.0,
        energy_per_meter: float = 0.016,
        drone_speed: float = 28.0,
        base_pos: Tuple[float, float] = (500.0, 500.0),
    ) -> None:
        self.max_payload = max_payload
        self.battery_reserve = battery_reserve
        self.energy_per_meter = energy_per_meter
        self.drone_speed = drone_speed
        self.base_pos = base_pos
        self.safety_interventions: int = 0
        self.safety_violations: int = 0

    def estimate_mission_requirements(
        self,
        drone_pos: Tuple[float, float],
        task: DeliveryTask,
    ) -> Tuple[float, float, float]:
        """
        Returns (transit_time_sec, mission_energy_pct, return_to_base_energy_pct).
        """
        d_pickup = 0.0 if task.picked_up else math.hypot(
            task.pickup[0] - drone_pos[0], task.pickup[1] - drone_pos[1]
        )
        start_drop = drone_pos if task.picked_up else task.pickup
        d_dropoff = math.hypot(
            task.dropoff[0] - start_drop[0], task.dropoff[1] - start_drop[1]
        )
        d_return = math.hypot(
            self.base_pos[0] - task.dropoff[0], self.base_pos[1] - task.dropoff[1]
        )

        payload_factor = 1.0 + 0.30 * (task.payload / max(self.max_payload, 0.1))
        e_pickup = d_pickup * self.energy_per_meter
        e_dropoff = d_dropoff * self.energy_per_meter * payload_factor
        e_return = d_return * self.energy_per_meter

        transit_time = (d_pickup + d_dropoff) / max(self.drone_speed, 1.0)
        return transit_time, (e_pickup + e_dropoff), e_return

    def can_undertake_task(
        self,
        drone_pos: Tuple[float, float],
        battery: float,
        task: DeliveryTask,
        current_time: float,
    ) -> Tuple[bool, str]:
        if task.payload > self.max_payload:
            return False, "payload_exceeded"
        transit_time, e_mission, e_return = self.estimate_mission_requirements(drone_pos, task)
        if battery - (e_mission + e_return) < self.battery_reserve:
            return False, "insufficient_battery_reserve"
        # Allow a slight grace on late tasks that were released after a failure so fleet can still recover them
        effective_deadline = task.deadline if task.version == 1 else task.deadline + 35.0
        if current_time + transit_time > effective_deadline:
            return False, "deadline_infeasible"
        return True, "ok"

    def requires_emergency_abort(
        self,
        drone_pos: Tuple[float, float],
        battery: float,
        active_task: Optional[DeliveryTask],
    ) -> bool:
        """Checks if continuing current task would violate return-to-base battery safety reserve."""
        if active_task is None:
            d_base = math.hypot(self.base_pos[0] - drone_pos[0], self.base_pos[1] - drone_pos[1])
            return battery - d_base * self.energy_per_meter < self.battery_reserve
        _, e_mission, e_return = self.estimate_mission_requirements(drone_pos, active_task)
        if battery - (e_mission + e_return) < (self.battery_reserve - 2.0):
            self.safety_interventions += 1
            return True
        return False


# ============================================================================
# 3. TaskNegotiationEngine
# ============================================================================
class TaskNegotiationEngine:
    """
    Distributed auction engine.
    Computes cost J = w_t * T + w_e * E + w_r * R and Bid = -J.
    Consults SafetyMonitor first; never bids on unsafe tasks.
    """

    def __init__(
        self,
        agent_id: int,
        safety_monitor: SafetyMonitor,
        w_t: float = 0.50,
        w_e: float = 0.30,
        w_r: float = 0.20,
    ) -> None:
        self.agent_id = agent_id
        self.safety_monitor = safety_monitor
        self.w_t = w_t
        self.w_e = w_e
        self.w_r = w_r

    def compute_bid(
        self,
        drone_pos: Tuple[float, float],
        battery: float,
        task: DeliveryTask,
        current_time: float,
        hazards: Dict[str, HazardZone],
    ) -> Optional[float]:
        feasible, _ = self.safety_monitor.can_undertake_task(
            drone_pos, battery, task, current_time
        )
        if not feasible:
            return None

        transit_time, e_mission, _ = self.safety_monitor.estimate_mission_requirements(
            drone_pos, task
        )
        # Normalized time cost T in [0, 2]
        t_norm = transit_time / 60.0
        # Normalized energy cost E in [0, 1]
        e_norm = e_mission / 100.0

        # Risk cost R: deadline tightness + hazard proximity along route
        slack = max(1.0, task.deadline - (current_time + transit_time))
        deadline_risk = max(0.0, 1.0 - (slack / 60.0))
        hazard_risk = 0.0
        mid_x = 0.5 * (drone_pos[0] + task.pickup[0])
        mid_y = 0.5 * (drone_pos[1] + task.pickup[1])
        for hz in hazards.values():
            d_hz = math.hypot(mid_x - hz.center[0], mid_y - hz.center[1])
            if d_hz < hz.radius * 1.5:
                hazard_risk += hz.severity * (1.0 - d_hz / (hz.radius * 1.5))

        r_norm = min(2.0, deadline_risk + hazard_risk)
        cost_j = self.w_t * t_norm + self.w_e * e_norm + self.w_r * r_norm
        # Deterministic tie-breaker offset (1e-6 * agent_id)
        return round(-cost_j - (self.agent_id * 1e-6), 6)

    @staticmethod
    def is_better_bid(
        candidate_bid: float,
        candidate_agent: int,
        current_bid: float,
        current_agent: Optional[int],
    ) -> bool:
        if current_agent is None:
            return True
        if abs(candidate_bid - current_bid) > 1e-5:
            return candidate_bid > current_bid
        return candidate_agent < current_agent


# ============================================================================
# 4. AssignmentManager
# ============================================================================
class AssignmentManager:
    """
    Versioned, lease-based task ownership and deterministic conflict resolution.
    - Higher version wins.
    - On equal version, lower agent_id wins.
    - Stale updates never overwrite newer ones.
    - Detects and logs duplicate active claims.
    """

    def __init__(
        self,
        agent_id: int,
        lease_duration: float = 6.0,
        renew_interval: float = 2.0,
        auction_window: float = 1.2,
        use_leases: bool = True,
        use_conflict_resolution: bool = True,
    ) -> None:
        self.agent_id = agent_id
        self.lease_duration = lease_duration
        self.renew_interval = renew_interval
        self.auction_window = auction_window
        self.use_leases = use_leases
        self.use_conflict_resolution = use_conflict_resolution

        self.last_renew_sent_at: float = -999.0
        self.conflicts_resolved: int = 0
        self.duplicate_claims_detected: int = 0

    @staticmethod
    def _claim_wins(
        inc_version: int,
        inc_owner: int,
        cur_version: int,
        cur_owner: Optional[int],
    ) -> bool:
        if cur_owner is None:
            return True
        if inc_version != cur_version:
            return inc_version > cur_version
        return inc_owner < cur_owner

    def resolve_incoming_claim(
        self,
        local_task: DeliveryTask,
        inc_owner: int,
        inc_version: int,
        inc_lease_expiry: float,
        local_state: LocalStateManager,
    ) -> Tuple[bool, bool]:
        """
        Applies deterministic conflict resolution for an incoming CLAIM or RENEW.
        Returns (state_changed, local_agent_preempted).
        """
        if local_task.status == TaskStatus.COMPLETED:
            return False, False

        # Detect duplicate claim if both have active claims by different owners
        if (
            local_task.status in (TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS)
            and local_task.owner_id is not None
            and local_task.owner_id != inc_owner
        ):
            self.duplicate_claims_detected += 1
            if not self.use_conflict_resolution and local_state.current_task_id == local_task.task_id:
                # Without conflict resolution, local owner ignores competing claim and keeps flying
                return False, False

        # Stale version check: never overwrite newer version
        if self.use_conflict_resolution and inc_version < local_task.version:
            return False, False

        wins = (
            self._claim_wins(inc_version, inc_owner, local_task.version, local_task.owner_id)
            if self.use_conflict_resolution
            else (local_task.owner_id is None)
        )
        if not wins:
            return False, False

        preempted = (
            local_state.current_task_id == local_task.task_id
            and inc_owner != self.agent_id
        )
        if preempted:
            self.conflicts_resolved += 1
            local_state.current_task_id = None
            logger.info(
                "Agent %d yielded task %s to Agent %d (version %d vs %d)",
                self.agent_id,
                local_task.task_id,
                inc_owner,
                inc_version,
                local_task.version,
            )

        changed = (
            local_task.owner_id != inc_owner
            or local_task.version != inc_version
            or abs(local_task.lease_expiry - inc_lease_expiry) > 1e-4
            or local_task.status not in (TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS)
        )
        local_task.owner_id = inc_owner
        local_task.version = inc_version
        local_task.lease_expiry = inc_lease_expiry
        local_task.status = TaskStatus.IN_PROGRESS if local_task.picked_up else TaskStatus.CLAIMED
        return changed, preempted

    def claim_task_locally(
        self,
        task: DeliveryTask,
        current_time: float,
        local_state: LocalStateManager,
    ) -> None:
        # If reclaiming a released task, version was already bumped upon release
        task.owner_id = self.agent_id
        task.lease_expiry = (
            current_time + self.lease_duration if self.use_leases else 1e9
        )
        task.status = TaskStatus.CLAIMED
        local_state.current_task_id = task.task_id
        self.last_renew_sent_at = current_time


# ============================================================================
# 5. RecoveryManager
# ============================================================================
class RecoveryManager:
    """
    Handles heartbeat freshness tracking, lease expiry + conservative safety grace
    period, task release for re-bidding, and partition reconciliation.
    Note: A lease timeout is NOT proof of a crash (could be packet loss or partition),
    so a grace period is enforced and version is strictly incremented on release.
    """

    def __init__(
        self,
        agent_id: int,
        grace_period: float = 3.0,
        heartbeat_timeout: float = 6.0,
        use_leases: bool = True,
    ) -> None:
        self.agent_id = agent_id
        self.grace_period = grace_period
        self.heartbeat_timeout = heartbeat_timeout
        self.use_leases = use_leases
        self.tasks_released_count: int = 0
        self.reconciliations_completed: int = 0

    def check_expired_leases(
        self,
        local_state: LocalStateManager,
        current_time: float,
    ) -> List[DeliveryTask]:
        """
        Inspects all claimed tasks not owned by self.
        If current_time > lease_expiry + grace_period, marks the task RELEASED,
        increments version, and resets auction fields for re-bidding.
        """
        if not self.use_leases:
            return []

        released: List[DeliveryTask] = []
        for task in local_state.known_tasks.values():
            if task.status in (TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS):
                if task.owner_id == self.agent_id:
                    continue
                if current_time > task.lease_expiry + self.grace_period:
                    task.status = TaskStatus.RELEASED
                    task.version += 1
                    task.owner_id = None
                    task.best_bid = -1e9
                    task.best_bidder = None
                    task.auction_opened_at = current_time
                    self.tasks_released_count += 1
                    released.append(task)
        return released

    def reconcile_digest(
        self,
        local_state: LocalStateManager,
        assignment_mgr: AssignmentManager,
        peer_digest: Dict[str, Dict[str, Any]],
        current_time: float,
    ) -> int:
        """
        Merges a peer's task digest after partition healing or new link establishment.
        Returns number of local tasks updated toward convergence.
        """
        updates = 0
        for tid, remote_dict in peer_digest.items():
            remote_task = DeliveryTask.from_dict(remote_dict)
            if tid not in local_state.known_tasks:
                local_state.known_tasks[tid] = remote_task
                updates += 1
                continue

            local_task = local_state.known_tasks[tid]
            # Terminal completion always dominates
            if remote_task.status == TaskStatus.COMPLETED and local_task.status != TaskStatus.COMPLETED:
                if local_state.current_task_id == tid:
                    local_state.current_task_id = None
                local_task.status = TaskStatus.COMPLETED
                local_task.completed_at = remote_task.completed_at
                local_task.completed_by = remote_task.completed_by
                local_task.owner_id = remote_task.owner_id
                local_task.version = max(local_task.version, remote_task.version)
                updates += 1
                continue

            if local_task.status == TaskStatus.COMPLETED:
                continue

            # If remote has a newer version or valid competing claim, resolve deterministically
            if remote_task.owner_id is not None and remote_task.status in (
                TaskStatus.CLAIMED,
                TaskStatus.IN_PROGRESS,
            ):
                changed, _ = assignment_mgr.resolve_incoming_claim(
                    local_task,
                    remote_task.owner_id,
                    remote_task.version,
                    remote_task.lease_expiry,
                    local_state,
                )
                if changed:
                    local_task.picked_up = local_task.picked_up or remote_task.picked_up
                    updates += 1
            elif remote_task.version > local_task.version and remote_task.status == TaskStatus.RELEASED:
                if local_state.current_task_id == tid:
                    local_state.current_task_id = None
                local_task.version = remote_task.version
                local_task.status = TaskStatus.RELEASED
                local_task.owner_id = None
                local_task.best_bid = -1e9
                local_task.best_bidder = None
                local_task.auction_opened_at = current_time
                updates += 1

        if updates > 0:
            self.reconciliations_completed += 1
        return updates
