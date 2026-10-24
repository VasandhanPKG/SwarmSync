from __future__ import annotations
from typing import Any, Dict, List


class ObserverDashboardNode:
    """
    Stage 2 Observer-Only Dashboard & RViz Marker Generator.
    CORE DESIGN PRINCIPLE ENFORCEMENT:
    This node is strictly passive (`READ_ONLY_OBSERVER = True`). It subscribes to
    peer forum traffic to compute real-time metrics and RViz MarkerArray visuals,
    and is architecturally prohibited from publishing task assignments, bids, or claims.
    """

    READ_ONLY_OBSERVER: bool = True

    def __init__(self) -> None:
        self.observed_messages: List[Dict[str, Any]] = []
        self.agent_telemetry: Dict[int, Dict[str, Any]] = {}
        self.task_views: Dict[str, Dict[str, Any]] = {}

    def record_forum_packet(self, wire_dict: Dict[str, Any]) -> None:
        self.observed_messages.append(wire_dict)
        sender_id = int(wire_dict["sender_id"])
        self.agent_telemetry[sender_id] = {
            "agent_id": sender_id,
            "position": wire_dict.get("sender_pos", [0.0, 0.0]),
            "alive": wire_dict.get("sender_alive", True),
            "last_seen": wire_dict.get("timestamp", 0.0),
            "last_message_type": wire_dict.get("message_type"),
        }
        tid = wire_dict.get("task_id")
        if tid:
            self.task_views[tid] = {
                "task_id": tid,
                "last_event": wire_dict.get("message_type"),
                "sender_id": sender_id,
                "timestamp": wire_dict.get("timestamp"),
                "payload": wire_dict.get("payload", {}),
            }

    def build_rviz_marker_summary(self) -> Dict[str, Any]:
        return {
            "observer_only": self.READ_ONLY_OBSERVER,
            "total_observed_packets": len(self.observed_messages),
            "agents": list(self.agent_telemetry.values()),
            "tasks": list(self.task_views.values()),
        }
