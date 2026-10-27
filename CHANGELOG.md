# Changelog — SwarmSync Credibility, Ablations & UI Upgrade

## [2.0.0] — Credibility, Scientific Rigor & Layout Redesign

### Part 1: Credibility & Correctness
1. **Project Status Badges (`Project Status` Tab & Top Badge)**:
   - Added a dedicated **Project Status** view listing every subsystem (`Frontend Interactive Sim`, `Python Stage 1 Simulator`, `Benchmark & Ablation Suite`, `Stage 2 ROS 2 Package`, `Stage 3 PX4 SITL Bridge`) with verification badges (`Validated`, `Tested`, `Coded, not validated`).
   - Stage 2 ROS 2 and Stage 3 PX4 SITL default honestly to **`Coded, not validated`** (unit-tested in mock harness, not executed in a live ROS 2 / PX4 SITL daemon in this container).
2. **Parameter Audit & Shared Config (`/configs/params.json` + `/docs/PARAMETERS.md`)**:
   - Created `/configs/params.json` as the single canonical configuration read by both the Python simulator (`/swarmsync/sim/world.py`) and the TypeScript engine (`/src/sim/engine.ts`).
   - Documented all parameters side by side in `/docs/PARAMETERS.md` and standardized recovery time everywhere as `t_reassigned_claim_committed - t_failure_injected` (`L_rem + grace_period + auction_window`).
3. **One Source of Truth (`Replay` Mode)**:
   - Added `SimulationWorld.run_and_export_trace()` in `/swarmsync/sim/world.py` exporting `/experiments/results/replay_trace.json`.
   - Added a **Replay (`Benchmark-faithful`)** viewport mode in the UI alongside the live TypeScript **Interactive visualization engine**.
4. **Baseline Fairness (`/docs/BASELINES.md`)**:
   - Verified and documented identical task streams, RNG seeds, vehicle safety limits, and fault schedules across `SwarmSync`, `Centralized`, `BasicAuction`, and `CBBA`.
5. **Ablation Studies (`/experiments/run_all.py` + `Ablations & Sensitivity` Tab)**:
   - Executed 10-seed experiments comparing `SwarmSync (Full)`, `SwarmSync w/o Leases`, `SwarmSync w/o Event-Triggered Messaging (Periodic Broadcast)`, and `SwarmSync w/o Conflict Resolution`.
6. **Sensitivity Sweeps**:
   - Added a **Cost-Weight Sweep** (`(w_t, w_e, w_r)` across Time-Heavy, Balanced, Energy-Heavy, and Risk-Heavy profiles) and a **Packet-Loss Sweep** (`0%, 10%, 25%, 40%, 50%`) across all 4 modes.
7. **Honest Statistical Reporting & Limitations (`Limitations` Tab)**:
   - Every benchmark metric displays `Mean ± SD` and `95% CI` across `N = 10` seeds read directly from `/experiments/results/*.json` and `/experiments/results/*.csv`.
   - Added a dedicated **Limitations** tab detailing why 2D/3D kinematic simulation is not real-world flight certification and why Bernoulli packet loss differs from multipath urban RF fading.
8. **Reproducibility (`/README.md`, `/requirements.txt`, `/Dockerfile`, `/Makefile`)**:
   - Added `make reproduce` to regenerate all unit test logs, CSVs, JSONs, replay traces, and SVG/PNG plots with one command.

### Part 2: UI & Layout Redesign
- **Visual Theme**: Dark navy `#0B1220` background, `#111D31` panels, cyan `#22D3EE` accents, lime `#A3E635` success, red `#F87171` failure, amber `#F59E0B` warnings, plus a **Light Theme Toggle**.
- **12-Column Desktop Grid**:
  - **Top Bar**: Logo, engine source badge, mode selector, playback (`Play/Pause`, `0.5x/1x/2x`), 5 live KPIs (`Delivered`, `Open Tasks`, `Msgs/Delivery`, `Duplicate Claims`, `Recovery Time`), Guided Demo trigger, and Theme/Help toggles.
  - **Collapsible Left Rail (`Experiment controls`)**: Grouped into `Faults` (Kill Drone, Kill Hub, Partition On/Off), `Network` (Packet Loss, Delay, Comm Range sliders), and `Tasks` (Spawn Task, Place Task on Map, Arrival Rate).
  - **Center Viewport**: Tabs for `3D Town`, `2D Tactical Map`, `Replay (Benchmark-faithful)`, and `Split-Screen Compare`, with floating mini-legend, camera controls, live **FPS badge**, shrinking **lease rings** around owning drones (flashing red on expiry), and PNG screenshot export.
  - **Right Inspector**: Per-drone local state inspector explicitly captioned *"This is the drone's own local view"*, showing local task table, lease countdown progress bar, and 6 module counters.
  - **Resizable/Collapsible Bottom Dock**: Tabs for `Forum Stream` (filterable by `MessageType` and `LogicalChannel`), `Event Timeline` (failures, lease expiries, re-bids, reconciliations), and `Metrics Live`.
  - **Guided 60-Second Demo Mode & Split-Screen Comparison**: Automated 4-phase narrated sequence (`0–10s`, `10–30s`, `30–45s`, `45–60s`) and side-by-side synchronized `SwarmSync` vs `Centralized` comparison with live KPI delta cards.
