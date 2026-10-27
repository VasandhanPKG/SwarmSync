/**
 * SwarmSync Discrete-Time 2D Decentralized Multi-Agent Simulator Engine
 * Mirrors the exact Stage 1-3 architecture (6 decoupled agent modules, peer-to-peer
 * communication forum, lease-based ownership, partition reconciliation, RVO collision
 * avoidance, and 4 baseline modes) for deterministic real-time browser visualization.
 */

import canonicalParams from '../../configs/params.json';

export type MessageType =
  | 'TASK_ANNOUNCE'
  | 'BID'
  | 'CLAIM'
  | 'RENEW'
  | 'DONE'
  | 'HAZARD'
  | 'HEARTBEAT'
  | 'RECOVERY_REQUEST';

export type LogicalChannel =
  | 'task_coordination'
  | 'resource_sharing'
  | 'route_hazard'
  | 'recovery_reconciliation';

export type TaskStatus =
  | 'ANNOUNCED'
  | 'BIDDING'
  | 'CLAIMED'
  | 'IN_PROGRESS'
  | 'RELEASED'
  | 'COMPLETED';

export type CoordinationMode = 'swarmsync' | 'centralized' | 'basic_auction' | 'cbba';

export interface TimelineEvent {
  id: string;
  time: number;
  type:
    | 'DRONE_FAILURE'
    | 'DRONE_REVIVED'
    | 'LEASE_EXPIRED'
    | 'TASK_REBID'
    | 'RECONCILIATION'
    | 'PARTITION_TOGGLE'
    | 'HUB_FAILURE'
    | 'ORDER_DROPPED'
    | 'CONFLICT_RESOLVED'
    | 'TASK_SPAWNED';
  droneId?: number;
  taskId?: string;
  description: string;
}

export interface MetricsHistoryPoint {
  time: number;
  completedCount: number;
  openCount: number;
  messagesPerDelivery: number;
  duplicateClaims: number;
  avgRecoveryS: number;
}

export interface ForumMessage {
  message_id: string;
  sender_id: number;
  origin_id: number;
  message_type: MessageType;
  channel: LogicalChannel;
  task_id: string | null;
  sequence_number: number;
  timestamp: number;
  expiry_time: number;
  hop_count: number;
  max_hops: number;
  byte_size: number;
  payload: Record<string, unknown>;
}

export interface DeliveryTask {
  task_id: string;
  pickup: [number, number];
  dropoff: [number, number];
  payload: number;
  spawn_time: number;
  deadline: number;
  status: TaskStatus;
  owner_id: number | null;
  version: number;
  lease_expiry: number;
  best_bid: number;
  best_bidder: number | null;
  auction_opened_at: number;
  picked_up: boolean;
  completed_at: number | null;
  completed_by: number | null;
  last_expired_at?: number;
}

export interface HazardZone {
  hazard_id: string;
  center: [number, number];
  radius: number;
  severity: number;
}

export class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

export function getChannelForType(t: MessageType): LogicalChannel {
  switch (t) {
    case 'HEARTBEAT':
      return 'resource_sharing';
    case 'HAZARD':
      return 'route_hazard';
    case 'RECOVERY_REQUEST':
      return 'recovery_reconciliation';
    default:
      return 'task_coordination';
  }
}

export function cloneTask(t: DeliveryTask): DeliveryTask {
  return {
    ...t,
    pickup: [t.pickup[0], t.pickup[1]],
    dropoff: [t.dropoff[0], t.dropoff[1]],
  };
}

// ============================================================================
// 1. LocalStateManager
// ============================================================================
export class LocalStateManager {
  readonly agentId: number;
  knownTasks: Map<string, DeliveryTask> = new Map();
  peerHeartbeats: Map<number, number> = new Map();
  hazards: Map<string, HazardZone> = new Map();
  currentTaskId: string | null = null;

  constructor(agentId: number) {
    this.agentId = agentId;
  }

  upsertTask(task: DeliveryTask): boolean {
    if (!this.knownTasks.has(task.task_id)) {
      this.knownTasks.set(task.task_id, cloneTask(task));
      return true;
    }
    return false;
  }

  buildDigest(): Record<string, DeliveryTask> {
    const out: Record<string, DeliveryTask> = {};
    for (const [k, v] of this.knownTasks.entries()) {
      out[k] = cloneTask(v);
    }
    return out;
  }
}

// ============================================================================
// 2. CommunicationManager
// ============================================================================
export class CommunicationManager {
  readonly agentId: number;
  sequenceNumber = 0;
  seenMessageIds: Set<string> = new Set();
  dedupedCount = 0;
  droppedExpiredCount = 0;
  forwardedCount = 0;
  periodicBroadcast: boolean;

  constructor(agentId: number, periodicBroadcast = false) {
    this.agentId = agentId;
    this.periodicBroadcast = periodicBroadcast;
  }

  createMessage(
    type: MessageType,
    currentTime: number,
    taskId: string | null,
    payload: Record<string, unknown>,
    ttl = canonicalParams.network.message_ttl_s || 16.0
  ): ForumMessage {
    this.sequenceNumber += 1;
    const msgId = `M-${String(this.agentId).padStart(2, '0')}-${String(this.sequenceNumber).padStart(4, '0')}`;
    const rawLen = JSON.stringify(payload).length;
    const msg: ForumMessage = {
      message_id: msgId,
      sender_id: this.agentId,
      origin_id: this.agentId,
      message_type: type,
      channel: getChannelForType(type),
      task_id: taskId,
      sequence_number: this.sequenceNumber,
      timestamp: currentTime,
      expiry_time: currentTime + ttl,
      hop_count: 0,
      max_hops: canonicalParams.network.gossip_hop_limit || 3,
      byte_size: 48 + msgId.length + type.length + rawLen,
      payload,
    };
    this.seenMessageIds.add(msgId);
    return msg;
  }

  filterIncoming(rawInbox: ForumMessage[], currentTime: number): ForumMessage[] {
    const valid: ForumMessage[] = [];
    for (const msg of rawInbox) {
      if (!msg.message_id || msg.sequence_number <= 0 || msg.expiry_time < msg.timestamp) {
        continue;
      }
      if (currentTime > msg.expiry_time + 1e-6) {
        this.droppedExpiredCount += 1;
        continue;
      }
      if (this.seenMessageIds.has(msg.message_id)) {
        this.dedupedCount += 1;
        continue;
      }
      this.seenMessageIds.add(msg.message_id);
      valid.push(msg);
    }
    return valid;
  }
}

// ============================================================================
// 6. SafetyMonitor
// ============================================================================
export class SafetyMonitor {
  maxPayload = canonicalParams.drone.max_payload_kg || 3.5;
  batteryReserve = canonicalParams.drone.reserve_battery_pct || 18.0;
  energyPerMeter = canonicalParams.drone.energy_per_meter_pct || 0.015;
  droneSpeed = canonicalParams.drone.speed_mps || 35.0;
  basePos: [number, number] = [500, 500];
  safetyInterventions = 0;
  safetyViolations = 0;

