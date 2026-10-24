# SwarmSync — Architectural Specification & Engineering Design (`DESIGN.md`)

## 1. Repository Structure & Staged Roadmap

```text
swarmsync/
├── __init__.py
├── run.py                          # CLI: python -m swarmsync.run --scenario partition --mode swarmsync --seed 1
├── agents/
│   ├── __init__.py
│   ├── modules.py                  # LocalStateManager, CommunicationManager, TaskNegotiationEngine,
│   │                               # AssignmentManager, RecoveryManager, SafetyMonitor
│   └── drone.py                    # Autonomous DroneAgent combining the 6 modules + kinematics/energy
├── net/
│   ├── __init__.py
│   ├── messages.py                 # ForumMessage dataclass, MessageType, LogicalChannel
│   └── network.py                  # SimulatedNetwork (range, delay queue, packet loss, partition, failure)
├── sim/
│   ├── __init__.py
│   ├── tasks.py                    # DeliveryTask dataclass, TaskStatus, TaskSource (nearest-reachable injection)
│   ├── world.py                    # Discrete-time 2D simulator engine (seeded RNG, fixed timestep)
│   └── visualizer.py               # Matplotlib live animation + interactive "Kill Drone" & "Partition" controls
├── baselines/
│   ├── __init__.py
│   └── modes.py                    # CentralizedScheduler, BasicDecentralizedAuction, CBBAEngine, SwarmSync
└── metrics/
    ├── __init__.py
    └── collector.py                # Per-run CSV logger, statistical aggregator (Mean, SD, 95% CI)
configs/
├── normal.json                     # Nominal operation (5 drones, 12 tasks)
├── dynamic_arrival.json            # Continuous Poisson-like task arrival
├── packet_loss_delay.json          # 25% packet loss, 0.4s-1.6s variable message delay
├── partition.json                  # Network partition at t=25s, healing & reconciliation at t=75s
├── drone_failure.json              # Random mid-delivery drone failures
├── hub_failure.json                # Central-hub outage at t=30s
└── scale.json                      # Fleet scaling configuration (3, 5, 10, 20 drones)
experiments/
├── run_all.py                      # Runs all scenarios x modes x 10 seeds + fleet scale sweep
├── plot_metrics.py                 # Generates publication-grade Matplotlib / SVG & PNG comparison plots
├── results/                        # Raw per-run CSVs and aggregated summary_stats.json / summary_table.csv
└── figures/                        # Generated comparison plots (*.svg, *.png)
tests/
└── test_swarmsync.py               # Unit tests: conflict resolution, lease expiry, dedupe, reconciliation, safety
ros2_ws/src/swarmsync_ros2/         # STAGE 2: Peer-to-peer ROS 2 nodes, DDS forum msgs, netem relay, observer
px4_sitl/                           # STAGE 3: PX4 SITL multi-vehicle spawner, uXRCE-DDS bridge, RVO avoidance
```

### Stage 1 Task List
1. Define typed peer-to-peer `ForumMessage` schema and logical channels (`swarmsync/net/messages.py`).
2. Build `SimulatedNetwork` with range checks, stochastic delay buffer, packet loss, partition barrier, and node failure (`swarmsync/net/network.py`).
3. Implement `TaskSource` that spawns tasks with pickup, dropoff, payload, and deadline, handing each task exclusively to the nearest reachable alive drone (`swarmsync/sim/tasks.py`).
4. Implement the 6 decoupled agent modules (`LocalStateManager`, `CommunicationManager`, `TaskNegotiationEngine`, `AssignmentManager`, `RecoveryManager`, `SafetyMonitor`) in `swarmsync/agents/modules.py`.
5. Implement the 4 coordination modes (`centralized`, `basic_auction`, `cbba`, `swarmsync`) under identical physics and RNG seeds (`swarmsync/baselines/modes.py`).
6. Write unit tests verifying conflict resolution, lease expiry & grace rules, message deduplication, safety hard constraints, and partition reconciliation (`tests/test_swarmsync.py`).
7. Run 10-seed experiments across all 6 scenarios and 4 fleet sizes (3, 5, 10, 20) and generate real comparison plots (`experiments/run_all.py`).

---

## 2. Core Design Choices & Ambiguity Resolutions

