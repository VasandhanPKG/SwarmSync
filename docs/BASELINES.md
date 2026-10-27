# Baseline Implementations & Fairness Audit (`/docs/BASELINES.md`)

To guarantee a fair, apples-to-apples scientific comparison against **SwarmSync**, all four coordination modes execute inside the exact same `SimulationWorld` (`/swarmsync/sim/world.py`) and `SwarmSyncSimulator` (`/src/sim/engine.ts`) with identical:
1. **Seeded Random Number Generators (`seed = 1..10`)**:
   - Task stream RNG (`seed + 2000`): Identical task pickup coordinates, dropoff coordinates, payload masses, spawn timestamps, and deadlines.
   - Network RNG (`seed + 1000`): Identical per-link Bernoulli packet drop draws and propagation delay jitter.
2. **Physical Vehicle Limits (`SafetyMonitor`)**:
   - Identical cruise speed (`35.0 m/s`), payload capacity (`5.0 kg`), energy consumption rate (`0.015 %/m`), and hard RTB battery reserve (`18.0 %`).
3. **Fault Schedules**:
   - Identical mid-delivery drone failure timestamps (`kill_drone_events`), partition windows (`partition_window`), and packet loss rates.

---

## 1. SwarmSync (`swarmsync`)
- **Architecture**: Fully decentralized peer-to-peer coordination via typed forum messages (`TASK_ANNOUNCE`, `BID`, `CLAIM`, `RENEW`, `DONE`, `HAZARD`, `HEARTBEAT`, `RECOVERY_REQUEST`).
- **Key Mechanisms**:
  - **Event-triggered communication**: Messages are transmitted only on state transitions (task discovery, bid improvement, claim commitment, lease renewal every `2.0s`, completion, link-change digest reconciliation, or 10% battery band crossings) plus hop-limited gossip (`max_hops = 3`) with `message_id` deduplication.
  - **Versioned lease-based ownership**: Claims expire after `lease_duration_s = 6.0s` unless renewed. After `grace_period_s = 2.5s`, peers release the task with `version + 1` for re-bidding.
  - **Deterministic conflict resolution**: Higher `version` wins; on equal `version`, lower `agent_id` wins; stale versions are ignored.

---

## 2. Centralized Dispatch Baseline (`centralized`)
- **Architecture**: A single central dispatch coordinator (`CentralizedScheduler` at `(500, 500)`) receives all task announcements and assigns tasks greedily to the lowest-cost feasible idle drone.
- **Fairness & Tuning**:
  - Uses the **exact same `SafetyMonitor` feasibility check** and distance/energy cost function as SwarmSync.
  - Accounts for 2-way command/telemetry messages between the central hub and assigned drones (`2 messages` per dispatch + telemetry updates).
  - Respects network partitions: when `partition_enabled = True`, the central hub cannot dispatch or receive telemetry from drones isolated in the opposite partition.
  - **Re-allocation on drone failure**: When a drone fails while connected to the hub, the hub immediately detects telemetry loss and reassigns the task on the next step (`~0.5s`).
  - **Vulnerability**: Single point of failure (`hub_failure` scenario). When the central hub fails at $t = 22\text{s}$, no new or orphaned tasks can be allocated.

---

## 3. Basic Distributed Auction Baseline (`basic_auction`)
- **Architecture**: Decentralized single-task auction using the same cost function $J = w_t T + w_e E + w_r R$, **without** lease-based ownership (`use_leases = False`) and **without** event-triggered suppression (`periodic_broadcast = True`).
- **Fairness & Tuning**:
  - Periodic broadcast interval is tuned to `1.0s` (`TTL = 4.0s`) so discoveries propagate across multi-hop topologies under packet loss.
  - Auction window is identical (`1.2s`).
  - **Weaknesses Revealed**:
    1. High communication overhead (`3x–4x` more messages per delivery than SwarmSync) due to periodic state/task rebroadcasting.
    2. Permanent task orphaning (`use_leases = False`): when a drone fails mid-delivery after committing a claim, surviving peers never expire its static lock.

---

## 4. Consensus-Based Bundle Algorithm Baseline (`cbba`)
- **Architecture**: Multi-task bundle construction (`max_bundle_size = 2`) with consensus conflict resolution tables (`CBBAEngine` in `/swarmsync/baselines/modes.py`).
- **Fairness & Tuning**:
  - Agents build bundles of up to 2 tasks using marginal score improvement and exchange bundle/winner vectors with reachable neighbors every `1.5s`.
  - Uses lease-based recovery (`use_leases = True`) so CBBA is not artificially penalized on single-drone crashes.
  - **Weaknesses Revealed**:
    - Under high packet loss (`25%–50%`) or network partitions, multi-task bundle consensus requires multiple synchronous rounds of winner-matrix exchange, increasing message overhead and causing slower convergence than SwarmSync's single-slot event-triggered lease protocol.