  estimateMission(
    pos: [number, number],
    task: DeliveryTask
  ): { transitTime: number; missionEnergy: number; returnEnergy: number } {
    const dPick = task.picked_up
      ? 0
      : Math.hypot(task.pickup[0] - pos[0], task.pickup[1] - pos[1]);
    const dropStart = task.picked_up ? pos : task.pickup;
    const dDrop = Math.hypot(task.dropoff[0] - dropStart[0], task.dropoff[1] - dropStart[1]);
    const dRet = Math.hypot(this.basePos[0] - task.dropoff[0], this.basePos[1] - task.dropoff[1]);
    const pFactor = 1.0 + 0.3 * (task.payload / this.maxPayload);
    const eMission = dPick * this.energyPerMeter + dDrop * this.energyPerMeter * pFactor;
    const eReturn = dRet * this.energyPerMeter;
    const transitTime = (dPick + dDrop) / this.droneSpeed;
    return { transitTime, missionEnergy: eMission, returnEnergy: eReturn };
  }

  canUndertake(
    pos: [number, number],
    battery: number,
    task: DeliveryTask,
    currentTime: number
  ): { ok: boolean; reason: string } {
    if (task.payload > this.maxPayload) {
      return { ok: false, reason: 'payload_exceeded' };
    }
    const { transitTime, missionEnergy, returnEnergy } = this.estimateMission(pos, task);
    if (battery - (missionEnergy + returnEnergy) < this.batteryReserve) {
      return { ok: false, reason: 'insufficient_battery_reserve' };
    }
    const effDeadline = task.version === 1 ? task.deadline : task.deadline + 45.0;
    if (currentTime + transitTime > effDeadline) {
      return { ok: false, reason: 'deadline_infeasible' };
    }
    return { ok: true, reason: 'ok' };
  }
}

// ============================================================================
// 3. TaskNegotiationEngine
// ============================================================================
export class TaskNegotiationEngine {
  readonly agentId: number;
  readonly safety: SafetyMonitor;
  w_t = canonicalParams.auction_weights.w_t ?? 0.5;
  w_e = canonicalParams.auction_weights.w_e ?? 0.3;
  w_r = canonicalParams.auction_weights.w_r ?? 0.2;

  constructor(agentId: number, safety: SafetyMonitor) {
    this.agentId = agentId;
    this.safety = safety;
  }

  computeBid(
    pos: [number, number],
    battery: number,
    task: DeliveryTask,
    currentTime: number,
    hazards: Map<string, HazardZone>
  ): number | null {
    const check = this.safety.canUndertake(pos, battery, task, currentTime);
    if (!check.ok) return null;
    const { transitTime, missionEnergy } = this.safety.estimateMission(pos, task);
    const tNorm = transitTime / 60.0;
    const eNorm = missionEnergy / 100.0;
    const slack = Math.max(1.0, task.deadline - (currentTime + transitTime));
    let risk = Math.max(0.0, 1.0 - slack / 60.0);
    const midX = 0.5 * (pos[0] + task.pickup[0]);
    const midY = 0.5 * (pos[1] + task.pickup[1]);
    for (const hz of hazards.values()) {
      const d = Math.hypot(midX - hz.center[0], midY - hz.center[1]);
      if (d < hz.radius * 1.5) {
        risk += hz.severity * (1 - d / (hz.radius * 1.5));
      }
    }
    const costJ = this.w_t * tNorm + this.w_e * eNorm + this.w_r * Math.min(2.0, risk);
    return Number((-costJ - this.agentId * 1e-6).toFixed(6));
  }

  static isBetterBid(
    candBid: number,
    candAgent: number,
    curBid: number,
    curAgent: number | null
  ): boolean {
    if (curAgent === null) return true;
    if (Math.abs(candBid - curBid) > 1e-5) return candBid > curBid;
    return candAgent < curAgent;
  }
}

// ============================================================================
// 4. AssignmentManager
// ============================================================================
export class AssignmentManager {
  readonly agentId: number;
  leaseDuration = canonicalParams.protocol.lease_duration_s ?? 6.0;
  renewInterval = canonicalParams.protocol.renew_interval_s ?? 2.0;
  auctionWindow = canonicalParams.protocol.auction_window_s ?? 1.2;
  useLeases: boolean;
  useConflictResolution: boolean;
  lastRenewSentAt = -999;
  conflictsResolved = 0;
  duplicateClaimsDetected = 0;

  constructor(agentId: number, useLeases = true, useConflictResolution = true) {
    this.agentId = agentId;
    this.useLeases = useLeases;
    this.useConflictResolution = useConflictResolution;
  }

  static claimWins(
    incVersion: number,
    incOwner: number,
    curVersion: number,
    curOwner: number | null
  ): boolean {
    if (curOwner === null) return true;
    if (incVersion !== curVersion) return incVersion > curVersion;
    return incOwner < curOwner;
  }

  resolveIncomingClaim(
    localTask: DeliveryTask,
    incOwner: number,
    incVersion: number,
    incLeaseExpiry: number,
    localState: LocalStateManager
  ): { changed: boolean; preempted: boolean } {
    if (localTask.status === 'COMPLETED') return { changed: false, preempted: false };

    if (
      (localTask.status === 'CLAIMED' || localTask.status === 'IN_PROGRESS') &&
      localTask.owner_id !== null &&
      localTask.owner_id !== incOwner
    ) {
      this.duplicateClaimsDetected += 1;
      if (!this.useConflictResolution && localState.currentTaskId === localTask.task_id) {
        return { changed: false, preempted: false };
      }
    }

    if (this.useConflictResolution && incVersion < localTask.version) {
      return { changed: false, preempted: false };
    }

    const wins = this.useConflictResolution
      ? AssignmentManager.claimWins(
          incVersion,
          incOwner,
          localTask.version,
          localTask.owner_id
        )
      : localTask.owner_id === null;
    if (!wins) return { changed: false, preempted: false };

    const preempted =
      localState.currentTaskId === localTask.task_id && incOwner !== this.agentId;
    if (preempted) {
      this.conflictsResolved += 1;
      localState.currentTaskId = null;
    }

    const changed =
      localTask.owner_id !== incOwner ||
      localTask.version !== incVersion ||
      Math.abs(localTask.lease_expiry - incLeaseExpiry) > 1e-3 ||
      (localTask.status !== 'CLAIMED' && localTask.status !== 'IN_PROGRESS');

    localTask.owner_id = incOwner;
    localTask.version = incVersion;
    localTask.lease_expiry = incLeaseExpiry;
    localTask.status = localTask.picked_up ? 'IN_PROGRESS' : 'CLAIMED';
    return { changed, preempted };
  }
}

// ============================================================================
// 5. RecoveryManager
// ============================================================================
export class RecoveryManager {
  readonly agentId: number;
  gracePeriod = canonicalParams.protocol.grace_period_s ?? 2.5;
  useLeases: boolean;
  tasksReleasedCount = 0;
  reconciliationsCompleted = 0;

  constructor(agentId: number, useLeases = true) {
    this.agentId = agentId;
    this.useLeases = useLeases;
  }

