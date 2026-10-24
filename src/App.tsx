import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Skull,
  ShieldAlert,
  PlusCircle,
  Download,
  Radio,
  Box,
  Map as MapIcon,
} from 'lucide-react';
import { CoordinationMode, SwarmSyncSimulator } from './sim/engine';
import { LiveArenaCanvas } from './components/LiveArenaCanvas';
import { DroneArena3D } from './components/DroneArena3D';
import { BenchmarkData, BenchmarkSuiteView } from './components/BenchmarkSuiteView';
import { ArchitectureView } from './components/ArchitectureView';

type ActiveTab = 'simulator' | 'benchmarks' | 'architecture';
type ViewportDimension = '3d' | '2d';

const SCENARIO_PRESETS = [
  { id: 'normal', label: 'Normal Operation' },
  { id: 'dynamic_arrival', label: 'Dynamic Task Arrival' },
  { id: 'packet_loss_delay', label: 'Packet Loss (25%) & Delay' },
  { id: 'partition', label: 'Network Partition & Heal' },
  { id: 'drone_failure', label: 'Mid-Delivery Drone Failure' },
  { id: 'hub_failure', label: 'Central-Hub Failure' },
];

const MODE_OPTIONS: { id: CoordinationMode; label: string }[] = [
  { id: 'swarmsync', label: 'SwarmSync (Event + Lease)' },
  { id: 'centralized', label: 'Centralized Scheduler' },
  { id: 'basic_auction', label: 'Basic Auction (Periodic)' },
  { id: 'cbba', label: 'CBBA (Bundle Consensus)' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('simulator');
  const [viewportDim, setViewportDim] = useState<ViewportDimension>('3d');
  const [scenario, setScenario] = useState<string>('drone_failure');
  const [mode, setMode] = useState<CoordinationMode>('swarmsync');
  const [seed, setSeed] = useState<number>(1);
  const [fleetSize, setFleetSize] = useState<number>(5);
  const [isRunning, setIsRunning] = useState<boolean>(true);
  const [selectedDroneId, setSelectedDroneId] = useState<number>(1);
  const [renderTick, setRenderTick] = useState<number>(0);

  const [benchmarkData, setBenchmarkData] = useState<BenchmarkData | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState<boolean>(true);

  const simRef = useRef<SwarmSyncSimulator>(
    new SwarmSyncSimulator('drone_failure', 'swarmsync', 1, 5)
  );

  // Fetch empirical 10-seed Python benchmark results
  useEffect(() => {
    setBenchmarkLoading(true);
    fetch('/api/experiments')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.scenario_summary) {
          setBenchmarkData(d);
        }
      })
      .catch(() => {})
      .finally(() => setBenchmarkLoading(false));
  }, []);

  // Re-initialize simulator when scenario, mode, seed, or fleetSize changes
  const resetSimulation = (
    nextScenario = scenario,
    nextMode = mode,
    nextSeed = seed,
    nextFleet = fleetSize
  ) => {
    simRef.current = new SwarmSyncSimulator(nextScenario, nextMode, nextSeed, nextFleet);
    setSelectedDroneId(1);
    setRenderTick((t) => t + 1);
  };

  // Simulation loop at 15Hz with continuous order replenishment so all drones keep making decisions & dropping orders
  useEffect(() => {
    if (!isRunning || activeTab !== 'simulator') return;
    const timer = window.setInterval(() => {
      const sim = simRef.current;
      const tasks = sim.getConsolidatedTasks();
      const activeOrOpen = tasks.filter((t) => t.status !== 'COMPLETED');
      if (activeOrOpen.length < sim.drones.size && sim.masterTasks.size < 36) {
        const px = Math.round(120 + sim.rng.next() * 760);
        const py = Math.round(120 + sim.rng.next() * 760);
        let dx = Math.round(120 + sim.rng.next() * 760);
        let dy = Math.round(120 + sim.rng.next() * 760);
        while (Math.hypot(dx - px, dy - py) < 170) {
          dx = Math.round(120 + sim.rng.next() * 760);
          dy = Math.round(120 + sim.rng.next() * 760);
        }
        sim.spawnCustomTask([px, py], [dx, dy], Number((1.0 + sim.rng.next() * 1.6).toFixed(2)));
      }
      if (sim.currentTime < 360) {
        sim.step();
        setRenderTick((t) => t + 1);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [isRunning, activeTab]);

  const sim = simRef.current;
  const drones = Array.from(sim.drones.values());
  const selectedDrone = sim.drones.get(selectedDroneId) || drones[0];
  const consolidatedTasks = sim.getConsolidatedTasks();
  const completedTasks = consolidatedTasks.filter((t) => t.status === 'COMPLETED');
  const msgsPerDeliv =
    completedTasks.length > 0
      ? (sim.totalMessagesSent / completedTasks.length).toFixed(1)
      : sim.totalMessagesSent.toString();

  const handleKillSelectedDrone = () => {
    if (!selectedDrone) return;
    if (selectedDrone.alive) {
      sim.killDrone(selectedDrone.id);
    } else {
      sim.reviveDrone(selectedDrone.id);
    }
    setRenderTick((t) => t + 1);
  };

  const handleKillActiveOwner = () => {
    const busy = drones.find((d) => d.alive && d.localState.currentTaskId !== null);
    const target = busy || drones.find((d) => d.alive);
    if (target) {
      sim.killDrone(target.id);
      setSelectedDroneId(target.id);
      setRenderTick((t) => t + 1);
    }
  };

  const handleTogglePartition = () => {
    sim.partitionEnabled = !sim.partitionEnabled;
    setRenderTick((t) => t + 1);
  };

  const handleSpawnUrgentTask = () => {
    const px = Math.round(140 + Math.random() * 720);
    const py = Math.round(140 + Math.random() * 720);
    const dx = Math.round(140 + Math.random() * 720);
    const dy = Math.round(140 + Math.random() * 720);
    sim.spawnCustomTask([px, py], [dx, dy], 1.6);
    setRenderTick((t) => t + 1);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Strict 3-Zone Top Navigation Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 bg-white border-b border-slate-200">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('simulator');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          SwarmSync
        </a>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav aria-label="Main Navigation" className="flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => setActiveTab('simulator')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'simulator'
                ? 'text-slate-900 border-sky-600 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Live Simulator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('benchmarks')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'benchmarks'
                ? 'text-slate-900 border-sky-600 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Benchmark & Plots
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('architecture')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'architecture'
                ? 'text-slate-900 border-sky-600 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            ROS 2 & PX4 Stack
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="flex items-center shrink-0">
          <a
            href="/api/csv/scenarios"
            download="scenario_runs_10seeds.csv"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export Benchmark CSV
          </a>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6">
        {activeTab === 'simulator' && (
          <div className="space-y-6">
            {/* Top Telemetry & Mode Ribbon */}
            <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-slate-600">
                <span className="font-semibold text-slate-900">
                  MISSION TIME: T+{sim.currentTime.toFixed(1)}s
                </span>
                <span>·</span>
                <span className={sim.partitionEnabled ? 'text-rose-600 font-semibold' : 'text-emerald-700 font-semibold'}>
                  {sim.partitionEnabled ? '▲ NETWORK PARTITION ACTIVE' : '● MESH TOPOLOGY NOMINAL'}
                </span>
                <span>·</span>
                <span>
                  DELIVERED: {completedTasks.length}/{consolidatedTasks.length}
                </span>
                <span>·</span>
                <span>FORUM MSGS: {sim.totalMessagesSent}</span>
                <span>·</span>
                <span>MSGS/DELIV: {msgsPerDeliv}</span>
                <span>·</span>
                <span>RVO AVOIDANCE: {sim.rvoAvoidanceCount}</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsRunning((r) => !r)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  {isRunning ? 'Pause Simulation' : 'Resume Simulation'}
                </button>
                <button
                  type="button"
                  onClick={() => resetSimulation()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset Run
                </button>
                <button
                  type="button"
                  onClick={handleKillActiveOwner}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Skull className="w-3.5 h-3.5" />
                  Kill Mid-Delivery Drone
                </button>
                <button
                  type="button"
                  onClick={handleTogglePartition}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <ShieldAlert className="w-3.5 h-3.5" />
                  {sim.partitionEnabled ? 'Heal Network Partition' : 'Inject Network Partition'}
                </button>
                <button
                  type="button"
                  onClick={handleSpawnUrgentTask}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  Spawn Delivery Task
                </button>
              </div>
            </div>

            {/* Asymmetric Split Console: Left Parameter Deck (4 cols) + Right Interactive Stage (8 cols) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Control & Per-Agent Local State Column */}
              <div className="lg:col-span-4 space-y-6">
                {/* Scenario & Algorithm Configuration */}
                <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                  <h2 className="text-base font-semibold text-slate-900">
                    Simulation & Fault Configuration
                  </h2>

                  <div>
                    <label htmlFor="sim-mode-select" className="block text-xs font-medium text-slate-700 mb-1">
                      Coordination Algorithm Mode
                    </label>
                    <select
                      id="sim-mode-select"
                      value={mode}
                      onChange={(e) => {
                        const nextM = e.target.value as CoordinationMode;
                        setMode(nextM);
                        resetSimulation(scenario, nextM, seed, fleetSize);
                      }}
                      className="w-full px-3 py-2 text-xs font-medium bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
                    >
                      {MODE_OPTIONS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="sim-scenario-select" className="block text-xs font-medium text-slate-700 mb-1">
                      Operational Scenario Preset
                    </label>
                    <select
                      id="sim-scenario-select"
                      value={scenario}
                      onChange={(e) => {
                        const nextS = e.target.value;
                        setScenario(nextS);
                        resetSimulation(nextS, mode, seed, fleetSize);
                      }}
                      className="w-full px-3 py-2 text-xs font-medium bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
                    >
                      {SCENARIO_PRESETS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="sim-fleet-select" className="block text-xs font-medium text-slate-700 mb-1">
                        Fleet Size: {fleetSize} Drones
                      </label>
                      <select
                        id="sim-fleet-select"
                        value={fleetSize}
                        onChange={(e) => {
                          const nf = Number(e.target.value);
                          setFleetSize(nf);
                          resetSimulation(scenario, mode, seed, nf);
                        }}
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
                      >
                        <option value={3}>3 Drones</option>
                        <option value={5}>5 Drones</option>
                        <option value={10}>10 Drones</option>
                        <option value={20}>20 Drones</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="sim-seed-input" className="block text-xs font-medium text-slate-700 mb-1">
                        RNG Seed: #{seed}
                      </label>
                      <input
                        id="sim-seed-input"
                        type="number"
                        min={1}
                        max={99}
                        value={seed}
                        onChange={(e) => {
                          const ns = Math.max(1, Number(e.target.value) || 1);
                          setSeed(ns);
                          resetSimulation(scenario, mode, ns, fleetSize);
                        }}
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="packet-loss-slider" className="flex justify-between text-xs font-medium text-slate-700 mb-1">
                      <span>Packet Loss Probability</span>
                      <span className="font-mono">{Math.round(sim.packetLossProb * 100)}%</span>
                    </label>
                    <input
                      id="packet-loss-slider"
                      type="range"
                      min={0}
                      max={60}
                      value={Math.round(sim.packetLossProb * 100)}
                      onChange={(e) => {
                        sim.packetLossProb = Number(e.target.value) / 100;
                        setRenderTick((t) => t + 1);
                      }}
                      className="w-full accent-sky-600"
                    />
                  </div>
                </section>

                {/* Selected Drone Local State & 6-Module Telemetry Inspector */}
                {selectedDrone && (
                  <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900">
                          Agent D{selectedDrone.id} — Local State View
                        </h2>
                        <p className="text-xs text-slate-500 font-mono mt-0.5">
                          POS: ({Math.round(selectedDrone.position[0])}m, {Math.round(selectedDrone.position[1])}m, {selectedDrone.altitude.toFixed(1)}m) · BAT: {selectedDrone.battery.toFixed(1)}%
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleKillSelectedDrone}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                          selectedDrone.alive
                            ? 'bg-rose-600 text-white hover:bg-rose-700'
                            : 'bg-emerald-600 text-white hover:bg-emerald-700'
                        }`}
                      >
                        {selectedDrone.alive
                          ? `Kill Drone D${selectedDrone.id}`
                          : `Revive Drone D${selectedDrone.id}`}
                      </button>
                    </div>

                    {/* Drone selector buttons */}
                    <div className="flex flex-wrap gap-1.5">
                      {drones.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setSelectedDroneId(d.id)}
                          className={`px-2.5 py-1 text-xs font-mono rounded border transition-colors whitespace-nowrap shrink-0 ${
                            d.id === selectedDrone.id
                              ? 'bg-slate-900 text-white border-slate-900 font-semibold'
                              : !d.alive
                              ? 'bg-rose-50 text-rose-700 border-rose-200'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          D{d.id} {!d.alive ? '✖' : d.localState.currentTaskId ? '●' : '○'}
                        </button>
                      ))}
                    </div>

                    {/* 6 Modules Metrics Summary */}
                    <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-200 text-xs font-mono">
                      <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                        <div className="text-slate-500 text-[10px]">1. LOCAL STATE VIEW</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {selectedDrone.localState.knownTasks.size} Known Tasks
                        </div>
                      </div>
                      <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                        <div className="text-slate-500 text-[10px]">2. COMM DEDUPE / EXP</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {selectedDrone.comm.dedupedCount} dedup · {selectedDrone.comm.droppedExpiredCount} exp
                        </div>
                      </div>
                      <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                        <div className="text-slate-500 text-[10px]">3-4. LEASE & CONFLICTS</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {selectedDrone.assignment.conflictsResolved} resolved
                        </div>
                      </div>
                      <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                        <div className="text-slate-500 text-[10px]">5-6. RECOVERY & SAFETY</div>
                        <div className="text-slate-900 font-semibold mt-0.5">
                          {selectedDrone.recovery.tasksReleasedCount} rel · {selectedDrone.recovery.reconciliationsCompleted} sync
                        </div>
                      </div>
                    </div>

                    {/* Per-Agent Local Task Table */}
                    <div className="pt-2">
                      <div className="text-xs font-medium text-slate-700 mb-2">
                        Agent D{selectedDrone.id} Local Task Table (Decentralized View)
                      </div>
                      <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg">
                        <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200 text-[10px] text-slate-500">
                              <th className="py-1.5 px-2.5">Task</th>
                              <th className="py-1.5 px-2">Status</th>
                              <th className="py-1.5 px-2">Owner</th>
                              <th className="py-1.5 px-2">Ver</th>
                              <th className="py-1.5 px-2">Lease</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {Array.from(selectedDrone.localState.knownTasks.values()).map((t) => {
                              const leaseRem = Math.max(0, t.lease_expiry - sim.currentTime);
                              return (
                                <tr key={t.task_id}>
                                  <td className="py-1.5 px-2.5 font-semibold text-slate-900">
                                    {t.task_id}
                                  </td>
                                  <td className="py-1.5 px-2 text-slate-700">{t.status}</td>
                                  <td className="py-1.5 px-2 text-slate-700">
                                    {t.owner_id ? `D${t.owner_id}` : '—'}
                                  </td>
                                  <td className="py-1.5 px-2 text-slate-600">v{t.version}</td>
                                  <td className="py-1.5 px-2 text-slate-600">
                                    {t.status === 'COMPLETED' || leaseRem > 500
                                      ? '—'
                                      : `${leaseRem.toFixed(1)}s`}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </section>
                )}
              </div>

              {/* Right Main Viewport Stage + Peer Communication Forum Feed */}
              <div className="lg:col-span-8 space-y-4">
                {/* Per-Drone Autonomous Decision & Order Drop Matrix (Above the Fold) */}
                <section className="bg-white border border-slate-200 rounded-lg p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-200">
                    <div className="flex items-center gap-3">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-900">
                        Autonomous Per-Drone Decisions & Order Drops (No Central Controller)
                      </h2>
                      <span className="text-xs font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                        ORDERS DROPPED: {drones.reduce((s, d) => s + d.ordersDropped, 0)}
                      </span>
                    </div>

                    <div className="inline-flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                      <button
                        type="button"
                        onClick={() => setViewportDim('3d')}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          viewportDim === '3d'
                            ? 'bg-slate-900 text-white shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <Box className="w-3.5 h-3.5" />
                        3D Spatial Sim
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewportDim('2d')}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          viewportDim === '2d'
                            ? 'bg-slate-900 text-white shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <MapIcon className="w-3.5 h-3.5" />
                        2D Tactical Map
                      </button>
                    </div>
                  </div>

                  <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
                    {drones.map((d) => {
                      const isSel = d.id === selectedDrone?.id;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setSelectedDroneId(d.id)}
                          className={`text-left p-2 rounded-lg border transition-colors ${
                            !d.alive
                              ? 'bg-rose-50/70 border-rose-200'
                              : isSel
                              ? 'bg-sky-50/70 border-sky-400'
                              : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          <div className="flex items-center justify-between font-mono text-xs">
                            <span className="font-bold text-slate-900">
                              D{d.id} {!d.alive ? '✖' : '●'}
                            </span>
                            <span className="font-semibold text-emerald-700">
                              Dropped: {d.ordersDropped}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] font-mono text-slate-700 line-clamp-2 min-h-[1.9rem]">
                            {d.autonomousDecision}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {viewportDim === '3d' ? (
                  <DroneArena3D
                    simRef={simRef}
                    selectedDroneId={selectedDroneId}
                    onSelectDrone={(id) => setSelectedDroneId(id)}
                    onSpawnTaskAt={(pickup, dropoff) => {
                      sim.spawnCustomTask(pickup, dropoff, 1.7);
                      setRenderTick((t) => t + 1);
                    }}
                    renderTick={renderTick}
                  />
                ) : (
                  <LiveArenaCanvas
                    simRef={simRef}
                    selectedDroneId={selectedDroneId}
                    onSelectDrone={(id) => setSelectedDroneId(id)}
                    onSpawnTaskAt={(pickup, dropoff) => {
                      sim.spawnCustomTask(pickup, dropoff, 1.7);
                      setRenderTick((t) => t + 1);
                    }}
                    renderTick={renderTick}
                  />
                )}

                {/* Peer-to-Peer Communication Forum Message Stream */}
                <section className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                    <div className="flex items-center gap-2">
                      <Radio className="w-4 h-4 text-sky-600" />
                      <h2 className="text-sm font-semibold text-slate-900">
                        Peer-to-Peer Communication Forum Stream (Read-Only Observer Tap)
                      </h2>
                    </div>
                    <span className="text-xs font-mono text-slate-500">
                      {sim.totalMessagesSent} msgs · {(sim.totalBytesSent / 1024).toFixed(1)} KB · {sim.totalPacketsDropped} dropped
                    </span>
                  </div>

                  <div className="mt-3 max-h-48 overflow-y-auto font-mono text-xs divide-y divide-slate-100">
                    {sim.recentForumLog.length === 0 ? (
                      <div className="py-4 text-slate-500 text-center">
                        No forum messages transmitted yet.
                      </div>
                    ) : (
                      sim.recentForumLog.slice(0, 18).map((m) => (
                        <div
                          key={`${m.message_id}-${m.hop_count}-${m.sender_id}`}
                          className="py-1.5 flex items-center justify-between gap-4 text-[11px]"
                        >
                          <div className="flex items-center gap-2.5 truncate">
                            <span className="text-slate-400">
                              t={m.timestamp.toFixed(1)}s
                            </span>
                            <span className="font-semibold text-slate-900">
                              {m.message_id}
                            </span>
                            <span className="text-sky-700 font-semibold">
                              {m.message_type}
                            </span>
                            <span className="text-slate-600">
                              from D{m.sender_id} (hop {m.hop_count}/{m.max_hops})
                            </span>
                            {m.task_id && (
                              <span className="text-slate-800 font-medium">
                                task={m.task_id}
                              </span>
                            )}
                          </div>
                          <span className="text-slate-400 shrink-0">
                            {m.channel} · {m.byte_size}B
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'benchmarks' && (
          <BenchmarkSuiteView data={benchmarkData} loading={benchmarkLoading} />
        )}

        {activeTab === 'architecture' && <ArchitectureView />}
      </main>
    </div>
  );
}
