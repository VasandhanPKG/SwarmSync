# SwarmSync Parameter Audit & Canonical Configuration (`/configs/params.json`)

Both the **TypeScript Interactive Visualization Engine** (`/src/sim/engine.ts`) and the **Python Stage 1 Discrete-Time Simulator** (`/swarmsync/sim/world.py`, `/swarmsync/agents/drone.py`) read their canonical defaults directly from a single shared JSON file: **`/configs/params.json`**.

---

## 1. Side-by-Side Parameter Audit Table

| Parameter Key (`configs/params.json`) | Physical / Protocol Meaning | Python Stage 1 Simulator (`/swarmsync/`) | TypeScript Interactive Engine (`/src/sim/engine.ts`) | Unit |
| :--- | :--- | :---: | :---: | :---: |
| `world.width_m` × `world.height_m` | 2D / 3D arena dimensions | `1000.0 × 1000.0` | `1000.0 × 1000.0` | meters |
| `world.dt_s` | Fixed simulation timestep ($\Delta t$) | `0.20` (`0.50` in batch sweeps) | `0.20` | seconds |
| `drone.speed_mps` | Nominal cruise groundspeed ($v_{\text{max}}$) | `35.0` | `35.0` | m/s |
| `drone.max_payload_kg` | Hard payload capacity enforced by `SafetyMonitor` | `5.0` | `5.0` | kg |
| `drone.energy_per_meter_pct` | Battery drain per meter of horizontal flight | `0.015` | `0.015` | % / m |
| `drone.reserve_battery_pct` | Hard Return-to-Base (RTB) battery reserve floor | `18.0` | `18.0` | % |
| `drone.delivery_radius_m` | Horizontal proximity threshold for pickup/dropoff | `5.0–16.0` | `7.0–16.0` | meters |
| `network.comm_range_m` | Peer-to-peer wireless ad-hoc radio range | `620.0` | `620.0` | meters |
| `network.base_delay_s` | Nominal per-hop packet propagation delay | `0.10` | `0.05–0.22` | seconds |
| `network.packet_loss_prob` | Bernoulli per-link packet drop probability | `0.00` (`0.25` in loss scenario) | `0.00` (slider `0.00–0.60`) | probability |
| `network.gossip_hop_limit` | Maximum multi-hop forwarding TTL (`max_hops`) | `3` | `3` | hops |
| `network.message_ttl_s` | Message expiration window (`expiry_time - timestamp`) | `10.0–18.0` | `10.0–16.0` | seconds |
| `network.partition_split_x_m` | East/West network partition boundary ($X = 500\text{m}$) | `500.0` | `500.0` | meters |
| `protocol.lease_duration_s` | Task ownership lease validity ($L$) | **`6.0`** | **`6.0`** | seconds |
| `protocol.renew_interval_s` | Owner lease renewal broadcast period ($R_{\text{renew}}$) | **`2.0`** | **`2.0`** | seconds |
| `protocol.grace_period_s` | Post-expiry safety buffer before task release ($G$) | **`2.5`** | **`2.5`** | seconds |
| `protocol.auction_window_s` | Distributed bidding convergence window ($W_{\text{auction}}$) | **`1.2`** | **`1.2`** | seconds |
| `protocol.periodic_broadcast_interval_s` | Beacon/task sync interval when event-triggering is disabled | `1.0` | `1.0` | seconds |
| `auction_weights.w_t` | Time / transit duration weight in cost $J$ | `0.50` | `0.50` | dimensionless |
| `auction_weights.w_e` | Energy consumption weight in cost $J$ | `0.30` | `0.30` | dimensionless |
| `auction_weights.w_r` | Deadline & hazard risk weight in cost $J$ | `0.20` | `0.20` | dimensionless |

---

## 2. Precise Definition of Recovery Time (`avg_recovery_time_s`)

### Previous Discrepancy Audit
In the earlier prototype, `lease_duration` was set to `8.0s` and `grace_period` to `3.0s`, yet reported recovery times in some runs averaged `~4.8s–6.5s`. This occurred because:
1. A drone killed at $t_{\text{kill}}$ had last renewed its lease at $t_{\text{renew}} \le t_{\text{kill}}$, leaving a residual lease duration $L_{\text{rem}} = (t_{\text{renew}} + L) - t_{\text{kill}} \in [0, L]$.
2. Some scenario overrides used shorter lease windows without documenting the residual lease calculation.

### Canonical Definition Used Everywhere
Recovery time is strictly defined in both `/swarmsync/sim/world.py` and `/src/sim/engine.ts` as:

$$T_{\text{recovery}} = t_{\text{reassigned\_claim\_committed}} - t_{\text{failure\_injected}}$$

where:
- $t_{\text{failure\_injected}}$ is the exact simulation timestamp when an active task-owning drone fails (`kill_drone` / battery exhaustion).
- $t_{\text{reassigned\_claim\_committed}}$ is the exact simulation timestamp when a surviving peer completes the post-expiry grace period, increments the task version ($v \leftarrow v + 1$), wins the re-bid auction window, and commits a valid `CLAIM`.

### Theoretical Bounds under Canonical Parameters (`L = 6.0s`, `R = 2.0s`, `G = 2.5s`, `W = 1.2s`)
When an active owner is killed at $t_{\text{kill}}$, the time since its last renewal is $\Delta t_{\text{since\_renew}} \in [0, R_{\text{renew}}] = [0, 2.0\text{s}]$. Therefore, the remaining lease time at failure is:

$$L_{\text{rem}} = L - \Delta t_{\text{since\_renew}} \in [4.0\text{s},\, 6.0\text{s}]$$

Once the lease expires at $t_{\text{kill}} + L_{\text{rem}}$, surviving peers wait the conservative safety grace period $G = 2.5\text{s}$ (because a missed renewal under packet loss is not proof of a physical crash) and then run a distributed re-bid auction of duration $W_{\text{auction}} = 1.2\text{s}$ plus one network propagation step $\delta_{\text{net}}$:

$$T_{\text{recovery}} = L_{\text{rem}} + G + W_{\text{auction}} + \delta_{\text{net}} \in [7.7\text{s},\, 10.2\text{s}]$$