  checkExpiredLeases(localState: LocalStateManager, currentTime: number): DeliveryTask[] {
    if (!this.useLeases) return [];
    const released: DeliveryTask[] = [];
    for (const task of localState.knownTasks.values()) {
      if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS') {
        if (task.owner_id === this.agentId) continue;
        if (currentTime > task.lease_expiry + this.gracePeriod) {
          task.status = 'RELEASED';
          task.version += 1;
          task.owner_id = null;
          task.best_bid = -1e9;
          task.best_bidder = null;
          task.auction_opened_at = currentTime;
          task.last_expired_at = currentTime;
          this.tasksReleasedCount += 1;
          released.push(task);
        }
      }
    }
    return released;
  }

  reconcileDigest(
    localState: LocalStateManager,
    assignMgr: AssignmentManager,
    peerDigest: Record<string, DeliveryTask>,
    currentTime: number
  ): number {
    let updates = 0;
    for (const [tid, remoteTask] of Object.entries(peerDigest)) {
      const localTask = localState.knownTasks.get(tid);
      if (!localTask) {
        localState.knownTasks.set(tid, cloneTask(remoteTask));
        updates += 1;
        continue;
      }
      if (remoteTask.status === 'COMPLETED' && localTask.status !== 'COMPLETED') {
        if (localState.currentTaskId === tid) localState.currentTaskId = null;
        localTask.status = 'COMPLETED';
        localTask.completed_at = remoteTask.completed_at;
        localTask.completed_by = remoteTask.completed_by;
        localTask.owner_id = remoteTask.owner_id;
        localTask.version = Math.max(localTask.version, remoteTask.version);
        updates += 1;
        continue;
      }
      if (localTask.status === 'COMPLETED') continue;

      if (
        remoteTask.owner_id !== null &&
        (remoteTask.status === 'CLAIMED' || remoteTask.status === 'IN_PROGRESS')
      ) {
        const { changed } = assignMgr.resolveIncomingClaim(
          localTask,
          remoteTask.owner_id,
          remoteTask.version,
          remoteTask.lease_expiry,
          localState
        );
        if (changed) {
          localTask.picked_up = localTask.picked_up || remoteTask.picked_up;
          updates += 1;
        }
      } else if (remoteTask.version > localTask.version && remoteTask.status === 'RELEASED') {
        if (localState.currentTaskId === tid) localState.currentTaskId = null;
        localTask.version = remoteTask.version;
        localTask.status = 'RELEASED';
        localTask.owner_id = null;
        localTask.best_bid = -1e9;
        localTask.best_bidder = null;
        localTask.auction_opened_at = currentTime;
        updates += 1;
      }
    }
    if (updates > 0) this.reconciliationsCompleted += 1;
    return updates;
  }
}

// ============================================================================
// Simulated Network + Complete World State for Live Interactive Visualizer
// ============================================================================
export interface DroneState {
  id: number;
  homePos: [number, number];
  position: [number, number];
  altitude: number;
  velocity: [number, number];
  yaw: number;
  pitch: number;
  roll: number;
  trail: [number, number, number][];
  battery: number;
  alive: boolean;
  returningForSafety: boolean;
  energyConsumed: number;
  ordersDropped: number;
  lastDropTime: number;
  lastDropTaskId: string | null;
  autonomousDecision: string;
  leaseProgress: number; // 0..1 (1 = fresh lease, 0 = expired)
  leaseExpiredFlashUntil: number;
  localState: LocalStateManager;
  comm: CommunicationManager;
  safety: SafetyMonitor;
  negotiation: TaskNegotiationEngine;
  assignment: AssignmentManager;
  recovery: RecoveryManager;
  lastPeriodicAt: number;
}

export interface InFlightVisualPacket {
  id: string;
  fromId: number;
  toId: number;
  fromPos: [number, number];
  toPos: [number, number];
  sentAt: number;
  deliverAt: number;
  message: ForumMessage;
}

export interface OrderDropEvent {
  id: string;
  taskId: string;
  droneId: number;
  dropoff: [number, number];
  payload: number;
  startAlt: number;
  droppedAt: number;
}

export class SwarmSyncSimulator {
  rng: SeededRNG;
  mode: CoordinationMode;
  scenario: string;
  currentTime = 0;
  dt = canonicalParams.world.dt_s ?? 0.2;
  commRange = canonicalParams.network.comm_range_m ?? 620;
  packetLossProb = canonicalParams.network.packet_loss_prob ?? 0.0;
  minDelay = 0.05;
  maxDelay = canonicalParams.network.base_delay_s + canonicalParams.network.delay_jitter_s || 0.2;
  partitionEnabled = false;
  partitionX = canonicalParams.network.partition_split_x_m ?? 500;
  centralHubAlive = true;
  arrivalInterval = 3.2;

  drones: Map<number, DroneState> = new Map();
  masterTasks: Map<string, DeliveryTask> = new Map();
  spawnSchedule: DeliveryTask[] = [];
  spawnedTaskIds: Set<string> = new Set();
  inFlightPackets: InFlightVisualPacket[] = [];
  activeDrops: OrderDropEvent[] = [];
  recentForumLog: ForumMessage[] = [];
  eventTimeline: TimelineEvent[] = [];
  metricsHistory: MetricsHistoryPoint[] = [];
  previousNeighbors: Map<number, Set<number>> = new Map();

  totalMessagesSent = 0;
  totalBytesSent = 0;
  totalPacketsDropped = 0;
  rvoAvoidanceCount = 0;
  duplicateClaimsCount = 0;
  taskFailureTimes: Map<string, number> = new Map();
  recoveryDurations: number[] = [];
  private lastHistorySampleTime = -1;

