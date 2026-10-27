import React, { useEffect, useRef } from 'react';
import { SwarmSyncSimulator } from '../sim/engine';

export interface ReplayFrameData {
  time: number;
  partitioned: boolean;
  totalMessages: number;
  completedCount: number;
  drones: {
    id: string;
    x: number;
    y: number;
    battery: number;
    alive: boolean;
    currentTaskId: string | null;
    leaseRemaining: number;
    leaseDuration: number;
    knownTasksCount: number;
    conflictsResolved: number;
    reconciliations: number;
  }[];
  tasks: {
    id: string;
    x: number;
    y: number;
    pickupX: number;
    pickupY: number;
    status: string;
    ownerId: string | null;
    version: number;
    leaseExpiry: number;
    payload: number;
  }[];
}

interface LiveArenaCanvasProps {
  simRef: React.MutableRefObject<SwarmSyncSimulator>;
  selectedDroneId: number;
  onSelectDrone: (id: number) => void;
  onSpawnTaskAt: (pickup: [number, number], dropoff: [number, number]) => void;
  renderTick: number;
  replayFrame?: ReplayFrameData | null;
  compact?: boolean;
  labelBadge?: string;
}

export const LiveArenaCanvas: React.FC<LiveArenaCanvasProps> = ({
  simRef,
  selectedDroneId,
  onSelectDrone,
  onSpawnTaskAt,
  renderTick,
  replayFrame = null,
  compact = false,
  labelBadge,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingPickupRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const scaleX = w / 1000;
    const scaleY = h / 1000;

    ctx.clearRect(0, 0, w, h);

    // 1. Background field (#0B1220 deep navy)
    ctx.fillStyle = '#0B1220';
    ctx.fillRect(0, 0, w, h);

    // 2. Coordinate grid (every 100m)
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.08)';
    ctx.lineWidth = 1;
    for (let m = 100; m < 1000; m += 100) {
      const gx = m * scaleX;
      const gy = m * scaleY;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '10px "IBM Plex Mono", monospace';
    for (let m = 200; m <= 800; m += 200) {
      ctx.fillText(`${m}m`, m * scaleX + 4, 14);
      ctx.fillText(`${m}m`, 6, m * scaleY - 4);
    }

    // If rendering a Benchmark-Faithful Python Replay Frame:
    if (replayFrame) {
      if (replayFrame.partitioned) {
        const px = 500 * scaleX;
        ctx.save();
        ctx.strokeStyle = '#F87171';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();
        ctx.fillStyle = 'rgba(248, 113, 113, 0.14)';
        ctx.fillRect(px - 14, 0, 28, h);
        ctx.fillStyle = '#FCA5A5';
        ctx.font = '600 11px "IBM Plex Mono", monospace';
        ctx.fillText('▲ PYTHON TRACE PARTITION BARRIER (X = 500m)', px - 130, 26);
        ctx.restore();
      }

      // Draw peer links in replay
      for (let i = 0; i < replayFrame.drones.length; i++) {
        for (let j = i + 1; j < replayFrame.drones.length; j++) {
          const dA = replayFrame.drones[i];
          const dB = replayFrame.drones[j];
          if (!dA.alive || !dB.alive) continue;
          if (replayFrame.partitioned && (dA.x < 500) !== (dB.x < 500)) continue;
          const dist = Math.hypot(dA.x - dB.x, dA.y - dB.y);
          if (dist <= 620) {
            ctx.strokeStyle = 'rgba(34, 211, 238, 0.22)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(dA.x * scaleX, dA.y * scaleY);
            ctx.lineTo(dB.x * scaleX, dB.y * scaleY);
            ctx.stroke();
          }
        }
      }

      // Draw tasks in replay
      for (const t of replayFrame.tasks) {
        const px = t.pickupX * scaleX;
        const py = t.pickupY * scaleY;
        const dx = t.x * scaleX;
        const dy = t.y * scaleY;
        if (t.status === 'COMPLETED') {
          ctx.fillStyle = '#A3E635';
          ctx.beginPath();
          ctx.arc(dx, dy, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = '10px "IBM Plex Mono", monospace';
          ctx.fillText(`✓ ${t.id}`, dx + 7, dy + 3);
          continue;
        }
        ctx.save();
        ctx.strokeStyle = t.status === 'RELEASED' ? '#F87171' : '#22D3EE';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(dx, dy);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = '#F59E0B';
        ctx.fillRect(px - 4.5, py - 4.5, 9, 9);
        ctx.fillStyle = '#22D3EE';
        ctx.beginPath();
        ctx.moveTo(dx, dy - 6);
        ctx.lineTo(dx + 6, dy + 5);
        ctx.lineTo(dx - 6, dy + 5);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#F8FAFC';
        ctx.font = '600 10px "IBM Plex Mono", monospace';
        ctx.fillText(`${t.id}·v${t.version} [${t.ownerId || t.status}]`, dx + 8, dy - 4);
      }

      // Draw drones in replay with shrinking lease ring
      for (const d of replayFrame.drones) {
        const x = d.x * scaleX;
        const y = d.y * scaleY;
        const numId = Number(d.id.replace('D', '')) || 1;
        const isSelected = numId === selectedDroneId;

        if (isSelected) {
          ctx.strokeStyle = '#22D3EE';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 18, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Shrinking Lease Ring
        if (d.alive && d.currentTaskId && d.leaseDuration > 0) {
          const prog = Math.max(0, Math.min(1, d.leaseRemaining / d.leaseDuration));
          ctx.save();
          ctx.strokeStyle = prog < 0.25 ? '#F87171' : prog < 0.5 ? '#F59E0B' : '#A3E635';
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.arc(x, y, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
          ctx.stroke();
          ctx.restore();
        }

        ctx.fillStyle = !d.alive ? '#F87171' : d.currentTaskId ? '#22D3EE' : '#94A3B8';
        ctx.beginPath();
        ctx.arc(x, y, 9.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#0B1220';
        ctx.font = '700 10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(d.id, x, y + 3.5);

        ctx.textAlign = 'left';
        ctx.fillStyle = !d.alive ? '#FCA5A5' : '#E2E8F0';
        ctx.fillText(
          !d.alive
            ? '✖ FAILED'
            : d.currentTaskId
            ? `${d.currentTaskId} (L:${d.leaseRemaining.toFixed(1)}s)`
            : 'IDLE',
          x + 15,
          y + 4
        );
      }
      return;
    }

    const sim = simRef.current;

    // 3. Decentralized Sector Pads vs Centralized Hub
    if (sim.mode === 'centralized') {
      const bx = 500 * scaleX;
      const by = 500 * scaleY;
      ctx.strokeStyle = sim.centralHubAlive
        ? 'rgba(34, 211, 238, 0.6)'
        : 'rgba(248, 113, 113, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, 26 * scaleX, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(11, 18, 32, 0.9)';
      ctx.fillRect(bx - 46, by + 22, 92, 16);
      ctx.fillStyle = sim.centralHubAlive ? '#22D3EE' : '#F87171';
      ctx.font = '700 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(sim.centralHubAlive ? 'CENTRAL HUB' : '✖ HUB FAILED', bx, by + 33);
    } else {
      for (const d of sim.drones.values()) {
        const hx = d.homePos[0] * scaleX;
        const hy = d.homePos[1] * scaleY;
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(hx, hy, 14 * scaleX, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 4. Network Partition Barrier if enabled
    if (sim.partitionEnabled) {
      const px = sim.partitionX * scaleX;
      ctx.save();
      ctx.strokeStyle = '#F87171';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      ctx.fillStyle = 'rgba(248, 113, 113, 0.14)';
      ctx.fillRect(px - 14, 0, 28, h);
      ctx.fillStyle = '#FCA5A5';
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('▲ NETWORK PARTITION ISOLATION BARRIER (X = 500m)', px, 26);
      ctx.restore();
    }

    // 5. Peer-to-peer wireless links between reachable drones
    const drones = Array.from(sim.drones.values());
    for (let i = 0; i < drones.length; i++) {
      for (let j = i + 1; j < drones.length; j++) {
        const dA = drones[i];
        const dB = drones[j];
        if (sim.canCommunicate(dA.id, dB.id)) {
          ctx.strokeStyle = 'rgba(34, 211, 238, 0.22)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(dA.position[0] * scaleX, dA.position[1] * scaleY);
          ctx.lineTo(dB.position[0] * scaleX, dB.position[1] * scaleY);
          ctx.stroke();
        }
      }
    }

    // 6. Animated In-Flight Forum Packets (color-coded by MessageType)
    for (const pkt of sim.inFlightPackets) {
      const totalDur = Math.max(0.02, pkt.deliverAt - pkt.sentAt);
      const frac = Math.min(1, Math.max(0, (sim.currentTime - pkt.sentAt) / totalDur));
      const ix = (pkt.fromPos[0] + (pkt.toPos[0] - pkt.fromPos[0]) * frac) * scaleX;
      const iy = (pkt.fromPos[1] + (pkt.toPos[1] - pkt.fromPos[1]) * frac) * scaleY;

      const mtype = pkt.message.message_type;
      ctx.fillStyle =
        mtype === 'CLAIM' || mtype === 'RENEW'
          ? '#A3E635'
          : mtype === 'RECOVERY_REQUEST'
          ? '#C084FC'
          : mtype === 'DONE'
          ? '#10B981'
          : mtype === 'TASK_ANNOUNCE'
          ? '#22D3EE'
          : '#F59E0B';
      ctx.beginPath();
      ctx.arc(ix, iy, 3.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // 7. Delivery Tasks (Pickup -> Dropoff vectors, status, version, lease)
    const tasks = sim.getConsolidatedTasks();
    for (const t of tasks) {
      const px = t.pickup[0] * scaleX;
      const py = t.pickup[1] * scaleY;
      const dx = t.dropoff[0] * scaleX;
      const dy = t.dropoff[1] * scaleY;

      if (t.status === 'COMPLETED') {
        ctx.strokeStyle = 'rgba(163, 230, 53, 0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(dx, dy);
        ctx.stroke();

        ctx.fillStyle = '#A3E635';
        ctx.beginPath();
        ctx.arc(dx, dy, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`✓ ${t.task_id}`, dx + 7, dy + 3);
        continue;
      }

      // Active or open task route vector
      ctx.save();
      ctx.strokeStyle =
        t.status === 'RELEASED'
          ? 'rgba(248, 113, 113, 0.75)'
          : t.owner_id !== null
          ? 'rgba(34, 211, 238, 0.55)'
          : 'rgba(245, 158, 11, 0.4)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(dx, dy);
      ctx.stroke();
      ctx.restore();

      // Pickup square
      if (!t.picked_up) {
        ctx.fillStyle = t.status === 'RELEASED' ? '#F87171' : '#F59E0B';
        ctx.fillRect(px - 5, py - 5, 10, 10);
      }

      // Dropoff triangle
      ctx.fillStyle = '#22D3EE';
      ctx.beginPath();
      ctx.moveTo(dx, dy - 6);
      ctx.lineTo(dx + 6, dy + 5);
      ctx.lineTo(dx - 6, dy + 5);
      ctx.closePath();
      ctx.fill();

      const lx = t.picked_up ? dx : px;
      const ly = t.picked_up ? dy : py;
      ctx.fillStyle = '#F8FAFC';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      const ownerTag = t.owner_id ? `D${t.owner_id}` : t.status === 'RELEASED' ? 'RE-BID' : 'OPEN';
      ctx.fillText(`${t.task_id}·v${t.version} [${ownerTag}]`, lx + 8, ly - 4);
    }

    // 8. Drones (Position, Selection ring, Shrinking Lease Ring, Battery bar)
    for (const d of drones) {
      const x = d.position[0] * scaleX;
      const y = d.position[1] * scaleY;
      const isSelected = d.id === selectedDroneId;

      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.16)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.arc(x, y, sim.commRange * scaleX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Shrinking Lease Ring around owner drone (flashes red on lease expiry)
      const isFlashingExpiry = sim.currentTime < d.leaseExpiredFlashUntil;
      if (isFlashingExpiry) {
        ctx.save();
        ctx.strokeStyle = '#F87171';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (d.alive && d.localState.currentTaskId && d.leaseProgress > 0) {
        ctx.save();
        ctx.strokeStyle =
          d.leaseProgress < 0.25
            ? '#F87171'
            : d.leaseProgress < 0.5
            ? '#F59E0B'
            : '#A3E635';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(
          x,
          y,
          13.5,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.max(0.05, d.leaseProgress)
        );
        ctx.stroke();
        ctx.restore();
      }

      // If drone is dead and still had an orphaned task whose lease is expiring, draw red decaying ring
      if (!d.alive && d.localState.currentTaskId) {
        const failT = sim.taskFailureTimes.get(d.localState.currentTaskId);
        if (failT !== undefined) {
          const elapsed = sim.currentTime - failT;
          const totalWait = d.assignment.leaseDuration + d.recovery.gracePeriod;
          const remFrac = Math.max(0, 1 - elapsed / totalWait);
          ctx.save();
          ctx.strokeStyle = '#F87171';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, y, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remFrac);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Drone body
      ctx.fillStyle = !d.alive
        ? '#F87171'
        : d.localState.currentTaskId
        ? '#22D3EE'
        : '#94A3B8';
      ctx.beginPath();
      ctx.arc(x, y, 9.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0B1220';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Drone ID inside circle
      ctx.fillStyle = '#0B1220';
      ctx.font = '700 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`D${d.id}`, x, y + 3.5);

      // Battery mini bar below drone
      const barW = 28;
      const barH = 4;
      ctx.fillStyle = 'rgba(11, 18, 32, 0.9)';
      ctx.fillRect(x - barW / 2, y + 15, barW, barH);
      ctx.fillStyle = !d.alive
        ? '#F87171'
        : d.battery > 35
        ? '#A3E635'
        : '#F59E0B';
      ctx.fillRect(x - barW / 2, y + 15, (barW * Math.max(0, d.battery)) / 100, barH);

      // Telemetry tag beside drone
      ctx.textAlign = 'left';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      if (!d.alive) {
        ctx.fillStyle = '#FCA5A5';
        ctx.fillText('✖ FAILED', x + 15, y + 4);
      } else {
        const tid = d.localState.currentTaskId;
        const activeT = tid ? d.localState.knownTasks.get(tid) : null;
        const leaseRem = activeT ? Math.max(0, activeT.lease_expiry - sim.currentTime) : 0;
        ctx.fillStyle = '#E2E8F0';
        const statusStr = tid
          ? `${tid} ${leaseRem < 900 ? `L:${leaseRem.toFixed(1)}s` : ''}`
          : 'IDLE';
        ctx.fillText(statusStr, x + 15, y + 4);
      }
    }

    // Pending custom task pickup marker if user clicked once
    if (pendingPickupRef.current) {
      const [px, py] = pendingPickupRef.current;
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px * scaleX, py * scaleY, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [simRef, selectedDroneId, renderTick, replayFrame]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (replayFrame) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const worldX = Math.round(((e.clientX - rect.left) / rect.width) * 1000);
    const worldY = Math.round(((e.clientY - rect.top) / rect.height) * 1000);

    const sim = simRef.current;
    for (const d of sim.drones.values()) {
      const dist = Math.hypot(d.position[0] - worldX, d.position[1] - worldY);
      if (dist <= 30) {
        onSelectDrone(d.id);
        return;
      }
    }

    if (!pendingPickupRef.current) {
      pendingPickupRef.current = [worldX, worldY];
    } else {
      const pickup = pendingPickupRef.current;
      pendingPickupRef.current = null;
      onSpawnTaskAt(pickup, [worldX, worldY]);
    }
  };

  return (
    <div className="relative w-full bg-[#0B1220] rounded-lg border border-slate-800/90 overflow-hidden">
      {labelBadge && (
        <div className="absolute top-2.5 left-2.5 z-10 px-2.5 py-1 rounded bg-[#111D31]/90 border border-cyan-500/30 text-[11px] font-mono text-cyan-300">
          {labelBadge}
        </div>
      )}
      <canvas
        ref={canvasRef}
        data-testid="swarmsync-arena-canvas"
        width={compact ? 520 : 760}
        height={compact ? 400 : 520}
        onClick={handleCanvasClick}
        className="w-full h-auto block cursor-crosshair"
      />
      {/* Floating Mini-Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#111D31] border-t border-slate-800 text-[11px] text-slate-300 font-mono">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[#22D3EE]" /> Carrying
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full border-2 border-[#A3E635]" /> Lease Ring
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-[#F59E0B]" /> Pickup
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[#A3E635]" /> Delivered
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[#F87171]" /> Failed / Expired
          </span>
        </div>
        {!compact && (
          <div className="text-slate-400">
            Click drone to inspect local view · 2-click map to place task
          </div>
        )}
      </div>
    </div>
  );
};
