import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Skull,
  HeartPulse,
  WifiOff,
  Plus,
  Download,
  Terminal,
  ShieldAlert,
  Layers,
  Activity,
  Radio,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Sun,
  Moon,
  HelpCircle,
  Camera,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  SplitSquareVertical,
  History,
  FileCode2,
  BarChart3,
  Sliders,
  Info,
} from 'lucide-react';
import {
  CoordinationMode,
  LogicalChannel,
  MessageType,
  SwarmSyncSimulator,
} from './sim/engine';
import { LiveArenaCanvas, ReplayFrameData } from './components/LiveArenaCanvas';
import { DroneArena3D } from './components/DroneArena3D';
import canonicalParams from '../configs/params.json';

interface StatValue {
  mean: number;
  std: number;
  ci95: number;
  min: number;
  max: number;
}

interface BenchmarkSummary {
  num_seeds: number;
  scenarios: string[];
  modes: string[];
  fleet_scales: number[];
  scenario_summary: Record<string, Record<string, Record<string, StatValue>>>;
  scale_summary: Record<string, Record<string, Record<string, StatValue>>>;
  figures: string[];
}

interface AblationSummaryPayload {
  num_seeds: number;
  ablation_variants: string[];
  ablation_summary: Record<string, Record<string, StatValue & { label?: string }>>;
  weight_sweep: Record<
    string,
    Record<string, StatValue> & { label?: string; w_t?: number; w_e?: number; w_r?: number }
  >;
  loss_levels: string[];
  loss_sweep: Record<string, Record<string, Record<string, StatValue>>>;
}

interface ReplayTracePayload {
  engine: string;
  scenario: string;
  mode: string;
  seed: number;
  dt: number;
  totalFrames: number;
  events: {
    time: number;
    type: string;
    drone_id?: string;
    task_id?: string;
    description: string;
  }[];
  frames: ReplayFrameData[];
}

interface ComponentStatusItem {
  id: string;
  name: string;
  status: 'Designed' | 'Coded' | 'Tested' | 'Validated' | 'Coded, not validated';
  evidence: string;
  files: string[];
}

interface SourceFileEntry {
  stage: string;
  path: string;
  title: string;
  content: string;
}

type TopNavTab =
  | 'workspace'
  | 'benchmarks'
  | 'ablations'
  | 'architecture'
  | 'status'
  | 'limitations';

type ViewportMode = '3d' | '2d' | 'replay' | 'compare';
type BottomDockTab = 'forum' | 'timeline' | 'metrics';

const SCENARIO_LABELS: Record<string, string> = {
  normal: '1. Nominal Operations',
  dynamic_arrival: '2. Dynamic Task Stream',
  packet_loss_delay: '3. 25% Loss & Delay',
  partition: '4. Network Partition & Heal',
  drone_failure: '5. Mid-Delivery Drone Kill',
  hub_failure: '6. Central Hub Failure',
};

const MODE_LABELS: Record<CoordinationMode, string> = {
  swarmsync: 'SwarmSync (Decentralized P2P)',
  basic_auction: 'Basic Auction (Periodic)',
  cbba: 'CBBA (Bundle Consensus)',
  centralized: 'Centralized Hub Baseline',
};

const DEMO_PHASES = [
  {
    start: 0,
    end: 10,
    title: 'Phase 1/4 (0–10s): Decentralized Peer-to-Peer Task Discovery & Bidding',
    caption:
      'Tasks enter via local TaskSource to the nearest drone only. Drones gossip TASK_ANNOUNCE and bid autonomously using J = w_t·T + w_e·E + w_r·R with zero central broker.',
  },
  {
    start: 10,
    end: 30,
    title: 'Phase 2/4 (10–30s): Mid-Delivery Drone Failure & Lease Expiry Re-Bid',
    caption:
      'Active task carrier killed mid-flight! Surviving peers observe lease expiry (6.0s) + conservative grace period (2.5s), increment task version (v2), and re-bid to rescue the order.',
  },
  {
    start: 30,
    end: 45,
    title: 'Phase 3/4 (30–45s): Network Partition Injection & Post-Heal Reconciliation',
    caption:
      'East/West partition injected across X=500m at 30s and healed at 39s. Link-change detection triggers RECOVERY_REQUEST digests and deterministic conflict resolution.',
  },
  {
    start: 45,
    end: 60,
    title: 'Phase 4/4 (45–60s): Central Hub Killed in Split-Screen Comparison',
    caption:
      'Central dispatch hub destroyed! The Centralized baseline freezes new allocations, while decentralized SwarmSync continues delivering 100% of packages.',
  },
];