  constructor(
    scenario = 'normal',
    mode: CoordinationMode = 'swarmsync',
    seed = 1,
    fleetSize = 5
  ) {
    this.scenario = scenario;
    this.mode = mode;
    this.rng = new SeededRNG(seed);

    if (scenario === 'packet_loss_delay') {
      this.packetLossProb = 0.25;
      this.minDelay = 0.25;
      this.maxDelay = 1.1;
    } else if (scenario === 'partition') {
      this.packetLossProb = 0.04;
      this.partitionEnabled = true;
    } else if (scenario === 'hub_failure' && mode === 'centralized') {
      this.packetLossProb = 0.02;
    }

    const periodic = mode === 'basic_auction';
    const useLeases = mode === 'swarmsync' || mode === 'cbba';

    for (let i = 1; i <= fleetSize; i++) {
      const angle = (2 * Math.PI * (i - 1)) / fleetSize + 0.35;
      // Distribute drones across independent decentralized sectors (not clustered at center)
      const radius = mode === 'centralized' ? 120 : 275 + (i % 2) * 55;
      const pos: [number, number] = [
        Math.round(500 + radius * Math.cos(angle)),
        Math.round(500 + radius * Math.sin(angle)),
      ];
      const safety = new SafetyMonitor();
      safety.basePos = mode === 'centralized' ? [500, 500] : [pos[0], pos[1]];
      const cruiseAlt = 22 + (i % 3) * 4;
      this.drones.set(i, {
        id: i,
        homePos: [pos[0], pos[1]],
        position: [pos[0], pos[1]],
        altitude: cruiseAlt,
        velocity: [0, 0],
        yaw: angle + Math.PI,
        pitch: 0,
        roll: 0,
        trail: [[pos[0], cruiseAlt, pos[1]]],
        battery: 100,
        alive: true,
        returningForSafety: false,
        energyConsumed: 0,
        ordersDropped: 0,
        lastDropTime: -999,
        lastDropTaskId: null,
        autonomousDecision:
          mode === 'centralized'
            ? 'Awaiting Central Hub dispatch'
            : 'Autonomous P2P node ready · Scanning tasks',
        leaseProgress: 0,
        leaseExpiredFlashUntil: -1,
        localState: new LocalStateManager(i),
        comm: new CommunicationManager(i, periodic),
        safety,
        negotiation: new TaskNegotiationEngine(i, safety),
        assignment: new AssignmentManager(i, useLeases),
        recovery: new RecoveryManager(i, useLeases),
        lastPeriodicAt: -999,
      });
      this.previousNeighbors.set(i, new Set());
    }

    // Build initial task schedule: spawn initial wave across sectors at t=0 so every drone immediately negotiates & drops orders
    const totalTasks = Math.max(12, fleetSize * 2 + 2);
    const initialWave = Math.max(6, fleetSize + 1);
    for (let idx = 1; idx <= totalTasks; idx++) {
      const spawnT =
        idx <= initialWave
          ? 0
          : scenario === 'dynamic_arrival'
          ? (idx - initialWave) * 3.2
          : (idx - initialWave) * 1.2;

      let px: number;
      let py: number;
      if (idx <= fleetSize) {
        const secAngle = (2 * Math.PI * (idx - 1)) / fleetSize + 0.35 + this.rng.uniform(-0.22, 0.22);
        const secRad = 190 + this.rng.uniform(-35, 45);
        px = Math.max(100, Math.min(900, Math.round(500 + secRad * Math.cos(secAngle))));
        py = Math.max(100, Math.min(900, Math.round(500 + secRad * Math.sin(secAngle))));
      } else {
        px = Math.round(this.rng.uniform(110, 890));
        py = Math.round(this.rng.uniform(110, 890));
      }

      let dx = Math.round(this.rng.uniform(130, 870));
      let dy = Math.round(this.rng.uniform(130, 870));
      while (Math.hypot(dx - px, dy - py) < 130 || Math.hypot(dx - px, dy - py) > 330) {
        dx = Math.round(this.rng.uniform(130, 870));
        dy = Math.round(this.rng.uniform(130, 870));
      }
      const dist = Math.hypot(dx - px, dy - py);
      const t: DeliveryTask = {
        task_id: `T-${String(idx).padStart(2, '0')}`,
        pickup: [px, py],
        dropoff: [dx, dy],
        payload: Number(this.rng.uniform(0.9, 2.6).toFixed(2)),
        spawn_time: spawnT,
        deadline: Math.round(spawnT + 150 + dist * 0.15),
        status: 'ANNOUNCED',
        owner_id: null,
        version: 1,
        lease_expiry: 0,
        best_bid: -1e9,
        best_bidder: null,
        auction_opened_at: spawnT,
        picked_up: false,
        completed_at: null,
        completed_by: null,
      };
      this.spawnSchedule.push(t);
      this.masterTasks.set(t.task_id, cloneTask(t));
    }
  }

  canCommunicate(idA: number, idB: number): boolean {
    if (idA === idB) return false;
    const dA = this.drones.get(idA);
    const dB = this.drones.get(idB);
    if (!dA || !dB || !dA.alive || !dB.alive) return false;
    if (this.partitionEnabled) {
      const sideA = dA.position[0] < this.partitionX;
      const sideB = dB.position[0] < this.partitionX;
      if (sideA !== sideB) return false;
    }
    const dist = Math.hypot(dA.position[0] - dB.position[0], dA.position[1] - dB.position[1]);
    return dist <= this.commRange;
  }

  getNeighbors(id: number): number[] {
    const out: number[] = [];
    for (const otherId of this.drones.keys()) {
      if (this.canCommunicate(id, otherId)) out.push(otherId);
    }
    return out;
  }

  broadcast(senderId: number, msg: ForumMessage): void {
    const sender = this.drones.get(senderId);
    if (!sender || !sender.alive) return;
    this.totalMessagesSent += 1;
    this.totalBytesSent += msg.byte_size;
    this.recentForumLog.unshift(msg);
    if (this.recentForumLog.length > 60) this.recentForumLog.pop();

    const neighbors = this.getNeighbors(senderId);
    for (const peerId of neighbors) {
      if (this.packetLossProb > 0 && this.rng.next() < this.packetLossProb) {
        this.totalPacketsDropped += 1;
        continue;
      }
      const peer = this.drones.get(peerId)!;
      const delay = this.rng.uniform(this.minDelay, this.maxDelay);
      this.inFlightPackets.push({
        id: `${msg.message_id}->${peerId}-${this.currentTime.toFixed(2)}`,
        fromId: senderId,
        toId: peerId,
        fromPos: [sender.position[0], sender.position[1]],
        toPos: [peer.position[0], peer.position[1]],
        sentAt: this.currentTime,
        deliverAt: this.currentTime + delay,
        message: msg,
      });
    }
  }

  recordTimelineEvent(
    type: TimelineEvent['type'],
    description: string,
    droneId?: number,
    taskId?: string
  ): void {
    this.eventTimeline.unshift({
      id: `EV-${this.currentTime.toFixed(2)}-${this.eventTimeline.length + 1}`,
      time: Number(this.currentTime.toFixed(2)),
      type,
      droneId,
      taskId,
      description,
    });
    if (this.eventTimeline.length > 100) {
      this.eventTimeline.pop();
    }
  }

  setPartition(enabled: boolean): void {
    if (this.partitionEnabled !== enabled) {
      this.partitionEnabled = enabled;
      this.recordTimelineEvent(
        'PARTITION_TOGGLE',
        enabled
          ? `Network partition injected across X=${this.partitionX}m (East/West isolated)`
          : 'Network partition healed; peer digest reconciliation triggered'
      );
    }
  }

  killDrone(droneId: number): string | null {
    const d = this.drones.get(droneId);
    if (!d || !d.alive) return null;
    const orphaned = d.localState.currentTaskId;
    d.alive = false;
    d.velocity = [0, 0];
    d.altitude = 0.6;
    d.pitch = 0.35;
    d.roll = -0.28;
    d.leaseProgress = 0;
    d.autonomousDecision = orphaned
      ? `NODE FAILED MID-DELIVERY (${orphaned} lease expiring)`
      : 'NODE FAILED · OFFLINE';
    if (orphaned) {
      this.taskFailureTimes.set(orphaned, this.currentTime);
    }
    this.recordTimelineEvent(
      'DRONE_FAILURE',
      orphaned
        ? `Drone D${droneId} failed mid-delivery while carrying ${orphaned}; lease countdown active`
        : `Drone D${droneId} failed at (${Math.round(d.position[0])}, ${Math.round(d.position[1])})`,
      droneId,
      orphaned || undefined
    );
    return orphaned;
  }

  reviveDrone(droneId: number): void {
    const d = this.drones.get(droneId);
    if (!d) return;
    d.alive = true;
    d.battery = 100;
    d.altitude = 18 + (d.id % 4) * 3;
    d.pitch = 0;
    d.roll = 0;
    d.localState.currentTaskId = null;
    d.autonomousDecision = 'Rejoined P2P mesh · Negotiating tasks';
    this.recordTimelineEvent(
      'DRONE_REVIVED',
      `Drone D${droneId} restored to active P2P mesh`,
      droneId
    );
  }

