# SwarmSync: Decentralized Multi-Agent Coordination for Autonomous Drone Logistics

SwarmSync is a simulation-first engineering prototype of **decentralized peer-to-peer task allocation and fault recovery** for autonomous delivery drone fleets. Drones coordinate exclusively through a peer-to-peer communication forum of typed messages (`TASK_ANNOUNCE`, `BID`, `CLAIM`, `RENEW`, `DONE`, `HAZARD`, `HEARTBEAT`, `RECOVERY_REQUEST`) with **no central task-allocation controller, broker, or shared database**.

---

## Key Architecture & Credibility Guarantees

1. **Zero Central Controller in Decentralized Modes**: Each drone runs 6 isolated modules (`LocalStateManager`, `CommunicationManager`, `TaskNegotiationEngine`, `AssignmentManager`, `RecoveryManager`, `SafetyMonitor`) operating strictly on its own local task table. The UI dashboard is a **read-only observer**; fault-injection buttons and task placement are strictly **Experiment Controls**.
2. **One Canonical Configuration (`/configs/params.json`)**: Both the Python Stage 1 simulator (`/swarmsync/`) and the TypeScript interactive visualization engine (`/src/sim/engine.ts`) read from `/configs/params.json`. See [`/docs/PARAMETERS.md`](./docs/PARAMETERS.md).
3. **Interactive Engine + Benchmark-Faithful Replay**:
   - **Interactive Visualization Engine (TypeScript/Three.js)**: Real-time 3D Small Town & 2D Tactical Map for interactive fault injection, 60-second Guided Demo, and Split-Screen Comparison (`SwarmSync` vs `Centralized`).
   - **Benchmark-Faithful Replay Mode**: Loads deterministic JSON event traces (`/experiments/results/replay_trace.json`) exported directly by the Python Stage 1 simulator.
4. **Honest Reporting & Verification Status**:
   - Every benchmark metric in the UI is loaded from real CSV/JSON files in `/experiments/results/` with **Mean, Standard Deviation (SD), and 95% Confidence Intervals (CI)** across `N = 10` seeds.
   - Stage 2 (ROS 2 package in `/ros2_ws/`) and Stage 3 (PX4 SITL bridge in `/px4_sitl/`) are unit-tested via mock interfaces in Python, and marked honestly as **"Coded, not validated on live ROS 2 / PX4 SITL"** in the Project Status panel.

---

## Reproducibility: One Command Per Table, Figure & Test

### 1. Reproduce Everything (`make reproduce`)
Regenerates all unit test logs, 10-seed scenario CSVs, fleet scaling CSVs, ablation CSVs, sensitivity sweep CSVs, replay trace JSON, and SVG/PNG plots:
```bash
make reproduce
```

### 2. Run Stage 1–3 Python Unit Tests (8 tests)
```bash
python3 -m unittest discover -s tests -v
```

### 3. Run TypeScript Decentralized Engine Unit Tests (7 tests)
```bash
npx --yes tsx --test src/sim/engine.test.ts
```

### 4. Generate All Benchmark CSVs, JSONs, Replay Trace & Figures
```bash
python3 -m experiments.run_all
```
This single command produces:
- **Tables / Raw CSVs**:
  - `experiments/results/scenario_runs_10seeds.csv` (6 scenarios × 4 modes × 10 seeds)
  - `experiments/results/scale_runs_10seeds.csv` ($N \in \{3, 5, 10, 20\}$ drones × 4 modes × 10 seeds)
  - `experiments/results/ablation_runs_10seeds.csv` (Full SwarmSync vs w/o Leases vs w/o Event-Triggered vs w/o Conflict Resolution × 10 seeds)
  - `experiments/results/weight_sensitivity_10seeds.csv` (Cost-weight sweep $(w_t, w_e, w_r)$ × 10 seeds)
  - `experiments/results/loss_sensitivity_10seeds.csv` (Packet-loss sweep $0\%, 10\%, 25\%, 40\%, 50\%$ × 4 modes × 10 seeds)
  - `experiments/results/summary_stats.json` & `experiments/results/ablations_sensitivity.json`
  - `experiments/results/replay_trace.json` (Benchmark-faithful replay trace)
- **Figures (`.svg` and `.png`)**:
  - `experiments/figures/delivery_success_rate.svg` (`.png`)
  - `experiments/figures/messages_per_delivery.svg` (`.png`)
  - `experiments/figures/avg_delivery_time.svg` (`.png`)
  - `experiments/figures/scale_messages_per_delivery.svg` (`.png`)
  - `experiments/figures/sensitivity_packet_loss.svg` (`.png`)

### 5. Run Single CLI Scenario
```bash
python3 -m swarmsync.run --scenario drone_failure --mode swarmsync --seed 1
```

### 6. Start Interactive Web Dashboard & 3D Simulator
```bash
npm install
npm run dev
# Open http://localhost:3000
```

---

## Documentation Index
- [`/docs/PARAMETERS.md`](./docs/PARAMETERS.md) — Side-by-side parameter audit (`/configs/params.json`) and mathematical recovery time definition.
- [`/docs/BASELINES.md`](./docs/BASELINES.md) — Tuning and fairness audit for `Centralized`, `BasicAuction`, and `CBBA`.
- [`/CHANGELOG.md`](./CHANGELOG.md) — Complete engineering changelog of credibility, ablation, and UI upgrades.
