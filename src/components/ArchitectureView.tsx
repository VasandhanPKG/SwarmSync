import React, { useEffect, useState } from 'react';
import { Terminal, Play, CheckCircle2, FileCode2 } from 'lucide-react';

interface SourceFileEntry {
  stage: string;
  path: string;
  title: string;
  content: string;
}

export const ArchitectureView: React.FC = () => {
  const [files, setFiles] = useState<SourceFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('DESIGN.md');
  const [cliScenario, setCliScenario] = useState<string>('partition');
  const [cliMode, setCliMode] = useState<string>('swarmsync');
  const [cliSeed, setCliSeed] = useState<number>(1);
  const [cliOutput, setCliOutput] = useState<string>('');
  const [cliCommand, setCliCommand] = useState<string>(
    'python -m swarmsync.run --scenario partition --mode swarmsync --seed 1'
  );
  const [runningCli, setRunningCli] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/source-files')
      .then((r) => r.json())
      .then((d) => {
        if (d.files) setFiles(d.files);
      })
      .catch(() => {});
  }, []);

  const executePythonCommand = async (action: 'cli' | 'unit_tests' | 'px4_demo') => {
    setRunningCli(true);
    try {
      const res = await fetch('/api/run-python', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          scenario: cliScenario,
          mode: cliMode,
          seed: cliSeed,
        }),
      });
      const data = await res.json();
      if (data.command) setCliCommand(data.command);
      setCliOutput(data.output || data.error || 'Completed with no output.');
    } catch (err) {
      setCliOutput(String(err));
    } finally {
      setRunningCli(false);
    }
  };

  const activeFile = files.find((f) => f.path === selectedPath) || files[0];

  return (
    <div className="space-y-8">
      {/* Live Python CLI & Stage 1-3 Verification Runner */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              01. Live Python Backend CLI & Verification Runner
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Execute the real Stage 1 Python CLI (`python -m swarmsync.run`), the 8 unit tests, or the Stage 3 PX4 SITL mid-delivery kill & re-bid demo directly on the container.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={runningCli}
              onClick={() => executePythonCommand('unit_tests')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              Run All 8 Python Unit Tests
            </button>
            <button
              type="button"
              disabled={runningCli}
              onClick={() => executePythonCommand('px4_demo')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-3.5 h-3.5 text-sky-600" />
              Run Stage 3 PX4 Kill & Re-Bid Demo
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4 items-end">
          <div>
            <label htmlFor="cli-scenario" className="block text-xs font-medium text-slate-700 mb-1">
              Scenario (`--scenario`)
            </label>
            <select
              id="cli-scenario"
              value={cliScenario}
              onChange={(e) => setCliScenario(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
            >
              <option value="partition">partition</option>
              <option value="normal">normal</option>
              <option value="dynamic_arrival">dynamic_arrival</option>
              <option value="packet_loss_delay">packet_loss_delay</option>
              <option value="drone_failure">drone_failure</option>
              <option value="hub_failure">hub_failure</option>
            </select>
          </div>

          <div>
            <label htmlFor="cli-mode" className="block text-xs font-medium text-slate-700 mb-1">
              Mode (`--mode`)
            </label>
            <select
              id="cli-mode"
              value={cliMode}
              onChange={(e) => setCliMode(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
            >
              <option value="swarmsync">swarmsync</option>
              <option value="centralized">centralized</option>
              <option value="basic_auction">basic_auction</option>
              <option value="cbba">cbba</option>
            </select>
          </div>

          <div>
            <label htmlFor="cli-seed" className="block text-xs font-medium text-slate-700 mb-1">
              Seed (`--seed`)
            </label>
            <input
              id="cli-seed"
              type="number"
              min={1}
              max={50}
              value={cliSeed}
              onChange={(e) => setCliSeed(Number(e.target.value) || 1)}
              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
            />
          </div>

          <div>
            <button
              type="button"
              disabled={runningCli}
              onClick={() => executePythonCommand('cli')}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Terminal className="w-3.5 h-3.5" />
              {runningCli ? 'Executing Python...' : 'Execute CLI Run'}
            </button>
          </div>
        </div>

        <div className="mt-4 bg-slate-950 text-slate-100 rounded-lg p-4 font-mono text-xs overflow-x-auto border border-slate-800">
          <div className="text-sky-400 pb-2 border-b border-slate-800">
            $ {cliCommand}
          </div>
          <pre className="mt-3 text-slate-200 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
            {cliOutput ||
              'Ready. Select a scenario and click a command button above to view live Python execution output.'}
          </pre>
        </div>
      </section>

      {/* Stage 1, Stage 2 (ROS 2), and Stage 3 (PX4 SITL) Code & Design Inspector */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="pb-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            02. Repository Source Inspector (Stage 1 Python · Stage 2 ROS 2 · Stage 3 PX4 SITL)
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Inspect the complete implementation of the 6 agent modules, ROS 2 peer-to-peer nodes, Linux `tc/netem` fault scripts, and PX4 uXRCE-DDS offboard bridge.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-5">
          <div className="lg:col-span-4 space-y-1.5">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={`w-full text-left px-3.5 py-2.5 rounded-lg border text-xs transition-colors flex items-center justify-between gap-2 ${
                  selectedPath === file.path
                    ? 'bg-slate-900 text-white border-slate-900 font-medium'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <span className="truncate flex items-center gap-2">
                  <FileCode2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{file.title}</span>
                </span>
                <span
                  className={`font-mono text-[10px] shrink-0 ${
                    selectedPath === file.path ? 'text-sky-300' : 'text-slate-500'
                  }`}
                >
                  {file.stage}
                </span>
              </button>
            ))}
          </div>

          <div className="lg:col-span-8">
            {activeFile && (
              <div className="bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 text-xs font-mono text-slate-300">
                  <span>{activeFile.path}</span>
                  <span>{activeFile.stage}</span>
                </div>
                <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto max-h-[540px] overflow-y-auto leading-relaxed">
                  {activeFile.content}
                </pre>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