  spawnCustomTask(pickup: [number, number], dropoff: [number, number], payload = 1.8): DeliveryTask {
    const idx = this.masterTasks.size + 1;
    const tid = `T-${String(idx).padStart(2, '0')}`;
    const task: DeliveryTask = {
      task_id: tid,
      pickup,
      dropoff,
      payload,
      spawn_time: this.currentTime,
      deadline: Math.round(this.currentTime + 140),
      status: 'ANNOUNCED',
      owner_id: null,
      version: 1,
      lease_expiry: 0,
      best_bid: -1e9,
      best_bidder: null,
      auction_opened_at: this.currentTime,
      picked_up: false,
      completed_at: null,
      completed_by: null,
    };
    this.spawnSchedule.push(task);
    this.masterTasks.set(tid, cloneTask(task));
    this.recordTimelineEvent(
      'TASK_SPAWNED',
      `Task ${tid} (${payload}kg) injected at (${pickup[0]}, ${pickup[1]}) → (${dropoff[0]}, ${dropoff[1]})`,
      undefined,
      tid
    );
    return task;
  }

  private evaluateAndBid(d: DroneState, task: DeliveryTask): void {
    if (!d.alive || d.returningForSafety || d.localState.currentTaskId !== null) return;
    if (task.status !== 'ANNOUNCED' && task.status !== 'BIDDING' && task.status !== 'RELEASED') {
      return;
    }

    let otherWinning: DeliveryTask | null = null;
    for (const ot of d.localState.knownTasks.values()) {
      if (
        ot.task_id !== task.task_id &&
        (ot.status === 'ANNOUNCED' || ot.status === 'BIDDING' || ot.status === 'RELEASED') &&
        ot.best_bidder === d.id
      ) {
        otherWinning = ot;
        break;
      }
    }

    const myBid = d.negotiation.computeBid(
      d.position,
      d.battery,
      task,
      this.currentTime,
      d.localState.hazards
    );
    if (myBid === null) return;
    if (otherWinning && myBid <= otherWinning.best_bid + 0.02) return;

    if (TaskNegotiationEngine.isBetterBid(myBid, d.id, task.best_bid, task.best_bidder)) {
      if (otherWinning) {
        otherWinning.best_bid = -1e9;
        otherWinning.best_bidder = null;
      }
      task.best_bid = myBid;
      task.best_bidder = d.id;
      task.status = 'BIDDING';
      if (task.auction_opened_at <= 0) task.auction_opened_at = this.currentTime;
      d.autonomousDecision = `Bidding ${myBid.toFixed(2)} on ${task.task_id} (P2P Auction)`;
      const msg = d.comm.createMessage('BID', this.currentTime, task.task_id, {
        bid: myBid,
        bidder_id: d.id,
        version: task.version,
        task: cloneTask(task),
      });
      this.broadcast(d.id, msg);
    }
  }

  step(): void {
    // Scenario-based automated events for partition / drone_failure / hub_failure
    if (this.scenario === 'partition') {
      if (Math.abs(this.currentTime - 38.0) < this.dt * 0.6) {
        this.setPartition(false);
      }
    } else if (this.scenario === 'drone_failure' && Math.abs(this.currentTime - 12.0) < this.dt * 0.6) {
      const busy = Array.from(this.drones.values()).find(
        (d) => d.alive && d.localState.currentTaskId !== null
      );
      if (busy) this.killDrone(busy.id);
    } else if (this.scenario === 'hub_failure' && Math.abs(this.currentTime - 14.0) < this.dt * 0.6) {
      if (this.centralHubAlive) {
        this.centralHubAlive = false;
        this.recordTimelineEvent('HUB_FAILURE', 'Central coordinator hub failed at (500, 500)');
      }
    }

    // 1. TaskSource: inject due tasks ONLY to nearest reachable alive drone
    const aliveDrones = Array.from(this.drones.values()).filter((d) => d.alive);
    if (aliveDrones.length > 0) {
      for (const schedTask of this.spawnSchedule) {
        if (this.spawnedTaskIds.has(schedTask.task_id)) continue;
        if (schedTask.spawn_time <= this.currentTime + 1e-6) {
          this.spawnedTaskIds.add(schedTask.task_id);
          let nearest = aliveDrones[0];
          let bestDist = Infinity;
          for (const cand of aliveDrones) {
            const dist = Math.hypot(
              cand.position[0] - schedTask.pickup[0],
              cand.position[1] - schedTask.pickup[1]
            );
            if (dist < bestDist) {
              bestDist = dist;
              nearest = cand;
            }
          }
          const copy = cloneTask(schedTask);
          copy.auction_opened_at = this.currentTime;
          if (this.mode === 'centralized') {
            this.masterTasks.set(copy.task_id, copy);
          } else {
            const added = nearest.localState.upsertTask(copy);
            if (added) {
              const msg = nearest.comm.createMessage(
                'TASK_ANNOUNCE',
                this.currentTime,
                copy.task_id,
                { task: cloneTask(copy) }
              );
              this.broadcast(nearest.id, msg);
              this.evaluateAndBid(nearest, nearest.localState.knownTasks.get(copy.task_id)!);
            }
          }
        }
      }
    }

    // 2. Deliver due in-flight network packets
    const dueByReceiver: Map<number, ForumMessage[]> = new Map();
    const stillInFlight: InFlightVisualPacket[] = [];
    for (const pkt of this.inFlightPackets) {
      if (pkt.deliverAt <= this.currentTime + 1e-6) {
        if (this.canCommunicate(pkt.fromId, pkt.toId)) {
          const arr = dueByReceiver.get(pkt.toId) || [];
          arr.push(pkt.message);
          dueByReceiver.set(pkt.toId, arr);
        } else {
          this.totalPacketsDropped += 1;
        }
      } else {
        stillInFlight.push(pkt);
      }
    }
    this.inFlightPackets = stillInFlight;

    // 3. Mode-specific coordination step
    if (this.mode === 'centralized') {
      this.stepCentralized();
    } else {
      for (const d of this.drones.values()) {
        if (!d.alive) continue;
        this.stepDecentralizedDrone(d, dueByReceiver.get(d.id) || []);
      }
    }

    // 4. Step kinematics with RVO local collision avoidance & lease progress updates
    const activeOwnersByTask: Map<string, number[]> = new Map();
    for (const d of this.drones.values()) {
      if (!d.alive) {
        d.leaseProgress = 0;
        continue;
      }
      this.stepDroneKinematics(d);
      if (d.localState.currentTaskId) {
        const tid = d.localState.currentTaskId;
        const list = activeOwnersByTask.get(tid) || [];
        list.push(d.id);
        activeOwnersByTask.set(tid, list);
        const lt = d.localState.knownTasks.get(tid);
        if (lt && d.assignment.useLeases) {
          const rem = Math.max(0, lt.lease_expiry - this.currentTime);
          d.leaseProgress = Math.max(0, Math.min(1, rem / d.assignment.leaseDuration));
        } else {
          d.leaseProgress = 1;
        }
      } else {
        d.leaseProgress = 0;
      }
    }

    for (const owners of activeOwnersByTask.values()) {
      if (owners.length > 1) {
        this.duplicateClaimsCount += 1;
      }
    }

    // 5. Track recovery latency (failure_injected_to_valid_reassignment_committed_s)
    for (const d of this.drones.values()) {
      if (d.alive && d.localState.currentTaskId) {
        const failT = this.taskFailureTimes.get(d.localState.currentTaskId);
        if (failT !== undefined) {
          const recDur = Number(Math.max(0.2, this.currentTime - failT).toFixed(2));
          this.recoveryDurations.push(recDur);
          this.taskFailureTimes.delete(d.localState.currentTaskId);
          this.recordTimelineEvent(
            'TASK_REBID',
            `Orphaned task ${d.localState.currentTaskId} reassigned to D${d.id} after ${recDur}s recovery`,
            d.id,
            d.localState.currentTaskId
          );
        }
      }
    }

    // 6. Sample live metrics history every 1.0s for Bottom Dock charts
    if (this.currentTime - this.lastHistorySampleTime >= 1.0 - 1e-5) {
      this.lastHistorySampleTime = this.currentTime;
      const tasks = this.getConsolidatedTasks();
      const comp = tasks.filter((t) => t.status === 'COMPLETED').length;
      const open = tasks.length - comp;
      const avgRec =
        this.recoveryDurations.length > 0
          ? this.recoveryDurations.reduce((a, b) => a + b, 0) / this.recoveryDurations.length
          : 0;
      this.metricsHistory.push({
        time: Number(this.currentTime.toFixed(1)),
        completedCount: comp,
        openCount: open,
        messagesPerDelivery: Number((this.totalMessagesSent / Math.max(comp, 1)).toFixed(1)),
        duplicateClaims: this.duplicateClaimsCount,
        avgRecoveryS: Number(avgRec.toFixed(2)),
      });
      if (this.metricsHistory.length > 60) {
        this.metricsHistory.shift();
      }
    }

    this.currentTime = Number((this.currentTime + this.dt).toFixed(3));
  }

