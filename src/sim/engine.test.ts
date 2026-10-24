import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssignmentManager,
  CommunicationManager,
  DeliveryTask,
  LocalStateManager,
  RecoveryManager,
  SafetyMonitor,
  SwarmSyncSimulator,
} from './engine';

function makeSampleTask(id = 'T-01'): DeliveryTask {
  return {
    task_id: id,
    pickup: [200, 200],
    dropoff: [450, 450],
    payload: 1.5,
    spawn_time: 0,
    deadline: 120,
    status: 'ANNOUNCED',
    owner_id: null,
    version: 1,
    lease_expiry: 0,
    best_bid: -1e9,
    best_bidder: null,
    auction_opened_at: 0,
    picked_up: false,
    completed_at: null,
    completed_by: null,
  };
}

test('CommunicationManager deduplicates message_id and drops expired messages', () => {
  const comm1 = new CommunicationManager(1);
  const comm2 = new CommunicationManager(2);

  const msg = comm1.createMessage('TASK_ANNOUNCE', 10.0, 'T-01', { test: true }, 5.0);
  const expiredMsg = comm1.createMessage('BID', 2.0, 'T-01', { bid: -0.4 }, 3.0);

  const accepted = comm2.filterIncoming([msg, msg, expiredMsg], 11.0);
  assert.equal(accepted.length, 1);
  assert.equal(comm2.dedupedCount, 1);
  assert.equal(comm2.droppedExpiredCount, 1);
});

test('AssignmentManager resolves conflicts deterministically by (version, -agentId)', () => {
  const state2 = new LocalStateManager(2);
  const assign2 = new AssignmentManager(2, true);
  const t = makeSampleTask('T-10');
  t.status = 'CLAIMED';
  t.owner_id = 2;
  t.version = 1;
  t.lease_expiry = 15.0;
  state2.upsertTask(t);
  state2.currentTaskId = 'T-10';
  const localT = state2.knownTasks.get('T-10')!;

  // Higher agent_id (3) at equal version (1) loses tie-breaker
  const resLose = assign2.resolveIncomingClaim(localT, 3, 1, 16.0, state2);
  assert.equal(resLose.changed, false);
  assert.equal(localT.owner_id, 2);

  // Lower agent_id (1) at equal version (1) wins tie-breaker
  const resWinTie = assign2.resolveIncomingClaim(localT, 1, 1, 16.0, state2);
  assert.equal(resWinTie.changed, true);
  assert.equal(resWinTie.preempted, true);
  assert.equal(localT.owner_id, 1);
  assert.equal(state2.currentTaskId, null);

  // Higher version (2) from agent 4 strictly wins over version 1
  const resHigherVer = assign2.resolveIncomingClaim(localT, 4, 2, 22.0, state2);
  assert.equal(resHigherVer.changed, true);
  assert.equal(localT.owner_id, 4);
  assert.equal(localT.version, 2);
});

test('RecoveryManager enforces conservative grace period before releasing expired lease', () => {
  const state1 = new LocalStateManager(1);
  const recovery1 = new RecoveryManager(1, true);
  const t = makeSampleTask('T-07');
  t.status = 'CLAIMED';
  t.owner_id = 3;
  t.version = 1;
  t.lease_expiry = 20.0;
  state1.upsertTask(t);

  // Within grace period (t = 21.5 <= 20.0 + 3.0): not released
  const early = recovery1.checkExpiredLeases(state1, 21.5);
  assert.equal(early.length, 0);

  // Past grace period (t = 23.5 > 23.0): released with version incremented to 2
  const released = recovery1.checkExpiredLeases(state1, 23.5);
  assert.equal(released.length, 1);
  assert.equal(state1.knownTasks.get('T-07')!.status, 'RELEASED');
  assert.equal(state1.knownTasks.get('T-07')!.version, 2);
});

test('SafetyMonitor rejects overweight or insufficient-reserve missions', () => {
  const safety = new SafetyMonitor();
  const heavy = makeSampleTask('T-HEAVY');
  heavy.payload = 4.5;
  assert.equal(safety.canUndertake([500, 500], 100, heavy, 0).ok, false);

  const normal = makeSampleTask('T-NORM');
  assert.equal(safety.canUndertake([100, 100], 18, normal, 0).ok, false);
});

test('SwarmSyncSimulator completes deliveries and recovers killed drone task', () => {
  const sim = new SwarmSyncSimulator('drone_failure', 'swarmsync', 1, 5);
  for (let i = 0; i < 650; i++) {
    sim.step();
  }
  const tasks = sim.getConsolidatedTasks();
  const completed = tasks.filter((t) => t.status === 'COMPLETED');
  assert.ok(completed.length >= 10, `Expected >=10 completed tasks, got ${completed.length}`);
});

test('SwarmSyncSimulator updates 3D flight kinematics (altitude, attitude, and 3D trail)', () => {
  const sim = new SwarmSyncSimulator('normal', 'swarmsync', 2, 5);
  for (let i = 0; i < 40; i++) {
    sim.step();
  }
  const drones = Array.from(sim.drones.values());
  const moving = drones.find((d) => d.trail.length > 5);
  assert.ok(moving, 'Expected at least one drone to record 3D flight trail');
  assert.ok(moving!.altitude > 4.0, 'Expected active drone to maintain positive 3D altitude');

  sim.killDrone(1);
  const d1 = sim.drones.get(1)!;
  assert.equal(d1.alive, false);
  assert.ok(d1.altitude < 2.0, 'Killed drone should drop to ground altitude');
});

test('Every drone in decentralized SwarmSync mode operates on its own decision and drops orders', () => {
  const sim = new SwarmSyncSimulator('normal', 'swarmsync', 1, 5);
  // Step 8 steps (1.6s): all 5 drones should independently claim 5 distinct tasks without any central hub
  for (let i = 0; i < 8; i++) {
    sim.step();
  }
  const claimedTasks = new Set<string>();
  for (const d of sim.drones.values()) {
    if (d.localState.currentTaskId) {
      claimedTasks.add(d.localState.currentTaskId);
    }
  }
  assert.equal(claimedTasks.size, 5, 'All 5 drones should simultaneously claim 5 distinct orders');

  // Run until completion and verify every single drone dropped at least 1 order
  for (let i = 0; i < 500; i++) {
    sim.step();
  }
  for (const d of sim.drones.values()) {
    assert.ok(
      d.ordersDropped >= 1,
      `Expected Drone D${d.id} to drop at least 1 order, got ${d.ordersDropped}`
    );
  }
});