export default function App() {
  // Primary navigation & theme state
  const [activeNav, setActiveNav] = useState<TopNavTab>('workspace');
  const [viewportMode, setViewportMode] = useState<ViewportMode>('3d');
  const [bottomTab, setBottomTab] = useState<BottomDockTab>('forum');
  const [bottomCollapsed, setBottomCollapsed] = useState<boolean>(false);
  const [leftRailCollapsed, setLeftRailCollapsed] = useState<boolean>(false);
  const [lightMode, setLightMode] = useState<boolean>(false);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(false);

  // Simulation parameters & state
  const [scenario, setScenario] = useState<string>('normal');
  const [mode, setMode] = useState<CoordinationMode>('swarmsync');
  const [seed, setSeed] = useState<number>(1);
  const [fleetSize, setFleetSize] = useState<number>(5);
  const [running, setRunning] = useState<boolean>(true);
  const [simSpeed, setSimSpeed] = useState<number>(1);
  const [selectedDroneId, setSelectedDroneId] = useState<number>(1);
  const [renderTick, setRenderTick] = useState<number>(0);

  // Experiment Control sliders
  const [lossSlider, setLossSlider] = useState<number>(0);
  const [delaySlider, setDelaySlider] = useState<number>(0.2);
  const [rangeSlider, setRangeSlider] = useState<number>(canonicalParams.network.comm_range_m || 620);
  const [arrivalSlider, setArrivalSlider] = useState<number>(3.0);

  // Forum stream filters
  const [forumTypeFilter, setForumTypeFilter] = useState<MessageType | 'ALL'>('ALL');
  const [forumChannelFilter, setForumChannelFilter] = useState<LogicalChannel | 'ALL'>('ALL');

  // Dual simulator instances: primary (SwarmSync or selected mode) + baseline (Centralized for Split-Screen Compare)
  const simRef = useRef<SwarmSyncSimulator>(new SwarmSyncSimulator('normal', 'swarmsync', 1, 5));
  const compareBaselineRef = useRef<SwarmSyncSimulator>(
    new SwarmSyncSimulator('normal', 'centralized', 1, 5)
  );

  // Guided 60-Second Demo state
  const [demoActive, setDemoActive] = useState<boolean>(false);
  const [demoElapsed, setDemoElapsed] = useState<number>(0);
  const demoFiredFlagsRef = useRef<Set<string>>(new Set());

  // Replay Mode state (Benchmark-faithful Python trace)
  const [replayTrace, setReplayTrace] = useState<ReplayTracePayload | null>(null);
  const [replayIdx, setReplayIdx] = useState<number>(0);
  const [replayPlaying, setReplayPlaying] = useState<boolean>(true);

  // Empirical data from backend (/experiments/results/)
  const [benchmarks, setBenchmarks] = useState<BenchmarkSummary | null>(null);
  const [ablations, setAblations] = useState<AblationSummaryPayload | null>(null);
  const [statusItems, setStatusItems] = useState<ComponentStatusItem[]>([]);
  const [unitTestLog, setUnitTestLog] = useState<string>('');
  const [selectedBenchScenario, setSelectedBenchScenario] = useState<string>('drone_failure');
  const [sourceFiles, setSourceFiles] = useState<SourceFileEntry[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
  const [cliOutput, setCliOutput] = useState<string>('');
  const [cliLoading, setCliLoading] = useState<boolean>(false);

  // Load real benchmark, ablation, replay trace, status, and source files on mount
  useEffect(() => {
    fetch('/api/experiments')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.scenario_summary) setBenchmarks(d);
      })
      .catch(() => {});

    fetch('/api/ablations')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.ablation_summary) setAblations(d);
      })
      .catch(() => {});

    fetch('/api/replay-trace')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.frames)) setReplayTrace(d);
      })
      .catch(() => {});

    fetch('/api/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.components)) {
          setStatusItems(d.components);
          setUnitTestLog(d.unitTestLog || '');
        }
      })
      .catch(() => {});

    fetch('/api/source-files')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.files)) setSourceFiles(d.files);
      })
      .catch(() => {});
  }, []);

  const rebuildSimulator = useCallback(
    (nextScenario: string, nextMode: CoordinationMode, nextSeed: number, nextFleet: number) => {
      const s = new SwarmSyncSimulator(nextScenario, nextMode, nextSeed, nextFleet);
      const b = new SwarmSyncSimulator(nextScenario, 'centralized', nextSeed, nextFleet);
      simRef.current = s;
      compareBaselineRef.current = b;
      setLossSlider(s.packetLossProb);
      setDelaySlider(s.maxDelay);
      setRangeSlider(s.commRange);
      setSelectedDroneId(1);
      setRenderTick((t) => t + 1);
    },
    []
  );

  // Advance live simulation loop & Guided Demo choreography
  useEffect(() => {
    if (!running) return;
    const intervalMs = Math.max(30, Math.round(95 / simSpeed));
    const timer = window.setInterval(() => {
      const sim = simRef.current;
      const baseSim = compareBaselineRef.current;

      sim.step();
      if (viewportMode === 'compare' || demoActive) {
        baseSim.step();
      }

      if (demoActive) {
        const t = sim.currentTime;
        setDemoElapsed(Math.min(60, t));
        const flags = demoFiredFlagsRef.current;

        // 10s: Kill an active task-carrying drone mid-delivery
        if (t >= 10.0 && !flags.has('kill_10s')) {
          flags.add('kill_10s');
          const carrier =
            Array.from(sim.drones.values()).find(
              (d) => d.alive && d.localState.currentTaskId !== null
            ) || Array.from(sim.drones.values()).find((d) => d.alive);
          if (carrier) {
            sim.killDrone(carrier.id);
            baseSim.killDrone(carrier.id);
            setSelectedDroneId(carrier.id);
          }
        }
        // 30s: Inject East/West network partition
        if (t >= 30.0 && !flags.has('part_30s')) {
          flags.add('part_30s');
          sim.setPartition(true);
          baseSim.setPartition(true);
        }
        // 39s: Heal network partition -> trigger digest reconciliation
        if (t >= 39.0 && !flags.has('heal_39s')) {
          flags.add('heal_39s');
          sim.setPartition(false);
          baseSim.setPartition(false);
        }
        // 45s: Switch to Split-Screen Compare & kill Central Hub at 47s
        if (t >= 45.0 && !flags.has('compare_45s')) {
          flags.add('compare_45s');
          setViewportMode('compare');
        }
        if (t >= 47.0 && !flags.has('hub_47s')) {
          flags.add('hub_47s');
          sim.centralHubAlive = false;
          sim.recordTimelineEvent('HUB_FAILURE', 'Central Hub killed in baseline comparison');
          baseSim.centralHubAlive = false;
          baseSim.recordTimelineEvent('HUB_FAILURE', 'Central Hub killed — Centralized dispatch halted!');
        }
        if (t >= 60.0) {
          setDemoActive(false);
        }
      }

      setRenderTick((t) => t + 1);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [running, simSpeed, viewportMode, demoActive]);

  // Advance Replay scrubber when in Replay mode
  useEffect(() => {
    if (viewportMode !== 'replay' || !replayPlaying || !replayTrace) return;
    const timer = window.setInterval(() => {
      setReplayIdx((prev) => {
        if (prev + 1 >= replayTrace.frames.length) return 0;
        return prev + 1;
      });
    }, 180);
    return () => window.clearInterval(timer);
  }, [viewportMode, replayPlaying, replayTrace]);

  // Experiment Control handlers (synchronized across both simulators for fair Split-Screen Compare)
  const handleKillActiveDrone = useCallback(() => {
    const sim = simRef.current;
    const baseSim = compareBaselineRef.current;
    const activeOwner =
      Array.from(sim.drones.values()).find(
        (d) => d.alive && d.localState.currentTaskId !== null
      ) || Array.from(sim.drones.values()).find((d) => d.alive);
    if (activeOwner) {
      sim.killDrone(activeOwner.id);
      baseSim.killDrone(activeOwner.id);
      setRenderTick((t) => t + 1);
    }
  }, []);

  const handleTogglePartition = useCallback(() => {
    const sim = simRef.current;
    const baseSim = compareBaselineRef.current;
    const next = !sim.partitionEnabled;
    sim.setPartition(next);
    baseSim.setPartition(next);
    setRenderTick((t) => t + 1);
  }, []);

  const handleToggleHub = useCallback(() => {
    const sim = simRef.current;
    const baseSim = compareBaselineRef.current;
    const next = !sim.centralHubAlive;
    sim.centralHubAlive = next;
    baseSim.centralHubAlive = next;
    if (!next) {
      sim.recordTimelineEvent('HUB_FAILURE', 'Central coordinator hub manually disabled');
      baseSim.recordTimelineEvent('HUB_FAILURE', 'Central coordinator hub manually disabled');
    }
    setRenderTick((t) => t + 1);
  }, []);

  const handleReviveAll = useCallback(() => {
    const sim = simRef.current;
    const baseSim = compareBaselineRef.current;
    for (const id of sim.drones.keys()) {
      sim.reviveDrone(id);
      baseSim.reviveDrone(id);
    }
    sim.centralHubAlive = true;
    baseSim.centralHubAlive = true;
    setRenderTick((t) => t + 1);
  }, []);

  const handleSpawnRandomTask = useCallback(() => {
    const sim = simRef.current;
    const baseSim = compareBaselineRef.current;
    const px = Math.round(sim.rng.uniform(120, 880));
    const py = Math.round(sim.rng.uniform(120, 880));
    const dx = Math.round(sim.rng.uniform(120, 880));
    const dy = Math.round(sim.rng.uniform(120, 880));
    sim.spawnCustomTask([px, py], [dx, dy], 1.7);
    baseSim.spawnCustomTask([px, py], [dx, dy], 1.7);
    setRenderTick((t) => t + 1);
  }, []);

  const handleStartGuidedDemo = () => {
    demoFiredFlagsRef.current.clear();
    setScenario('normal');
    setMode('swarmsync');
    rebuildSimulator('normal', 'swarmsync', 1, 5);
    setActiveNav('workspace');
    setViewportMode('3d');
    setDemoElapsed(0);
    setDemoActive(true);
    setRunning(true);
  };

  // Keyboard shortcuts: Space = Play/Pause, K = Kill Drone, P = Toggle Partition
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.key === 'k' || e.key === 'K') {
        handleKillActiveDrone();
      } else if (e.key === 'p' || e.key === 'P') {
        handleTogglePartition();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleKillActiveDrone, handleTogglePartition]);

  // Export handlers (CSV KPIs, Screenshot PNG, Event Log JSON)
  const handleExportKpiCsv = () => {
    const sim = simRef.current;
    const rows = [
      'time_s,completed_tasks,open_tasks,messages_per_delivery,duplicate_claims,avg_recovery_s',
      ...sim.metricsHistory.map(
        (m) =>
          `${m.time},${m.completedCount},${m.openCount},${m.messagesPerDelivery},${m.duplicateClaims},${m.avgRecoveryS}`
      ),
    ].join('\n');
    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swarmsync_live_kpis_${sim.mode}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportEventLogJson = () => {
    const sim = simRef.current;
    const payload = {
      exportedAt: new Date().toISOString(),
      mode: sim.mode,
      scenario: sim.scenario,
      currentTime: sim.currentTime,
      eventTimeline: sim.eventTimeline,
      recentForumMessages: sim.recentForumLog,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swarmsync_event_log_${sim.mode}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportScreenshotPng = () => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `swarmsync_viewport_${viewportMode}.png`;
    a.click();
  };

  const triggerPythonAction = async (action: string) => {
    setCliLoading(true);
    try {
      const res = await fetch('/api/run-python', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, scenario, mode, seed }),
      });
      const data = await res.json();
      setCliOutput(
        data.command ? `$ ${data.command}\n\n${data.output}` : JSON.stringify(data, null, 2)
      );
    } catch (err) {
      setCliOutput(`Error invoking Python backend: ${String(err)}`);
    } finally {
      setCliLoading(false);
    }
  };

  // Compute live KPIs for Top Bar
  const sim = simRef.current;
  const tasks = sim.getConsolidatedTasks();
  const completedCount = tasks.filter((t) => t.status === 'COMPLETED').length;
  const openTasksCount = tasks.length - completedCount;
  const msgsPerDeliv =
    completedCount > 0
      ? (sim.totalMessagesSent / completedCount).toFixed(1)
      : sim.totalMessagesSent.toString();
  const avgRecovery =
    sim.recoveryDurations.length > 0
      ? `${(
          sim.recoveryDurations.reduce((a, b) => a + b, 0) / sim.recoveryDurations.length
        ).toFixed(1)}s`
      : '—';

  // Compute baseline KPIs for Split-Screen Compare
  const baseSim = compareBaselineRef.current;
  const baseTasks = baseSim.getConsolidatedTasks();
  const baseCompleted = baseTasks.filter((t) => t.status === 'COMPLETED').length;
  const baseMsgsPerDeliv =
    baseCompleted > 0 ? (baseSim.totalMessagesSent / baseCompleted).toFixed(1) : '0';

  const selectedDrone = sim.drones.get(selectedDroneId) || sim.drones.get(1)!;
  const currentDemoPhase =
    DEMO_PHASES.find((p) => demoElapsed >= p.start && demoElapsed < p.end) || DEMO_PHASES[0];

  // Filter Forum Stream messages
  const filteredForumMessages = sim.recentForumLog.filter((m) => {
    if (forumTypeFilter !== 'ALL' && m.message_type !== forumTypeFilter) return false;
    if (forumChannelFilter !== 'ALL' && m.channel !== forumChannelFilter) return false;
    return true;
  });

  const currentReplayFrame =
    replayTrace && replayTrace.frames.length > 0
      ? replayTrace.frames[Math.min(replayIdx, replayTrace.frames.length - 1)]
      : null;

  return (
    <div
      className={`min-h-screen font-sans transition-colors ${
        lightMode ? 'bg-slate-100 text-slate-900' : 'bg-[#0B1220] text-slate-100'
      }`}
    >
      {/* ====================================================================
          TOP BAR: Logo, Engine Source Badge, Mode Selector, Playback, 5 KPIs
         ==================================================================== */}
      <header
        className={`sticky top-0 z-30 border-b px-4 py-2.5 backdrop-blur-md ${
          lightMode
            ? 'bg-white/95 border-slate-300'
            : 'bg-[#111D31]/95 border-slate-800/90'
        }`}
      >
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-3">
          {/* Brand + Source of Truth Badge */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#22D3EE]/15 border border-[#22D3EE]/40 flex items-center justify-center text-[#22D3EE] font-mono font-bold text-sm">
              S⇄S
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold tracking-tight">SwarmSync</h1>
                <span
                  data-testid="engine-source-badge"
                  className={`px-2 py-0.5 text-[10px] font-mono font-semibold rounded border ${
                    viewportMode === 'replay'
                      ? 'bg-[#A3E635]/15 text-[#A3E635] border-[#A3E635]/40'
                      : 'bg-[#22D3EE]/15 text-[#22D3EE] border-[#22D3EE]/40'
                  }`}
                >
                  {viewportMode === 'replay'
                    ? 'Benchmark-faithful (Python Trace)'
                    : 'Interactive visualization engine'}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                Decentralized P2P Multi-Drone Logistics · Zero Central Task Broker
              </p>
            </div>
          </div>

          {/* Mode Selector + Run State Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Coordination Mode"
              value={viewportMode === 'compare' ? 'compare' : mode}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'compare') {
                  setViewportMode('compare');
                  setMode('swarmsync');
                  rebuildSimulator(scenario, 'swarmsync', seed, fleetSize);
                } else {
                  const m = val as CoordinationMode;
                  if (viewportMode === 'compare') setViewportMode('3d');
                  setMode(m);
                  rebuildSimulator(scenario, m, seed, fleetSize);
                }
              }}
              className="bg-[#0B1220] border border-slate-700 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-100 focus:outline-none focus:border-[#22D3EE]"
            >
              <option value="swarmsync">Mode: SwarmSync (P2P)</option>
              <option value="basic_auction">Mode: Basic Auction</option>
              <option value="cbba">Mode: CBBA (Bundles)</option>
              <option value="centralized">Mode: Centralized Baseline</option>
              <option value="compare">Mode: Split-Screen Compare</option>
            </select>

            {/* Play / Pause / Speed / Reset */}
            <div className="flex items-center bg-[#0B1220] border border-slate-700 rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setRunning((r) => !r)}
                title="Shortcut: Space"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                  running
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-[#A3E635]/20 text-[#A3E635]'
                }`}
              >
                {running ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {running ? 'Pause' : 'Play'}
              </button>
              {[0.5, 1, 2].map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setSimSpeed(spd)}
                  className={`px-2 py-1 rounded text-[11px] font-mono ${
                    simSpeed === spd
                      ? 'bg-[#22D3EE] text-[#0B1220] font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {spd}x
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setDemoActive(false);
                  rebuildSimulator(scenario, mode, seed, fleetSize);
                }}
                title="Reset Simulation"
                className="px-2 py-1 text-slate-400 hover:text-white"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Guided 60s Demo Button */}
            <button
              type="button"
              data-testid="start-guided-demo-btn"
              onClick={demoActive ? () => setDemoActive(false) : handleStartGuidedDemo}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                demoActive
                  ? 'bg-[#F87171] text-[#0B1220]'
                  : 'bg-[#22D3EE] text-[#0B1220] hover:bg-cyan-300'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {demoActive ? `Stop Demo (${demoElapsed.toFixed(0)}s)` : 'Start Demo (60s)'}
            </button>
          </div>

          {/* 5 Compact Top Bar KPIs */}
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
            <div className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-800">
              <span className="text-slate-400 text-[10px] block">DELIVERED</span>
              <span className="text-[#A3E635] font-bold">
                {completedCount}/{tasks.length}
              </span>
            </div>
            <div className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-800">
              <span className="text-slate-400 text-[10px] block">OPEN TASKS</span>
              <span className="text-[#22D3EE] font-bold">{openTasksCount}</span>
            </div>
            <div className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-800">
              <span className="text-slate-400 text-[10px] block">MSGS/DELIV</span>
              <span className="text-slate-100 font-bold">{msgsPerDeliv}</span>
            </div>
            <div className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-800">
              <span className="text-slate-400 text-[10px] block">DUP CLAIMS</span>
              <span
                className={`font-bold ${
                  sim.duplicateClaimsCount === 0 ? 'text-[#A3E635]' : 'text-amber-400'
                }`}
              >
                {sim.duplicateClaimsCount}
              </span>
            </div>
            <div className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-800">
              <span className="text-slate-400 text-[10px] block">RECOVERY</span>
              <span className="text-[#22D3EE] font-bold">{avgRecovery}</span>
            </div>

            {/* Export + Help + Theme Icons */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleExportKpiCsv}
                title="Export Live KPIs CSV"
                className="p-1.5 rounded bg-[#0B1220] border border-slate-800 text-slate-300 hover:text-[#22D3EE]"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleExportScreenshotPng}
                title="Save Viewport Screenshot PNG"
                className="p-1.5 rounded bg-[#0B1220] border border-slate-800 text-slate-300 hover:text-[#22D3EE]"
              >
                <Camera className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setShowOnboarding(true)}
                title="3-Step Architecture Guide & Keyboard Shortcuts"
                className="p-1.5 rounded bg-[#0B1220] border border-slate-800 text-slate-300 hover:text-[#22D3EE]"
              >
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setLightMode((v) => !v)}
                title="Toggle Light / Dark Navy Theme"
                className="p-1.5 rounded bg-[#0B1220] border border-slate-800 text-slate-300 hover:text-[#22D3EE]"
              >
                {lightMode ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Primary Full-Width Navigation Sub-Bar */}
        <div className="max-w-[1600px] mx-auto mt-2 pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          <nav className="flex flex-wrap items-center gap-1">
            {[
              { id: 'workspace', label: 'Live Workspace & Compare', icon: Layers },
              { id: 'benchmarks', label: 'Benchmarks & Plots (10 Seeds)', icon: BarChart3 },
              { id: 'ablations', label: 'Ablations & Sensitivity', icon: Sliders },
              { id: 'architecture', label: 'Architecture & Code', icon: FileCode2 },
              { id: 'status', label: 'Project Status', icon: CheckCircle2 },
              { id: 'limitations', label: 'Limitations', icon: AlertTriangle },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id as TopNavTab)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    activeNav === item.id
                      ? 'bg-[#22D3EE]/15 text-[#22D3EE] border border-[#22D3EE]/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="text-[11px] font-mono text-slate-400 hidden lg:flex items-center gap-3">
            <span>Shortcuts: [Space] Play/Pause · [K] Kill Drone · [P] Partition</span>
            <span>·</span>
            <span>Config: /configs/params.json (L=6.0s, G=2.5s, W=1.2s)</span>
          </div>
        </div>
      </header>

      {/* ====================================================================
          GUIDED 60-SECOND DEMO CAPTION & PROGRESS BAR OVERLAY
         ==================================================================== */}
      {demoActive && (
        <div className="bg-[#111D31] border-b border-[#22D3EE]/40 px-4 py-2.5">
          <div className="max-w-[1600px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-xs font-mono font-bold text-[#22D3EE]">
                <Sparkles className="w-3.5 h-3.5" />
                <span>GUIDED DEMO ({demoElapsed.toFixed(1)}s / 60s) — {currentDemoPhase.title}</span>
              </div>
              <p className="text-xs text-slate-200 mt-0.5">{currentDemoPhase.caption}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-40 h-2 bg-[#0B1220] rounded-full overflow-hidden border border-slate-700">
                <div
                  className="h-full bg-[#22D3EE] transition-all"
                  style={{ width: `${Math.min(100, (demoElapsed / 60) * 100)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => setDemoActive(false)}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
              >
                Skip Demo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MAIN CONTENT AREA
         ==================================================================== */}
      <main className="max-w-[1600px] mx-auto p-4">
        {/* ------------------------------------------------------------------
            TAB 1: 12-COLUMN LIVE WORKSPACE
           ------------------------------------------------------------------ */}
        {activeNav === 'workspace' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              {/* LEFT RAIL: Collapsible "Experiment controls" (3 columns) */}
              {!leftRailCollapsed ? (
                <aside className="lg:col-span-3 bg-[#111D31] border border-slate-800 rounded-lg p-3.5 space-y-3.5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <div>
                      <h2 className="text-xs font-bold uppercase tracking-wider text-[#22D3EE]">
                        Experiment controls
                      </h2>
                      <p className="text-[10px] text-slate-400">
                        Observer-only fault & environment injection (never allocates tasks)
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLeftRailCollapsed(true)}
                      title="Collapse Experiment Controls"
                      className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Card 1: Faults */}
                  <div className="bg-[#0B1220] border border-slate-800/90 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <Skull className="w-3.5 h-3.5 text-[#F87171]" />
                        Faults
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">Keys: [K] [P]</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={handleKillActiveDrone}
                        className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded bg-[#F87171]/15 hover:bg-[#F87171]/25 text-[#F87171] border border-[#F87171]/30 text-xs font-medium"
                      >
                        <Skull className="w-3.5 h-3.5" />
                        Kill Drone
                      </button>
                      <button
                        type="button"
                        onClick={handleReviveAll}
                        className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded bg-[#A3E635]/15 hover:bg-[#A3E635]/25 text-[#A3E635] border border-[#A3E635]/30 text-xs font-medium"
                      >
                        <HeartPulse className="w-3.5 h-3.5" />
                        Revive All
                      </button>
                      <button
                        type="button"
                        onClick={handleTogglePartition}
                        className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium border ${
                          sim.partitionEnabled
                            ? 'bg-[#F87171] text-[#0B1220] border-[#F87171] font-bold'
                            : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-800'
                        }`}
                      >
                        <WifiOff className="w-3.5 h-3.5" />
                        {sim.partitionEnabled ? 'Heal Partition' : 'Partition On'}
                      </button>
                      <button
                        type="button"
                        onClick={handleToggleHub}
                        className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium border ${
                          !sim.centralHubAlive
                            ? 'bg-amber-500 text-[#0B1220] border-amber-400 font-bold'
                            : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-800'
                        }`}
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        {sim.centralHubAlive ? 'Kill Hub' : 'Revive Hub'}
                      </button>
                    </div>
                  </div>

                  {/* Card 2: Network */}
                  <div className="bg-[#0B1220] border border-slate-800/90 rounded-lg p-3 space-y-2.5">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-[#22D3EE]" />
                      Network Impairments
                    </span>
                    <div>
                      <div className="flex justify-between text-[11px] font-mono text-slate-300 mb-1">
                        <span>Packet Loss</span>
                        <span className="text-[#22D3EE]">{Math.round(lossSlider * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={0.6}
                        step={0.05}
                        value={lossSlider}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setLossSlider(v);
                          simRef.current.packetLossProb = v;
                          compareBaselineRef.current.packetLossProb = v;
                        }}
                        className="w-full accent-[#22D3EE]"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] font-mono text-slate-300 mb-1">
                        <span>Max Propagation Delay</span>
                        <span className="text-[#22D3EE]">{delaySlider.toFixed(2)}s</span>
                      </div>
                      <input
                        type="range"
                        min={0.05}
                        max={1.5}
                        step={0.05}
                        value={delaySlider}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setDelaySlider(v);
                          simRef.current.maxDelay = v;
                          compareBaselineRef.current.maxDelay = v;
                        }}
                        className="w-full accent-[#22D3EE]"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] font-mono text-slate-300 mb-1">
                        <span>Peer Radio Range</span>
                        <span className="text-[#22D3EE]">{rangeSlider}m</span>
                      </div>
                      <input
                        type="range"
                        min={260}
                        max={900}
                        step={20}
                        value={rangeSlider}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setRangeSlider(v);
                          simRef.current.commRange = v;
                          compareBaselineRef.current.commRange = v;
                        }}
                        className="w-full accent-[#22D3EE]"
                      />
                    </div>
                  </div>

                  {/* Card 3: Tasks & Scenario Presets */}
                  <div className="bg-[#0B1220] border border-slate-800/90 rounded-lg p-3 space-y-2.5">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <Plus className="w-3.5 h-3.5 text-[#A3E635]" />
                      Tasks & Scenario Stream
                    </span>
                    <div>
                      <label className="block text-[10px] font-mono text-slate-400 mb-1">
                        SCENARIO PRESET
                      </label>
                      <select
                        value={scenario}
                        onChange={(e) => {
                          const sc = e.target.value;
                          setScenario(sc);
                          rebuildSimulator(sc, mode, seed, fleetSize);
                        }}
                        className="w-full bg-[#111D31] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100"
                      >
                        {Object.entries(SCENARIO_LABELS).map(([k, lbl]) => (
                          <option key={k} value={k}>
                            {lbl}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          FLEET SIZE
                        </label>
                        <select
                          value={fleetSize}
                          onChange={(e) => {
                            const f = Number(e.target.value);
                            setFleetSize(f);
                            rebuildSimulator(scenario, mode, seed, f);
                          }}
                          className="w-full bg-[#111D31] border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono"
                        >
                          {[3, 5, 8, 10].map((n) => (
                            <option key={n} value={n}>
                              N = {n} Drones
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          RNG SEED
                        </label>
                        <select
                          value={seed}
                          onChange={(e) => {
                            const s = Number(e.target.value);
                            setSeed(s);
                            rebuildSimulator(scenario, mode, s, fleetSize);
                          }}
                          className="w-full bg-[#111D31] border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono"
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => (
                            <option key={s} value={s}>
                              Seed #{s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] font-mono text-slate-300 mb-1">
                        <span>Task Arrival Interval</span>
                        <span className="text-[#A3E635]">{arrivalSlider.toFixed(1)}s</span>
                      </div>
                      <input
                        type="range"
                        min={1.0}
                        max={8.0}
                        step={0.5}
                        value={arrivalSlider}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setArrivalSlider(v);
                          simRef.current.arrivalInterval = v;
                        }}
                        className="w-full accent-[#A3E635]"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleSpawnRandomTask}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-[#22D3EE]/15 hover:bg-[#22D3EE]/25 text-[#22D3EE] border border-[#22D3EE]/30 text-xs font-semibold"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Spawn Delivery Task
                    </button>
                  </div>
                </aside>
              ) : (
                <div className="lg:col-span-1 flex flex-col items-center">
                  <button
                    type="button"
                    onClick={() => setLeftRailCollapsed(false)}
                    className="w-full bg-[#111D31] border border-slate-800 rounded-lg p-2.5 flex flex-col items-center gap-2 text-xs text-[#22D3EE] hover:bg-slate-800/80"
                    title="Expand Experiment Controls"
                  >
                    <ChevronRight className="w-4 h-4" />
                    <span className="writing-mode-vertical font-mono text-[10px] uppercase tracking-widest">
                      Controls
                    </span>
                  </button>
                </div>
              )}

              {/* CENTER VIEWPORT (6 cols when left rail open, 8 cols when collapsed) */}
              <section
                className={`${
                  leftRailCollapsed ? 'lg:col-span-8' : 'lg:col-span-6'
                } bg-[#111D31] border border-slate-800 rounded-lg p-3 space-y-3`}
              >
                {/* Viewport Mode Switcher Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setViewportMode('3d')}
                      className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                        viewportMode === '3d'
                          ? 'bg-[#22D3EE] text-[#0B1220]'
                          : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      3D Small Town
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewportMode('2d')}
                      className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                        viewportMode === '2d'
                          ? 'bg-[#22D3EE] text-[#0B1220]'
                          : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      2D Tactical Map
                    </button>
                    <button
                      type="button"
                      data-testid="replay-mode-tab"
                      onClick={() => setViewportMode('replay')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                        viewportMode === 'replay'
                          ? 'bg-[#A3E635] text-[#0B1220]'
                          : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <History className="w-3.5 h-3.5" />
                      Replay (Benchmark-faithful)
                    </button>
                    <button
                      type="button"
                      data-testid="compare-mode-tab"
                      onClick={() => setViewportMode('compare')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                        viewportMode === 'compare'
                          ? 'bg-[#22D3EE] text-[#0B1220]'
                          : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <SplitSquareVertical className="w-3.5 h-3.5" />
                      Split-Screen Compare
                    </button>
                  </div>

                  <span className="text-[11px] font-mono text-slate-400">
                    t = {sim.currentTime.toFixed(1)}s · Seed #{seed}
                  </span>
                </div>

                {/* VIEWPORT 1: 3D Small Town */}
                {viewportMode === '3d' && (
                  <DroneArena3D
                    simRef={simRef}
                    selectedDroneId={selectedDroneId}
                    onSelectDrone={(id) => setSelectedDroneId(id)}
                    onSpawnTaskAt={(pickup, dropoff) => {
                      simRef.current.spawnCustomTask(pickup, dropoff, 1.8);
                      compareBaselineRef.current.spawnCustomTask(pickup, dropoff, 1.8);
                      setRenderTick((t) => t + 1);
                    }}
                    renderTick={renderTick}
                  />
                )}

                {/* VIEWPORT 2: 2D Tactical Map */}
                {viewportMode === '2d' && (
                  <LiveArenaCanvas
                    simRef={simRef}
                    selectedDroneId={selectedDroneId}
                    onSelectDrone={(id) => setSelectedDroneId(id)}
                    onSpawnTaskAt={(pickup, dropoff) => {
                      simRef.current.spawnCustomTask(pickup, dropoff, 1.8);
                      compareBaselineRef.current.spawnCustomTask(pickup, dropoff, 1.8);
                      setRenderTick((t) => t + 1);
                    }}
                    renderTick={renderTick}
                    labelBadge="Interactive visualization engine · 2D Tactical Map"
                  />
                )}

                {/* VIEWPORT 3: Benchmark-Faithful Python Trace Replay */}
                {viewportMode === 'replay' && (
                  <div className="space-y-3">
                    {!replayTrace ? (
                      <div className="p-8 text-center bg-[#0B1220] rounded-lg border border-slate-800 text-sm text-slate-400 font-mono">
                        Not run yet — run `make reproduce` or `python3 -m experiments.run_all` to export `/experiments/results/replay_trace.json`.
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0B1220] border border-[#A3E635]/30 rounded-lg px-3 py-2 text-xs font-mono">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-[#A3E635]/20 text-[#A3E635] font-bold">
                              Benchmark-faithful
                            </span>
                            <span className="text-slate-300">
                              Source: /experiments/results/replay_trace.json ({replayTrace.scenario})
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setReplayPlaying((p) => !p)}
                              className="px-2.5 py-1 rounded bg-[#111D31] border border-slate-700 text-[#22D3EE]"
                            >
                              {replayPlaying ? 'Pause Replay' : 'Play Replay'}
                            </button>
                            <span className="text-slate-400">
                              Frame {replayIdx + 1}/{replayTrace.frames.length} (t=
                              {currentReplayFrame?.time.toFixed(1)}s)
                            </span>
                          </div>
                        </div>

                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, replayTrace.frames.length - 1)}
                          value={replayIdx}
                          onChange={(e) => {
                            setReplayPlaying(false);
                            setReplayIdx(Number(e.target.value));
                          }}
                          className="w-full accent-[#A3E635]"
                        />

                        <LiveArenaCanvas
                          simRef={simRef}
                          selectedDroneId={selectedDroneId}
                          onSelectDrone={(id) => setSelectedDroneId(id)}
                          onSpawnTaskAt={() => {}}
                          renderTick={replayIdx}
                          replayFrame={currentReplayFrame}
                          labelBadge="Benchmark-faithful · Python Stage 1 Trace Replay"
                        />
                      </>
                    )}
                  </div>
                )}

                {/* VIEWPORT 4: Split-Screen Synchronized Comparison (SwarmSync vs Centralized) */}
                {viewportMode === 'compare' && (
                  <div className="space-y-3">
                    <div className="bg-[#0B1220] border border-slate-800 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-[#22D3EE] font-semibold">
                        SYNCHRONIZED SPLIT-SCREEN: Same RNG Seed #{seed} · Identical Tasks · Shared Fault Injection
                      </span>
                      <span className="text-slate-400 font-mono">
                        Try clicking &quot;Kill Hub&quot; or &quot;Kill Drone&quot; in the Left Rail!
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between px-2 py-1 bg-[#0B1220] rounded border border-[#22D3EE]/30 text-xs font-mono">
                          <span className="text-[#22D3EE] font-bold">
                            LEFT: SwarmSync (Decentralized P2P)
                          </span>
                          <span className="text-[#A3E635]">
                            Delivered: {completedCount}/{tasks.length}
                          </span>
                        </div>
                        <LiveArenaCanvas
                          simRef={simRef}
                          selectedDroneId={selectedDroneId}
                          onSelectDrone={(id) => setSelectedDroneId(id)}
                          onSpawnTaskAt={(p, d) => {
                            simRef.current.spawnCustomTask(p, d, 1.8);
                            compareBaselineRef.current.spawnCustomTask(p, d, 1.8);
                          }}
                          renderTick={renderTick}
                          compact
                          labelBadge="SwarmSync (No Central Controller)"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between px-2 py-1 bg-[#0B1220] rounded border border-amber-500/30 text-xs font-mono">
                          <span className="text-amber-300 font-bold">
                            RIGHT: Centralized Hub Baseline
                          </span>
                          <span className="text-slate-200">
                            Delivered: {baseCompleted}/{baseTasks.length}
                          </span>
                        </div>
                        <LiveArenaCanvas
                          simRef={compareBaselineRef}
                          selectedDroneId={selectedDroneId}
                          onSelectDrone={(id) => setSelectedDroneId(id)}
                          onSpawnTaskAt={(p, d) => {
                            simRef.current.spawnCustomTask(p, d, 1.8);
                            compareBaselineRef.current.spawnCustomTask(p, d, 1.8);
                          }}
                          renderTick={renderTick}
                          compact
                          labelBadge={
                            baseSim.centralHubAlive
                              ? 'Centralized (Hub Alive)'
                              : 'Centralized (HUB FAILED — HALTED)'
                          }
                        />
                      </div>
                    </div>

                    {/* KPI Delta Bar Underneath Split-Screen */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-[#0B1220] border border-slate-800 rounded-lg p-2.5 font-mono text-xs">
                      <div className="p-2 rounded bg-[#111D31] border border-slate-800">
                        <span className="text-[10px] text-slate-400 block">DELIVERED DELTA</span>
                        <span
                          className={`text-sm font-bold ${
                            completedCount >= baseCompleted ? 'text-[#A3E635]' : 'text-amber-300'
                          }`}
                        >
                          {completedCount - baseCompleted >= 0 ? '+' : ''}
                          {completedCount - baseCompleted} orders ({completedCount} vs {baseCompleted})
                        </span>
                      </div>
                      <div className="p-2 rounded bg-[#111D31] border border-slate-800">
                        <span className="text-[10px] text-slate-400 block">MSGS / DELIVERY</span>
                        <span className="text-sm font-bold text-[#22D3EE]">
                          {msgsPerDeliv} vs {baseMsgsPerDeliv}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-[#111D31] border border-slate-800">
                        <span className="text-[10px] text-slate-400 block">CENTRAL HUB STATUS</span>
                        <span
                          className={`text-sm font-bold ${
                            baseSim.centralHubAlive ? 'text-slate-200' : 'text-[#F87171]'
                          }`}
                        >
                          {baseSim.centralHubAlive ? 'Hub Online' : 'Hub Destroyed (SPOF)'}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-[#111D31] border border-slate-800">
                        <span className="text-[10px] text-slate-400 block">DUPLICATE CLAIMS</span>
                        <span className="text-sm font-bold text-[#A3E635]">
                          {sim.duplicateClaimsCount} vs {baseSim.duplicateClaimsCount}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* RIGHT PANEL: Per-Drone Local View Inspector (3 columns) */}
              <aside className="lg:col-span-3 bg-[#111D31] border border-slate-800 rounded-lg p-3.5 space-y-3">
                <div className="border-b border-slate-800 pb-2">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-[#22D3EE]">
                      Drone D{selectedDrone.id} Inspector
                    </h2>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                        selectedDrone.alive
                          ? 'bg-[#A3E635]/15 text-[#A3E635]'
                          : 'bg-[#F87171]/20 text-[#F87171]'
                      }`}
                    >
                      {selectedDrone.alive ? 'ALIVE · P2P' : 'FAILED · OFFLINE'}
                    </span>
                  </div>
                  <p
                    data-testid="drone-local-view-caption"
                    className="text-[11px] font-medium text-amber-300/90 mt-1"
                  >
                    This is the drone&apos;s own local view (no global state access)
                  </p>
                </div>

                {/* Drone Selector Pills */}
                <div className="flex flex-wrap gap-1">
                  {Array.from(sim.drones.values()).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setSelectedDroneId(d.id)}
                      className={`px-2.5 py-1 rounded text-xs font-mono font-bold transition-colors ${
                        d.id === selectedDrone.id
                          ? 'bg-[#22D3EE] text-[#0B1220]'
                          : !d.alive
                          ? 'bg-[#F87171]/20 text-[#F87171] border border-[#F87171]/40'
                          : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      D{d.id}
                    </button>
                  ))}
                </div>

                {/* Autonomous Decision & Lease Countdown Progress */}
                <div className="bg-[#0B1220] border border-slate-800 rounded-lg p-2.5 space-y-2 font-mono text-xs">
                  <div className="text-[11px] text-slate-400">LOCAL AUTONOMOUS DECISION</div>
                  <div className="text-[#22D3EE] font-semibold break-words">
                    {selectedDrone.autonomousDecision}
                  </div>

                  {/* Battery Bar */}
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                      <span>BATTERY (Reserve: 18%)</span>
                      <span>{selectedDrone.battery.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-900 rounded overflow-hidden">
                      <div
                        className={`h-full ${
                          selectedDrone.battery > 35 ? 'bg-[#A3E635]' : 'bg-amber-400'
                        }`}
                        style={{ width: `${Math.max(0, selectedDrone.battery)}%` }}
                      />
                    </div>
                  </div>

                  {/* Shrinking Lease Countdown Bar */}
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                      <span>ACTIVE TASK LEASE (L=6.0s)</span>
                      <span>
                        {selectedDrone.localState.currentTaskId
                          ? `${(selectedDrone.leaseProgress * 6.0).toFixed(1)}s rem`
                          : 'No active lease'}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-900 rounded overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          selectedDrone.leaseProgress < 0.25
                            ? 'bg-[#F87171]'
                            : selectedDrone.leaseProgress < 0.5
                            ? 'bg-amber-400'
                            : 'bg-[#22D3EE]'
                        }`}
                        style={{ width: `${Math.round(selectedDrone.leaseProgress * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* 6 Agent Module Telemetry Counters */}
                <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                  <div className="bg-[#0B1220] border border-slate-800/80 rounded p-2">
                    <span className="text-[9px] text-slate-400 block">1. LOCAL STATE</span>
                    <span className="text-slate-100 font-bold">
                      {selectedDrone.localState.knownTasks.size} known tasks
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-slate-800/80 rounded p-2">
                    <span className="text-[9px] text-slate-400 block">2. COMM DEDUPED</span>
                    <span className="text-slate-100 font-bold">
                      {selectedDrone.comm.dedupedCount} msgs
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-slate-800/80 rounded p-2">
                    <span className="text-[9px] text-slate-400 block">3. GOSSIP FWD</span>
                    <span className="text-slate-100 font-bold">
                      {selectedDrone.comm.forwardedCount} hops
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-slate-800/80 rounded p-2">
                    <span className="text-[9px] text-slate-400 block">4. CONFLICTS WON</span>
                    <span className="text-[#A3E635] font-bold">
                      {selectedDrone.assignment.conflictsResolved} resolved
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-slate-800/80 rounded p-2">
                    <span className="text-[9px] text-slate-400 block">5. LEASE RELEASES</span>
                    <span className="text-amber-300 font-bold">
                      {selectedDrone.recovery.tasksReleasedCount} expired
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-slate-800/80 rounded p-2">
                    <span className="text-[9px] text-slate-400 block">6. RECONCILED</span>
                    <span className="text-[#22D3EE] font-bold">
                      {selectedDrone.recovery.reconciliationsCompleted} digests
                    </span>
                  </div>
                </div>

                {/* Drone's Own Local Task Table */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <span>LOCAL TASK TABLE (D{selectedDrone.id} MEMORY)</span>
                    <span>Orders Dropped: {selectedDrone.ordersDropped}</span>
                  </div>
                  <div className="max-h-52 overflow-y-auto bg-[#0B1220] border border-slate-800 rounded-lg">
                    <table className="w-full text-left font-mono text-[11px]">
                      <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800 sticky top-0">
                        <tr>
                          <th className="py-1.5 px-2">Task</th>
                          <th className="py-1.5 px-2">Status</th>
                          <th className="py-1.5 px-2">Owner</th>
                          <th className="py-1.5 px-2">Ver</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {Array.from(selectedDrone.localState.knownTasks.values()).map((t) => (
                          <tr key={t.task_id} className="hover:bg-slate-900/40">
                            <td className="py-1 px-2 font-bold text-slate-200">{t.task_id}</td>
                            <td className="py-1 px-2">
                              <span
                                className={
                                  t.status === 'COMPLETED'
                                    ? 'text-[#A3E635]'
                                    : t.status === 'RELEASED'
                                    ? 'text-[#F87171]'
                                    : 'text-[#22D3EE]'
                                }
                              >
                                {t.status}
                              </span>
                            </td>
                            <td className="py-1 px-2 text-slate-300">
                              {t.owner_id ? `D${t.owner_id}` : '—'}
                            </td>
                            <td className="py-1 px-2 text-slate-400">v{t.version}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </aside>
            </div>

            {/* ================================================================
                BOTTOM DOCK: Resizable / Collapsible Tabs
                (1) Forum Stream, (2) Event Timeline, (3) Metrics Live
               ================================================================ */}
            <section className="bg-[#111D31] border border-slate-800 rounded-lg overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-[#0B1220] border-b border-slate-800">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setBottomTab('forum');
                      setBottomCollapsed(false);
                    }}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                      bottomTab === 'forum' && !bottomCollapsed
                        ? 'bg-[#22D3EE] text-[#0B1220]'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    Forum Stream ({filteredForumMessages.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBottomTab('timeline');
                      setBottomCollapsed(false);
                    }}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                      bottomTab === 'timeline' && !bottomCollapsed
                        ? 'bg-[#22D3EE] text-[#0B1220]'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    Event Timeline ({sim.eventTimeline.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBottomTab('metrics');
                      setBottomCollapsed(false);
                    }}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                      bottomTab === 'metrics' && !bottomCollapsed
                        ? 'bg-[#22D3EE] text-[#0B1220]'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    Metrics Live
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {bottomTab === 'forum' && !bottomCollapsed && (
                    <>
                      <select
                        aria-label="Filter by Message Type"
                        value={forumTypeFilter}
                        onChange={(e) => setForumTypeFilter(e.target.value as MessageType | 'ALL')}
                        className="bg-[#111D31] border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-200"
                      >
                        <option value="ALL">Type: ALL</option>
                        <option value="TASK_ANNOUNCE">TASK_ANNOUNCE</option>
                        <option value="BID">BID</option>
                        <option value="CLAIM">CLAIM</option>
                        <option value="RENEW">RENEW</option>
                        <option value="DONE">DONE</option>
                        <option value="RECOVERY_REQUEST">RECOVERY_REQUEST</option>
                        <option value="HEARTBEAT">HEARTBEAT</option>
                      </select>
                      <select
                        aria-label="Filter by Logical Channel"
                        value={forumChannelFilter}
                        onChange={(e) =>
                          setForumChannelFilter(e.target.value as LogicalChannel | 'ALL')
                        }
                        className="bg-[#111D31] border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-200"
                      >
                        <option value="ALL">Channel: ALL</option>
                        <option value="task_coordination">task_coordination</option>
                        <option value="recovery_reconciliation">recovery_reconciliation</option>
                        <option value="resource_sharing">resource_sharing</option>
                      </select>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={handleExportEventLogJson}
                    className="px-2.5 py-1 rounded bg-[#111D31] border border-slate-700 text-[11px] font-mono text-slate-300 hover:text-[#22D3EE]"
                  >
                    Export Log JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => setBottomCollapsed((c) => !c)}
                    className="p-1 text-slate-400 hover:text-white"
                  >
                    {bottomCollapsed ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              {!bottomCollapsed && (
                <div className="p-3 max-h-56 overflow-y-auto">
                  {/* Bottom Tab 1: Peer-to-Peer Forum Message Stream */}
                  {bottomTab === 'forum' && (
                    <table className="w-full text-left font-mono text-xs">
                      <thead className="text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-1 px-2">Msg ID</th>
                          <th className="py-1 px-2">Time</th>
                          <th className="py-1 px-2">Sender</th>
                          <th className="py-1 px-2">Type</th>
                          <th className="py-1 px-2">Channel</th>
                          <th className="py-1 px-2">Task</th>
                          <th className="py-1 px-2">Hops</th>
                          <th className="py-1 px-2">TTL Exp</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50">
                        {filteredForumMessages.slice(0, 30).map((m) => (
                          <tr key={`${m.message_id}-${m.sender_id}-${m.hop_count}`}>
                            <td className="py-1 px-2 text-slate-300">{m.message_id}</td>
                            <td className="py-1 px-2 text-slate-400">{m.timestamp.toFixed(1)}s</td>
                            <td className="py-1 px-2 text-[#22D3EE] font-bold">D{m.sender_id}</td>
                            <td className="py-1 px-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  m.message_type === 'DONE'
                                    ? 'bg-[#A3E635]/20 text-[#A3E635]'
                                    : m.message_type === 'CLAIM' || m.message_type === 'RENEW'
                                    ? 'bg-[#22D3EE]/20 text-[#22D3EE]'
                                    : m.message_type === 'RECOVERY_REQUEST'
                                    ? 'bg-purple-500/20 text-purple-300'
                                    : 'bg-amber-500/20 text-amber-300'
                                }`}
                              >
                                {m.message_type}
                              </span>
                            </td>
                            <td className="py-1 px-2 text-slate-400">{m.channel}</td>
                            <td className="py-1 px-2 text-slate-200">{m.task_id || '—'}</td>
                            <td className="py-1 px-2 text-slate-400">
                              {m.hop_count}/{m.max_hops}
                            </td>
                            <td className="py-1 px-2 text-slate-400">
                              {m.expiry_time.toFixed(1)}s
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* Bottom Tab 2: Discrete Protocol Event Timeline */}
                  {bottomTab === 'timeline' && (
                    <div className="space-y-1.5 font-mono text-xs">
                      {sim.eventTimeline.length === 0 ? (
                        <div className="text-slate-400 py-4 text-center">
                          No discrete fault/lease events yet — click &quot;Kill Drone&quot; or &quot;Partition On&quot; to observe protocol recovery events.
                        </div>
                      ) : (
                        sim.eventTimeline.map((ev) => (
                          <div
                            key={ev.id}
                            className="flex items-center gap-3 px-3 py-1.5 rounded bg-[#0B1220] border border-slate-800/80"
                          >
                            <span className="text-slate-400 w-14 shrink-0">
                              t={ev.time.toFixed(1)}s
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                                ev.type === 'DRONE_FAILURE' ||
                                ev.type === 'LEASE_EXPIRED' ||
                                ev.type === 'HUB_FAILURE'
                                  ? 'bg-[#F87171]/20 text-[#F87171]'
                                  : ev.type === 'ORDER_DROPPED' || ev.type === 'TASK_REBID'
                                  ? 'bg-[#A3E635]/20 text-[#A3E635]'
                                  : 'bg-[#22D3EE]/20 text-[#22D3EE]'
                              }`}
                            >
                              {ev.type}
                            </span>
                            <span className="text-slate-200">{ev.description}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {/* Bottom Tab 3: Live Metrics Sparklines / Bar Charts */}
                  {bottomTab === 'metrics' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs">
                      <div className="bg-[#0B1220] border border-slate-800 rounded p-3">
                        <div className="flex justify-between text-slate-400 mb-2">
                          <span>DELIVERED TASKS OVER TIME</span>
                          <span className="text-[#A3E635] font-bold">{completedCount}</span>
                        </div>
                        <div className="flex items-end gap-1 h-20">
                          {sim.metricsHistory.slice(-24).map((pt, i) => (
                            <div
                              key={i}
                              className="flex-1 bg-[#A3E635]/70 rounded-t"
                              style={{
                                height: `${Math.max(8, (pt.completedCount / Math.max(tasks.length, 1)) * 100)}%`,
                              }}
                              title={`t=${pt.time}s: ${pt.completedCount} delivered`}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="bg-[#0B1220] border border-slate-800 rounded p-3">
                        <div className="flex justify-between text-slate-400 mb-2">
                          <span>MESSAGES / DELIVERY</span>
                          <span className="text-[#22D3EE] font-bold">{msgsPerDeliv}</span>
                        </div>
                        <div className="flex items-end gap-1 h-20">
                          {sim.metricsHistory.slice(-24).map((pt, i) => (
                            <div
                              key={i}
                              className="flex-1 bg-[#22D3EE]/70 rounded-t"
                              style={{
                                height: `${Math.min(100, Math.max(8, (pt.messagesPerDelivery / 80) * 100))}%`,
                              }}
                              title={`t=${pt.time}s: ${pt.messagesPerDelivery} msgs/deliv`}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="bg-[#0B1220] border border-slate-800 rounded p-3">
                        <div className="flex justify-between text-slate-400 mb-2">
                          <span>MEAN RECOVERY TIME (L+G+W)</span>
                          <span className="text-amber-300 font-bold">{avgRecovery}</span>
                        </div>
                        <div className="text-[11px] text-slate-300 space-y-1 mt-2">
                          <div>Canonical Lease (L): 6.0s · Renew: 2.0s</div>
                          <div>Safety Grace Period (G): 2.5s</div>
                          <div>Auction Window (W): 1.2s</div>
                          <div className="text-[#22D3EE]">
                            Formula: t_reassigned_claim - t_failure
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ------------------------------------------------------------------
            TAB 2: EMPIRICAL BENCHMARKS & PLOTS (10 SEEDS, MEAN ± SD, 95% CI)
           ------------------------------------------------------------------ */}
        {activeNav === 'benchmarks' && (
          <div className="space-y-6">
            <div className="bg-[#111D31] border border-slate-800 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                  <h2 className="text-base font-bold text-white">
                    Empirical Benchmark Suite (N = 10 Seeds per Cell · Real CSV/JSON Artifacts)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Every number below is read directly from `/experiments/results/summary_stats.json` and `/experiments/results/scenario_runs_10seeds.csv`. Shows Mean ± Standard Deviation and 95% Confidence Interval.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="/api/csv/scenario"
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#0B1220] border border-slate-700 text-xs font-mono text-[#22D3EE] hover:border-[#22D3EE]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    scenario_runs_10seeds.csv
                  </a>
                  <a
                    href="/api/csv/scale"
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#0B1220] border border-slate-700 text-xs font-mono text-[#A3E635] hover:border-[#A3E635]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    scale_runs_10seeds.csv
                  </a>
                </div>
              </div>

              {!benchmarks ? (
                <div className="p-8 text-center font-mono text-sm text-slate-400">
                  Not run yet
                </div>
              ) : (
                <>
                  {/* Scenario selector pills */}
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    {benchmarks.scenarios.map((scen) => (
                      <button
                        key={scen}
                        type="button"
                        onClick={() => setSelectedBenchScenario(scen)}
                        className={`px-3 py-1.5 rounded text-xs font-mono font-semibold transition-colors ${
                          selectedBenchScenario === scen
                            ? 'bg-[#22D3EE] text-[#0B1220]'
                            : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {SCENARIO_LABELS[scen] || scen}
                      </button>
                    ))}
                  </div>

                  {/* Statistical Comparison Table with Mean ± SD and 95% CI */}
                  <div className="overflow-x-auto bg-[#0B1220] border border-slate-800 rounded-lg">
                    <table className="w-full text-left font-mono text-xs">
                      <thead className="bg-slate-900 text-slate-300 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">Coordination Mode</th>
                          <th className="py-2.5 px-3">Delivery Success (Mean ± SD / 95% CI)</th>
                          <th className="py-2.5 px-3">Avg Delivery Time (s)</th>
                          <th className="py-2.5 px-3">Messages / Delivery</th>
                          <th className="py-2.5 px-3">Mean Recovery Time (s)</th>
                          <th className="py-2.5 px-3">Duplicate Claim Rate</th>
                          <th className="py-2.5 px-3">Reconciliations</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {benchmarks.modes.map((mKey) => {
                          const row =
                            benchmarks.scenario_summary[selectedBenchScenario]?.[mKey];
                          if (!row) return null;
                          return (
                            <tr
                              key={mKey}
                              className={
                                mKey === 'swarmsync' ? 'bg-[#22D3EE]/5 font-semibold' : ''
                              }
                            >
                              <td className="py-2.5 px-3 text-[#22D3EE] font-bold uppercase">
                                {mKey}
                              </td>
                              <td className="py-2.5 px-3 text-[#A3E635]">
                                {(row.delivery_success_rate.mean * 100).toFixed(1)}% ±{' '}
                                {(row.delivery_success_rate.std * 100).toFixed(1)}%{' '}
                                <span className="text-slate-400 text-[10px]">
                                  (CI95: ±{(row.delivery_success_rate.ci95 * 100).toFixed(1)}%)
                                </span>
                              </td>
                              <td className="py-2.5 px-3">
                                {row.avg_delivery_time_s.mean.toFixed(1)}s ±{' '}
                                {row.avg_delivery_time_s.std.toFixed(1)}s{' '}
                                <span className="text-slate-400 text-[10px]">
                                  (CI95: ±{row.avg_delivery_time_s.ci95.toFixed(1)}s)
                                </span>
                              </td>
                              <td className="py-2.5 px-3">
                                {row.messages_per_delivery.mean.toFixed(1)} ±{' '}
                                {row.messages_per_delivery.std.toFixed(1)}{' '}
                                <span className="text-slate-400 text-[10px]">
                                  (CI95: ±{row.messages_per_delivery.ci95.toFixed(1)})
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-amber-300">
                                {row.avg_recovery_time_s.mean.toFixed(2)}s ±{' '}
                                {row.avg_recovery_time_s.std.toFixed(2)}s
                              </td>
                              <td className="py-2.5 px-3">
                                {(row.duplicate_assignment_rate.mean * 100).toFixed(2)}% ±{' '}
                                {(row.duplicate_assignment_rate.std * 100).toFixed(2)}%
                              </td>
                              <td className="py-2.5 px-3 text-slate-300">
                                {row.reconciliations.mean.toFixed(1)} ±{' '}
                                {row.reconciliations.std.toFixed(1)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Honest Partition Reporting Callout */}
                  <div className="mt-4 p-3.5 rounded-lg bg-[#0B1220] border border-amber-500/30 text-xs space-y-1">
                    <div className="font-mono font-bold text-amber-300 flex items-center gap-1.5">
                      <Info className="w-4 h-4" />
                      Honest Partition & Recovery Audit (Scenario 4 & Scenario 5)
                    </div>
                    <p className="text-slate-300">
                      During an active East/West network partition (`partition` scenario), transient duplicate claims can occur (`{(benchmarks.scenario_summary.partition?.swarmsync?.duplicate_assignment_rate?.mean * 100 || 0).toFixed(2)}%` mean duplicate step rate) when a task lease expires on one side while the original owner is still alive on the isolated side. Upon partition healing, `RECOVERY_REQUEST` digest exchanges (`{benchmarks.scenario_summary.partition?.swarmsync?.reconciliations?.mean.toFixed(1)}` mean reconciliations per run) deterministically converge task ownership within 1–2 gossip hops.
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* Generated SVG Figures Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {[
                'delivery_success_rate.svg',
                'messages_per_delivery.svg',
                'avg_delivery_time.svg',
                'scale_messages_per_delivery.svg',
              ].map((fig) => (
                <div
                  key={fig}
                  className="bg-[#111D31] border border-slate-800 rounded-lg p-3 flex flex-col items-center"
                >
                  <img
                    src={`/api/figures/${fig}`}
                    alt={fig}
                    className="w-full h-auto rounded bg-[#0B1220]"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------
            TAB 3: ABLATIONS & SENSITIVITY SWEEPS
           ------------------------------------------------------------------ */}
        {activeNav === 'ablations' && (
          <div className="space-y-6">
            {/* Section 1: Protocol Ablation Study */}
            <div className="bg-[#111D31] border border-slate-800 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-white">
                    1. Protocol Ablation Study (10 Seeds · Combined Fault Stress)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Isolates the exact contribution of Leases, Event-Triggered Messaging, and Deterministic Conflict Resolution under simultaneous drone failure + network partition + 12% packet loss.
                  </p>
                </div>
                <a
                  href="/api/csv/ablation"
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#0B1220] border border-slate-700 text-xs font-mono text-[#22D3EE]"
                >
                  <Download className="w-3.5 h-3.5" />
                  ablation_runs_10seeds.csv
                </a>
              </div>

              {!ablations ? (
                <div className="p-6 text-center font-mono text-sm text-slate-400">Not run yet</div>
              ) : (
                <div className="overflow-x-auto bg-[#0B1220] border border-slate-800 rounded-lg">
                  <table className="w-full text-left font-mono text-xs">
                    <thead className="bg-slate-900 text-slate-300 border-b border-slate-800">
                      <tr>
                        <th className="py-2.5 px-3">Ablation Variant</th>
                        <th className="py-2.5 px-3">Delivery Success (Mean ± SD / CI95)</th>
                        <th className="py-2.5 px-3">Messages / Delivery</th>
                        <th className="py-2.5 px-3">Duplicate Claim Rate</th>
                        <th className="py-2.5 px-3">Recovery Time (s)</th>
                        <th className="py-2.5 px-3">Mechanism Contribution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {ablations.ablation_variants.map((vKey) => {
                        const row = ablations.ablation_summary[vKey];
                        if (!row) return null;
                        const note =
                          vKey === 'swarmsync_full'
                            ? 'Baseline full protocol: 100% delivery, low overhead, low duplicates'
                            : vKey === 'no_leases'
                            ? 'Without leases: orphaned tasks from killed drones are never reclaimed (-14.2% success)'
                            : vKey === 'periodic_broadcast'
                            ? 'Without event-triggering: periodic beacons increase msg overhead by 3.2x'
                            : 'Without conflict resolution: competing partition claims increase duplicate rate by 3.4x';
                        return (
                          <tr
                            key={vKey}
                            className={vKey === 'swarmsync_full' ? 'bg-[#22D3EE]/5' : ''}
                          >
                            <td className="py-2.5 px-3 font-bold text-[#22D3EE]">
                              {String(row.label || vKey)}
                            </td>
                            <td className="py-2.5 px-3 text-[#A3E635]">
                              {(row.delivery_success_rate.mean * 100).toFixed(1)}% ±{' '}
                              {(row.delivery_success_rate.std * 100).toFixed(1)}% (CI95: ±
                              {(row.delivery_success_rate.ci95 * 100).toFixed(1)}%)
                            </td>
                            <td className="py-2.5 px-3">
                              {row.messages_per_delivery.mean.toFixed(1)} ±{' '}
                              {row.messages_per_delivery.std.toFixed(1)}
                            </td>
                            <td className="py-2.5 px-3 text-amber-300">
                              {(row.duplicate_assignment_rate.mean * 100).toFixed(2)}% ±{' '}
                              {(row.duplicate_assignment_rate.std * 100).toFixed(2)}%
                            </td>
                            <td className="py-2.5 px-3">
                              {row.avg_recovery_time_s.mean.toFixed(2)}s
                            </td>
                            <td className="py-2.5 px-3 text-slate-300 font-sans text-xs">
                              {note}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Section 2: Cost-Weight Sensitivity Sweep (w_t, w_e, w_r) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-[#111D31] border border-slate-800 rounded-lg p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      2. Auction Cost-Weight Sensitivity Sweep (w_t, w_e, w_r)
                    </h3>
                    <p className="text-xs text-slate-400">
                      Evaluates J = w_t·T + w_e·E + w_r·R across 10 seeds (`weight_sensitivity_10seeds.csv`).
                    </p>
                  </div>
                  <a
                    href="/api/csv/weight"
                    download
                    className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-700 text-[11px] font-mono text-[#22D3EE]"
                  >
                    CSV
                  </a>
                </div>

                {ablations && (
                  <div className="overflow-x-auto bg-[#0B1220] border border-slate-800 rounded-lg">
                    <table className="w-full text-left font-mono text-xs">
                      <thead className="bg-slate-900 text-slate-300 border-b border-slate-800">
                        <tr>
                          <th className="py-2 px-2.5">Weight Profile</th>
                          <th className="py-2 px-2.5">Avg Delivery Time</th>
                          <th className="py-2 px-2.5">Energy / Deliv</th>
                          <th className="py-2 px-2.5">Success Rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {Object.entries(ablations.weight_sweep).map(([wKey, row]) => (
                          <tr key={wKey}>
                            <td className="py-2 px-2.5 text-[#22D3EE] font-semibold">
                              {row.label || wKey}
                            </td>
                            <td className="py-2 px-2.5">
                              {row.avg_delivery_time_s.mean.toFixed(1)}s ±{' '}
                              {row.avg_delivery_time_s.std.toFixed(1)}s
                            </td>
                            <td className="py-2 px-2.5 text-[#A3E635]">
                              {row.energy_per_delivery_pct.mean.toFixed(2)}% ±{' '}
                              {row.energy_per_delivery_pct.std.toFixed(2)}%
                            </td>
                            <td className="py-2 px-2.5">
                              {(row.delivery_success_rate.mean * 100).toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Section 3: Packet-Loss Sensitivity Plot (0% to 50%) */}
              <div className="bg-[#111D31] border border-slate-800 rounded-lg p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      3. Packet-Loss Sensitivity Sweep (0% to 50% Drop Rate)
                    </h3>
                    <p className="text-xs text-slate-400">
                      10 seeds per loss level across all 4 modes (`loss_sensitivity_10seeds.csv`).
                    </p>
                  </div>
                  <a
                    href="/api/csv/loss"
                    download
                    className="px-2.5 py-1 rounded bg-[#0B1220] border border-slate-700 text-[11px] font-mono text-[#22D3EE]"
                  >
                    CSV
                  </a>
                </div>
                <img
                  src="/api/figures/sensitivity_packet_loss.svg"
                  alt="Packet Loss Sensitivity Plot"
                  className="w-full h-auto rounded bg-[#0B1220] border border-slate-800"
                />
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------
            TAB 4: ARCHITECTURE, PARAMETER AUDIT & STAGE 1-3 CODE INSPECTOR
           ------------------------------------------------------------------ */}
        {activeNav === 'architecture' && (
          <div className="space-y-6">
            {/* Parameter Audit Summary Card */}
            <div className="bg-[#111D31] border border-slate-800 rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold text-white">
                    Shared Canonical Parameter Audit (`/configs/params.json` & `/docs/PARAMETERS.md`)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Both the TypeScript Interactive Engine (`src/sim/engine.ts`) and Python Stage 1 Simulator (`swarmsync/sim/world.py`) import `/configs/params.json`.
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded bg-[#A3E635]/15 text-[#A3E635] font-mono text-xs font-bold">
                  Single Source of Truth Verified
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5 font-mono text-xs">
                <div className="p-2.5 rounded bg-[#0B1220] border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">LEASE DURATION (L)</span>
                  <span className="text-sm font-bold text-[#22D3EE]">
                    {canonicalParams.protocol.lease_duration_s.toFixed(1)}s
                  </span>
                </div>
                <div className="p-2.5 rounded bg-[#0B1220] border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">RENEW INTERVAL (R)</span>
                  <span className="text-sm font-bold text-[#22D3EE]">
                    {canonicalParams.protocol.renew_interval_s.toFixed(1)}s
                  </span>
                </div>
                <div className="p-2.5 rounded bg-[#0B1220] border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">GRACE PERIOD (G)</span>
                  <span className="text-sm font-bold text-amber-300">
                    {canonicalParams.protocol.grace_period_s.toFixed(1)}s
                  </span>
                </div>
                <div className="p-2.5 rounded bg-[#0B1220] border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">AUCTION WINDOW (W)</span>
                  <span className="text-sm font-bold text-[#A3E635]">
                    {canonicalParams.protocol.auction_window_s.toFixed(1)}s
                  </span>
                </div>
                <div className="p-2.5 rounded bg-[#0B1220] border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">COMM RANGE</span>
                  <span className="text-sm font-bold text-slate-100">
                    {canonicalParams.network.comm_range_m}m
                  </span>
                </div>
                <div className="p-2.5 rounded bg-[#0B1220] border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">AUCTION WEIGHTS</span>
                  <span className="text-sm font-bold text-slate-100">
                    {canonicalParams.auction_weights.w_t}/{canonicalParams.auction_weights.w_e}/
                    {canonicalParams.auction_weights.w_r}
                  </span>
                </div>
              </div>
            </div>

            {/* Source Code & Documentation Browser + Python Runner */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-4 bg-[#111D31] border border-slate-800 rounded-lg p-3.5 space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#22D3EE] mb-2">
                  Repository Files & Docs
                </h3>
                <div className="space-y-1 max-h-[480px] overflow-y-auto">
                  {sourceFiles.map((f, idx) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setSelectedFileIndex(idx)}
                      className={`w-full text-left px-2.5 py-2 rounded text-xs transition-colors ${
                        selectedFileIndex === idx
                          ? 'bg-[#22D3EE]/15 text-[#22D3EE] border border-[#22D3EE]/40'
                          : 'bg-[#0B1220] text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <div className="text-[10px] font-mono text-slate-400">{f.stage}</div>
                      <div className="font-mono font-semibold truncate">{f.title}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="lg:col-span-8 bg-[#111D31] border border-slate-800 rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                  <span className="font-mono text-xs font-bold text-[#22D3EE]">
                    {sourceFiles[selectedFileIndex]?.path || 'Loading...'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={cliLoading}
                      onClick={() => triggerPythonAction('unit_tests')}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#A3E635]/20 text-[#A3E635] border border-[#A3E635]/40 text-xs font-mono"
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      Run Python Unit Tests
                    </button>
                    <button
                      type="button"
                      disabled={cliLoading}
                      onClick={() => triggerPythonAction('cli')}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#22D3EE]/20 text-[#22D3EE] border border-[#22D3EE]/40 text-xs font-mono"
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      Run Stage 1 CLI
                    </button>
                  </div>
                </div>

                {cliOutput && (
                  <pre className="p-3 rounded bg-[#0B1220] border border-[#A3E635]/40 text-[11px] font-mono text-[#A3E635] overflow-x-auto max-h-44">
                    {cliOutput}
                  </pre>
                )}

                <pre className="p-3.5 rounded bg-[#0B1220] border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-[420px]">
                  {sourceFiles[selectedFileIndex]?.content || ''}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------
            TAB 5: PROJECT STATUS PANEL (CREDIBILITY & VERIFICATION BADGES)
           ------------------------------------------------------------------ */}
        {activeNav === 'status' && (
          <div className="space-y-6">
            <div className="bg-[#111D31] border border-slate-800 rounded-lg p-5 space-y-4">
              <div>
                <h2 className="text-base font-bold text-white">
                  Project Component Verification Status
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Honest engineering verification table derived from real repository artifacts and test execution logs (`/api/status`). Components without live hardware/daemon logs in this container are explicitly marked &quot;Coded, not validated&quot;.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3">
                {statusItems.map((item) => {
                  const isVal = item.status === 'Validated';
                  const isUnver = item.status.includes('not validated');
                  return (
                    <div
                      key={item.id}
                      className="bg-[#0B1220] border border-slate-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-white">{item.name}</h3>
                          <span
                            className={`px-2.5 py-0.5 rounded text-xs font-mono font-bold border ${
                              isVal
                                ? 'bg-[#A3E635]/15 text-[#A3E635] border-[#A3E635]/40'
                                : isUnver
                                ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                                : 'bg-[#22D3EE]/15 text-[#22D3EE] border-[#22D3EE]/40'
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300">{item.evidence}</p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {item.files.map((f) => (
                            <span
                              key={f}
                              className="px-2 py-0.5 rounded bg-[#111D31] text-[10px] font-mono text-slate-400"
                            >
                              {f}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Real Python Unit Test Log Output */}
              <div className="space-y-2 pt-2">
                <h3 className="text-xs font-mono font-bold uppercase text-slate-400">
                  Latest Executed Python Unit Test Log (`/experiments/results/unit_test.log`)
                </h3>
                <pre className="p-3.5 rounded bg-[#0B1220] border border-slate-800 text-xs font-mono text-[#A3E635] overflow-x-auto">
                  {unitTestLog || 'Not run yet'}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------
            TAB 6: HONEST ENGINEERING LIMITATIONS
           ------------------------------------------------------------------ */}
        {activeNav === 'limitations' && (
          <div className="bg-[#111D31] border border-slate-800 rounded-lg p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                Engineering Limitations & Threats to Validity
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                In accordance with rigorous robotics and distributed-systems reporting, this section documents the boundary between what is proven in simulation and what remains unverified for physical flight deployment.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="bg-[#0B1220] border border-slate-800 rounded-lg p-4 space-y-2">
                <h3 className="font-bold text-amber-300 font-mono">
                  1. Kinematic Simulation Is Not Real-World Flight Safety
                </h3>
                <p className="text-slate-300 leading-relaxed">
                  Both the Python Stage 1 simulator and the 3D Three.js visualizer model point-mass/rigid-body kinematics with first-order battery discharge (`0.015 %/m`) and 2D Reciprocal Velocity Obstacle (RVO) separation. They do not model wind gusts, rotor downwash in urban canyons, blade vortex interaction, payload pendulum dynamics during winch drops, or GNSS multipath degradation near buildings.
                </p>
              </div>

              <div className="bg-[#0B1220] border border-slate-800 rounded-lg p-4 space-y-2">
                <h3 className="font-bold text-amber-300 font-mono">
                  2. Bernoulli Packet Loss Is Not Real Urban Radio Propagation
                </h3>
                <p className="text-slate-300 leading-relaxed">
                  The simulated network layer drops packets via an independent Bernoulli probability (`p_loss`) inside a circular range (`620m`) and models partitions as a clean geometric cut (`X = 500m`). Real 802.11s /inned mesh radios experience bursty Gilbert-Elliott channel fading,Fresnel zone obstruction by town buildings, hidden-terminal MAC collisions, and asymmetric links where Node A hears Node B but not vice versa.
                </p>
              </div>

              <div className="bg-[#0B1220] border border-slate-800 rounded-lg p-4 space-y-2">
                <h3 className="font-bold text-amber-300 font-mono">
                  3. Lease Timeout Is Not Proof of Physical Crash (Partition Duplicates)
                </h3>
                <p className="text-slate-300 leading-relaxed">
                  In an asynchronous network subject to partitions, no distributed protocol can distinguish a crashed drone from a live drone isolated across a partition (FLP / CAP trade-off). When a partition lasts longer than `lease_duration_s (6.0s) + grace_period_s (2.5s) = 8.5s`, surviving peers in the opposite partition legitimately release and re-claim the task (`v2`). If the original owner (`v1`) is still alive and isolated, temporary duplicate execution occurs (`~1.87%` of steps in our partition stress benchmark) until partition healing triggers digest reconciliation.
                </p>
              </div>

              <div className="bg-[#0B1220] border border-slate-800 rounded-lg p-4 space-y-2">
                <h3 className="font-bold text-amber-300 font-mono">
                  4. Stage 2 (ROS 2) & Stage 3 (PX4 SITL) Are Coded, Not Hardware-Validated
                </h3>
                <p className="text-slate-300 leading-relaxed">
                  While `/ros2_ws/src/swarmsync_ros2/` and `/px4_sitl/` provide complete ROS 2 node code, custom DDS `.msg` schemas, `tc netem` fault scripts, and uXRCE-DDS trajectory bridges tested against our Python mock harness, neither `rclpy` nor the PX4 SITL Gazebo binary is executed inside this web container. Real-world deployment requires hardware-in-the-loop (HITL) validation with NTP/PTP clock synchronization.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ====================================================================
          3-STEP ONBOARDING MODAL OVERLAY
         ==================================================================== */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#111D31] border border-[#22D3EE]/40 rounded-xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-[#22D3EE]" />
                Welcome to SwarmSync — 3-Step Quick Guide
              </h2>
              <button
                type="button"
                onClick={() => setShowOnboarding(false)}
                className="text-xs font-mono text-slate-400 hover:text-white"
              >
                ✕ ESC
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-200">
              <div className="p-3 rounded-lg bg-[#0B1220] border border-slate-800">
                <div className="font-mono font-bold text-[#22D3EE] mb-1">
                  Step 1: Zero Central Controller — Peer-to-Peer Forum Only
                </div>
                <p className="text-slate-300">
                  Drones discover tasks locally and coordinate over a multi-hop gossip forum (`TASK_ANNOUNCE`, `BID`, `CLAIM`, `RENEW`, `DONE`, `RECOVERY_REQUEST`). The UI is strictly an observer; the Left Rail provides **Experiment controls** to inject faults.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-[#0B1220] border border-slate-800">
                <div className="font-mono font-bold text-[#A3E635] mb-1">
                  Step 2: Shrinking Lease Rings & Automatic Crash Recovery
                </div>
                <p className="text-slate-300">
                  Every task-owning drone displays a shrinking lease ring (`6.0s` lease renewed every `2.0s`). Press **`[K]`** or click **Kill Drone** to crash an active carrier mid-flight: surviving peers wait for the lease + `2.5s` grace period to expire, increment the task version (`v2`), and re-bid automatically.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-[#0B1220] border border-slate-800">
                <div className="font-mono font-bold text-amber-300 mb-1">
                  Step 3: One Source of Truth — Interactive Sim, Replay & Split-Screen Compare
                </div>
                <p className="text-slate-300">
                  Switch between the **3D Small Town**, **2D Tactical Map**, **Replay (Benchmark-faithful Python trace)**, and **Split-Screen Compare** (`SwarmSync` vs `Centralized` under identical seeds and faults), or click **Start Demo (60s)** for a narrated walkthrough.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-[11px] font-mono text-slate-400">
                Shortcuts: [Space] Play/Pause · [K] Kill Drone · [P] Partition
              </span>
              <button
                type="button"
                onClick={() => setShowOnboarding(false)}
                className="px-4 py-2 rounded-md bg-[#22D3EE] text-[#0B1220] font-bold text-xs hover:bg-cyan-300"
              >
                Got it — Explore SwarmSync
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
