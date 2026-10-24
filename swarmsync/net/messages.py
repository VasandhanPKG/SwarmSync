from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional
import json


class MessageType(str, Enum):
    TASK_ANNOUNCE = "TASK_ANNOUNCE"
    BID = "BID"
    CLAIM = "CLAIM"
    RENEW = "RENEW"
    DONE = "DONE"
    HAZARD = "HAZARD"
    HEARTBEAT = "HEARTBEAT"
    RECOVERY_REQUEST = "RECOVERY_REQUEST"


class LogicalChannel(str, Enum):
    TASK_COORDINATION = "task_coordination"
    RESOURCE_SHARING = "resource_sharing"
    ROUTE_HAZARD = "route_hazard"
    RECOVERY_RECONCILIATION = "recovery_reconciliation"


CHANNEL_BY_TYPE: Dict[MessageType, LogicalChannel] = {
    MessageType.TASK_ANNOUNCE: LogicalChannel.TASK_COORDINATION,
    MessageType.BID: LogicalChannel.TASK_COORDINATION,
    MessageType.CLAIM: LogicalChannel.TASK_COORDINATION,
    MessageType.RENEW: LogicalChannel.TASK_COORDINATION,
    MessageType.DONE: LogicalChannel.TASK_COORDINATION,
    MessageType.HEARTBEAT: LogicalChannel.RESOURCE_SHARING,
    MessageType.HAZARD: LogicalChannel.ROUTE_HAZARD,
    MessageType.RECOVERY_REQUEST: LogicalChannel.RECOVERY_RECONCILIATION,
}


@dataclass(frozen=True)
class ForumMessage:
    message_id: str
    sender_id: int
    message_type: MessageType
    task_id: Optional[str]
    sequence_number: int
    timestamp: float
    expiry_time: float
    payload: Dict[str, Any] = field(default_factory=dict)
    hop_count: int = 0
    max_hops: int = 3
    origin_id: Optional[int] = None

    @property
    def channel(self) -> LogicalChannel:
        return CHANNEL_BY_TYPE.get(self.message_type, LogicalChannel.TASK_COORDINATION)

    @property
    def byte_size(self) -> int:
        # Realistic wire-size calculation (header + JSON payload bytes)
        raw = json.dumps(self.payload, separators=(",", ":"), sort_keys=True)
        return 48 + len(self.message_id) + len(self.message_type.value) + len(raw)

    def forwarded_by(self, forwarder_id: int) -> ForumMessage:
        return ForumMessage(
            message_id=self.message_id,
            sender_id=forwarder_id,
            message_type=self.message_type,
            task_id=self.task_id,
            sequence_number=self.sequence_number,
            timestamp=self.timestamp,
            expiry_time=self.expiry_time,
            payload=dict(self.payload),
            hop_count=self.hop_count + 1,
            max_hops=self.max_hops,
            origin_id=self.origin_id if self.origin_id is not None else self.sender_id,
        )
