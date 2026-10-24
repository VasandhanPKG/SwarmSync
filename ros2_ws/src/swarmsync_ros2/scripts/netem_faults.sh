#!/usr/bin/env bash
# Stage 2 Linux Kernel Traffic Control (tc/netem) + iptables Partition Injector
# Applies real packet loss, jittered delay, and subnet partition rules to ROS 2 DDS traffic.

set -euo pipefail

IFACE="${1:-lo}"
ACTION="${2:-status}"

case "$ACTION" in
  impair)
    LOSS_PCT="${3:-15%}"
    DELAY_MS="${4:-120ms}"
    JITTER_MS="${5:-40ms}"
    echo "[SwarmSync netem] Applying delay=${DELAY_MS}±${JITTER_MS}, loss=${LOSS_PCT} on ${IFACE}"
    sudo tc qdisc replace dev "$IFACE" root netem delay "$DELAY_MS" "$JITTER_MS" distribution normal loss "$LOSS_PCT"
    ;;
  partition)
    BLOCKED_IP="${3:-172.18.0.14}"
    echo "[SwarmSync netem] Partitioning peer ${BLOCKED_IP} via iptables DROP"
    sudo iptables -A INPUT -s "$BLOCKED_IP" -j DROP
    sudo iptables -A OUTPUT -d "$BLOCKED_IP" -j DROP
    ;;
  heal)
    echo "[SwarmSync netem] Healing network partitions and clearing tc netem rules on ${IFACE}"
    sudo tc qdisc del dev "$IFACE" root 2>/dev/null || true
    sudo iptables -F INPUT || true
    sudo iptables -F OUTPUT || true
    ;;
  *)
    tc qdisc show dev "$IFACE"
    ;;
esac