  private stepCentralized(): void {
    if (!this.centralHubAlive) return;
    for (const t of this.masterTasks.values()) {
      if (t.status === 'CLAIMED' || t.status === 'IN_PROGRESS') {
        const owner = t.owner_id ? this.drones.get(t.owner_id) : null;
        if (!owner || !owner.alive) {
          t.status = 'RELEASED';
          t.owner_id = null;
          t.version += 1;
        }
      }
      if (t.status === 'ANNOUNCED' || t.status === 'RELEASED' || t.status === 'BIDDING') {
        const idle = Array.from(this.drones.values()).filter(
          (d) =>
            d.alive &&
            !d.returningForSafety &&
            d.localState.currentTaskId === null &&
            (!this.partitionEnabled || d.position[0] < this.partitionX) &&
            d.safety.canUndertake(d.position, d.battery, t, this.currentTime).ok
        );
        if (idle.length > 0) {
          idle.sort(
            (a, b) =>
              Math.hypot(a.position[0] - t.pickup[0], a.position[1] - t.pickup[1]) -
              Math.hypot(b.position[0] - t.pickup[0], b.position[1] - t.pickup[1])
          );
          const chosen = idle[0];
          t.owner_id = chosen.id;
          t.status = 'CLAIMED';
          t.lease_expiry = 1e9;
          chosen.localState.knownTasks.set(t.task_id, cloneTask(t));
          chosen.localState.currentTaskId = t.task_id;
          this.totalMessagesSent += 2;
          this.totalBytesSent += 280;
        }
      }
    }
  }

