'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Service, 
  LogEntry, 
  PostgresDatabase, 
  RedisDatabase, 
  PersistentVolume, 
  S3BucketConfig 
} from '@/lib/hoster/types';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';
import { Server, 
  Terminal, 
  Cpu, 
  GitBranch, 
  ExternalLink, 
  Zap, 
  Activity, 
  Database, 
  HardDrive, 
  Globe, 
  ShieldCheck, 
  RefreshCw, 
  Play, 
  Square,
  Copy, 
  Check, 
  Download, 
  Trash2, 
  Sliders, 
  Key, 
  Lock, 
  Eye, 
  EyeOff, 
  ArrowLeft,
  Sparkles,
  Search,
  Code
} from 'lucide-react';

interface ServiceDetailViewProps {
  service: Service;
  onBack: () => void;
  onUpdateService: (updated: Service) => void;
  postgresDbs: PostgresDatabase[];
  redisDbs: RedisDatabase[];
  volumes: PersistentVolume[];
  s3Buckets: S3BucketConfig[];
  onToggleServiceStatus?: (serviceId: string) => Promise<void>;
  onRestartService?: (serviceId: string) => Promise<void>;
  onDeleteService?: (serviceId: string) => Promise<void>;
}

export default function ServiceDetailView({
  service,
  onBack,
  onUpdateService,
  postgresDbs,
  redisDbs,
  volumes,
  s3Buckets,
  onToggleServiceStatus,
  onRestartService,
  onDeleteService,
}: ServiceDetailViewProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'logs' | 'mcp' | 'hardware' | 'env' | 'domains' | 'storage'>('overview');
  
  // Hardware Spec
  const spec = HARDWARE_SPECS[service.hardwareTier] || HARDWARE_SPECS['cpu-standard'];
  const isGpu = spec.category === 'gpu';
  const isMcp = service.type === 'mcp';
  const isPlugin = service.type === 'plugin';

  // Logs state (REAL logs streamed from the control plane)
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'debug'>('all');
  const [logSearch, setLogSearch] = useState('');
  const [isStreamingLogs, setIsStreamingLogs] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // MCP Tester State
  const [selectedToolIndex, setSelectedToolIndex] = useState(0);
  const [toolInputJson, setToolInputJson] = useState('{\n  "query": "vector indexing in PostgreSQL",\n  "limit": 3\n}');
  const [toolResult, setToolResult] = useState<string | null>(null);
  const [isCallingTool, setIsCallingTool] = useState(false);

  // Env Vars State
  const [envVars, setEnvVars] = useState(service.envVars);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});

  // Domain State
  const [newDomainInput, setNewDomainInput] = useState('');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Hardware upgrade state
  const [selectedHardwareTier, setSelectedHardwareTier] = useState(service.hardwareTier);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => setCopiedText(null), 2000);
  };

  // Real log streaming from the control plane (poll every 4s while streaming)
  useEffect(() => {
    let cancelled = false;

    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/logs?serviceId=${service.id}&limit=150`);
        const json = await res.json();
        if (!cancelled && json?.data) {
          const entries = (json.data as LogEntry[]).slice().reverse();
          setLogs(entries);
          logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
      } catch {
        // transient network error — next tick retries
      }
    };

    void fetchLogs();
    if (!isStreamingLogs) return () => { cancelled = true; };
    const interval = setInterval(fetchLogs, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [service.id, isStreamingLogs]);

  // Execute MCP tool via the platform runtime (LLM-backed tool execution API)
  const handleExecuteTool = async () => {
    setIsCallingTool(true);
    setToolResult(null);

    try {
      const tool = service.mcpDetails?.tools[selectedToolIndex];
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(toolInputJson);
      } catch {
        parsed = { raw: toolInputJson };
      }

      const res = await fetch('/api/mcp/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: service.id,
          toolName: tool?.name || 'unknown_tool',
          toolDescription: tool?.description,
          inputSchema: tool?.inputSchema,
          input: parsed,
        }),
      });
      const json = await res.json();

      if (!res.ok || json?.error) {
        setToolResult(
          JSON.stringify(
            {
              jsonrpc: '2.0',
              error: { code: -32000, message: json?.error || `Execution failed (HTTP ${res.status})` },
              id: Date.now(),
            },
            null,
            2
          )
        );
        return;
      }

      const result = json.data as { ok?: boolean; result?: unknown; executionMs?: number; logs?: string[]; error?: string };
      const rpc = {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 100000),
        result: result?.ok
          ? {
              content: [
                {
                  type: 'text',
                  text:
                    typeof result.result === 'string'
                      ? result.result
                      : JSON.stringify(result.result, null, 2),
                },
              ],
              isError: false,
              metadata: {
                executionMs: result.executionMs,
                runtimeLogs: result.logs,
                executionNode: `${service.region} / ${spec.name}`,
                protocolVersion: service.mcpDetails?.protocolVersion || '2024-11-05',
              },
            }
          : {
              content: [{ type: 'text', text: result?.error || 'Tool execution reported failure.' }],
              isError: true,
              metadata: { runtimeLogs: result?.logs },
            },
      };
      setToolResult(JSON.stringify(rpc, null, 2));
    } catch (err) {
      setToolResult(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: (err as Error).message }, id: Date.now() }, null, 2));
    } finally {
      setIsCallingTool(false);
    }
  };

  const handleAddEnvVar = () => {
    if (!newKey.trim()) return;
    const updated = [...envVars, { key: newKey.trim(), value: newValue.trim(), isSecret }];
    setEnvVars(updated);
    onUpdateService({ ...service, envVars: updated });
    setNewKey('');
    setNewValue('');
    setIsSecret(false);
  };

  const handleDeleteEnvVar = (index: number) => {
    const updated = envVars.filter((_, i) => i !== index);
    setEnvVars(updated);
    onUpdateService({ ...service, envVars: updated });
  };

  const handleSaveHardware = () => {
    onUpdateService({ ...service, hardwareTier: selectedHardwareTier });
  };

  const handleAddCustomDomain = () => {
    if (!newDomainInput.trim()) return;
    const updated = [...service.customDomains, newDomainInput.trim()];
    onUpdateService({ ...service, customDomains: updated });
    setNewDomainInput('');
  };

  const handleDeleteService = async () => {
    if (!onDeleteService) return;
    if (!window.confirm(`Delete service "${service.name}"? Volumes will be detached and custom domains released.`)) return;
    await onDeleteService(service.id);
  };

  const filteredLogs = logs.filter((l) => {
    const matchesLevel = logFilter === 'all' || l.level === logFilter;
    const matchesSearch = logSearch === '' || l.message.toLowerCase().includes(logSearch.toLowerCase()) || (l.source && l.source.includes(logSearch));
    return matchesLevel && matchesSearch;
  });

  // Working endpoint = same-origin ingress proxy (serves the real runner — no DNS needed).
  const absoluteIngress =
    typeof window !== 'undefined'
      ? `${window.location.origin}${service.ingressPath}`
      : service.ingressPath;
  const ingressUrl = service.protocol === 'sse' ? `${absoluteIngress}/sse` : absoluteIngress;

  // Claude Desktop config snippet
  const claudeDesktopConfig = {
    mcpServers: {
      [service.name]: {
        url: ingressUrl,
        transport: service.protocol,
        headers: {
          Authorization: 'Bearer <YOUR_NEXUS_TOKEN>',
        },
      },
    },
  };

  // Cursor mcp config snippet
  const cursorMcpConfig = {
    name: service.name,
    type: service.protocol,
    url: ingressUrl,
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-150">
      {/* Back Button & Service Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-start gap-3.5">
          <button
            onClick={onBack}
            className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition mt-0.5"
            title="Return to Services"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold text-zinc-100">{service.name}</h1>
              <span
                className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold border ${
                  isMcp
                    ? 'bg-purple-950/70 text-purple-300 border-purple-800/60'
                    : isPlugin
                    ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800/60'
                    : 'bg-cyan-950/70 text-cyan-300 border-cyan-800/60'
                }`}
              >
                {service.type === 'mcp' ? 'MCP Server (SSE)' : service.type === 'plugin' ? 'AI Plugin' : 'API Provider'}
              </span>

              <span className="flex items-center gap-1.5 text-xs font-mono text-zinc-300">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="capitalize">{service.status}</span>
              </span>

              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800/90 text-zinc-300 border border-zinc-700 flex items-center gap-1">
                {isGpu ? <Cpu className="w-3 h-3 text-emerald-400" /> : <Server className="w-3 h-3 text-zinc-400" />}
                {spec.gpuModel || spec.name}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-zinc-400 font-mono">
              <a
                href={service.ingressPath}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 font-medium hover:text-cyan-300 hover:underline"
                title="Working endpoint — served by this control plane via the same-origin ingress"
              >
                {service.ingressPath}
              </a>
              <span className="text-zinc-700">&bull;</span>
              <span className="flex items-center gap-1.5">
                <span className="text-zinc-500">{service.url}</span>
                <span
                  className="px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-800/60 text-amber-400 text-[9px] font-mono uppercase tracking-wider"
                  title={`Custom hostname — resolves once a wildcard DNS record (*.nexushost.dev) points at this host. Until then use ${service.ingressPath}`}
                >
                  DNS pending
                </span>
              </span>
              {service.runtime && (
                <>
                  <span className="text-zinc-700">&bull;</span>
                  <span
                    className="text-emerald-400"
                    title={`Builtin runner: 127.0.0.1:${service.runtime.port} · pid ${service.runtime.pid} · ${service.runtime.healthy ? 'healthy' : 'starting'}`}
                  >
                    runner :{service.runtime.port}
                  </span>
                </>
              )}
              <span className="text-zinc-700">&bull;</span>
              <span className="text-zinc-500">Branch: {service.branch}</span>
              <span className="text-zinc-700">&bull;</span>
              <span className="text-zinc-500">Region: {service.region}</span>
            </div>
          </div>
        </div>

        {/* Quick External Actions */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {onToggleServiceStatus && (
            <button
              onClick={() => void onToggleServiceStatus(service.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition"
            >
              {service.status === 'running' ? (
                <>
                  <Square className="w-3 h-3 fill-amber-400 text-amber-400" />
                  <span>Stop</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-emerald-400 text-emerald-400" />
                  <span>Start</span>
                </>
              )}
            </button>
          )}

          {onRestartService && (
            <button
              onClick={() => void onRestartService(service.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition"
            >
              <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
              <span>Restart</span>
            </button>
          )}

          {onDeleteService && (
            <button
              onClick={() => void handleDeleteService()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-900/50 text-xs font-medium transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete</span>
            </button>
          )}

          <button
            onClick={() => copyToClipboard(absoluteIngress, 'url')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition"
          >
            {copiedText === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
            <span>Copy URL</span>
          </button>

          <a
            href={service.ingressPath}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-sm transition ${
              service.status === 'running'
                ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                : 'bg-zinc-800 text-zinc-400 cursor-not-allowed'
            }`}
            title={service.status === 'running' ? 'Open live endpoint — real HTTP response from the service runner' : `Endpoint not live yet (status: ${service.status})`}
          >
            <span>Live Endpoint</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-800 overflow-x-auto text-xs font-medium">
        {[
          { id: 'overview', label: 'Metrics & Health', icon: Activity },
          { id: 'logs', label: 'Live Logs Terminal', icon: Terminal },
          ...(isMcp || isPlugin ? [{ id: 'mcp', label: 'MCP & Plugin Studio', icon: Code }] : []),
          { id: 'hardware', label: 'Hardware & GPU Scaling', icon: Cpu },
          { id: 'env', label: 'Environment & Secrets', icon: Key },
          { id: 'domains', label: 'Custom Domains', icon: Globe },
          { id: 'storage', label: 'Databases & Volumes', icon: Database },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as 'overview' | 'logs' | 'mcp' | 'hardware' | 'env' | 'domains' | 'storage')}
              className={`flex items-center gap-2 px-4 py-2.5 border-b-2 whitespace-nowrap transition ${
                isActive
                  ? 'border-cyan-400 text-cyan-300 bg-cyan-950/20'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/40'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: OVERVIEW & REAL-TIME CHARTS */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Real-time Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[11px] text-zinc-400 font-mono uppercase">CPU Utilization</span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1">
                {service.metrics.cpuPercent}%
              </div>
              <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  className="bg-cyan-400 h-full rounded-full transition-all"
                  style={{ width: `${service.metrics.cpuPercent}%` }}
                />
              </div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">
                {spec.vCpu} vCPU dedicated
              </p>
            </div>

            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[11px] text-zinc-400 font-mono uppercase">RAM Allocation</span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1">
                {service.metrics.ramUsedGb} <span className="text-xs text-zinc-500 font-normal">/ {service.metrics.ramTotalGb} GB</span>
              </div>
              <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  className="bg-indigo-400 h-full rounded-full transition-all"
                  style={{ width: `${(service.metrics.ramUsedGb / service.metrics.ramTotalGb) * 100}%` }}
                />
              </div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">
                {Math.round((service.metrics.ramUsedGb / service.metrics.ramTotalGb) * 100)}% utilized
              </p>
            </div>

            {isGpu ? (
              <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-800/40">
                <span className="text-[11px] text-emerald-400 font-mono uppercase flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  GPU VRAM
                </span>
                <div className="text-2xl font-bold font-mono text-emerald-300 mt-1">
                  {service.metrics.gpuVramUsedGb !== undefined ? (
                    <>
                      {service.metrics.gpuVramUsedGb} <span className="text-xs text-emerald-500/70 font-normal">/ {service.metrics.gpuVramTotalGb} GB</span>
                    </>
                  ) : (
                    <span className="text-sm text-zinc-500 font-normal">No GPU on host</span>
                  )}
                </div>
                <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
                  <div
                    className="bg-emerald-400 h-full rounded-full transition-all"
                    style={{ width: `${service.metrics.gpuUtilPercent}%` }}
                  />
                </div>
                <p className="text-[10px] text-emerald-400/80 font-mono mt-1.5">
                  Compute Load: {service.metrics.gpuUtilPercent}% &bull; CUDA 12.4
                </p>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
                <span className="text-[11px] text-zinc-400 font-mono uppercase">Inference Engine</span>
                <div className="text-2xl font-bold font-mono text-zinc-100 mt-1">Standard</div>
                <p className="text-[10px] text-zinc-500 font-mono mt-3">
                  CPU worker pool active
                </p>
              </div>
            )}

            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[11px] text-zinc-400 font-mono uppercase">P95 Request Latency</span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1">
                {service.metrics.latencyP95Ms} <span className="text-xs text-zinc-500 font-normal">ms</span>
              </div>
              <p className="text-[10px] text-emerald-400 font-mono mt-3">
                {service.metrics.requestsPerMin} requests / min
              </p>
            </div>
          </div>

          {/* Graphical Traffic & Compute SVG Chart */}
          <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-zinc-200">
                  Live Resource Load &amp; Ingress (Last 30 Minutes)
                </h3>
                <p className="text-[11px] text-zinc-400">
                  Telemetry sampled every 10s via internal eBPF edge probes
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-mono">
                <span className="flex items-center gap-1.5 text-cyan-400">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
                  Traffic (rpm)
                </span>
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  {isGpu ? 'GPU Compute %' : 'CPU %'}
                </span>
              </div>
            </div>

            {/* Simulated Live SVG Line Graph */}
            <div className="relative h-44 w-full bg-zinc-950/80 rounded-xl border border-zinc-800/80 p-3 overflow-hidden">
              <svg className="w-full h-full" viewBox="0 0 600 120" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
                  </linearGradient>
                  <linearGradient id="emeraldGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Horizontal Grid lines */}
                <line x1="0" y1="30" x2="600" y2="30" stroke="#27272a" strokeDasharray="3 3" />
                <line x1="0" y1="60" x2="600" y2="60" stroke="#27272a" strokeDasharray="3 3" />
                <line x1="0" y1="90" x2="600" y2="90" stroke="#27272a" strokeDasharray="3 3" />

                {/* Traffic Path Area */}
                <path
                  d="M0,80 Q50,45 100,55 T200,40 T300,70 T400,30 T500,45 T600,35 L600,120 L0,120 Z"
                  fill="url(#cyanGrad)"
                />
                <path
                  d="M0,80 Q50,45 100,55 T200,40 T300,70 T400,30 T500,45 T600,35"
                  fill="none"
                  stroke="#06b6d4"
                  strokeWidth="2"
                />

                {/* GPU Compute Path Area */}
                <path
                  d="M0,95 Q50,75 100,60 T200,65 T300,50 T400,55 T500,35 T600,40 L600,120 L0,120 Z"
                  fill="url(#emeraldGrad)"
                />
                <path
                  d="M0,95 Q50,75 100,60 T200,65 T300,50 T400,55 T500,35 T600,40"
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2"
                />
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: LIVE LOGS TERMINAL */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          {/* Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-zinc-400 font-mono text-[11px]">Level:</span>
              {(['all', 'info', 'warn', 'error', 'debug'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setLogFilter(lvl)}
                  className={`px-2.5 py-1 rounded text-[11px] font-mono uppercase transition ${
                    logFilter === lvl
                      ? 'bg-zinc-800 text-cyan-300 border border-zinc-700'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Filter logs by keyword..."
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsStreamingLogs(!isStreamingLogs)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono transition ${
                  isStreamingLogs
                    ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-500'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isStreamingLogs ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                <span>{isStreamingLogs ? 'Streaming' : 'Paused'}</span>
              </button>

              <button
                onClick={() => setLogs([])}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition"
                title="Clear logs"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={() => copyToClipboard(logs.map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n'), 'all-logs')}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] font-mono transition"
              >
                {copiedText === 'all-logs' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>Copy</span>
              </button>
            </div>
          </div>

          {/* Terminal Console */}
          <div className="p-4 rounded-xl bg-black border border-zinc-800 font-mono text-xs text-zinc-300 h-96 overflow-y-auto space-y-1 shadow-2xl">
            {filteredLogs.length === 0 ? (
              <div className="text-zinc-600 text-center py-12">No logs match your filter criteria.</div>
            ) : (
              filteredLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 hover:bg-zinc-900/60 px-1 py-0.5 rounded leading-relaxed">
                  <span className="text-zinc-600 shrink-0 select-none">{log.timestamp}</span>
                  <span
                    className={`uppercase text-[10px] font-semibold px-1 rounded shrink-0 select-none ${
                      log.level === 'error'
                        ? 'bg-red-950 text-red-400'
                        : log.level === 'warn'
                        ? 'bg-amber-950 text-amber-400'
                        : log.level === 'debug'
                        ? 'bg-blue-950 text-blue-400'
                        : 'bg-zinc-900 text-cyan-400'
                    }`}
                  >
                    {log.level}
                  </span>
                  {log.source && (
                    <span className="text-purple-400 shrink-0">[{log.source}]</span>
                  )}
                  <span className="text-zinc-300 break-all">{log.message}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {/* TAB 3: MCP & PLUGIN STUDIO */}
      {activeTab === 'mcp' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Tool Tester & Execution */}
            <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-purple-400" />
                  <h3 className="text-xs font-bold text-zinc-200">
                    Live Tool Invocation Tester (JSON-RPC 2.0)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-zinc-500">
                  Protocol: {service.mcpDetails?.protocolVersion || '2024-11-05'}
                </span>
              </div>

              {service.mcpDetails?.tools && service.mcpDetails.tools.length > 0 ? (
                <>
                  <div>
                    <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                      Select MCP Tool:
                    </label>
                    <select
                      value={selectedToolIndex}
                      onChange={(e) => {
                        const idx = parseInt(e.target.value);
                        setSelectedToolIndex(idx);
                        const example = service.mcpDetails?.tools[idx]?.exampleInput;
                        if (example) {
                          setToolInputJson(JSON.stringify(example, null, 2));
                        }
                      }}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-purple-500"
                    >
                      {service.mcpDetails.tools.map((t, idx) => (
                        <option key={t.name} value={idx}>
                          {t.name} - {t.description.substring(0, 50)}...
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                      Arguments (JSON Object):
                    </label>
                    <textarea
                      rows={5}
                      value={toolInputJson}
                      onChange={(e) => setToolInputJson(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-cyan-300 focus:outline-none focus:border-purple-500"
                    />
                  </div>

                  <button
                    onClick={handleExecuteTool}
                    disabled={isCallingTool}
                    className="w-full py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition disabled:opacity-50"
                  >
                    {isCallingTool ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Play className="w-4 h-4 fill-white" />
                    )}
                    <span>Execute Tool on GPU Host</span>
                  </button>

                  {/* Output */}
                  {toolResult && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-mono text-emerald-400">Response Payload:</span>
                      <pre className="p-3 bg-black rounded-lg border border-zinc-800 font-mono text-xs text-emerald-300 overflow-x-auto max-h-56">
                        {toolResult}
                      </pre>
                    </div>
                  )}
                </>
              ) : (
                <div className="p-8 text-center text-zinc-500 text-xs">
                  No MCP tools registered on this service.
                </div>
              )}
            </div>

            {/* Claude Desktop & Cursor Integration Snippets */}
            <div className="space-y-4">
              <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                    <Code className="w-4 h-4 text-cyan-400" />
                    <span>Claude Desktop Configuration</span>
                  </h4>
                  <button
                    onClick={() => copyToClipboard(JSON.stringify(claudeDesktopConfig, null, 2), 'claude-cfg')}
                    className="flex items-center gap-1 text-[11px] font-mono text-cyan-400 hover:text-cyan-300"
                  >
                    {copiedText === 'claude-cfg' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>Copy Config</span>
                  </button>
                </div>
                <p className="text-[11px] text-zinc-400">
                  Paste this into your <code className="text-zinc-200">claude_desktop_config.json</code> to use this remote MCP server directly in Claude.
                </p>
                <pre className="p-3 rounded-lg bg-black border border-zinc-800 font-mono text-xs text-zinc-300 overflow-x-auto">
                  {JSON.stringify(claudeDesktopConfig, null, 2)}
                </pre>
              </div>

              <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                    <Code className="w-4 h-4 text-emerald-400" />
                    <span>Cursor IDE Configuration</span>
                  </h4>
                  <button
                    onClick={() => copyToClipboard(JSON.stringify(cursorMcpConfig, null, 2), 'cursor-cfg')}
                    className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 hover:text-emerald-300"
                  >
                    {copiedText === 'cursor-cfg' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>Copy Config</span>
                  </button>
                </div>
                <pre className="p-3 rounded-lg bg-black border border-zinc-800 font-mono text-xs text-zinc-300 overflow-x-auto">
                  {JSON.stringify(cursorMcpConfig, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: HARDWARE & GPU SCALING */}
      {activeTab === 'hardware' && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-6">
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span>Compute Hardware &amp; GPU Accelerator Selection</span>
              </h3>
              <p className="text-xs text-zinc-400 mt-1">
                Zero-downtime hot swap: upgrades container instance across dedicated high-config GPU nodes.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.values(HARDWARE_SPECS).map((hSpec) => {
                const isSelected = selectedHardwareTier === hSpec.id;
                const isSpecGpu = hSpec.category === 'gpu';

                return (
                  <button
                    key={hSpec.id}
                    type="button"
                    onClick={() => setSelectedHardwareTier(hSpec.id)}
                    className={`p-4 rounded-xl border text-left transition flex flex-col justify-between ${
                      isSelected
                        ? 'border-cyan-400 bg-cyan-950/30 ring-1 ring-cyan-400'
                        : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-zinc-100 flex items-center gap-2">
                          {isSpecGpu ? <Cpu className="w-4 h-4 text-emerald-400" /> : <Server className="w-4 h-4 text-zinc-400" />}
                          {hSpec.name}
                        </span>
                        <span className="text-xs font-mono font-bold text-cyan-300">
                          ${hSpec.priceHourly}/hr
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 font-mono mt-1.5">
                        {hSpec.description}
                      </p>
                    </div>

                    <div className="mt-3 pt-2 border-t border-zinc-800 text-[10px] text-zinc-500 flex items-center justify-between">
                      <span>{hSpec.recommendedFor}</span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end pt-4 border-t border-zinc-800">
              <button
                onClick={handleSaveHardware}
                className="px-5 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition shadow-sm"
              >
                Apply Hardware Specification
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: ENVIRONMENT & SECRETS */}
      {activeTab === 'env' && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-5">
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Key className="w-4 h-4 text-cyan-400" />
                <span>Environment Variables &amp; Secrets</span>
              </h3>
              <p className="text-xs text-zinc-400 mt-1">
                Encrypted at rest with AES-256 and securely injected into the runtime container environment.
              </p>
            </div>

            {/* List */}
            <div className="space-y-2">
              {envVars.map((env, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-mono"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-zinc-200 font-semibold">{env.key}</span>
                    <span className="text-zinc-600">=</span>
                    <span className="text-cyan-300">
                      {env.isSecret && !revealedSecrets[env.key] ? '••••••••••••••••••••' : env.value}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {env.isSecret && (
                      <button
                        onClick={() =>
                          setRevealedSecrets((prev) => ({ ...prev, [env.key]: !prev[env.key] }))
                        }
                        className="p-1 text-zinc-500 hover:text-zinc-300"
                        title={revealedSecrets[env.key] ? 'Hide secret' : 'Reveal secret'}
                      >
                        {revealedSecrets[env.key] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteEnvVar(idx)}
                      className="p-1 text-zinc-500 hover:text-red-400 transition"
                      title="Delete variable"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Add new */}
            <div className="pt-4 border-t border-zinc-800 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-5">
                <label className="text-[11px] text-zinc-400 block mb-1 font-mono">KEY</label>
                <input
                  type="text"
                  placeholder="e.g. HUGGING_FACE_TOKEN"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="sm:col-span-5">
                <label className="text-[11px] text-zinc-400 block mb-1 font-mono">VALUE</label>
                <input
                  type="text"
                  placeholder="value..."
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="sm:col-span-2 flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSecret}
                    onChange={(e) => setIsSecret(e.target.checked)}
                    className="accent-cyan-500"
                  />
                  <span>Secret</span>
                </label>

                <button
                  type="button"
                  onClick={handleAddEnvVar}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold ml-auto"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: CUSTOM DOMAINS */}
      {activeTab === 'domains' && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-5">
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Globe className="w-4 h-4 text-cyan-400" />
                <span>Custom Domain Management &amp; SSL Certificates</span>
              </h3>
              <p className="text-xs text-zinc-400 mt-1">
                Point your CNAME record to NexusHost edge routers. Let&apos;s Encrypt certificates are automatically generated and renewed.
              </p>
            </div>

            {/* Existing custom domains */}
            <div className="space-y-3">
              {service.customDomains.map((dom) => (
                <div
                  key={dom}
                  className="flex items-center justify-between p-4 rounded-xl bg-zinc-950 border border-zinc-800"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-zinc-100 font-mono">{dom}</span>
                      <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/60">
                        <ShieldCheck className="w-3 h-3" />
                        SSL Active (Let&apos;s Encrypt)
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500 font-mono mt-1">
                      CNAME &rarr; <span className="text-cyan-400">cname.nexushost.dev</span>
                    </div>
                  </div>

                  <a
                    href={`https://${dom}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-lg bg-zinc-800 text-zinc-300 hover:text-white"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              ))}
            </div>

            {/* Add new domain */}
            <div className="pt-4 border-t border-zinc-800 flex items-center gap-3">
              <input
                type="text"
                placeholder="api.yourcompany.ai"
                value={newDomainInput}
                onChange={(e) => setNewDomainInput(e.target.value)}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
              />
              <button
                onClick={handleAddCustomDomain}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
              >
                Add Domain
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 7: STORAGE & VOLUMES */}
      {activeTab === 'storage' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* PostgreSQL & pgvector Card */}
            <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                  <Database className="w-4 h-4 text-purple-400" />
                  <span>Attached PostgreSQL Database</span>
                </h4>
                {service.attachedPostgresId && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                    pgvector 0.7.4
                  </span>
                )}
              </div>

              {service.attachedPostgresId ? (
                <div className="space-y-2 text-xs font-mono text-zinc-300">
                  <p className="text-zinc-400">Database ID: {service.attachedPostgresId}</p>
                  <div className="p-3 bg-black rounded-lg border border-zinc-800 text-[11px] text-purple-300 break-all">
                    postgresql://nexus_admin:***@pg-us-east-01.nexushost.internal:5432/vector_db
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    Accessible directly via internal private VPC network with low latency (&lt;1ms).
                  </p>
                </div>
              ) : (
                <div className="text-xs text-zinc-500 py-4">No PostgreSQL cluster attached.</div>
              )}
            </div>

            {/* Redis Cache Card */}
            <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-rose-400" />
                  <span>Attached Redis In-Memory Cache</span>
                </h4>
                {service.attachedRedisId && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800">
                    Redis 7.2
                  </span>
                )}
              </div>

              {service.attachedRedisId ? (
                <div className="space-y-2 text-xs font-mono text-zinc-300">
                  <p className="text-zinc-400">Redis ID: {service.attachedRedisId}</p>
                  <div className="p-3 bg-black rounded-lg border border-zinc-800 text-[11px] text-rose-300 break-all">
                    redis://default:***@redis-us-east-01.nexushost.internal:6379
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    Active eviction: allkeys-lru with in-memory persistence.
                  </p>
                </div>
              ) : (
                <div className="text-xs text-zinc-500 py-4">No Redis cache attached.</div>
              )}
            </div>

            {/* NVMe Volume Mount */}
            <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-cyan-400" />
                  <span>Persistent NVMe SSD Mount</span>
                </h4>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                  High IOPS NVMe
                </span>
              </div>

              {service.volumeMounts.length > 0 ? (
                <div className="space-y-2 text-xs font-mono text-zinc-300">
                  <div className="flex justify-between text-zinc-400">
                    <span>Mount Target:</span>
                    <span className="text-cyan-400">{service.volumeMounts[0].mountPath}</span>
                  </div>
                  <div className="flex justify-between text-zinc-400">
                    <span>Volume ID:</span>
                    <span>{service.volumeMounts[0].volumeId}</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 pt-1">
                    Retains downloaded HuggingFace model checkpoints between container builds and auto-scales.
                  </p>
                </div>
              ) : (
                <div className="text-xs text-zinc-500 py-4">No volume mounted.</div>
              )}
            </div>

            {/* S3 Buckets */}
            <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                  <Globe className="w-4 h-4 text-emerald-400" />
                  <span>S3 Object Storage Bridge</span>
                </h4>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                  Zero Egress R2 / S3
                </span>
              </div>

              {service.s3BucketId ? (
                <div className="space-y-2 text-xs font-mono text-zinc-300">
                  <p className="text-zinc-400">Bucket ID: {service.s3BucketId}</p>
                  <p className="text-[11px] text-zinc-500">
                    Integrated via S3-compatible API with automatic credentials injection.
                  </p>
                </div>
              ) : (
                <div className="text-xs text-zinc-500 py-4">No S3 bucket connected.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
