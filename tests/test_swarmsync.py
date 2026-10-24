from __future__ import annotations
import random
import unittest
from swarmsync.agents.modules import (
    AssignmentManager,
    CommunicationManager,
    LocalStateManager,
    RecoveryManager,
    SafetyMonitor,
)
from swarmsync.baselines.modes import CoordinationMode
from swarmsync.net.messages import ForumMessage, MessageType
from swarmsync.net.network import SimulatedNetwork
from swarmsync.run import load_scenario_config
from swarmsync.sim.tasks import DeliveryTask, TaskStatus
from swarmsync.sim.world import SimulationWorld


class TestSwarmSyncUnit(unittest.TestCase):
    def setUp(self) -> None:
        self.rng = random.Random(42)
        self.net = SimulatedNetwork(self.rng, comm_range=500.0)
        self.net.register_node(1, (100.0, 100.0), True)
        self.net.register_node(2, (200.0, 100.0), True)
        self.net.register_node(3, (300.0, 100.0), True)

    def test_message_deduplication_and_expiry(self) -> None:
        comm1 = CommunicationManager(agent_id=1, network=self.net)
        comm2 = CommunicationManager(agent_id=2, network=self.net)

        msg = comm1.create_and_send(
            MessageType.TASK_ANNOUNCE,
            current_time=10.0,
            task_id="T-01",
            payload={"info": "test"},
            ttl=5.0,
        )
        # Re-broadcast exact same message to simulate gossip duplicate arrival
        self.net.broadcast(3, msg.forwarded_by(3), current_time=10.0)
        self.net.step(10.5)

        received = comm2.receive_valid_messages(current_time=10.5)
        self.assertEqual(len(received), 1)
        self.assertEqual(comm2.deduped_count, 1)

        # Now send a message and advance past its expiry time
        comm1.create_and_send(
            MessageType.BID,
            current_time=10.0,
            task_id="T-01",
            payload={"bid": -0.5},
            ttl=2.0,
        )
        self.net.step(13.0)
        received_late = comm2.receive_valid_messages(current_time=13.0)
        self.assertEqual(len(received_late), 0)
        self.assertEqual(comm2.dropped_expired_count, 1)

    def test_deterministic_conflict_resolution(self) -> None:
        state2 = LocalStateManager(agent_id=2)
        assign2 = AssignmentManager(agent_id=2)
        task = DeliveryTask(
            task_id="T-99",
            pickup=(150.0, 150.0),
            dropoff=(400.0, 400.0),
            payload=1.5,
            spawn_time=0.0,
            deadline=100.0,
        )
        state2.upsert_task(task)
        local_t = state2.known_tasks["T-99"]

        # Agent 2 claims at version 1
        assign2.claim_task_locally(local_t, current_time=5.0, local_state=state2)
        self.assertEqual(local_t.owner_id, 2)
        self.assertEqual(state2.current_task_id, "T-99")

        # Incoming claim at SAME version 1 from Agent 3 (higher ID): Agent 2 must KEEP ownership
        changed, preempted = assign2.resolve_incoming_claim(
            local_t, inc_owner=3, inc_version=1, inc_lease_expiry=13.0, local_state=state2
        )
        self.assertFalse(changed)
        self.assertFalse(preempted)
        self.assertEqual(local_t.owner_id, 2)
        self.assertEqual(state2.current_task_id, "T-99")

        # Incoming claim at SAME version 1 from Agent 1 (lower ID): Agent 1 wins tie-breaker!
        changed, preempted = assign2.resolve_incoming_claim(
            local_t, inc_owner=1, inc_version=1, inc_lease_expiry=13.0, local_state=state2
        )
        self.assertTrue(changed)
        self.assertTrue(preempted)
        self.assertEqual(local_t.owner_id, 1)
        self.assertIsNone(state2.current_task_id)

        # Incoming claim at HIGHER version 2 from Agent 3: higher version wins regardless of agent_id!
        changed, _ = assign2.resolve_incoming_claim(
            local_t, inc_owner=3, inc_version=2, inc_lease_expiry=20.0, local_state=state2
        )
        self.assertTrue(changed)
        self.assertEqual(local_t.owner_id, 3)
        self.assertEqual(local_t.version, 2)

        # Stale version 1 update from Agent 1 must NEVER overwrite version 2
        changed_stale, _ = assign2.resolve_incoming_claim(
            local_t, inc_owner=1, inc_version=1, inc_lease_expiry=25.0, local_state=state2
        )
        self.assertFalse(changed_stale)
        self.assertEqual(local_t.owner_id, 3)
        self.assertEqual(local_t.version, 2)

    def test_lease_expiry_and_grace_period(self) -> None:
        state1 = LocalStateManager(agent_id=1)
        recovery1 = RecoveryManager(agent_id=1, grace_period=3.0, use_leases=True)
        task = DeliveryTask(
            task_id="T-05",
            pickup=(200.0, 200.0),
            dropoff=(350.0, 350.0),
            payload=1.2,
            spawn_time=0.0,
            deadline=90.0,
            status=TaskStatus.CLAIMED,
            owner_id=2,
            version=1,
            lease_expiry=10.0,
        )
        state1.upsert_task(task)

        # At t=11.5 (past lease_expiry=10.0, but within grace_period=3.0): must NOT release yet
        released_early = recovery1.check_expired_leases(state1, current_time=11.5)
        self.assertEqual(len(released_early), 0)
        self.assertEqual(state1.known_tasks["T-05"].status, TaskStatus.CLAIMED)

        # At t=13.5 (past lease_expiry + grace_period = 13.0): MUST release and bump version to 2
        released_now = recovery1.check_expired_leases(state1, current_time=13.5)
        self.assertEqual(len(released_now), 1)
        self.assertEqual(state1.known_tasks["T-05"].status, TaskStatus.RELEASED)
        self.assertEqual(state1.known_tasks["T-05"].version, 2)
        self.assertIsNone(state1.known_tasks["T-05"].owner_id)

    def test_partition_reconciliation_convergence(self) -> None:
        state_west = LocalStateManager(agent_id=1)
        state_east = LocalStateManager(agent_id=2)
        assign_west = AssignmentManager(agent_id=1)
        recovery_west = RecoveryManager(agent_id=1)

        # Task T-01 completed in East partition while West still thinks it is ANNOUNCED
        t1_west = DeliveryTask("T-01", (100, 100), (200, 200), 1.0, 0.0, 80.0, status=TaskStatus.ANNOUNCED, version=1)
        t1_east = DeliveryTask(
            "T-01", (100, 100), (200, 200), 1.0, 0.0, 80.0,
            status=TaskStatus.COMPLETED, owner_id=2, version=2, completed_at=34.0, completed_by=2
        )
        # Task T-02 discovered only in East partition
        t2_east = DeliveryTask(
            "T-02", (700, 700), (800, 800), 1.5, 15.0, 95.0,
            status=TaskStatus.CLAIMED, owner_id=2, version=1, lease_expiry=50.0
        )
        state_west.upsert_task(t1_west)
        state_east.upsert_task(t1_east)
        state_east.upsert_task(t2_east)

        east_digest = state_east.build_reconciliation_digest()
        updates = recovery_west.reconcile_digest(state_west, assign_west, east_digest, current_time=45.0)
        self.assertEqual(updates, 2)
        self.assertEqual(state_west.known_tasks["T-01"].status, TaskStatus.COMPLETED)
        self.assertEqual(state_west.known_tasks["T-01"].completed_by, 2)
        self.assertIn("T-02", state_west.known_tasks)
        self.assertEqual(state_west.known_tasks["T-02"].owner_id, 2)

    def test_safety_monitor_hard_constraints(self) -> None:
        safety = SafetyMonitor(max_payload=3.5, battery_reserve=15.0)
        heavy_task = DeliveryTask("T-H", (500, 500), (600, 600), payload=4.2, spawn_time=0.0, deadline=100.0)
        ok, reason = safety.can_undertake_task((500, 500), battery=100.0, task=heavy_task, current_time=0.0)
        self.assertFalse(ok)
        self.assertEqual(reason, "payload_exceeded")

        normal_task = DeliveryTask("T-N", (100, 100), (900, 900), payload=2.0, spawn_time=0.0, deadline=100.0)
        ok_low_bat, reason_bat = safety.can_undertake_task((500, 500), battery=22.0, task=normal_task, current_time=0.0)
        self.assertFalse(ok_low_bat)
        self.assertEqual(reason_bat, "insufficient_battery_reserve")

    def test_stage1_definition_of_done(self) -> None:
        # 1. Nominal scenario: zero duplicate committed owners & lower messages than periodic broadcast
        cfg_norm = load_scenario_config("normal")
        res_swarm = SimulationWorld(cfg_norm, CoordinationMode.SWARMSYNC, seed=1).run_to_completion()
        res_basic = SimulationWorld(cfg_norm, CoordinationMode.BASIC_AUCTION, seed=1).run_to_completion()
        self.assertEqual(res_swarm.duplicate_assignment_rate, 0.0)
        self.assertEqual(res_swarm.delivery_success_rate, 1.0)
        self.assertLess(res_swarm.messages_per_delivery, res_basic.messages_per_delivery)

        # 2. Drone failure scenario: failed drones' tasks are reassigned and completed
        cfg_fail = load_scenario_config("drone_failure")
        res_fail_swarm = SimulationWorld(cfg_fail, CoordinationMode.SWARMSYNC, seed=1).run_to_completion()
        res_fail_basic = SimulationWorld(cfg_fail, CoordinationMode.BASIC_AUCTION, seed=1).run_to_completion()
        self.assertGreater(res_fail_swarm.delivery_success_rate, res_fail_basic.delivery_success_rate)
        self.assertGreaterEqual(res_fail_swarm.delivery_success_rate, 0.90)

        # 3. Central-hub failure scenario: SwarmSync outperforms centralized baseline when hub fails
        cfg_hub = load_scenario_config("hub_failure")
        res_hub_swarm = SimulationWorld(cfg_hub, CoordinationMode.SWARMSYNC, seed=1).run_to_completion()
        res_hub_cent = SimulationWorld(cfg_hub, CoordinationMode.CENTRALIZED, seed=1).run_to_completion()
        self.assertGreater(res_hub_swarm.delivery_success_rate, res_hub_cent.delivery_success_rate)

    def test_stage2_ros2_node_and_impairment_layer(self) -> None:
        import sys
        from pathlib import Path
        ros_pkg_dir = str(Path("ros2_ws/src/swarmsync_ros2").resolve())
        if ros_pkg_dir not in sys.path:
            sys.path.insert(0, ros_pkg_dir)
        from swarmsync_ros2.drone_node import SwarmSyncDroneNode
        from swarmsync_ros2.impairment_relay import Ros2NetworkImpairmentLayer
        from swarmsync_ros2.observer_dashboard_node import ObserverDashboardNode

        n1 = SwarmSyncDroneNode(agent_id=1, initial_x=400.0, initial_y=500.0)
        n2 = SwarmSyncDroneNode(agent_id=2, initial_x=460.0, initial_y=500.0)
        relay = Ros2NetworkImpairmentLayer(seed=7, comm_range=500.0, packet_loss_prob=0.0, min_delay=0.0, max_delay=0.0)
        observer = ObserverDashboardNode()
        self.assertTrue(observer.READ_ONLY_OBSERVER)

        # Hook n1 and n2 TX to relay
        n1.ros_net.tx_callback = lambda wd: (relay.on_agent_tx(wd, 1.0), observer.record_forum_packet(wd))
        n2.ros_net.tx_callback = lambda wd: (relay.on_agent_tx(wd, 1.0), observer.record_forum_packet(wd))
        relay.agent_positions[1] = (400.0, 500.0)
        relay.agent_positions[2] = (460.0, 500.0)

        t = DeliveryTask("T-R2", (410.0, 500.0), (650.0, 500.0), 1.0, 0.0, 120.0)
        n1.drone.receive_direct_task_from_source(t, current_time=1.0)
        delivered = relay.flush_due_packets(1.1, lambda aid, wd: (n1 if aid == 1 else n2).ros_net.enqueue_from_ros2(wd))
        self.assertGreaterEqual(delivered, 1)
        n2._on_timer_tick()
        self.assertIn("T-R2", n2.drone.local_state.known_tasks)

    def test_stage3_px4_sitl_rvo_and_kill_rebid(self) -> None:
        from px4_sitl.collision_avoidance import PX4FailsafeMode, ReciprocalVelocityObstacleAvoidance
        from px4_sitl.demo_kill_rebid import run_stage3_px4_kill_rebid_demo

        rvo = ReciprocalVelocityObstacleAvoidance(safety_radius=25.0, avoidance_horizon=50.0)
        # Verify PX4 failsafe always overrides task logic on low/critical battery or heartbeat loss
        self.assertEqual(rvo.evaluate_px4_failsafe(battery_pct=6.0, time_since_last_heartbeat=0.1), PX4FailsafeMode.AUTO_LAND_CRITICAL)
        self.assertEqual(rvo.evaluate_px4_failsafe(battery_pct=14.0, time_since_last_heartbeat=0.1), PX4FailsafeMode.AUTO_RTL_LOW_BATTERY)
        self.assertEqual(rvo.evaluate_px4_failsafe(battery_pct=90.0, time_since_last_heartbeat=0.8), PX4FailsafeMode.POSCTL_HEARTBEAT_LOST)

        # Verify 3-drone and 5-drone PX4 mid-delivery kill & re-bid demo
        demo_3 = run_stage3_px4_kill_rebid_demo(fleet_size=3, seed=1)
        self.assertIsNotNone(demo_3["killed_drone_id"])
        self.assertTrue(demo_3["orphaned_task_completed"])
        self.assertGreaterEqual(demo_3["orphaned_task_final_version"], 2)


if __name__ == "__main__":
    unittest.main()