  private stepDecentralizedDrone(d: DroneState, rawInbox: ForumMessage[]): void {
    // Link-change detection for partition healing reconciliation
    const curNeighbors = new Set(this.getNeighbors(d.id));
    const prevNeighbors = this.previousNeighbors.get(d.id) || new Set();
    let hasNewLink = false;
    for (const n of curNeighbors) {
      if (!prevNeighbors.has(n)) hasNewLink = true;
    }
    this.previousNeighbors.set(d.id, curNeighbors);

    if (hasNewLink && d.localState.knownTasks.size > 0) {
      const recMsg = d.comm.createMessage('RECOVERY_REQUEST', this.currentTime, null, {
        digest: d.localState.buildDigest(),
        is_request: true,
      });
      this.broadcast(d.id, recMsg);
    }

    const validMsgs = d.comm.filterIncoming(rawInbox, this.currentTime);
    for (const msg of validMsgs) {
      let shouldGossip = false;
      const p = msg.payload;

      if (msg.message_type === 'TASK_ANNOUNCE' && p.task) {
        const inc = cloneTask(p.task as DeliveryTask);
        if (d.localState.upsertTask(inc)) {
          const lt = d.localState.knownTasks.get(inc.task_id)!;
          lt.auction_opened_at = this.currentTime;
          shouldGossip = true;
          this.evaluateAndBid(d, lt);
        } else {
          const lt = d.localState.knownTasks.get(inc.task_id)!;
          if (inc.version > lt.version && inc.status === 'RELEASED') {
            if (d.localState.currentTaskId === lt.task_id) d.localState.currentTaskId = null;
            lt.version = inc.version;
            lt.status = 'RELEASED';
            lt.owner_id = null;
            lt.best_bid = -1e9;
            lt.best_bidder = null;
            lt.auction_opened_at = this.currentTime;
            shouldGossip = true;
            this.evaluateAndBid(d, lt);
          }
        }
      } else if (msg.message_type === 'BID' && msg.task_id) {
        if (p.task) d.localState.upsertTask(cloneTask(p.task as DeliveryTask));
        const lt = d.localState.knownTasks.get(msg.task_id);
        if (lt && (lt.status === 'ANNOUNCED' || lt.status === 'BIDDING' || lt.status === 'RELEASED')) {
          const incVer = Number(p.version || 1);
          const incBid = Number(p.bid ?? -1e9);
          const incBidder = Number(p.bidder_id ?? msg.sender_id);
          if (incVer >= lt.version) {
            if (incVer > lt.version) {
              lt.version = incVer;
              lt.owner_id = null;
              lt.best_bid = -1e9;
              lt.best_bidder = null;
            }
            if (TaskNegotiationEngine.isBetterBid(incBid, incBidder, lt.best_bid, lt.best_bidder)) {
              lt.best_bid = incBid;
              lt.best_bidder = incBidder;
              lt.status = 'BIDDING';
              shouldGossip = true;
            }
            this.evaluateAndBid(d, lt);
          }
        }
      } else if ((msg.message_type === 'CLAIM' || msg.message_type === 'RENEW') && msg.task_id) {
        if (p.task) d.localState.upsertTask(cloneTask(p.task as DeliveryTask));
        const lt = d.localState.knownTasks.get(msg.task_id);
        if (lt) {
          const incOwner = Number(p.owner_id ?? msg.sender_id);
          const incVer = Number(p.version ?? 1);
          const incExpiry = Number(p.lease_expiry ?? this.currentTime + d.assignment.leaseDuration);
          const { changed, preempted } = d.assignment.resolveIncomingClaim(
            lt,
            incOwner,
            incVer,
            incExpiry,
            d.localState
          );
          if (preempted) {
            this.recordTimelineEvent(
              'CONFLICT_RESOLVED',
              `D${d.id} yielded ${msg.task_id} to D${incOwner} (v${incVer}) via deterministic conflict resolution`,
              d.id,
              msg.task_id
            );
          }
          if (p.picked_up) lt.picked_up = true;
          for (const ot of d.localState.knownTasks.values()) {
            if (
              ot.task_id !== msg.task_id &&
              (ot.status === 'ANNOUNCED' || ot.status === 'BIDDING' || ot.status === 'RELEASED') &&
              ot.best_bidder === incOwner
            ) {
              ot.best_bidder = null;
              ot.best_bid = -1e9;
              ot.auction_opened_at = this.currentTime;
            }
          }
          if (changed) shouldGossip = true;
        }
      } else if (msg.message_type === 'DONE' && msg.task_id) {
        if (p.task) d.localState.upsertTask(cloneTask(p.task as DeliveryTask));
        const lt = d.localState.knownTasks.get(msg.task_id);
        if (lt && lt.status !== 'COMPLETED') {
          if (d.localState.currentTaskId === msg.task_id) d.localState.currentTaskId = null;
          lt.status = 'COMPLETED';
          lt.completed_at = Number(p.completed_at ?? this.currentTime);
          lt.completed_by = Number(p.completed_by ?? msg.sender_id);
          lt.owner_id = lt.completed_by;
          shouldGossip = true;
        }
      } else if (msg.message_type === 'RECOVERY_REQUEST' && p.digest) {
        const updates = d.recovery.reconcileDigest(
          d.localState,
          d.assignment,
          p.digest as Record<string, DeliveryTask>,
          this.currentTime
        );
        if (p.is_request) {
          const reply = d.comm.createMessage('RECOVERY_REQUEST', this.currentTime, null, {
            digest: d.localState.buildDigest(),
            is_request: false,
          });
          this.broadcast(d.id, reply);
        }
        if (updates > 0) {
          this.recordTimelineEvent(
            'RECONCILIATION',
            `D${d.id} reconciled ${updates} task state(s) from peer digest`,
            d.id
          );
          for (const t of d.localState.knownTasks.values()) {
            if (t.status === 'ANNOUNCED' || t.status === 'BIDDING' || t.status === 'RELEASED') {
              this.evaluateAndBid(d, t);
            }
          }
        }
      }

      if (shouldGossip && msg.hop_count < msg.max_hops) {
        const fwd: ForumMessage = {
          ...msg,
          sender_id: d.id,
          hop_count: msg.hop_count + 1,
        };
        d.comm.forwardedCount += 1;
        this.broadcast(d.id, fwd);
      }
    }

    // Check expired leases
    const released = d.recovery.checkExpiredLeases(d.localState, this.currentTime);
    for (const rt of released) {
      d.leaseExpiredFlashUntil = this.currentTime + 2.5;
      this.recordTimelineEvent(
        'LEASE_EXPIRED',
        `D${d.id} detected expired lease + ${d.recovery.gracePeriod}s grace on ${rt.task_id}; bumped to v${rt.version} for re-bid`,
        d.id,
        rt.task_id
      );
      const msg = d.comm.createMessage('TASK_ANNOUNCE', this.currentTime, rt.task_id, {
        task: cloneTask(rt),
        released: true,
      });
      this.broadcast(d.id, msg);
      this.evaluateAndBid(d, rt);
    }

    // Claim won auctions & ensure every idle drone bids on an unowned open task
    if (d.localState.currentTaskId === null && !d.returningForSafety) {
      let winningAny = false;
      for (const task of d.localState.knownTasks.values()) {
        if (
          (task.status === 'ANNOUNCED' || task.status === 'BIDDING' || task.status === 'RELEASED') &&
          task.best_bidder === d.id
        ) {
          winningAny = true;
          break;
        }
      }

      if (!winningAny) {
        // Autonomous multi-task evaluation: pick the best open task we can win so all drones work in parallel
        let bestTask: DeliveryTask | null = null;
        let bestMyBid = -1e9;
        for (const cand of d.localState.knownTasks.values()) {
          if (cand.status === 'ANNOUNCED' || cand.status === 'BIDDING' || cand.status === 'RELEASED') {
            const b = d.negotiation.computeBid(
              d.position,
              d.battery,
              cand,
              this.currentTime,
              d.localState.hazards
            );
            if (
              b !== null &&
              TaskNegotiationEngine.isBetterBid(b, d.id, cand.best_bid, cand.best_bidder) &&
              b > bestMyBid
            ) {
              bestMyBid = b;
              bestTask = cand;
            }
          }
        }
        if (bestTask) {
          this.evaluateAndBid(d, bestTask);
        }
      }

      for (const task of d.localState.knownTasks.values()) {
        if (task.status === 'ANNOUNCED' || task.status === 'BIDDING' || task.status === 'RELEASED') {
          if (
            task.best_bidder !== null &&
            task.best_bidder !== d.id &&
            this.currentTime - task.auction_opened_at > d.assignment.auctionWindow * 2.2
          ) {
            task.best_bidder = null;
            task.best_bid = -1e9;
            task.auction_opened_at = this.currentTime;
          }
          if (task.best_bidder === null) {
            this.evaluateAndBid(d, task);
          }
          if (
            task.best_bidder === d.id &&
            this.currentTime - task.auction_opened_at >= d.assignment.auctionWindow
          ) {
            if (d.safety.canUndertake(d.position, d.battery, task, this.currentTime).ok) {
              task.owner_id = d.id;
              task.lease_expiry = d.assignment.useLeases
                ? this.currentTime + d.assignment.leaseDuration
                : 1e9;
              task.status = 'CLAIMED';
              d.localState.currentTaskId = task.task_id;
              d.assignment.lastRenewSentAt = this.currentTime;
              d.autonomousDecision = `Claimed ${task.task_id} (v${task.version}) → Flying to Pickup`;
              const cMsg = d.comm.createMessage('CLAIM', this.currentTime, task.task_id, {
                owner_id: d.id,
                version: task.version,
                lease_expiry: task.lease_expiry,
                picked_up: task.picked_up,
                task: cloneTask(task),
              });
              this.broadcast(d.id, cMsg);
              break;
            } else {
              task.best_bidder = null;
              task.best_bid = -1e9;
            }
          }
        }
      }
    }

    // Renew active lease
    if (d.localState.currentTaskId) {
      const active = d.localState.knownTasks.get(d.localState.currentTaskId);
      if (
        active &&
        d.assignment.useLeases &&
        this.currentTime - d.assignment.lastRenewSentAt >= d.assignment.renewInterval
      ) {
        active.lease_expiry = this.currentTime + d.assignment.leaseDuration;
        d.assignment.lastRenewSentAt = this.currentTime;
        const rMsg = d.comm.createMessage('RENEW', this.currentTime, active.task_id, {
          owner_id: d.id,
          version: active.version,
          lease_expiry: active.lease_expiry,
          picked_up: active.picked_up,
          task: cloneTask(active),
        });
        this.broadcast(d.id, rMsg);
      }
    }

    // Periodic broadcast baseline overhead
    if (d.comm.periodicBroadcast && this.currentTime - d.lastPeriodicAt >= 1.0) {
      d.lastPeriodicAt = this.currentTime;
      const hb = d.comm.createMessage('HEARTBEAT', this.currentTime, null, {
        position: d.position,
        battery: d.battery,
      });
      this.broadcast(d.id, hb);
    }
  }

