import React, { useEffect, useRef } from 'react';
import { SwarmSyncSimulator } from '../sim/engine';

interface LiveArenaCanvasProps {
  simRef: React.MutableRefObject<SwarmSyncSimulator>;
  selectedDroneId: number;
  onSelectDrone: (id: number) => void;
  onSpawnTaskAt: (pickup: [number, number], dropoff: [number, number]) => void;
  renderTick: number;
}

export const LiveArenaCanvas: React.FC<LiveArenaCanvasProps> = ({
  simRef,
  selectedDroneId,
  onSelectDrone,
  onSpawnTaskAt,
  renderTick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingPickupRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sim = simRef.current;
    const w = canvas.width;
    const h = canvas.height;
    const scaleX = w / 1000;
    const scaleY = h / 1000;

    ctx.clearRect(0, 0, w, h);

    // 1. Background field (Deep tactical slate canvas for high-contrast telemetry)
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, w, h);

    // 2. Coordinate grid (every 100m)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
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

    // Coordinate labels
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '10px "IBM Plex Mono", monospace';
    for (let m = 200; m <= 800; m += 200) {
      ctx.fillText(`${m}m`, m * scaleX + 4, 14);
      ctx.fillText(`${m}m`, 6, m * scaleY - 4);
    }

    // 3. Decentralized Sector Pads vs Centralized Hub
    if (sim.mode === 'centralized') {
      const bx = 500 * scaleX;
      const by = 500 * scaleY;
      ctx.strokeStyle = sim.centralHubAlive
        ? 'rgba(56, 189, 248, 0.55)'
        : 'rgba(244, 63, 94, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(bx, by, 26 * scaleX, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(bx - 42, by + 22, 84, 16);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(sim.centralHubAlive ? 'CENTRAL HUB' : 'HUB FAILED', bx, by + 33);
    } else {
      for (const d of sim.drones.values()) {
        const hx = d.homePos[0] * scaleX;
        const hy = d.homePos[1] * scaleY;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
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
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      ctx.fillStyle = 'rgba(244, 63, 94, 0.14)';
      ctx.fillRect(px - 14, 0, 28, h);
      ctx.fillStyle = '#fda4af';
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      ctx.fillText('▲ NETWORK PARTITION ISOLATION BARRIER (X = 500m)', px, 28);
      ctx.restore();
    }

    // 5. Peer-to-peer wireless links between reachable drones
    const drones = Array.from(sim.drones.values());
    for (let i = 0; i < drones.length; i++) {
      for (let j = i + 1; j < drones.length; j++) {
        const dA = drones[i];
        const dB = drones[j];
        if (sim.canCommunicate(dA.id, dB.id)) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(dA.position[0] * scaleX, dA.position[1] * scaleY);
          ctx.lineTo(dB.position[0] * scaleX, dB.position[1] * scaleY);
          ctx.stroke();
        }
      }
    }

    // 6. Animated In-Flight Forum Packets
    for (const pkt of sim.inFlightPackets) {
      const totalDur = Math.max(0.02, pkt.deliverAt - pkt.sentAt);
      const frac = Math.min(1, Math.max(0, (sim.currentTime - pkt.sentAt) / totalDur));
      const ix = (pkt.fromPos[0] + (pkt.toPos[0] - pkt.fromPos[0]) * frac) * scaleX;
      const iy = (pkt.fromPos[1] + (pkt.toPos[1] - pkt.fromPos[1]) * frac) * scaleY;

      ctx.fillStyle =
        pkt.message.message_type === 'CLAIM' || pkt.message.message_type === 'RENEW'
          ? '#38bdf8'
          : pkt.message.message_type === 'RECOVERY_REQUEST'
          ? '#c084fc'
          : pkt.message.message_type === 'DONE'
          ? '#34d399'
          : '#fbbf24';
      ctx.beginPath();
      ctx.arc(ix, iy, 3.5, 0, Math.PI * 2);
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
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(dx, dy);
        ctx.stroke();

        ctx.fillStyle = '#10b981';
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
          ? 'rgba(244, 63, 94, 0.65)'
          : t.owner_id !== null
          ? 'rgba(56, 189, 248, 0.5)'
          : 'rgba(251, 191, 36, 0.35)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(dx, dy);
      ctx.stroke();
      ctx.restore();

      // Pickup square
      if (!t.picked_up) {
        ctx.fillStyle = t.status === 'RELEASED' ? '#f43f5e' : '#f59e0b';
        ctx.fillRect(px - 5, py - 5, 10, 10);
      }

      // Dropoff triangle
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(dx, dy - 6);
      ctx.lineTo(dx + 6, dy + 5);
      ctx.lineTo(dx - 6, dy + 5);
      ctx.closePath();
      ctx.fill();

      // Task label at pickup or dropoff
      const lx = t.picked_up ? dx : px;
      const ly = t.picked_up ? dy : py;
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      const ownerTag = t.owner_id ? `D${t.owner_id}` : t.status === 'RELEASED' ? 'RE-BID' : 'OPEN';
      ctx.fillText(`${t.task_id}·v${t.version} [${ownerTag}]`, lx + 8, ly - 4);
    }

    // 8. Drones (Position, RVO halo, Selection ring, Battery bar, Lease countdown)
    for (const d of drones) {
      const x = d.position[0] * scaleX;
      const y = d.position[1] * scaleY;
      const isSelected = d.id === selectedDroneId;

      if (isSelected) {
        // Comm range subtle circle for selected drone
        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.arc(x, y, sim.commRange * scaleX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Selection ring
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Drone body
      ctx.fillStyle = !d.alive
        ? '#e11d48'
        : d.localState.currentTaskId
        ? '#0ea5e9'
        : '#94a3b8';
      ctx.beginPath();
      ctx.arc(x, y, 9.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Drone ID inside circle
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`D${d.id}`, x, y + 3.5);

      // Battery mini bar below drone
      const barW = 28;
      const barH = 4;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(x - barW / 2, y + 13, barW, barH);
      ctx.fillStyle = !d.alive
        ? '#e11d48'
        : d.battery > 35
        ? '#10b981'
        : '#f59e0b';
      ctx.fillRect(x - barW / 2, y + 13, (barW * Math.max(0, d.battery)) / 100, barH);

      // Telemetry tag beside drone
      ctx.textAlign = 'left';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      if (!d.alive) {
        ctx.fillStyle = '#fda4af';
        ctx.fillText('✖ FAILED', x + 13, y + 4);
      } else {
        const tid = d.localState.currentTaskId;
        const activeT = tid ? d.localState.knownTasks.get(tid) : null;
        const leaseRem = activeT
          ? Math.max(0, activeT.lease_expiry - sim.currentTime)
          : 0;
        ctx.fillStyle = '#e2e8f0';
        const statusStr = tid
          ? `${tid} ${ leaseRem < 900 ? `L:${leaseRem.toFixed(1)}s` : ''}`
          : 'IDLE';
        ctx.fillText(statusStr, x + 13, y + 4);
      }
    }

    // Pending custom task pickup marker if user clicked once
    if (pendingPickupRef.current) {
      const [px, py] = pendingPickupRef.current;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px * scaleX, py * scaleY, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [simRef, selectedDroneId, renderTick]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const worldX = Math.round(((e.clientX - rect.left) / rect.width) * 1000);
    const worldY = Math.round(((e.clientY - rect.top) / rect.height) * 1000);

    // Check if user clicked on a drone first
    const sim = simRef.current;
    for (const d of sim.drones.values()) {
      const dist = Math.hypot(d.position[0] - worldX, d.position[1] - worldY);
      if (dist <= 30) {
        onSelectDrone(d.id);
        return;
      }
    }

    // Otherwise support 2-click custom task spawning (Click 1 = Pickup, Click 2 = Dropoff)
    if (!pendingPickupRef.current) {
      pendingPickupRef.current = [worldX, worldY];
    } else {
      const pickup = pendingPickupRef.current;
      pendingPickupRef.current = null;
      onSpawnTaskAt(pickup, [worldX, worldY]);
    }
  };

  return (
    <div className="relative w-full bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="swarmsync-arena-canvas"
        width={760}
        height={560}
        onClick={handleCanvasClick}
        className="w-full h-auto block cursor-crosshair"
      />
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-2.5 bg-slate-900 border-t border-slate-800 text-xs text-slate-300 font-mono">
        <div className="flex items-center gap-3">
          <span>■ Amber: Pickup</span>
          <span>·</span>
          <span>▲ Cyan: Dropoff</span>
          <span>·</span>
          <span>✓ Emerald: Delivered</span>
          <span>·</span>
          <span>● Blue: Active Drone</span>
          <span>·</span>
          <span>✖ Red: Failed Drone</span>
        </div>
        <div className="text-slate-400">
          Click any drone to inspect local view · Click twice on map to spawn delivery task
        </div>
      </div>
    </div>
  );
};
