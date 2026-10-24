from __future__ import annotations
from enum import Enum
import math
from typing import Dict, Tuple


class PX4FailsafeMode(str, Enum):
    NOMINAL_OFFBOARD = "NOMINAL_OFFBOARD"
    AUTO_RTL_LOW_BATTERY = "AUTO_RTL_LOW_BATTERY"
    AUTO_LAND_CRITICAL = "AUTO_LAND_CRITICAL"
    POSCTL_HEARTBEAT_LOST = "POSCTL_HEARTBEAT_LOST"


class ReciprocalVelocityObstacleAvoidance:
    """
    Stage 3 Local Collision Avoidance (Reciprocal Velocity Obstacles / RVO)
    with strict PX4 hardware failsafe priority.
    - Computes collision-free velocity vector V_safe from desired task velocity V_pref
      given neighboring drone positions and velocities within safety_radius.
    - PX4 failsafes (RTL on low battery, Land on critical battery, Hold on offboard
      heartbeat loss) ALWAYS override task setpoints.
    """

    def __init__(
        self,
        safety_radius: float = 28.0,
        avoidance_horizon: float = 55.0,
        max_speed: float = 28.0,
        rtl_battery_pct: float = 16.0,
        crit_battery_pct: float = 8.0,
    ) -> None:
        self.safety_radius = safety_radius
        self.avoidance_horizon = avoidance_horizon
        self.max_speed = max_speed
        self.rtl_battery_pct = rtl_battery_pct
        self.crit_battery_pct = crit_battery_pct
        self.avoidance_maneuvers: int = 0
        self.min_observed_separation: float = 9999.0

    def evaluate_px4_failsafe(
        self,
        battery_pct: float,
        time_since_last_heartbeat: float,
    ) -> PX4FailsafeMode:
        """
        PX4 internal state machine failsafe check.
        Always preempts task-level offboard setpoints.
        """
        if battery_pct <= self.crit_battery_pct:
            return PX4FailsafeMode.AUTO_LAND_CRITICAL
        if battery_pct <= self.rtl_battery_pct:
            return PX4FailsafeMode.AUTO_RTL_LOW_BATTERY
        # PX4 requires OffboardControlMode heartbeat > 2Hz (timeout = 0.5s)
        if time_since_last_heartbeat > 0.50:
            return PX4FailsafeMode.POSCTL_HEARTBEAT_LOST
        return PX4FailsafeMode.NOMINAL_OFFBOARD

    def compute_safe_velocity(
        self,
        own_id: int,
        own_pos: Tuple[float, float],
        preferred_vel: Tuple[float, float],
        neighbor_positions: Dict[int, Tuple[float, float]],
        neighbor_velocities: Dict[int, Tuple[float, float]],
    ) -> Tuple[float, float]:
        """
        Computes reciprocal repulsive + tangential avoidance velocity so two drones
        approaching head-on pass smoothly on the right without colliding.
        """
        vx, vy = preferred_vel
        repulse_x, repulse_y = 0.0, 0.0
        triggered = False

        for nid, npos in neighbor_positions.items():
            if nid == own_id:
                continue
            dx = own_pos[0] - npos[0]
            dy = own_pos[1] - npos[1]
            dist = math.hypot(dx, dy)
            if dist < self.min_observed_separation:
                self.min_observed_separation = dist

            if 1e-4 < dist < self.avoidance_horizon:
                nvel = neighbor_velocities.get(nid, (0.0, 0.0))
                rel_vx = vx - nvel[0]
                rel_vy = vy - nvel[1]
                # Check if closing distance or inside safety radius
                closing_speed = -(dx * rel_vx + dy * rel_vy) / dist
                if closing_speed > 0.0 or dist < self.safety_radius * 1.4:
                    triggered = True
                    strength = ((self.avoidance_horizon - dist) / self.avoidance_horizon) ** 1.5
                    # Reciprocal radial push + right-hand rule tangential deflection
                    ux, uy = dx / dist, dy / dist
                    tx, ty = -uy, ux
                    repulse_x += (ux * 0.65 + tx * 0.35) * self.max_speed * strength * 1.25
                    repulse_y += (uy * 0.65 + ty * 0.35) * self.max_speed * strength * 1.25

        if triggered:
            self.avoidance_maneuvers += 1

        out_vx = vx + repulse_x
        out_vy = vy + repulse_y
        spd = math.hypot(out_vx, out_vy)
        if spd > self.max_speed:
            out_vx = (out_vx / spd) * self.max_speed
            out_vy = (out_vy / spd) * self.max_speed
        return (out_vx, out_vy)