  private stepDroneKinematics(d: DroneState): void {
    // Expire old visual drop animations after 4.5s
    this.activeDrops = this.activeDrops.filter((dr) => this.currentTime - dr.droppedAt <= 4.5);

    const active = d.localState.currentTaskId
      ? d.localState.knownTasks.get(d.localState.currentTaskId) || null
      : null;

    // Decentralized: each drone uses its own homePos for reserve recharge, never a central controller hub
    let target: [number, number] =
      this.mode === 'centralized' ? [500, 500] : d.returningForSafety ? d.homePos : d.position;

    if (!d.returningForSafety && active) {
      target = active.picked_up ? active.dropoff : active.pickup;
      if (active.picked_up) {
        d.autonomousDecision = `Carrying Order ${active.task_id} (${active.payload}kg) → Dropoff`;
      } else {
        d.autonomousDecision = `Claimed ${active.task_id} (v${active.version}) → Flying to Pickup`;
      }
    }

    const dx = target[0] - d.position[0];
    const dy = target[1] - d.position[1];
    const dist = Math.hypot(dx, dy);

    if (!active || d.returningForSafety) {
      if (d.returningForSafety && dist <= 10) {
        d.battery = Math.min(100, d.battery + 18 * this.dt);
        d.autonomousDecision = `Recharging on Sector Pad (${d.battery.toFixed(0)}%)`;
        if (d.battery >= 85) d.returningForSafety = false;
        d.velocity = [0, 0];
        d.altitude += (4.5 - d.altitude) * 0.25;
        d.pitch *= 0.7;
        d.roll *= 0.7;
        return;
      }
      if (!active && !d.returningForSafety) {
        // Hover autonomously in place (no central return!) while negotiating on P2P forum
        d.velocity = [0, 0];
        const hoverAlt = 20 + (d.id % 4) * 3;
        d.altitude += (hoverAlt - d.altitude) * 0.18;
        d.pitch *= 0.75;
        d.roll *= 0.75;
        if (this.currentTime - d.lastDropTime < 2.4 && d.lastDropTaskId) {
          d.autonomousDecision = `Dropped Order ${d.lastDropTaskId}! Scanning P2P Forum`;
        }
        return;
      }
    }

    let vx = dist > 1e-3 ? (dx / dist) * d.safety.droneSpeed : 0;
    let vy = dist > 1e-3 ? (dy / dist) * d.safety.droneSpeed : 0;

    // Reciprocal Velocity Obstacle (RVO) local collision avoidance
    for (const other of this.drones.values()) {
      if (other.id === d.id || !other.alive) continue;
      const ox = d.position[0] - other.position[0];
      const oy = d.position[1] - other.position[1];
      const odist = Math.hypot(ox, oy);
      if (odist > 0.1 && odist < 42) {
        this.rvoAvoidanceCount += 1;
        const ux = ox / odist;
        const uy = oy / odist;
        const strength = (42 - odist) / 42;
        vx += (ux * 0.7 - uy * 0.3) * d.safety.droneSpeed * strength * 0.85;
        vy += (uy * 0.7 + ux * 0.3) * d.safety.droneSpeed * strength * 0.85;
      }
    }

    const spd = Math.hypot(vx, vy);
    const maxStep = Math.min(dist, d.safety.droneSpeed * this.dt);
    if (spd > 1e-3) {
      d.position = [
        d.position[0] + (vx / spd) * maxStep,
        d.position[1] + (vy / spd) * maxStep,
      ];
      d.velocity = [vx, vy];
      const targetYaw = Math.atan2(vy, vx);
      let yawDiff = targetYaw - d.yaw;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      d.yaw += yawDiff * 0.35;
      d.pitch = Math.min(0.28, (spd / d.safety.droneSpeed) * 0.22);
      d.roll = Math.max(-0.32, Math.min(0.32, yawDiff * 0.45));
    } else {
      d.pitch *= 0.75;
      d.roll *= 0.75;
    }

    // Smooth 3D altitude profile: cruise altitude when in transit, descend over pickup/dropoff pads
    const cruiseAlt = 24 + (d.id % 5) * 3.5;
    const targetAlt = dist < 55 ? 7.0 + (dist / 55) * (cruiseAlt - 7.0) : cruiseAlt;
    d.altitude += (targetAlt - d.altitude) * 0.26;

    d.trail.push([d.position[0], d.altitude, d.position[1]]);
    if (d.trail.length > 36) {
      d.trail.shift();
    }

    const drain = maxStep * d.safety.energyPerMeter * (active?.picked_up ? 1.25 : 1.0);
    d.battery = Math.max(0, d.battery - drain);
    d.energyConsumed += drain;

    if (active && dist - maxStep <= 7.0) {
      if (!active.picked_up) {
        active.picked_up = true;
        active.status = 'IN_PROGRESS';
        d.autonomousDecision = `Picked Up ${active.task_id} (${active.payload}kg) → En Route to Dropoff`;
        const master = this.masterTasks.get(active.task_id);
        if (master) {
          master.picked_up = true;
          master.status = 'IN_PROGRESS';
          master.owner_id = d.id;
        }
      } else {
        active.status = 'COMPLETED';
        active.completed_at = this.currentTime;
        active.completed_by = d.id;
        d.localState.currentTaskId = null;
        d.ordersDropped += 1;
        d.lastDropTime = this.currentTime;
        d.lastDropTaskId = active.task_id;
        d.autonomousDecision = `Dropped Order ${active.task_id} at Dropoff! Broadcasting DONE`;
        this.recordTimelineEvent(
          'ORDER_DROPPED',
          `Drone D${d.id} dropped order ${active.task_id} (${active.payload}kg) at (${active.dropoff[0]}, ${active.dropoff[1]})`,
          d.id,
          active.task_id
        );

        // Record 3D physical order drop event so 3D viewport animates the package dropping onto the pad
        this.activeDrops.push({
          id: `${active.task_id}-drop-${this.currentTime.toFixed(2)}`,
          taskId: active.task_id,
          droneId: d.id,
          dropoff: [active.dropoff[0], active.dropoff[1]],
          payload: active.payload,
          startAlt: Math.max(10, d.altitude),
          droppedAt: this.currentTime,
        });

        const master = this.masterTasks.get(active.task_id);
        if (master) {
          master.status = 'COMPLETED';
          master.completed_at = this.currentTime;
          master.completed_by = d.id;
          master.owner_id = d.id;
        }
        if (this.mode !== 'centralized') {
          const doneMsg = d.comm.createMessage('DONE', this.currentTime, active.task_id, {
            completed_at: this.currentTime,
            completed_by: d.id,
            version: active.version,
            task: cloneTask(active),
          });
          this.broadcast(d.id, doneMsg);
        }
      }
    }
  }

  getConsolidatedTasks(): DeliveryTask[] {
    const out: Map<string, DeliveryTask> = new Map();
    for (const [tid, t] of this.masterTasks.entries()) {
      if (this.spawnedTaskIds.has(tid)) {
        out.set(tid, cloneTask(t));
      }
    }
    for (const d of this.drones.values()) {
      for (const [tid, lt] of d.localState.knownTasks.entries()) {
        const cur = out.get(tid);
        if (!cur) {
          out.set(tid, cloneTask(lt));
          continue;
        }
        if (lt.status === 'COMPLETED') {
          out.set(tid, cloneTask(lt));
        } else if (cur.status !== 'COMPLETED') {
          if (lt.version > cur.version || (lt.owner_id !== null && cur.owner_id === null)) {
            out.set(tid, cloneTask(lt));
          }
        }
      }
    }
    return Array.from(out.values());
  }
}