### 2.1 Distributed Auction Cost Function & Hard Safety Constraints
Each agent evaluates an unassigned or expired task $k$ using:
$$J_i(k) = w_t \cdot T_i(k) + w_e \cdot E_i(k) + w_r \cdot R_i(k)$$
where:
- $T_i(k)$: Estimated time to reach pickup $\mathbf{p}_{\text{pick}}$ from current position $\mathbf{p}_i$ plus transit to $\mathbf{p}_{\text{drop}}$, normalized by nominal arena transit time ($100\text{ s}$).
- $E_i(k)$: Estimated energy consumption $E_{\text{req}}(k) = (d_{\text{pickup}} + d_{\text{delivery}}) \cdot c_{\text{move}}(1 + 0.35 \cdot \frac{\text{payload}}{\text{capacity}})$, normalized by battery capacity ($100\%$).
- $R_i(k)$: Risk term combining deadline slack tightness $\max(0, 1 - \frac{t_{\text{deadline}} - (t + T_{\text{total}})}{40})$ and proximity to any reported `HAZARD` zone along the segment.
- **Bid value**: $\text{Bid}_i(k) = -J_i(k)$ (higher bid = lower cost).
- **Hard constraints (`SafetyMonitor`)**: An agent is strictly forbidden from bidding on or continuing a task if:
  1. $\text{payload}_k > \text{max\_payload}_i$
  2. $\text{battery}_i - E_{\text{req}}(k) - E_{\text{return\_to\_base}}(\mathbf{p}_{\text{drop}}) < B_{\text{reserve}}$ (default $B_{\text{reserve}} = 15\%$)
  3. $t + T_{\text{total}} > t_{\text{deadline}}$ (strict deadline feasibility check at bid time)

### 2.2 Lease-Based Ownership & Why Timeout Is Not Proof of Crash
- When an agent wins the short local auction window ($W_{\text{auction}} = 2.0\text{ s}$), it broadcasts a `CLAIM` with `(owner_id, version, lease_expiry = t + L_lease)` where $L_{\text{lease}} = 8.0\text{ s}$.
- While executing the task, the owner broadcasts `RENEW` every $T_{\text{renew}} = 3.0\text{ s}$ (extending `lease_expiry` to $t + L_{\text{lease}}$).
- **Ambiguity & Safety Rule**: A missed lease renewal (`t > lease_expiry`) is **not** proof that the owner crashed—it may simply be delayed by packet loss or isolated on the other side of a network partition.
  - Therefore, `RecoveryManager` enforces a configurable conservative grace period $\Delta_{\text{grace}} = 3.0\text{ s}$ beyond `lease_expiry` before transitioning the task to `RELEASED` and incrementing `version = old_version + 1` for re-bidding.
  - Furthermore, if a partitioned owner fails to receive peer acks or sees a higher-version `CLAIM` upon reconnection, deterministic conflict resolution forces the stale owner to yield immediately so two drones do not deliver the same physical package.

### 2.3 Deterministic Conflict Resolution
For any task $k$, competing claims $C_a = (\text{owner}_a, v_a)$ and $C_b = (\text{owner}_b, v_b)$ are resolved deterministically without a coordinator:
1. `DONE` is terminal and overrides any active `CLAIM` regardless of version.
2. Higher `version` ($v_a > v_b$) strictly wins.
3. On equal `version` ($v_a == v_b$), lower lexicographical/numerical `owner_id` ($\text{owner}_a < \text{owner}_b$) strictly wins.
4. Stale updates ($v_{\text{incoming}} < v_{\text{local}}$) are ignored and never overwrite newer state.
5. Whenever an agent observes two distinct alive drones actively claiming the same task in the same step before convergence, the simulator logs a duplicate-claim conflict event.

### 2.4 Event-Triggered Gossip vs. Periodic Broadcast
- **SwarmSync (Event-Triggered)**: Agents emit forum messages *only* on discrete state transitions: (1) new task announced, (2) bid improved or claim state changed, (3) lease renewal boundary crossed, (4) battery safety threshold crossed, (5) hazard detected, (6) communication link up/down (triggers `RECOVERY_REQUEST`), or (7) task released on lease+grace expiry. Each message is gossip-forwarded at most once per agent (`seen_message_ids` set) up to `max_hops = 3` and dropped if `t > expiry_time`.
- **Periodic Broadcast Baseline (`PERIODIC_BROADCAST=True`)**: Broadcasts full task table every $1.0\text{ s}$, demonstrating why event-triggered gossip achieves $3\times\text{--}6\times$ lower message and byte overhead per completed delivery.
