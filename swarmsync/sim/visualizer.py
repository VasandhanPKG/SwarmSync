from __future__ import annotations
from swarmsync.sim.world import SimulationWorld
from swarmsync.sim.tasks import TaskStatus


def run_live_visualizer(world: SimulationWorld) -> None:
    """
    Interactive Matplotlib live animation showing drones, communication links,
    tasks, lease countdowns, network partition boundary, and a 'Kill Drone' button.
    """
    try:
        import matplotlib.pyplot as plt
        from matplotlib.animation import FuncAnimation
        from matplotlib.widgets import Button
    except ImportError:
        print(
            "[SwarmSync] Matplotlib GUI is not available in this headless shell. "
            "Use the interactive Web UI on http://localhost:3000 or run CLI headless."
        )
        return

    fig, ax = plt.subplots(figsize=(9, 8))
    plt.subplots_adjust(bottom=0.15)

    ax_kill = plt.axes([0.15, 0.03, 0.25, 0.06])
    btn_kill = Button(ax_kill, "Kill Active Drone")

    ax_part = plt.axes([0.45, 0.03, 0.25, 0.06])
    btn_part = Button(ax_part, "Toggle Partition")

    def on_kill(_event: object) -> None:
        alive = [d for d in world.drones.values() if d.alive]
        if alive:
            # Prefer killing a drone currently executing a task
            busy = [d for d in alive if d.local_state.current_task_id is not None]
            target = busy[0] if busy else alive[0]
            world.kill_drone(target.id)

    def on_part(_event: object) -> None:
        world.network.set_partition(not world.network.partition_enabled)

    btn_kill.on_clicked(on_kill)
    btn_part.on_clicked(on_part)

    def update(_frame: int) -> None:
        world.step()
        ax.clear()
        ax.set_xlim(0, 1000)
        ax.set_ylim(0, 1000)
        ax.set_title(
            f"SwarmSync Live Arena | Mode: {world.mode.value} | t = {world.current_time:.1f}s | "
            f"Msgs: {world.network.total_messages_sent}"
        )

        if world.network.partition_enabled:
            ax.axvline(world.network.partition_x_boundary, color="crimson", linestyle="--", lw=2, label="Partition")

        # Draw communication links
        ids = sorted(world.drones.keys())
        for i, id_a in enumerate(ids):
            for id_b in ids[i + 1 :]:
                if world.network.can_communicate(id_a, id_b):
                    pa = world.drones[id_a].position
                    pb = world.drones[id_b].position
                    ax.plot([pa[0], pb[0]], [pa[1], pb[1]], color="#94a3b8", lw=0.8, alpha=0.5)

        # Draw tasks
        outcomes = world.get_consolidated_task_outcomes()
        for t in outcomes.values():
            if t.status == TaskStatus.COMPLETED:
                ax.scatter(*t.dropoff, color="#10b981", marker="x", s=50)
            else:
                ax.scatter(*t.pickup, color="#f59e0b", marker="s", s=60)
                ax.scatter(*t.dropoff, color="#3b82f6", marker="^", s=60)
                ax.text(t.pickup[0] + 8, t.pickup[1] + 8, f"{t.task_id} (v{t.version})", fontsize=8)

        # Draw drones
        for d in world.drones.values():
            color = "#0284c7" if d.alive else "#ef4444"
            ax.scatter(*d.position, color=color, s=110, zorder=5)
            tid = d.local_state.current_task_id or "IDLE"
            lease_rem = 0.0
            if d.current_task is not None:
                lease_rem = max(0.0, d.current_task.lease_expiry - world.current_time)
            ax.text(
                d.position[0] + 10,
                d.position[1] - 12,
                f"D{d.id} [{tid}] B:{d.battery:.0f}% L:{lease_rem:.1f}s",
                fontsize=8,
            )

    _anim = FuncAnimation(fig, update, interval=60, cache_frame_data=False)
    plt.show()
