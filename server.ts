import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // 1. Serve 10-seed empirical benchmark summary JSON
  app.get('/api/experiments', (_req, res) => {
    try {
      const summaryPath = path.resolve(process.cwd(), 'experiments/results/summary_stats.json');
      if (fs.existsSync(summaryPath)) {
        const raw = fs.readFileSync(summaryPath, 'utf-8');
        res.json(JSON.parse(raw));
        return;
      }
      res.status(404).json({ error: 'Benchmark summary not yet generated.' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 2. Serve raw CSV benchmark files
  app.get('/api/csv/:kind', (req, res) => {
    const filename =
      req.params.kind === 'scale' ? 'scale_runs_10seeds.csv' : 'scenario_runs_10seeds.csv';
    const csvPath = path.resolve(process.cwd(), 'experiments/results', filename);
    if (!fs.existsSync(csvPath)) {
      res.status(404).send('CSV file not found');
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fs.readFileSync(csvPath, 'utf-8'));
  });

  // 3. Serve generated SVG & PNG Matplotlib/vector comparison plots
  app.get('/api/figures/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const figPath = path.resolve(process.cwd(), 'experiments/figures', safeName);
    if (!fs.existsSync(figPath)) {
      res.status(404).send('Figure not found');
      return;
    }
    if (safeName.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.send(fs.readFileSync(figPath, 'utf-8'));
    } else if (safeName.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
      res.send(fs.readFileSync(figPath));
    } else {
      res.status(400).send('Unsupported figure format');
    }
  });

  // 4. Execute real Python CLI / Unit Tests / Stage 3 PX4 Demo on demand
  app.post('/api/run-python', async (req, res) => {
    try {
      const { action, scenario = 'partition', mode = 'swarmsync', seed = 1 } = req.body || {};
      const allowedScenarios = [
        'normal',
        'dynamic_arrival',
        'packet_loss_delay',
        'partition',
        'drone_failure',
        'hub_failure',
      ];
      const allowedModes = ['swarmsync', 'centralized', 'basic_auction', 'cbba'];

      if (action === 'unit_tests') {
        const { stdout, stderr } = await execFileAsync(
          'python3',
          ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
          { cwd: process.cwd(), timeout: 15000 }
        );
        res.json({
          command: 'python3 -m unittest discover -s tests -v',
          output: (stdout + '\n' + stderr).trim(),
        });
        return;
      }

      if (action === 'px4_demo') {
        const { stdout, stderr } = await execFileAsync(
          'python3',
          ['-m', 'px4_sitl.demo_kill_rebid'],
          { cwd: process.cwd(), timeout: 15000 }
        );
        res.json({
          command: 'python3 -m px4_sitl.demo_kill_rebid',
          output: (stdout + '\n' + stderr).trim(),
        });
        return;
      }

      const safeScenario = allowedScenarios.includes(scenario) ? scenario : 'partition';
      const safeMode = allowedModes.includes(mode) ? mode : 'swarmsync';
      const safeSeed = Math.max(1, Math.min(100, Number(seed) || 1));

      const args = [
        '-m',
        'swarmsync.run',
        '--scenario',
        safeScenario,
        '--mode',
        safeMode,
        '--seed',
        String(safeSeed),
      ];
      const { stdout, stderr } = await execFileAsync('python3', args, {
        cwd: process.cwd(),
        timeout: 15000,
      });
      res.json({
        command: `python -m swarmsync.run --scenario ${safeScenario} --mode ${safeMode} --seed ${safeSeed}`,
        output: (stdout + '\n' + stderr).trim(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 5. Serve Stage 1, Stage 2 (ROS 2), and Stage 3 (PX4 SITL) source files & DESIGN.md
  app.get('/api/source-files', (_req, res) => {
    const filesToExpose = [
      { stage: 'Design Spec', path: 'DESIGN.md', title: 'DESIGN.md — Architectural Specification' },
      { stage: 'Stage 1: Python Sim', path: 'swarmsync/agents/modules.py', title: 'swarmsync/agents/modules.py (6 Agent Modules)' },
      { stage: 'Stage 1: Python Sim', path: 'swarmsync/agents/drone.py', title: 'swarmsync/agents/drone.py (Autonomous DroneAgent)' },
      { stage: 'Stage 1: Python Sim', path: 'swarmsync/net/network.py', title: 'swarmsync/net/network.py (SimulatedNetwork)' },
      { stage: 'Stage 1: Python Sim', path: 'tests/test_swarmsync.py', title: 'tests/test_swarmsync.py (Unit Test Suite)' },
      { stage: 'Stage 2: ROS 2', path: 'ros2_ws/src/swarmsync_ros2/msg/ForumMessage.msg', title: 'msg/ForumMessage.msg (DDS Forum Schema)' },
      { stage: 'Stage 2: ROS 2', path: 'ros2_ws/src/swarmsync_ros2/swarmsync_ros2/drone_node.py', title: 'swarmsync_ros2/drone_node.py (Peer ROS 2 Node)' },
      { stage: 'Stage 2: ROS 2', path: 'ros2_ws/src/swarmsync_ros2/swarmsync_ros2/impairment_relay.py', title: 'swarmsync_ros2/impairment_relay.py (Fault Layer)' },
      { stage: 'Stage 2: ROS 2', path: 'ros2_ws/src/swarmsync_ros2/scripts/netem_faults.sh', title: 'scripts/netem_faults.sh (Linux tc/netem)' },
      { stage: 'Stage 3: PX4 SITL', path: 'px4_sitl/uxrce_dds_bridge.py', title: 'px4_sitl/uxrce_dds_bridge.py (uXRCE-DDS Bridge)' },
      { stage: 'Stage 3: PX4 SITL', path: 'px4_sitl/collision_avoidance.py', title: 'px4_sitl/collision_avoidance.py (RVO + Failsafes)' },
      { stage: 'Stage 3: PX4 SITL', path: 'px4_sitl/spawn_multi_vehicle.sh', title: 'px4_sitl/spawn_multi_vehicle.sh (Gazebo x500)' },
      { stage: 'Stage 3: PX4 SITL', path: 'px4_sitl/demo_kill_rebid.py', title: 'px4_sitl/demo_kill_rebid.py (Kill & Re-Bid Demo)' },
    ];

    const result = filesToExpose.map((item) => {
      const fullPath = path.resolve(process.cwd(), item.path);
      const content = fs.existsSync(fullPath)
        ? fs.readFileSync(fullPath, 'utf-8')
        : '# File not found';
      return { ...item, content };
    });
    res.json({ files: result });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SwarmSync Server running on http://localhost:${PORT}`);
  });
}

startServer();
