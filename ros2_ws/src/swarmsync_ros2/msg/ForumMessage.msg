# Typed ROS 2 Message for the SwarmSync Peer-to-Peer Communication Forum
# No central broker: published and subscribed peer-to-peer over DDS logical channels.

string message_id
int32 sender_id
int32 origin_id
string message_type          # TASK_ANNOUNCE, BID, CLAIM, RENEW, DONE, HAZARD, HEARTBEAT, RECOVERY_REQUEST
string logical_channel       # task_coordination, resource_sharing, route_hazard, recovery_reconciliation
string task_id
uint64 sequence_number
float64 timestamp
float64 expiry_time
uint8 hop_count
uint8 max_hops
string payload_json          # Deterministic JSON-serialized payload dictionary
