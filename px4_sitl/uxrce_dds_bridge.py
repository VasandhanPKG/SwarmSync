from __future__ import annotations
from dataclasses import dataclass
import math
from typing import Any, Dict, Tuple
from px4_sitl.collision_avoidance import PX4FailsafeMode, ReciprocalVelocityObstacleAvoidance
from swarmsync.agents.drone import DroneAgent
from swarmsync.sim.tasks import TaskStatus


@dataclass
class OffboardControlModeMsg:
    timestamp_us: int
    position: bool = True
    velocity: bool = True
    acceleration: bool = False
    attitude: bool = False
    body_rate: bool = False


@dataclass
class TrajectorySetpointMsg:
    timestamp_us: int
    position_ned: Tuple[float, float, float]
    velocity_ned: Tuple[float, float, float]
    yaw_rad: float = 0.0


class PX4UXRCEDDSBridge:
    """
    Stage 3 Per-Drone uXRCE-DDS Bridge (`/px4_<id>/fmu/in/*` and `/px4_<id>/fmu/out/*`).
    CRITICAL ARCHITECTURAL RULE:
    Each bridge binds 1-to-1 with a single PX4 SITL instance (`px4_instance_id = agent.id`)
    and translates the agent's local task waypoint into PX4 `OffboardControlMode` (at >= 10Hz
    heartbeat) and `TrajectorySetpoint` messages.
    The uXRCE-DDS agent NEVER allocates tasks or coordinates across vehicles.
    PX4 hardware failsafes always preempt offboard task control.
    """

    def __init__(
        self,
        drone: DroneAgent,
        rvo: ReciprocalVelocityObstacleAvoidance,
        cruise_altitude_m: float = 25.0,
    ) -> None:
        self.drone = drone
        self.instance_id = drone.id
        self.namespace = f"/px4_{self.instance_id}"
        self.rvo = rvo
        self.cruise_altitude_m = cruise_altitude_m

        self.armed: bool = True
        self.failsafe_mode: PX4FailsafeMode = PX4FailsafeMode.NOMINAL_OFFBOARD
        self.last_heartbeat_sent_at: float = 0.0
        self.heartbeat_count: int = 0
        self.current_velocity: Tuple[float, float] = (0.0, 0.0)
        self.last_setpoint: TrajectorySetpointMsg | None = None

    def publish_offboard_heartbeat(self, current_time: float) -> OffboardControlModeMsg:
        self.last_heartbeat_sent_at = current_time
        self.heartbeat_count += 1
        return OffboardControlModeMsg(
            timestamp_us=int(current_time * 1_000_000),
            position=True,
            velocity=True,
        )

    def step_px4_bridge(
        self,
        current_time: float,
        dt: float,
        neighbor_positions: Dict[int, Tuple[float, float]],
        neighbor_velocities: Dict[int, Tuple[float, float]],
    ) -> Dict[str, Any]:
        if not self.drone.alive:
            self.armed = False
            self.current_velocity = (0.0, 0.0)
            return {"instance_id": self.instance_id, "armed": False, "mode": "DISARMED_CRASHED"}

        # 1. Emit 10Hz uXRCE-DDS OffboardControlMode heartbeat
        hb_msg = self.publish_offboard_heartbeat(current_time)

        # 2. Evaluate PX4 onboard failsafe priority (always wins over task logic)
        self.failsafe_mode = self.rvo.evaluate_px4_failsafe(
            battery_pct=self.drone.battery,
            time_since_last_heartbeat=current_time - self.last_heartbeat_sent_at,
        )

        # Determine target waypoint based on PX4 failsafe vs SwarmSync task logic
        active_task = self.drone.current_task
        if self.failsafe_mode == PX4FailsafeMode.AUTO_LAND_CRITICAL:
            target_xy = self.drone.position
            target_z = 0.0
        elif (
            self.failsafe_mode == PX4FailsafeMode.AUTO_RTL_LOW_BATTERY
            or self.drone.returning_for_safety
            or active_task is None
        ):
            target_xy = self.drone.base_position
            target_z = -self.cruise_altitude_m
        else:
            target_xy = active_task.dropoff if active_task.picked_up else active_task.pickup
            target_z = -self.cruise_altitude_m

        # Compute preferred velocity toward target_xy
        dx = target_xy[0] - self.drone.position[0]
        dy = target_xy[1] - self.drone.position[1]
        dist = math.hypot(dx, dy)
        if dist > 1.0:
            spd = min(self.drone.speed, dist / max(dt, 0.05))
            pref_vel = ((dx / dist) * spd, (dy / dist) * spd)
        else:
            pref_vel = (0.0, 0.0)

        # 3. Apply Reciprocal Velocity Obstacle (RVO) local collision avoidance
        safe_vel = self.rvo.compute_safe_velocity(
            own_id=self.drone.id,
            own_pos=self.drone.position,
            preferred_vel=pref_vel,
            neighbor_positions=neighbor_positions,
            neighbor_velocities=neighbor_velocities,
        )
        self.current_velocity = safe_vel

        # Publish TrajectorySetpoint to `/px4_<id>/fmu/in/trajectory_setpoint`
        yaw = math.atan2(safe_vel[1], safe_vel[0]) if math.hypot(*safe_vel) > 0.1 else 0.0
        self.last_setpoint = TrajectorySetpointMsg(
            timestamp_us=hb_msg.timestamp_us,
            position_ned=(target_xy[0], target_xy[1], target_z),
            velocity_ned=(safe_vel[0], safe_vel[1], 0.0),
            yaw_rad=yaw,
        )

        return {
            "instance_id": self.instance_id,
            "namespace": self.namespace,
            "armed": self.armed,
            "failsafe_mode": self.failsafe_mode.value,
            "heartbeats_sent": self.heartbeat_count,
            "velocity": [round(safe_vel[0], 2), round(safe_vel[1], 2)],
        }
