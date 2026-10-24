#!/usr/bin/env bash
# Stage 3: PX4 SITL + Gazebo Multi-Vehicle Spawner (3 or 5 x500 Quadrotors)
# Starts MicroXRCEAgent transport bridge and spawns isolated PX4 SITL instances.
# Each vehicle gets its own `/px4_<id>/fmu/*` namespace; no central task controller exists.

set -euo pipefail

NUM_DRONES="${1:-3}"
PX4_DIR="${PX4_AUTOPILOT_DIR:-$HOME/PX4-Autopilot}"

echo "[SwarmSync Stage 3] Starting uXRCE-DDS transport bridge on UDP port 8888..."
MicroXRCEAgent udp4 -p 8888 &
XRCE_PID=$!
trap 'kill $XRCE_PID 2>/dev/null || true' EXIT

for i in $(seq 1 "$NUM_DRONES"); do
  Y_OFFSET=$(( (i - 1) * 4 ))
  echo "[SwarmSync Stage 3] Spawning PX4 SITL x500 instance #${i} at pose (0, ${Y_OFFSET}, 0)..."
  PX4_SYS_AUTOSTART=4001 \
  PX4_GZ_MODEL_POSE="0,${Y_OFFSET},0,0,0,0" \
  PX4_SIM_MODEL=gz_x500 \
  "$PX4_DIR/build/px4_sitl_default/bin/px4" -i "$i" -d &
  sleep 2
done

echo "[SwarmSync Stage 3] All ${NUM_DRONES} PX4 instances active. Launching SwarmSync peer-to-peer nodes..."
wait
