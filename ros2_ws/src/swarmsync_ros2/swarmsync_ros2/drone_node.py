from __future__ import annotations
import json
import random
from typing import Any, Dict, List
from swarmsync.agents.drone import DroneAgent
from swarmsync.net.messages import ForumMessage, MessageType
from swarmsync.net.network import SimulatedNetwork

try:
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
    from std_msgs.msg import String
    HAS_RCLPY = True
except ImportError:
    HAS_RCLPY = False
    Node = object  # type: ignore


class Ros2AdapterNetwork(SimulatedNetwork):
    """
    Adapts the Stage 1 `SimulatedNetwork` interface so `DroneAgent` and its 6 modules
    (`LocalStateManager`, `CommunicationManager`, `TaskNegotiationEngine`,
    `AssignmentManager`, `RecoveryManager`, `SafetyMonitor`) run completely unchanged
    inside a ROS 2 Node!
    Outgoing messages are published to `/swarmsync/tx/agent_<id>` and delivered
    via the peer-to-peer DDS impairment fabric to `/swarmsync/rx/agent_<id>`.
    """

    def __init__(self, agent_id: int, tx_callback: Any) -> None:
        super().__init__(rng=random.Random(agent_id), comm_range=550.0)
        self.agent_id = agent_id
        self.tx_callback = tx_callback

    def broadcast(self, sender_id: int, message: ForumMessage, current_time: float) -> int:
        self.total_messages_sent += 1
        self.total_bytes_sent += message.byte_size
        wire_dict = {
            "message_id": message.message_id,
            "sender_id": message.sender_id,
            "origin_id": message.origin_id if message.origin_id is not None else message.sender_id,
            "message_type": message.message_type.value,
            "logical_channel": message.channel.value,
            "task_id": message.task_id or "",
            "sequence_number": message.sequence_number,
            "timestamp": message.timestamp,
            "expiry_time": message.expiry_time,
            "hop_count": message.hop_count,
            "max_hops": message.max_hops,
            "payload": message.payload,
        }
        self.tx_callback(wire_dict)
        return 1

    def enqueue_from_ros2(self, wire_dict: Dict[str, Any]) -> None:
        msg = ForumMessage(
            message_id=str(wire_dict["message_id"]),
            sender_id=int(wire_dict["sender_id"]),
            origin_id=int(wire_dict.get("origin_id", wire_dict["sender_id"])),
            message_type=MessageType(wire_dict["message_type"]),
            task_id=str(wire_dict["task_id"]) if wire_dict.get("task_id") else None,
            sequence_number=int(wire_dict["sequence_number"]),
            timestamp=float(wire_dict["timestamp"]),
            expiry_time=float(wire_dict["expiry_time"]),
            payload=dict(wire_dict.get("payload", {})),
            hop_count=int(wire_dict.get("hop_count", 0)),
            max_hops=int(wire_dict.get("max_hops", 3)),
        )
        self._inbox.setdefault(self.agent_id, []).append(msg)
        self.total_packets_delivered += 1


class SwarmSyncDroneNode(Node):  # type: ignore[misc]
    """
    One ROS 2 node per autonomous drone agent (`/swarmsync_drone_<id>`).
    Reuses the exact Stage 1 `DroneAgent` decision modules with zero central broker.
    """

    def __init__(self, agent_id: int = 1, initial_x: float = 400.0, initial_y: float = 500.0) -> None:
        if HAS_RCLPY:
            super().__init__(f"swarmsync_drone_{agent_id}")
        self.agent_id = agent_id
        self.sim_time: float = 0.0
        self.dt: float = 0.1

        self.ros_net = Ros2AdapterNetwork(agent_id, self._publish_forum_packet)
        self.ros_net.register_node(agent_id, (initial_x, initial_y), alive=True)

        self.drone = DroneAgent(
            agent_id=agent_id,
            initial_position=(initial_x, initial_y),
            network=self.ros_net,
            use_leases=True,
            periodic_broadcast=False,
        )

        if HAS_RCLPY:
            qos = QoSProfile(
                reliability=ReliabilityPolicy.BEST_EFFORT,
                durability=DurabilityPolicy.VOLATILE,
                history=HistoryPolicy.KEEP_LAST,
                depth=50,
            )
            self.pub_tx = self.create_publisher(
                String, f"/swarmsync/forum/tx/drone_{agent_id}", qos
            )
            self.sub_rx = self.create_subscription(
                String,
                f"/swarmsync/forum/rx/drone_{agent_id}",
                self._on_rx_msg,
                qos,
            )
            self.timer = self.create_timer(self.dt, self._on_timer_tick)

    def _publish_forum_packet(self, wire_dict: Dict[str, Any]) -> None:
        wire_dict["sender_pos"] = list(self.drone.position)
        wire_dict["sender_alive"] = self.drone.alive
        if HAS_RCLPY and hasattr(self, "pub_tx"):
            msg = String()
            msg.data = json.dumps(wire_dict)
            self.pub_tx.publish(msg)

    def _on_rx_msg(self, msg: Any) -> None:
        data = json.loads(msg.data)
        self.ros_net.enqueue_from_ros2(data)

    def _on_timer_tick(self) -> None:
        self.sim_time = round(self.sim_time + self.dt, 3)
        self.drone.step(self.sim_time, self.dt)
