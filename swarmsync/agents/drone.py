from __future__ import annotations
import math
from typing import Dict, List, Optional, Tuple
from swarmsync.agents.modules import (
    AssignmentManager,
    CommunicationManager,
    HazardZone,
    LocalStateManager,
    RecoveryManager,
    SafetyMonitor,
    TaskNegotiationEngine,
)
from swarmsync.net.messages import ForumMessage, MessageType
from swarmsync.net.network import SimulatedNetwork
from swarmsync.sim.tasks import DeliveryTask, TaskStatus


class DroneAgent:
    """
    Autonomous peer-to-peer delivery drone agent.
    Uses ONLY its local view (`LocalStateManager`) and peer forum messages
    (`CommunicationManager`) to bid on, claim, execute, renew, and recover tasks.
    """

    def __init__(
        self,
        agent_id: int,
        initial_position: Tuple[float, float],
        network: SimulatedNetwork,
        base_position: Tuple[float, float] = (500.0, 500.0),
        max_payload: float = 3.5,
        speed: float = 22.0,
        periodic_broadcast: bool = False,
        use_leases: bool = True,
        w_t: float = 0.50,
        w_e: float = 0.30,
        w_r: float = 0.20,
    ) -> None:
        self.id = agent_id
        self.position: Tuple[float, float] = initial_position
        self.base_position = base_position
        self.battery: float = 100.0
        self.payload_capacity: float = max_payload
        self.speed: float = speed
        self.alive: bool = True
        self.returning_for_safety: bool = False
        self.energy_consumed_total: float = 0.0

        # 6 Mandatory Agent Modules
        self.local_state = LocalStateManager(agent_id, base_position)
        self.comm = CommunicationManager(
            agent_id=agent_id,
            network=network,
            periodic_broadcast=periodic_broadcast,
        )
        self.safety = SafetyMonitor(
            max_payload=max_payload,
            battery_reserve=15.0,
            energy_per_meter=0.016,
            drone_speed=speed,
            base_pos=base_position,
        )
        self.negotiation = TaskNegotiationEngine(
            agent_id=agent_id,
            safety_monitor=self.safety,
            w_t=w_t,
            w_e=w_e,
            w_r=w_r,
        )
        self.assignment = AssignmentManager(
            agent_id=agent_id,
            lease_duration=8.0,
            renew_interval=2.5,
            auction_window=1.6,
            use_leases=use_leases,
        )
        self.recovery = RecoveryManager(
            agent_id=agent_id,
            grace_period=3.0,
            heartbeat_timeout=6.0,
            use_leases=use_leases,
        )

        self._last_heartbeat_at: float = -999.0
        self._last_periodic_sync_at: float = -999.0
        self._last_battery_alert_band: int = 10

    @property
    def current_task(self) -> Optional[DeliveryTask]:
        tid = self.local_state.current_task_id
        if tid is None:
            return None
        return self.local_state.known_tasks.get(tid)

    def receive_direct_task_from_source(self, task: DeliveryTask, current_time: float) -> None:
        """Called by TaskSource when this drone is the nearest reachable agent to a new task."""
        if not self.alive:
            return
        task.auction_opened_at = current_time
        is_new = self.local_state.upsert_task(task)
        if is_new:
            # Event-triggered announcement to peer forum
            self.comm.create_and_send(
                MessageType.TASK_ANNOUNCE,
                current_time=current_time,
                task_id=task.task_id,
                payload={"task": task.to_dict()},
            )
            self._evaluate_and_bid_on_task(self.local_state.known_tasks[task.task_id], current_time)

    def _evaluate_and_bid_on_task(self, task: DeliveryTask, current_time: float) -> None:
        if not self.alive or self.returning_for_safety:
            return
        if self.local_state.current_task_id is not None:
            return
        if task.status not in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED):
            return

        # Single-slot commitment rule: if already winning another open auction, only switch if strictly better
        other_winning: Optional[DeliveryTask] = None
        for ot in self.local_state.known_tasks.values():
            if (
                ot.task_id != task.task_id
                and ot.status in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED)
                and ot.best_bidder == self.id
            ):
                other_winning = ot
                break

        my_bid = self.negotiation.compute_bid(
            self.position, self.battery, task, current_time, self.local_state.hazards
        )
        if my_bid is None:
            return

        if other_winning is not None and my_bid <= other_winning.best_bid + 0.02:
            return

        if self.negotiation.is_better_bid(my_bid, self.id, task.best_bid, task.best_bidder):
            if other_winning is not None:
                other_winning.best_bid = -1e9
                other_winning.best_bidder = None
            task.best_bid = my_bid
            task.best_bidder = self.id
            task.status = TaskStatus.BIDDING
            if task.auction_opened_at <= 0.0:
                task.auction_opened_at = current_time
            # Event-triggered BID broadcast only when improving current known best bid
            self.comm.create_and_send(
                MessageType.BID,
                current_time=current_time,
                task_id=task.task_id,
                payload={
                    "bid": my_bid,
                    "bidder_id": self.id,
                    "version": task.version,
                    "task": task.to_dict(),
                },
            )

    def _process_inbox(self, current_time: float) -> None:
        messages = self.comm.receive_valid_messages(current_time)
        for msg in messages:
            mtype = msg.message_type
            should_gossip = False

            if mtype == MessageType.HEARTBEAT:
                pos_list = msg.payload.get("position", [0.0, 0.0])
                self.local_state.record_heartbeat(
                    msg.origin_id or msg.sender_id,
                    msg.timestamp,
                    (float(pos_list[0]), float(pos_list[1])),
                    msg.payload.get("current_task"),
                )

            elif mtype == MessageType.HAZARD:
                hz_data = msg.payload.get("hazard")
                if hz_data:
                    hz = HazardZone(
                        hazard_id=str(hz_data["hazard_id"]),
                        center=(float(hz_data["center"][0]), float(hz_data["center"][1])),
                        radius=float(hz_data["radius"]),
                        severity=float(hz_data["severity"]),
                        reported_at=msg.timestamp,
                    )
                    if self.local_state.record_hazard(hz):
                        should_gossip = True

            elif mtype == MessageType.TASK_ANNOUNCE:
                tdata = msg.payload.get("task")
                if tdata:
                    inc_task = DeliveryTask.from_dict(tdata)
                    if self.local_state.upsert_task(inc_task):
                        local_t = self.local_state.known_tasks[inc_task.task_id]
                        local_t.auction_opened_at = current_time
                        should_gossip = True
                        self._evaluate_and_bid_on_task(local_t, current_time)
                    else:
                        local_t = self.local_state.known_tasks[inc_task.task_id]
                        if inc_task.version > local_t.version and inc_task.status == TaskStatus.RELEASED:
                            if self.local_state.current_task_id == local_t.task_id:
                                self.local_state.current_task_id = None
                            local_t.version = inc_task.version
                            local_t.status = TaskStatus.RELEASED
                            local_t.owner_id = None
                            local_t.best_bid = -1e9
                            local_t.best_bidder = None
                            local_t.auction_opened_at = current_time
                            should_gossip = True
                            self._evaluate_and_bid_on_task(local_t, current_time)

            elif mtype == MessageType.BID:
                tdata = msg.payload.get("task")
                if tdata:
                    self.local_state.upsert_task(DeliveryTask.from_dict(tdata))
                tid = msg.task_id
                if tid and tid in self.local_state.known_tasks:
                    local_t = self.local_state.known_tasks[tid]
                    inc_ver = int(msg.payload.get("version", 1))
                    inc_bid = float(msg.payload.get("bid", -1e9))
                    inc_bidder = int(msg.payload.get("bidder_id", msg.sender_id))
                    if inc_ver >= local_t.version and local_t.status in (
                        TaskStatus.ANNOUNCED,
                        TaskStatus.BIDDING,
                        TaskStatus.RELEASED,
                    ):
                        if inc_ver > local_t.version:
                            local_t.version = inc_ver
                            local_t.owner_id = None
                            local_t.best_bid = -1e9
                            local_t.best_bidder = None
                        if self.negotiation.is_better_bid(
                            inc_bid, inc_bidder, local_t.best_bid, local_t.best_bidder
                        ):
                            local_t.best_bid = inc_bid
                            local_t.best_bidder = inc_bidder
                            local_t.status = TaskStatus.BIDDING
                            should_gossip = True
                        self._evaluate_and_bid_on_task(local_t, current_time)

            elif mtype in (MessageType.CLAIM, MessageType.RENEW):
                tdata = msg.payload.get("task")
                if tdata:
                    self.local_state.upsert_task(DeliveryTask.from_dict(tdata))
                tid = msg.task_id
                if tid and tid in self.local_state.known_tasks:
                    local_t = self.local_state.known_tasks[tid]
                    inc_owner = int(msg.payload.get("owner_id", msg.sender_id))
                    inc_ver = int(msg.payload.get("version", 1))
                    inc_expiry = float(msg.payload.get("lease_expiry", current_time + 8.0))
                    changed, _ = self.assignment.resolve_incoming_claim(
                        local_t, inc_owner, inc_ver, inc_expiry, self.local_state
                    )
                    if bool(msg.payload.get("picked_up", False)):
                        local_t.picked_up = True
                    # Clear any unconfirmed bids held by inc_owner on other open tasks
                    for ot in self.local_state.known_tasks.values():
                        if (
                            ot.task_id != tid
                            and ot.status in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED)
                            and ot.best_bidder == inc_owner
                        ):
                            ot.best_bidder = None
                            ot.best_bid = -1e9
                            ot.auction_opened_at = current_time
                    if changed:
                        should_gossip = True

            elif mtype == MessageType.DONE:
                tdata = msg.payload.get("task")
                if tdata:
                    self.local_state.upsert_task(DeliveryTask.from_dict(tdata))
                tid = msg.task_id
                if tid and tid in self.local_state.known_tasks:
                    local_t = self.local_state.known_tasks[tid]
                    if local_t.status != TaskStatus.COMPLETED:
                        if self.local_state.current_task_id == tid:
                            self.local_state.current_task_id = None
                        local_t.status = TaskStatus.COMPLETED
                        local_t.completed_at = float(msg.payload.get("completed_at", current_time))
                        local_t.completed_by = int(msg.payload.get("completed_by", msg.sender_id))
                        local_t.owner_id = local_t.completed_by
                        local_t.version = max(local_t.version, int(msg.payload.get("version", 1)))
                        should_gossip = True

            elif mtype == MessageType.RECOVERY_REQUEST:
                digest = msg.payload.get("digest", {})
                if isinstance(digest, dict):
                    updates = self.recovery.reconcile_digest(
                        self.local_state, self.assignment, digest, current_time
                    )
                    # If caller explicitly asked for a reply or we updated state, reply once
                    if msg.payload.get("is_request", False):
                        self.comm.create_and_send(
                            MessageType.RECOVERY_REQUEST,
                            current_time=current_time,
                            payload={
                                "digest": self.local_state.build_reconciliation_digest(),
                                "is_request": False,
                            },
                        )
                    if updates > 0:
                        for t in self.local_state.known_tasks.values():
                            if t.status in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED):
                                self._evaluate_and_bid_on_task(t, current_time)

            if should_gossip and not self.comm.periodic_broadcast:
                self.comm.gossip_forward(msg, current_time)

    def step(self, current_time: float, dt: float) -> None:
        if not self.alive:
            return

        # 1. Detect link changes (partition heal or neighbor entering range)
        added_peers, _ = self.comm.network.detect_link_changes(self.id)
        if added_peers and self.local_state.known_tasks:
            self.comm.create_and_send(
                MessageType.RECOVERY_REQUEST,
                current_time=current_time,
                payload={
                    "digest": self.local_state.build_reconciliation_digest(),
                    "is_request": True,
                },
            )

        # 2. Receive and process peer forum messages
        self._process_inbox(current_time)

        # 3. Check expired leases and release tasks after conservative grace period
        released_tasks = self.recovery.check_expired_leases(self.local_state, current_time)
        for rtask in released_tasks:
            self.comm.create_and_send(
                MessageType.TASK_ANNOUNCE,
                current_time=current_time,
                task_id=rtask.task_id,
                payload={"task": rtask.to_dict(), "released": True},
            )
            self._evaluate_and_bid_on_task(rtask, current_time)

        # 4. Evaluate open auctions and claim if this drone won the auction window
        if self.local_state.current_task_id is None and not self.returning_for_safety:
            for task in self.local_state.known_tasks.values():
                if task.status in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING, TaskStatus.RELEASED):
                    # Expire stale unconfirmed bids if previous bidder took another task
                    if (
                        task.best_bidder is not None
                        and task.best_bidder != self.id
                        and current_time - task.auction_opened_at > self.assignment.auction_window * 2.2
                    ):
                        task.best_bidder = None
                        task.best_bid = -1e9
                        task.auction_opened_at = current_time

                    if task.best_bidder is None:
                        self._evaluate_and_bid_on_task(task, current_time)
                    if (
                        task.best_bidder == self.id
                        and current_time - task.auction_opened_at >= self.assignment.auction_window
                    ):
                        # Re-verify safety before committing claim
                        can_do, _ = self.safety.can_undertake_task(
                            self.position, self.battery, task, current_time
                        )
                        if can_do:
                            self.assignment.claim_task_locally(task, current_time, self.local_state)
                            self.comm.create_and_send(
                                MessageType.CLAIM,
                                current_time=current_time,
                                task_id=task.task_id,
                                payload={
                                    "owner_id": self.id,
                                    "version": task.version,
                                    "lease_expiry": task.lease_expiry,
                                    "picked_up": task.picked_up,
                                    "task": task.to_dict(),
                                },
                            )
                            break
                        else:
                            task.best_bidder = None
                            task.best_bid = -1e9

        # 5. SafetyMonitor check on active task (hard constraint; overrides negotiation)
        active = self.current_task
        if self.safety.requires_emergency_abort(self.position, self.battery, active):
            self.returning_for_safety = True
            if active is not None:
                active.status = TaskStatus.RELEASED
                active.version += 1
                active.owner_id = None
                active.best_bid = -1e9
                active.best_bidder = None
                active.auction_opened_at = current_time
                self.local_state.current_task_id = None
                self.comm.create_and_send(
                    MessageType.TASK_ANNOUNCE,
                    current_time=current_time,
                    task_id=active.task_id,
                    payload={"task": active.to_dict(), "released": True},
                )

        # 6. Lease renewal if owning an active task
        active = self.current_task
        if (
            active is not None
            and self.assignment.use_leases
            and current_time - self.assignment.last_renew_sent_at >= self.assignment.renew_interval
        ):
            active.lease_expiry = current_time + self.assignment.lease_duration
            self.assignment.last_renew_sent_at = current_time
            self.comm.create_and_send(
                MessageType.RENEW,
                current_time=current_time,
                task_id=active.task_id,
                payload={
                    "owner_id": self.id,
                    "version": active.version,
                    "lease_expiry": active.lease_expiry,
                    "picked_up": active.picked_up,
                    "task": active.to_dict(),
                },
            )

        # 7. Physical kinematics and battery consumption
        self._step_kinematics(current_time, dt)

        # 8. Event-triggered battery threshold alert vs Periodic Broadcast baseline
        current_band = int(self.battery // 10)
        if current_band < self._last_battery_alert_band:
            self._last_battery_alert_band = current_band
            self.comm.create_and_send(
                MessageType.HEARTBEAT,
                current_time=current_time,
                payload={
                    "position": list(self.position),
                    "battery": round(self.battery, 2),
                    "current_task": self.local_state.current_task_id,
                },
                ttl=6.0,
            )
            self._last_heartbeat_at = current_time

        if self.comm.periodic_broadcast and current_time - self._last_periodic_sync_at >= 1.0:
            self._last_periodic_sync_at = current_time
            self.comm.create_and_send(
                MessageType.HEARTBEAT,
                current_time=current_time,
                payload={
                    "position": list(self.position),
                    "battery": round(self.battery, 2),
                    "current_task": self.local_state.current_task_id,
                },
                ttl=4.0,
            )
            for t in self.local_state.known_tasks.values():
                if t.status in (TaskStatus.ANNOUNCED, TaskStatus.BIDDING):
                    self.comm.create_and_send(
                        MessageType.TASK_ANNOUNCE,
                        current_time=current_time,
                        task_id=t.task_id,
                        payload={"task": t.to_dict()},
                        ttl=4.0,
                    )

    def _step_kinematics(self, current_time: float, dt: float) -> None:
        active = self.current_task
        if self.returning_for_safety or active is None:
            # Move toward base station and recharge when at base
            dx = self.base_position[0] - self.position[0]
            dy = self.base_position[1] - self.position[1]
            dist = math.hypot(dx, dy)
            if dist <= 6.0:
                self.battery = min(100.0, self.battery + 14.0 * dt)
                if self.battery >= 85.0:
                    self.returning_for_safety = False
                    self._last_battery_alert_band = int(self.battery // 10)
            else:
                step_d = min(dist, self.speed * dt)
                self.position = (
                    self.position[0] + (dx / dist) * step_d,
                    self.position[1] + (dy / dist) * step_d,
                )
                drain = step_d * self.safety.energy_per_meter
                self.battery = max(0.0, self.battery - drain)
                self.energy_consumed_total += drain
            return

        target = active.dropoff if active.picked_up else active.pickup
        dx = target[0] - self.position[0]
        dy = target[1] - self.position[1]
        dist = math.hypot(dx, dy)
        step_d = min(dist, self.speed * dt)
        if dist > 1e-6:
            self.position = (
                self.position[0] + (dx / dist) * step_d,
                self.position[1] + (dy / dist) * step_d,
            )
        payload_factor = (
            1.0 + 0.30 * (active.payload / max(self.payload_capacity, 0.1))
            if active.picked_up
            else 1.0
        )
        drain = step_d * self.safety.energy_per_meter * payload_factor
        self.battery = max(0.0, self.battery - drain)
        self.energy_consumed_total += drain
        if self.battery <= 0.0:
            self.safety.safety_violations += 1
            self.alive = False
            return

        if dist - step_d <= 5.0:
            if not active.picked_up:
                active.picked_up = True
                active.status = TaskStatus.IN_PROGRESS
            else:
                active.status = TaskStatus.COMPLETED
                active.completed_at = current_time
                active.completed_by = self.id
                self.local_state.current_task_id = None
                self.comm.create_and_send(
                    MessageType.DONE,
                    current_time=current_time,
                    task_id=active.task_id,
                    payload={
                        "completed_at": current_time,
                        "completed_by": self.id,
                        "version": active.version,
                        "task": active.to_dict(),
                    },
                )
