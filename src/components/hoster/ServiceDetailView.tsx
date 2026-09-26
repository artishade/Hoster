'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
  Code,
  Webhook,
  RotateCw,
  FileText,
  History,
  SquareArrowRight
} from 'lucide-react';
import ServiceTerminal from './ServiceTerminal';
import ServiceHistoryChart from './ServiceHistoryChart';
import QuickExecPanel from './QuickExecPanel';

/** On-disk app.log metadata + tail lines (complete stdout+stderr record). */
interface LogFileData {
  exists: boolean;
  lines: string[];
  sizeBytes: number;
  sizeMb?: number;
  truncated?: boolean;
  truncatedBytes?: number;
  totalLinesInWindow?: number;
  firstLineIndex?: number;
  requestedTail: number;
  showingLines?: number;
  modifiedAt?: string;
  message?: string;
}

/** One REAL webhook delivery (GitHub push / generic CI trigger) row. */
interface WebhookDeliveryRow {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  source: string;
  event: string;
  repo: string;
  branch: string;
  sender: string;
  commitSha: string;
  result: string;
  detail: string;
  createdAt: string;
}

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
  const [activeTab, setActiveTab] = useState<'overview' | 'logs' | 'terminal' | 'webhooks' | 'mcp' | 'hardware' | 'env' | 'domains' | 'storage'>('overview');
  const queryClient = useQueryClient();
  
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

  // Log file history state (the full on-disk app.log — beyond the DB buffer)
  const [logMode, setLogMode] = useState<'stream' | 'file'>('stream');
  const [fileLog, setFileLog] = useState<LogFileData | null>(null);
  const [fileLogTail, setFileLogTail] = useState(300);
  const [fileLogLoading, setFileLogLoading] = useState(false);

  // Webhook state (REAL delivery history from the control plane)
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);
  const [deliveryFilter, setDeliveryFilter] = useState<'all' | 'accepted' | 'skipped' | 'rejected'>('all');
  const [webhookSecretRevealed, setWebhookSecretRevealed] = useState(false);
  const [isRotatingSecret, setIsRotatingSecret] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const filteredDeliveries =
    deliveryFilter === 'all' ? deliveries : deliveries.filter((d) => d.result === deliveryFilter);

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

  // File-history mode: read the REAL on-disk app.log (unbounded, beyond the
  // rate-limited DB buffer). Refetch when the mode/tail changes, then poll
  // slowly while active so freshly written lines show up.
  const fetchFileLog = useCallback(async () => {
    setFileLogLoading(true);
    try {
      const res = await fetch(`/api/services/${service.id}/log-file?tail=${fileLogTail}`);
      const json = await res.json();
      if (json?.data) setFileLog(json.data as LogFileData);
    } catch {
      /* transient — next poll retries */
    } finally {
      setFileLogLoading(false);
    }
  }, [service.id, fileLogTail]);

  useEffect(() => {
    if (logMode !== 'file') return;
    void fetchFileLog();
    const interval = setInterval(() => void fetchFileLog(), 5000);
    return () => clearInterval(interval);
  }, [logMode, fetchFileLog]);

  // Webhook deliveries — REAL history from the control plane (poll while the tab is open).
  useEffect(() => {
    if (activeTab !== 'webhooks') return;
    let cancelled = false;
    const fetchDeliveries = async () => {
      try {
        const res = await fetch(`/api/webhooks/deliveries?serviceId=${service.id}&limit=50`);
        const json = await res.json();
        if (!cancelled && json?.data) setDeliveries(json.data as WebhookDeliveryRow[]);
      } catch {
        /* transient */
      }
    };
    void fetchDeliveries();
    const interval = setInterval(fetchDeliveries, 6000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeTab, service.id]);

  // Rotate the webhook secret (regenerates + returns the updated service).
  const handleRotateWebhookSecret = async () => {
    setIsRotatingSecret(true);
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate-webhook' }),
      });
      const json = await res.json();
      if (json?.data) {
        onUpdateService(json.data as Service);
        setWebhookSecretRevealed(true);
      }
    } catch {
      /* surfaced by missing update */
    } finally {
      setIsRotatingSecret(false);
    }
  };

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

  // ── REAL autoscaling controls (scale actions hit the live control plane) ──
  const [instancesForm, setInstancesForm] = useState({
    min: service.instances.min,
    max: service.instances.max,
  });
  const [isSavingInstances, setIsSavingInstances] = useState(false);
  const [scaleBusy, setScaleBusy] = useState(false);

  const handleScale = async (target: number) => {
    if (scaleBusy) return;
    setScaleBusy(true);
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'scale', instances: target }),
      });
      const json = (await res.json()) as { data?: typeof service; error?: string };
      if (!res.ok || !json.data) throw new Error(json.error ?? `scale failed (${res.status})`);
      // refresh the parent query so the new runtime/workers show up
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(`${service.name} scaled to ${target} instance${target === 1 ? '' : 's'} — real processes updated`);
    } catch (err) {
      toast.error(`Scale failed: ${(err as Error).message}`);
    } finally {
      setScaleBusy(false);
    }
  };

  const handleInstancesSave = async () => {
    if (instancesForm.max < instancesForm.min) {
      toast.error('max must be ≥ min');
      return;
    }
    setIsSavingInstances(true);
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instances: {
            min: instancesForm.min,
            max: instancesForm.max,
            current: service.instances.current,
            scaleToZero: service.instances.scaleToZero,
            scaleToZeroDelaySec: service.instances.scaleToZeroDelaySec,
          },
        }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success(`Autoscaling bounds saved: ${instancesForm.min}–${instancesForm.max}${instancesForm.max > 1 ? ' — policy engine armed' : ''}`);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setIsSavingInstances(false);
    }
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
          { id: 'terminal', label: 'Workspace Shell (PTY)', icon: SquareArrowRight },
          { id: 'webhooks', label: 'Deploy Webhooks', icon: Webhook },
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
              onClick={() => setActiveTab(tab.id as 'overview' | 'logs' | 'terminal' | 'webhooks' | 'mcp' | 'hardware' | 'env' | 'domains' | 'storage')}
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
                {service.runtime?.mode === 'git-deploy'
                  ? `measured from /proc/${service.runtime?.pid} — real worker process`
                  : `${spec.vCpu} vCPU · in-process runner (host CPU chart is authoritative)`}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[11px] text-zinc-400 font-mono uppercase">RAM Allocation</span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1">
                {service.metrics.ramUsedGb} <span className="text-xs text-zinc-500 font-normal">/ {service.metrics.ramTotalGb} GB</span>
              </div>
              <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  className="bg-violet-400 h-full rounded-full transition-all"
                  style={{ width: `${(service.metrics.ramUsedGb / service.metrics.ramTotalGb) * 100}%` }}
                />
              </div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">
                {service.runtime?.mode === 'builtin-runner' ? (
                  <>
                    in-process runner — the {service.metrics.ramUsedGb} GB shown is the shared control-plane RSS
                    (this runner has no separate address space; host chart is authoritative)
                  </>
                ) : (
                  <>
                    {Math.round((service.metrics.ramUsedGb / service.metrics.ramTotalGb) * 100)}% utilized
                    {service.runtime?.mode === 'git-deploy' && ' · measured RSS of the real worker process'}
                  </>
                )}
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

          {/* REAL per-service metric history (replaces the old simulated SVG) */}
          <ServiceHistoryChart serviceId={service.id} ramTotalGb={service.metrics.ramTotalGb || spec.ramGb} />
        </div>
      )}

      {/* TAB 2: LIVE LOGS TERMINAL */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          {/* Mode toggle: live DB stream ↔ full on-disk file history */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <button
                onClick={() => setLogMode('stream')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono transition ${
                  logMode === 'stream'
                    ? 'bg-zinc-800 text-cyan-300 shadow-inner'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>LIVE STREAM</span>
                <span className="text-zinc-600">(buffered)</span>
              </button>
              <button
                onClick={() => setLogMode('file')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono transition ${
                  logMode === 'file'
                    ? 'bg-zinc-800 text-purple-300 shadow-inner'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>FILE HISTORY</span>
                <span className="text-zinc-600">(app.log)</span>
              </button>
            </div>

            {logMode === 'file' && fileLog && fileLog.exists && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-400">
                  {fileLog.sizeMb !== undefined ? `${fileLog.sizeMb} MB` : `${(fileLog.sizeBytes / 1024).toFixed(1)} KB`} on disk
                </span>
                <span className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-400">
                  {fileLog.showingLines ?? fileLog.lines.length} / {fileLog.totalLinesInWindow ?? '?'} lines
                </span>
                {fileLog.truncated && (
                  <span
                    className="px-2 py-1 rounded bg-amber-950/40 border border-amber-800/50 text-[10px] font-mono text-amber-400"
                    title={`File exceeds 16 MB — showing the last 16 MB (${Math.round((fileLog.truncatedBytes ?? 0) / 1048576)} MB skipped). Download for the full log.`}
                  >
                    window capped @ 16 MB
                  </span>
                )}
                <button
                  onClick={() => setFileLogTail((t) => Math.min(t * 3, 5000))}
                  disabled={fileLogLoading || fileLogTail >= 5000}
                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-mono uppercase disabled:opacity-40 transition"
                >
                  Load older ({Math.min(fileLogTail * 3, 5000)} lines)
                </button>
                <a
                  href={`/api/services/${service.id}/log-file?download=1`}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-800/50 text-emerald-300 text-[10px] font-mono uppercase transition"
                >
                  <Download className="w-3 h-3" />
                  Download full log
                </a>
              </div>
            )}
          </div>

          {/* Controls Bar (stream mode only) */}
          {logMode === 'stream' && (
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
          )}

          {/* Terminal Console (live DB stream) */}
          {logMode === 'stream' && (
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
          )}

          {/* File-history terminal (the complete on-disk app.log) */}
          {logMode === 'file' && (
            <div className="rounded-xl bg-black border border-zinc-800 shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-950/80">
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="flex gap-1.5 shrink-0">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
                  </span>
                  <span className="text-zinc-400 truncate">deployments/{service.name}/app.log</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => void fetchFileLog()}
                    disabled={fileLogLoading}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition disabled:opacity-40"
                    title="Refresh now"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${fileLogLoading ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={() =>
                      fileLog &&
                      copyToClipboard(
                        fileLog.lines.slice().reverse().join('\n'),
                        'file-logs'
                      )
                    }
                    disabled={!fileLog || fileLog.lines.length === 0}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-mono transition disabled:opacity-40"
                  >
                    {copiedText === 'file-logs' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>Copy tail</span>
                  </button>
                  {fileLog?.modifiedAt && (
                    <span className="text-zinc-600 text-[10px] font-mono" title="Last write to app.log">
                      mtime {new Date(fileLog.modifiedAt).toLocaleTimeString()}
                    </span>
                  )}
                  <span className={`w-1.5 h-1.5 rounded-full ${fileLogLoading ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
                </div>
              </div>
              <div className="p-4 font-mono text-xs text-zinc-300 h-96 overflow-auto custom-scrollbar">
                {!fileLog ? (
                  <div className="text-zinc-600 text-center py-12">Reading app.log from disk…</div>
                ) : !fileLog.exists ? (
                  <div className="text-zinc-600 text-center py-12">{fileLog.message || 'No app.log on disk for this service yet.'}</div>
                ) : fileLog.lines.length === 0 ? (
                  <div className="text-zinc-600 text-center py-12">app.log exists but is empty.</div>
                ) : (
                  fileLog.lines
                    .slice()
                    .reverse()
                    .map((line, i) => (
                      <div
                        key={`${fileLog.firstLineIndex ?? 0}-${i}`}
                        className={`flex items-start gap-3 px-1 py-0.5 rounded leading-relaxed hover:bg-zinc-900/60 ${
                          /\b(error|fatal|panic|uncaught)\b/i.test(line) ? 'text-red-300' : /\b(warn|warning|deprecated)\b/i.test(line) ? 'text-amber-300' : ''
                        }`}
                      >
                        <span className="text-zinc-700 shrink-0 sticky left-0 bg-black pl-1 pr-1 select-none w-12 text-right">
                          #{(fileLog.firstLineIndex ?? 0) + fileLog.lines.length - 1 - i}
                        </span>
                        <span className="text-zinc-300 whitespace-pre">{line}</span>
                      </div>
                    ))
                )}
              </div>
              {fileLog?.exists && (
                <div className="px-4 py-1.5 border-t border-zinc-800 bg-zinc-950/80 text-[10px] font-mono text-zinc-600">
                  showing lines #{fileLog.firstLineIndex ?? 0}–#{(fileLog.firstLineIndex ?? 0) + (fileLog.showingLines ?? fileLog.lines.length) - 1} · newest first · long lines scroll horizontally · unfiltered process stdout+stderr
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2.5: WORKSPACE SHELL — real PTY terminal + one-shot exec into the deployment workspace */}
      {activeTab === 'terminal' && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <SquareArrowRight className="w-4 h-4 text-cyan-400" />
                Workspace Shell
              </h3>
              <p className="text-xs text-zinc-400 mt-1">
                A real bash pseudo-terminal spawned inside{' '}
                <code className="text-cyan-300/90 bg-cyan-950/30 px-1 py-0.5 rounded text-[10px]">
                  deployments/{service.name}/repo
                </code>{' '}
                — inspect files, read git state, probe the running app, debug the build, exactly like SSH.
              </p>
            </div>
          </div>
          <QuickExecPanel service={service} />
          <ServiceTerminal service={service} />
        </div>
      )}

      {/* TAB 2.75: DEPLOY WEBHOOKS (REAL push-to-deploy) */}
      {activeTab === 'webhooks' && (
        <div className="space-y-6">
          {!service.repoUrl && (
            <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-800/50 flex items-start gap-3">
              <Zap className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-200/90 leading-relaxed">
                This service runs the <strong>builtin runner</strong> (no git repository), so push-to-deploy does not apply.
                Redeploy it manually with the Restart action, or re-create it with a repo URL to unlock webhooks.
              </p>
            </div>
          )}

          {/* Configuration card */}
          <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Webhook className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-bold text-zinc-200">Push-to-Deploy Webhook</h3>
              </div>
              <span className="text-[11px] font-mono text-zinc-500">HMAC-SHA256 verified</span>
            </div>

            {/* Webhook endpoint */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-mono uppercase text-zinc-500">Webhook endpoint (GitHub)</span>
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs">
                <span className="text-emerald-400 font-bold shrink-0">POST</span>
                <span className="text-zinc-200 truncate flex-1">{origin || '…'}/api/webhooks/github</span>
                <button
                  onClick={() => copyToClipboard(`${origin}/api/webhooks/github`, 'wh-url')}
                  className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition shrink-0"
                  title="Copy webhook URL"
                >
                  {copiedText === 'wh-url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                Every push to <span className="text-cyan-300 font-mono">{service.repoUrl ? `${service.repoUrl.replace(/^https?:\/\//, '')} (branch ${service.branch})` : 'the tracked repo'}</span> re-runs the full git clone → build → run pipeline.
              </p>
            </div>

            {/* Secret */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-mono uppercase text-zinc-500">Webhook secret</span>
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs">
                <Lock className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-zinc-200 truncate flex-1" title={
                  service.webhookSecret && !webhookSecretRevealed
                    ? 'Middle characters hidden — click the eye to reveal the full secret'
                    : 'The full webhook secret — use it as the GitHub webhook secret or CI bearer token'
                }>
                  {service.webhookSecret
                    ? webhookSecretRevealed
                      ? service.webhookSecret
                      : `wh_${'•'.repeat(16)}${service.webhookSecret.slice(-4)}`
                    : 'no secret yet'}
                </span>
                <button
                  onClick={() => setWebhookSecretRevealed(!webhookSecretRevealed)}
                  className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition shrink-0"
                  title={webhookSecretRevealed ? 'Hide secret' : 'Reveal secret'}
                >
                  {webhookSecretRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => service.webhookSecret && copyToClipboard(service.webhookSecret, 'wh-secret')}
                  className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition shrink-0 disabled:opacity-40"
                  title="Copy secret"
                  disabled={!service.webhookSecret}
                >
                  {copiedText === 'wh-secret' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => void handleRotateWebhookSecret()}
                  disabled={isRotatingSecret}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-amber-950/50 hover:bg-amber-900/50 border border-amber-800/50 text-amber-300 text-[10px] font-mono uppercase transition shrink-0 disabled:opacity-50"
                  title="Generate a new secret — update GitHub afterwards"
                >
                  <RotateCw className={`w-3 h-3 ${isRotatingSecret ? 'animate-spin' : ''}`} />
                  Rotate
                </button>
              </div>
            </div>

            {/* GitHub setup steps */}
            <div className="p-3.5 rounded-lg bg-zinc-950/60 border border-zinc-800/80 space-y-2">
              <span className="text-[11px] font-mono uppercase text-zinc-500">GitHub setup — 4 steps</span>
              <ol className="text-[11px] text-zinc-400 space-y-1.5 list-decimal list-inside leading-relaxed">
                <li>Open your repository → <span className="text-zinc-200">Settings → Webhooks → Add webhook</span></li>
                <li>Payload URL: <span className="text-cyan-300 font-mono break-all">{origin || '…'}/api/webhooks/github</span></li>
                <li>Content type: <span className="text-zinc-200 font-mono">application/json</span> · Secret: the value above</li>
                <li>Which events: <span className="text-zinc-200">Just the push event</span> — GitHub&apos;s ping is answered automatically</li>
              </ol>
            </div>

            {/* Generic CI card */}
            <div className="p-3.5 rounded-lg bg-zinc-950/60 border border-zinc-800/80 space-y-2">
              <span className="text-[11px] font-mono uppercase text-zinc-500">Any other CI (GitLab, Gitea, scripts, cron)</span>
              <div className="font-mono text-[11px] text-zinc-300 bg-black/60 rounded-lg p-2.5 border border-zinc-800/60 overflow-x-auto whitespace-nowrap">
                <span className="text-emerald-400">curl</span> -X POST <span className="text-cyan-300">&quot;{origin || '…'}/api/webhooks/deploy?name={service.name}&amp;secret=&lt;secret&gt;&quot;</span>
              </div>
              <p className="text-[11px] text-zinc-500">Bearer token auth (<span className="font-mono">Authorization: Bearer &lt;secret&gt;</span>) works too.</p>
            </div>
          </div>

          {/* Delivery history — REAL records */}
          <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-purple-400" />
                <h3 className="text-xs font-bold text-zinc-200">Delivery history</h3>
              </div>
              <div className="flex items-center gap-1.5">
                {(['all', 'accepted', 'skipped', 'rejected'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setDeliveryFilter(f)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase transition border ${
                      deliveryFilter === f
                        ? f === 'accepted'
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-800/60'
                          : f === 'rejected'
                          ? 'bg-red-950 text-red-300 border-red-800/60'
                          : f === 'skipped'
                          ? 'bg-zinc-800 text-zinc-300 border-zinc-700'
                          : 'bg-cyan-950 text-cyan-300 border-cyan-800/60'
                        : 'text-zinc-500 hover:text-zinc-300 border-zinc-800 bg-zinc-900'
                    }`}
                  >
                    {f}
                    {f !== 'all' && (
                      <span className="ml-1 text-zinc-600">{deliveries.filter((d) => d.result === f).length}</span>
                    )}
                  </button>
                ))}
                <span className="text-[11px] font-mono text-zinc-500 ml-1">{deliveries.length} recent · live</span>
              </div>
            </div>

            {deliveries.length === 0 ? (
              <div className="text-center py-10 text-zinc-600 text-xs">
                No webhook deliveries yet — push to the repo (or curl the CI endpoint) and it will appear here within seconds.
              </div>
            ) : filteredDeliveries.length === 0 ? (
              <div className="text-center py-10 text-zinc-600 text-xs">No deliveries with result “{deliveryFilter}”.</div>
            ) : (
              <div className="max-h-96 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                {filteredDeliveries.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-start gap-2.5 p-2.5 rounded-lg bg-zinc-950/70 border border-zinc-800/70 hover:border-zinc-700 transition"
                  >
                    <span
                      className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-bold ${
                        d.result === 'accepted'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50'
                          : d.result === 'skipped'
                          ? 'bg-zinc-900 text-zinc-400 border border-zinc-700'
                          : d.result === 'rejected'
                          ? 'bg-red-950 text-red-400 border border-red-800/50'
                          : 'bg-amber-950 text-amber-400 border border-amber-800/50'
                      }`}
                    >
                      {d.result}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono">
                        <span className="text-cyan-400">{d.event}</span>
                        <span className="text-zinc-500">{d.source}</span>
                        {d.branch && <span className="text-zinc-400">@{d.branch}</span>}
                        {d.commitSha && <span className="text-purple-400">{d.commitSha}</span>}
                        {d.sender && <span className="text-zinc-500">by {d.sender}</span>}
                        <span className="text-zinc-600 ml-auto">{new Date(d.createdAt).toLocaleTimeString()}</span>
                      </div>
                      {d.detail && <p className="text-[11px] text-zinc-500 mt-0.5 break-words">{d.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
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

          {/* REAL autoscaling — live instances, scale controls, CPU policy */}
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-emerald-400" />
                  Autoscaling — Real Processes
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Scale-out spawns additional app processes (own ports, round-robin load balanced through the edge).
                  The policy engine watches measured CPU from the sampler history.
                </p>
              </div>
              <span className="text-[10px] font-mono px-2 py-1 rounded-full border border-emerald-800/60 bg-emerald-950/30 text-emerald-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                policy: avg CPU &gt; 65% → +1 · &lt; 12% → -1 · 3-min cooldown
              </span>
            </div>

            {/* live instance table */}
            <div className="rounded-xl border border-zinc-800 overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-4 py-2 bg-zinc-950/80 text-[10px] font-mono uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
                <span>instance</span>
                <span>pid</span>
                <span className="text-right">port</span>
              </div>
              <div className="divide-y divide-zinc-800/60 font-mono text-xs">
                <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-4 py-2.5 items-center bg-cyan-950/10">
                  <span className="flex items-center gap-2 text-zinc-100">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                    primary
                  </span>
                  <span className="text-zinc-400">{service.runtime?.pid ?? '—'}</span>
                  <span className="text-zinc-400 text-right">{service.runtime?.port ?? '—'}</span>
                </div>
                {(service.runtime?.workers ?? []).map((w, i) => (
                  <div key={w.pid} className="grid grid-cols-[1fr_auto_auto] gap-2 px-4 py-2.5 items-center">
                    <span className="flex items-center gap-2 text-zinc-100">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      worker {i + 1}
                    </span>
                    <span className="text-zinc-400">{w.pid}</span>
                    <span className="text-zinc-400 text-right">{w.port}</span>
                  </div>
                ))}
                {(service.runtime?.workers ?? []).length === 0 && (
                  <div className="px-4 py-3 text-[11px] text-zinc-600 font-mono">
                    single instance — scale out to add real worker processes
                  </div>
                )}
              </div>
            </div>

            {/* scale controls */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[11px] font-mono text-zinc-500">
                {service.instances.current}/{service.instances.max} instances live
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  onClick={() => void handleScale(service.instances.current - 1)}
                  disabled={!service.repoUrl || service.status !== 'running' || service.instances.current <= Math.max(1, service.instances.min)}
                  className="px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-mono transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Kill the newest worker (scale in)"
                >
                  − scale in
                </button>
                <button
                  onClick={() => void handleScale(service.instances.current + 1)}
                  disabled={!service.repoUrl || service.status !== 'running' || service.instances.current >= service.instances.max}
                  className="px-3 py-2 rounded-lg border border-emerald-800/60 bg-emerald-950/40 hover:bg-emerald-900/40 text-emerald-300 text-xs font-mono transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Spawn an additional worker process (scale out)"
                >
                  + scale out
                </button>
                <button
                  onClick={() => void handleInstancesSave()}
                  disabled={isSavingInstances || !service.repoUrl}
                  className="px-3 py-2 rounded-lg border border-cyan-800/60 bg-cyan-950/40 hover:bg-cyan-900/40 text-cyan-300 text-xs font-mono transition active:scale-95 disabled:opacity-40"
                  title={`Autoscaling bounds (currently min ${instancesForm.min} / max ${instancesForm.max})`}
                >
                  {isSavingInstances ? 'saving…' : `bounds: ${instancesForm.min}–${instancesForm.max} ⤳`}
                </button>
              </div>
            </div>

            {/* min/max editor */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end pt-3 border-t border-zinc-800">
              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-500 block mb-1">Min instances</label>
                <input
                  type="number" min={1} max={4} value={instancesForm.min}
                  onChange={(e) => setInstancesForm((f) => ({ ...f, min: Math.max(1, Math.min(4, Number(e.target.value) || 1)) }))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase text-zinc-500 block mb-1">Max instances</label>
                <input
                  type="number" min={1} max={4} value={instancesForm.max}
                  onChange={(e) => setInstancesForm((f) => ({ ...f, max: Math.max(1, Math.min(4, Number(e.target.value) || 1)) }))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <p className="col-span-2 text-[10px] font-mono text-zinc-600 leading-relaxed">
                autoscaling is armed for git deployments with max &gt; 1 — the policy sweep runs every 45s against real sampler CPU history
              </p>
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
