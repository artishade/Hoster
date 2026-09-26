'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  ExternalLink,
  HardDrive,
  Info,
  Key,
  Layers,
  MemoryStick,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import type {
  CustomServerNode,
  HostHistoryPoint,
  LiveSystemMetrics,
  NewProviderPayload,
  ProviderActionResult,
  SettingsViewProvider,
} from '@/lib/hoster/types';

/* ─── Public contract (must match src/app/page.tsx) ────────────────────────── */

interface CloudNodesViewProps {
  providers: SettingsViewProvider[];
  nodes: CustomServerNode[];
  hostMetrics: LiveSystemMetrics | null;
  hostHistory: HostHistoryPoint[];
  onAddProvider: (payload: NewProviderPayload) => Promise<ProviderActionResult>;
  onConnectProvider: (id: string, token: string | null, endpointUrl?: string | null) => Promise<ProviderActionResult>;
  onDisconnectProvider: (id: string) => Promise<ProviderActionResult>;
  onTestProvider: (id: string) => Promise<ProviderActionResult>;
  onDeleteProvider: (id: string) => Promise<ProviderActionResult>;
}

/* ─── Constants & helpers ──────────────────────────────────────────────────── */

interface VerifyDisplay {
  success: boolean;
  message?: string;
  error?: string;
  latencyMs?: number;
}

const TYPE_LABELS: Record<string, string> = {
  local: 'Local Node',
  huggingface: 'Hugging Face',
  render: 'Render',
  fly: 'Fly.io',
  runpod: 'RunPod',
  koyeb: 'Koyeb',
  custom_agent: 'Custom Agent',
  custom_probe: 'HTTP Probe',
};

const CATEGORY_LABELS: Record<string, string> = {
  local_node: 'Local Node',
  free_cloud: 'Free Cloud',
  custom_server: 'Custom Server',
  gpu_cloud: 'GPU Cloud',
};

const TOKEN_LABELS: Record<string, string> = {
  huggingface: 'Hugging Face Access Token (User Read/Write)',
  render: 'Render API Key',
  fly: 'Fly.io Personal Access Token (flyctl token)',
  koyeb: 'Koyeb API Token',
  runpod: 'RunPod API Key',
};

const TOKEN_HINTS: Record<string, string> = {
  huggingface: 'huggingface.co/settings/tokens → Access Tokens',
  render: 'Render Dashboard → Account Settings → API Keys',
  fly: 'Terminal: flyctl auth token',
  koyeb: 'app.koyeb.com → Settings → API Access',
  runpod: 'runpod.io console → Settings → API Keys',
};

const TOKEN_HINT_URLS: Record<string, string> = {
  huggingface: 'https://huggingface.co/settings/tokens',
  render: 'https://dashboard.render.com/account#api-keys',
  fly: 'https://fly.io/docs/flyctl/cli/flyctl-auth-token/',
  koyeb: 'https://app.koyeb.com/settings/api',
  runpod: 'https://www.runpod.io/console/user/settings',
};

const NODE_STATUS: Record<string, { dot: string; text: string; label: string }> = {
  online: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Online' },
  warning: { dot: 'bg-amber-400', text: 'text-amber-400', label: 'Warning' },
  offline: { dot: 'bg-red-400', text: 'text-red-400', label: 'Offline' },
};

const METHOD_LABELS: Record<string, string> = {
  agent: 'Agent',
  probe_url: 'Probe',
  manual: 'Manual',
};

const INPUT_CLASS =
  'w-full min-h-[44px] bg-zinc-900 border border-zinc-800 rounded-lg px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500';

function relTime(iso?: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtMs(ms?: number | null): string {
  return ms != null ? `${ms}ms` : '—';
}

function fmtUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 0)}m`;
}

function clampPct(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function pct(part: number, total: number): number {
  return total > 0 ? clampPct((part / total) * 100) : 0;
}

function mbToGb(mb?: number | null, digits = 1): string {
  if (mb == null) return '—';
  return `${(mb / 1024).toFixed(digits)} GB`;
}

/** The EXACT relative-path one-liner the real agent installer documents. */
function buildAgentCommand(token: string, name: string): string {
  const safeName = name.replace(/"/g, '').trim() || 'custom-node';
  return `curl -sL "/api/agent/install?token=${token}" -o nh-agent.sh && chmod +x nh-agent.sh && ./nh-agent.sh "${safeName}" 15`;
}

/* ─── Small pure presentational pieces ─────────────────────────────────────── */

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-4 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <Icon className={`w-3.5 h-3.5 ${tone}`} />
        <span>{label}</span>
      </div>
      <div className="text-xl font-extrabold font-mono text-white">{value}</div>
      <div className="text-[11px] text-zinc-500 font-mono">{sub}</div>
    </div>
  );
}

function StatusPill({ status, isBuiltIn }: { status: string; isBuiltIn?: boolean }) {
  if (status === 'connected') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Connected
      </span>
    );
  }
  if (status === 'connecting') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/40 text-cyan-400">
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        Syncing
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded-full bg-rose-500/10 border border-rose-500/40 text-red-400">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Error
      </span>
    );
  }
  return (
    <span className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/40 text-amber-400">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      {isBuiltIn ? 'Token required' : 'Disconnected'}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-zinc-700/60 bg-zinc-800/60 text-zinc-300">
      {TYPE_LABELS[type] || type}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-cyan-800/50 bg-cyan-950/40 text-cyan-300">
      {CATEGORY_LABELS[category] || category}
    </span>
  );
}

function ResultBanner({ result }: { result: VerifyDisplay }) {
  return (
    <div
      className={`p-3 rounded-xl text-xs flex items-start gap-2.5 ${
        result.success
          ? 'bg-emerald-950/50 border border-emerald-800/80 text-emerald-300'
          : 'bg-rose-950/50 border border-rose-800/80 text-rose-300'
      }`}
    >
      {result.success ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
      ) : (
        <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
      )}
      <span className="font-mono break-words">
        {result.success
          ? `Verified${result.latencyMs != null ? ` in ${result.latencyMs}ms` : ''}${result.message ? ` — ${result.message}` : ''}`
          : result.error || result.message || 'Verification failed'}
      </span>
    </div>
  );
}

function Meter({ label, percent, tone, sub }: { label: string; percent: number; tone: string; sub?: string }) {
  const clamped = clampPct(percent);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] font-mono">
        <span className="text-zinc-500 uppercase text-[10px]">{label}</span>
        <span className="text-zinc-300">{sub ?? `${Math.round(clamped)}%`}</span>
      </div>
      <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-4 space-y-3 ${className}`}>
      <div className="h-3 w-24 bg-zinc-800/80 rounded animate-pulse" />
      <div className="h-7 w-3/4 bg-zinc-800/70 rounded animate-pulse" />
      <div className="h-2 w-full bg-zinc-800/50 rounded animate-pulse" />
      <div className="h-2 w-2/3 bg-zinc-800/40 rounded animate-pulse" />
    </div>
  );
}

/** Inline-SVG area sparkline of real host CPU samples (no chart deps). */
function CpuSparkline({ points }: { points: HostHistoryPoint[] }) {
  const W = 320;
  const H = 88;

  if (points.length < 2) {
    return (
      <div className="h-[88px] flex items-center justify-center text-[11px] font-mono text-zinc-600 border border-dashed border-zinc-800 rounded-lg">
        Collecting samples… the chart appears after the second 15s sampler tick.
      </div>
    );
  }

  const peak = Math.max(10, ...points.map((p) => p.cpuPercent));
  const stepX = W / (points.length - 1);
  const yFor = (v: number) => H - 6 - (clampPct(v) / peak) * (H - 14);
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${yFor(p.cpuPercent).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const avg = points.reduce((acc, p) => acc + p.cpuPercent, 0) / points.length;

  return (
    <div className="space-y-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-24" role="img" aria-label="Host CPU percent history">
        <defs>
          <linearGradient id="cnv-cpu-spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(34,211,238,0.35)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0.02)" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          y1={yFor(peak / 2).toFixed(1)}
          x2={W}
          y2={yFor(peak / 2).toFixed(1)}
          stroke="rgba(148,163,184,0.15)"
          strokeDasharray="4 4"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill="url(#cnv-cpu-spark-fill)" />
        <path
          d={line}
          fill="none"
          stroke="#22d3ee"
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[10px] font-mono text-zinc-600">
        <span>{new Date(points[0].timestamp).toLocaleTimeString()}</span>
        <span>
          avg {avg.toFixed(0)}% · peak {peak.toFixed(0)}%
        </span>
        <span>{new Date(points[points.length - 1].timestamp).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

/* ─── Main view ────────────────────────────────────────────────────────────── */

export default function CloudNodesView({
  providers,
  nodes,
  hostMetrics,
  hostHistory,
  onAddProvider,
  onConnectProvider,
  onDisconnectProvider,
  onTestProvider,
  onDeleteProvider,
}: CloudNodesViewProps) {
  /* Connect-token modal state */
  const [connectTarget, setConnectTarget] = useState<SettingsViewProvider | null>(null);
  const [connectToken, setConnectToken] = useState('');
  const [connectEndpoint, setConnectEndpoint] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectResult, setConnectResult] = useState<VerifyDisplay | null>(null);

  /* Per-provider / per-node inline test results */
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, VerifyDisplay>>({});

  /* Busy flags */
  const [disconnectBusyId, setDisconnectBusyId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);

  /* Add-server modal state */
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState<'agent' | 'probe' | 'manual'>('agent');
  const [addName, setAddName] = useState('');
  const [addEndpoint, setAddEndpoint] = useState('');
  const [addTags, setAddTags] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addVCpu, setAddVCpu] = useState('');
  const [addRam, setAddRam] = useState('');
  const [addGpu, setAddGpu] = useState('');
  const [addVram, setAddVram] = useState('');
  const [addStorage, setAddStorage] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addResult, setAddResult] = useState<VerifyDisplay | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [agentTokenInfo, setAgentTokenInfo] = useState<{ token: string; name: string } | null>(null);
  const [copiedAgent, setCopiedAgent] = useState(false);
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);

  /* ── Derived pool totals (CONNECTED providers only, from real capacity) ── */
  const connectedProviders = providers.filter((p) => p.status === 'connected');
  const pool = connectedProviders.reduce(
    (acc, p) => ({
      vCpu: acc.vCpu + (p.capacity?.vCpu ?? 0),
      ramGb: acc.ramGb + (p.capacity?.ramGb ?? 0),
      storageGb: acc.storageGb + (p.capacity?.storageGb ?? 0),
      vramGb: acc.vramGb + (p.capacity?.vramGb ?? 0),
    }),
    { vCpu: 0, ramGb: 0, storageGb: 0, vramGb: 0 }
  );
  const nodesOnline = nodes.filter((n) => n.status === 'online').length;

  /* ── Actions ── */
  const openConnect = (p: SettingsViewProvider) => {
    setConnectTarget(p);
    setConnectToken('');
    setConnectEndpoint(p.endpointUrl || p.record?.endpointUrl || '');
    setConnectResult(null);
  };

  const handleConnectSubmit = async () => {
    if (!connectTarget) return;
    setConnectBusy(true);
    setConnectResult(null);
    try {
      const isProbe = connectTarget.type === 'custom_probe';
      const res = await onConnectProvider(
        connectTarget.id,
        connectToken.trim() || null,
        isProbe ? connectEndpoint.trim() || null : undefined
      );
      const v = res.verify;
      const display: VerifyDisplay = {
        success: res.success && (v ? v.success !== false : true),
        message: v?.message,
        error: res.error || v?.error,
        latencyMs: v?.latencyMs,
      };
      setConnectResult(display);
      if (display.success) {
        toast.success(v?.message || `${connectTarget.name} connected & verified`);
        window.setTimeout(() => setConnectTarget(null), 1500);
      } else {
        toast.error(display.error || 'Token verification failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error during verification';
      setConnectResult({ success: false, error: msg });
      toast.error(msg);
    } finally {
      setConnectBusy(false);
    }
  };

  const handleTest = async (id: string, label: string) => {
    setTestingId(id);
    try {
      const res = await onTestProvider(id);
      const v = res.verify;
      const display: VerifyDisplay = {
        success: res.success && (v ? v.success !== false : true),
        message: v?.message,
        error: res.error || v?.error,
        latencyMs: v?.latencyMs,
      };
      setTestResults((prev) => ({ ...prev, [id]: display }));
      if (display.success) {
        toast.success(`${label}: verified${display.latencyMs != null ? ` in ${display.latencyMs}ms` : ''}`);
      } else {
        toast.error(display.error || `${label}: verification failed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error during test';
      setTestResults((prev) => ({ ...prev, [id]: { success: false, error: msg } }));
      toast.error(msg);
    } finally {
      setTestingId(null);
    }
  };

  const handleDisconnect = async (p: SettingsViewProvider) => {
    if (!window.confirm(`Disconnect ${p.name}? Pooled capacity from this provider will be released.`)) return;
    setDisconnectBusyId(p.id);
    try {
      const res = await onDisconnectProvider(p.id);
      if (res.success) toast.success(`${p.name} disconnected`);
      else toast.error(res.error || 'Disconnect failed');
    } catch {
      toast.error('Unexpected error during disconnect');
    } finally {
      setDisconnectBusyId(null);
    }
  };

  const handleDeleteNode = async (node: CustomServerNode) => {
    if (!window.confirm(`Delete custom node "${node.name}"? This removes the provider, its token and heartbeat history.`)) return;
    setDeleteBusyId(node.id);
    try {
      const res = await onDeleteProvider(node.id);
      if (res.success) toast.success(`Node "${node.name}" deleted`);
      else toast.error(res.error || 'Delete failed');
    } catch {
      toast.error('Unexpected error during delete');
    } finally {
      setDeleteBusyId(null);
    }
  };

  const handleCopyInstallUrl = async (node: CustomServerNode) => {
    if (!node.agentToken) return;
    const url = `/api/agent/install?token=${node.agentToken}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedNodeId(node.id);
      toast.success('Agent install URL copied to clipboard');
      window.setTimeout(() => setCopiedNodeId(null), 2000);
    } catch {
      toast.error('Clipboard blocked — copy the URL manually');
    }
  };

  const resetAddForm = () => {
    setAddName('');
    setAddEndpoint('');
    setAddTags('');
    setAddNotes('');
    setAddVCpu('');
    setAddRam('');
    setAddGpu('');
    setAddVram('');
    setAddStorage('');
  };

  const openAddModal = () => {
    resetAddForm();
    setAddResult(null);
    setAddError(null);
    setAgentTokenInfo(null);
    setAddTab('agent');
    setAddOpen(true);
  };

  const closeAddModal = () => {
    setAddOpen(false);
    resetAddForm();
    setAddResult(null);
    setAddError(null);
    setAgentTokenInfo(null);
    setCopiedAgent(false);
  };

  const handleAddSubmit = async () => {
    const name = addName.trim();
    if (!name) {
      setAddError('Node name is required.');
      toast.error('Node name is required');
      return;
    }
    if (addTab === 'probe' && !addEndpoint.trim().startsWith('http')) {
      setAddError('HTTP probe requires a full endpoint URL (https://…).');
      toast.error('Endpoint URL is required for HTTP probe');
      return;
    }

    setAddBusy(true);
    setAddError(null);
    setAddResult(null);
    try {
      const payload: NewProviderPayload = {
        name,
        type: addTab === 'probe' ? 'custom_probe' : 'custom_agent',
      };

      if (addTab === 'probe') {
        payload.endpointUrl = addEndpoint.trim();
      }

      if (addTab === 'probe' || addTab === 'manual') {
        const cap: NonNullable<NewProviderPayload['capacity']> = {};
        let hasCap = false;
        const vCpu = parseFloat(addVCpu);
        const ram = parseFloat(addRam);
        const vram = parseFloat(addVram);
        const stor = parseFloat(addStorage);
        if (!Number.isNaN(vCpu)) { cap.vCpu = vCpu; hasCap = true; }
        if (!Number.isNaN(ram)) { cap.ramGb = ram; hasCap = true; }
        if (!Number.isNaN(vram)) { cap.vramGb = vram; hasCap = true; }
        if (!Number.isNaN(stor)) { cap.storageGb = stor; hasCap = true; }
        if (addGpu.trim()) { cap.gpuModel = addGpu.trim(); hasCap = true; }
        if (hasCap) payload.capacity = cap;
      }

      if (addTab === 'agent') {
        const tags = addTags.split(',').map((t) => t.trim()).filter(Boolean);
        if (tags.length > 0) payload.tags = tags;
      }
      if (addNotes.trim()) payload.notes = addNotes.trim();

      const res = await onAddProvider(payload);
      const v = res.verify;
      const ok = res.success && (v ? v.success !== false : true);
      const display: VerifyDisplay = {
        success: ok,
        message: v?.message,
        error: res.error || v?.error,
        latencyMs: v?.latencyMs,
      };

      if (!ok) {
        setAddError(res.error || v?.error || 'Failed to add node — verification did not pass.');
        toast.error(res.error || v?.error || 'Failed to add node');
        return;
      }

      setAddResult(display);
      toast.success(v?.message || `Node "${name}" added & verified`);
      if (res.agentToken) {
        setAgentTokenInfo({ token: res.agentToken, name });
        toast.success('Agent token generated — copy the install command below');
      }
      resetAddForm();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error while adding node';
      setAddError(msg);
      toast.error(msg);
    } finally {
      setAddBusy(false);
    }
  };

  const handleCopyAgentCommand = async () => {
    if (!agentTokenInfo) return;
    const cmd = buildAgentCommand(agentTokenInfo.token, agentTokenInfo.name);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedAgent(true);
      toast.success('Agent install command copied to clipboard');
      window.setTimeout(() => setCopiedAgent(false), 2000);
    } catch {
      toast.error('Clipboard blocked — select the command text and copy manually');
    }
  };

  const connectNeedsToken = connectTarget ? !['custom_agent', 'custom_probe'].includes(connectTarget.type) : false;
  const connectNeedsEndpoint = connectTarget?.type === 'custom_probe';

  /* ═══════════════════════════════════════════════════════════════════════ */

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* ═══ 1. HERO HEADER (grid pattern + pooled capacity stats) ═══ */}
      <div className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-950/20 via-zinc-900/60 to-blue-950/20 p-6 relative overflow-hidden backdrop-blur-sm">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(148,163,184,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.06) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />
        <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-cyan-400">
            <Activity className="w-4 h-4 animate-pulse" />
            <span>Compute Pool · Real Providers &amp; Real Telemetry</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1.5 flex items-center gap-2.5">
            <Layers className="w-6 h-6 text-cyan-400" />
            Nodes &amp; Free Providers
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 max-w-2xl">
            The always-on local host node plus free cloud quotas and your own servers — every connection state below is
            verified against real APIs, never simulated.
          </p>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mt-6">
            <StatTile
              icon={Server}
              label="Connected Providers"
              value={String(connectedProviders.length)}
              sub={`of ${providers.length} in pool`}
              tone="text-cyan-400"
            />
            <StatTile
              icon={Cpu}
              label="Pooled vCPUs"
              value={pool.vCpu.toFixed(1)}
              sub="summed from connected"
              tone="text-cyan-400"
            />
            <StatTile
              icon={MemoryStick}
              label="Pooled RAM"
              value={`${pool.ramGb.toFixed(1)} GB`}
              sub={pool.vramGb > 0 ? `+ ${pool.vramGb.toFixed(0)} GB VRAM` : 'summed from connected'}
              tone="text-indigo-400"
            />
            <StatTile
              icon={HardDrive}
              label="Pooled Storage"
              value={`${pool.storageGb.toFixed(0)} GB`}
              sub="summed from connected"
              tone="text-emerald-400"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-mono text-zinc-500">
            <span>
              Custom nodes:{' '}
              <span className="text-zinc-300">
                {nodesOnline}/{nodes.length} online
              </span>
            </span>
            {hostMetrics ? (
              <>
                <span>
                  Host CPU: <span className="text-cyan-300">{hostMetrics.cpu.usagePercent.toFixed(1)}%</span>
                </span>
                <span>
                  Host RAM:{' '}
                  <span className="text-indigo-300">
                    {hostMetrics.memory.usedGb.toFixed(1)}/{hostMetrics.memory.totalGb.toFixed(1)} GB (
                    {Math.round(hostMetrics.memory.usedPercent)}%)
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  sampler live
                </span>
              </>
            ) : (
              <span>Host telemetry: waiting for the first real sample…</span>
            )}
          </div>
        </div>
      </div>

      {/* ═══ 2. LOCAL HOST NODE — REAL TELEMETRY ═══ */}
      <section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Server className="w-5 h-5 text-cyan-400" />
              Local Host Node — Live Telemetry
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              This machine is the always-on local node of the pool. Readings come from the real OS — no simulation.
            </p>
          </div>
          {hostMetrics && (
            <span className="self-start shrink-0 text-[11px] font-mono text-zinc-500 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-md">
              {hostMetrics.os.platform} ({hostMetrics.os.arch}) · Node {hostMetrics.os.nodeVersion} · sampled{' '}
              {relTime(hostMetrics.timestamp)}
            </span>
          )}
        </div>

        {hostMetrics ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {/* Runtime & OS */}
              <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-400" />
                    Runtime &amp; OS
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    ONLINE
                  </span>
                </div>
                <div className="space-y-1 text-[11px] text-zinc-400">
                  <div className="flex justify-between gap-2">
                    <span>Hostname:</span>
                    <span className="font-mono text-zinc-200 truncate" title={hostMetrics.os.hostname}>
                      {hostMetrics.os.hostname}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Kernel:</span>
                    <span className="font-mono text-zinc-300 truncate max-w-[140px]" title={hostMetrics.os.release}>
                      {hostMetrics.os.release}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Uptime:</span>
                    <span className="font-mono text-zinc-200">{fmtUptime(hostMetrics.os.uptimeSeconds)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Node.js:</span>
                    <span className="font-mono text-zinc-300">{hostMetrics.os.nodeVersion}</span>
                  </div>
                </div>
              </div>

              {/* CPU */}
              <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-cyan-400" />
                    Host CPU
                  </span>
                  <span className="text-[10px] font-mono bg-cyan-950/80 border border-cyan-800/80 text-cyan-300 px-2 py-0.5 rounded">
                    {hostMetrics.cpu.cores} cores
                  </span>
                </div>
                <div className="text-[11px] font-mono text-zinc-200 truncate" title={hostMetrics.cpu.model}>
                  {hostMetrics.cpu.model}
                </div>
                <Meter
                  label="Usage"
                  percent={hostMetrics.cpu.usagePercent}
                  tone="bg-gradient-to-r from-cyan-500 to-blue-500"
                  sub={`${hostMetrics.cpu.usagePercent.toFixed(1)}%`}
                />
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Load (1m/5m/15m):</span>
                  <span className="font-mono text-cyan-400">{hostMetrics.cpu.loadAvg.map((l) => l.toFixed(2)).join(' / ')}</span>
                </div>
                <div className="flex justify-between text-[11px] text-zinc-500 font-mono">
                  <span>Clock:</span>
                  <span>{(hostMetrics.cpu.speedMhz / 1000).toFixed(2)} GHz</span>
                </div>
              </div>

              {/* RAM */}
              <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                    <MemoryStick className="w-4 h-4 text-indigo-400" />
                    Host Memory
                  </span>
                  <span className="text-[10px] font-mono bg-indigo-950/80 border border-indigo-800/80 text-indigo-300 px-2 py-0.5 rounded">
                    {hostMetrics.memory.totalGb.toFixed(1)} GB total
                  </span>
                </div>
                <Meter
                  label="Used"
                  percent={hostMetrics.memory.usedPercent}
                  tone="bg-indigo-500"
                  sub={`${hostMetrics.memory.usedGb.toFixed(2)} / ${hostMetrics.memory.totalGb.toFixed(2)} GB`}
                />
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Free:</span>
                  <span className="font-mono text-emerald-400">
                    {(hostMetrics.memory.totalGb - hostMetrics.memory.usedGb).toFixed(2)} GB
                  </span>
                </div>
                <div className="flex justify-between text-[11px] text-zinc-500 font-mono">
                  <span>Heap: {hostMetrics.memory.processHeapUsedMb} MB</span>
                  <span>RSS: {hostMetrics.memory.processRssMb} MB</span>
                </div>
              </div>

              {/* Disk */}
              <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    Host Storage
                  </span>
                  <span className="text-[10px] font-mono bg-emerald-950/80 border border-emerald-800/80 text-emerald-300 px-2 py-0.5 rounded">
                    {hostMetrics.storage.totalGb.toFixed(1)} GB
                  </span>
                </div>
                <Meter
                  label="Used"
                  percent={hostMetrics.storage.usedPercent}
                  tone="bg-gradient-to-r from-emerald-500 to-teal-500"
                  sub={`${hostMetrics.storage.usedGb.toFixed(1)} / ${hostMetrics.storage.totalGb.toFixed(1)} GB`}
                />
                <div className="flex justify-between text-[11px] text-zinc-400 font-mono">
                  <span className="truncate max-w-[120px]" title={hostMetrics.storage.mountPath}>
                    {hostMetrics.storage.mountPath}
                  </span>
                  <span>{hostMetrics.storage.filesystem || 'fs'}</span>
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                  measured via statfs on the project mount
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {/* CPU history sparkline + network */}
              <div className="xl:col-span-2 bg-zinc-900/60 border border-zinc-800/90 rounded-xl p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    Host CPU history ({hostHistory.length} samples)
                  </span>
                  <span className="text-[10px] font-mono text-zinc-500">
                    live samples collected every 15s by the platform sampler
                  </span>
                </div>
                <CpuSparkline points={hostHistory} />
                {hostMetrics.network && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-500 pt-1 border-t border-zinc-800/80">
                    <span className="flex items-center gap-1.5 text-zinc-400">
                      <Wifi className="w-3.5 h-3.5 text-cyan-400" />
                      Network (real /proc/net/dev deltas)
                    </span>
                    <span>
                      ↓ <span className="text-cyan-300">{hostMetrics.network.rxKbPerSec.toFixed(1)} KB/s</span>
                    </span>
                    <span>
                      ↑ <span className="text-indigo-300">{hostMetrics.network.txKbPerSec.toFixed(1)} KB/s</span>
                    </span>
                    <span>
                      totals: {hostMetrics.network.totalRxMb.toFixed(0)} MB in / {hostMetrics.network.totalTxMb.toFixed(0)} MB out
                    </span>
                  </div>
                )}
              </div>

              {/* GPU panel */}
              <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    GPU
                  </span>
                  {hostMetrics.gpu.detected ? (
                    <span className="text-[10px] font-mono bg-amber-950/80 border border-amber-800/80 text-amber-300 px-2 py-0.5 rounded">
                      {hostMetrics.gpu.vendor || 'gpu'} detected
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono bg-zinc-800/80 border border-zinc-700/80 text-zinc-400 px-2 py-0.5 rounded">
                      none
                    </span>
                  )}
                </div>

                {hostMetrics.gpu.detected ? (
                  <div className="space-y-3">
                    <div className="text-[11px] font-mono text-zinc-200 truncate" title={hostMetrics.gpu.model}>
                      {hostMetrics.gpu.model}
                    </div>
                    {hostMetrics.gpu.vramTotalMb != null && (
                      <Meter
                        label="VRAM"
                        percent={pct(hostMetrics.gpu.vramUsedMb ?? 0, hostMetrics.gpu.vramTotalMb)}
                        tone="bg-gradient-to-r from-amber-500 to-orange-500"
                        sub={`${mbToGb(hostMetrics.gpu.vramUsedMb, 2)} / ${mbToGb(hostMetrics.gpu.vramTotalMb, 2)}`}
                      />
                    )}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-zinc-400">
                      <div className="flex justify-between gap-2">
                        <span>Util:</span>
                        <span className="font-mono text-amber-300">
                          {hostMetrics.gpu.utilPercent != null ? `${hostMetrics.gpu.utilPercent.toFixed(0)}%` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Temp:</span>
                        <span className="font-mono text-zinc-200">
                          {hostMetrics.gpu.tempC != null ? `${hostMetrics.gpu.tempC.toFixed(0)}°C` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Driver:</span>
                        <span className="font-mono text-zinc-300 truncate" title={hostMetrics.gpu.driverVersion}>
                          {hostMetrics.gpu.driverVersion || '—'}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>CUDA:</span>
                        <span className="font-mono text-zinc-300">{hostMetrics.gpu.cudaVersion || '—'}</span>
                      </div>
                    </div>
                    {hostMetrics.gpu.source && (
                      <div className="text-[10px] font-mono text-zinc-500">detected via {hostMetrics.gpu.source}</div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2.5 p-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/50">
                    <Info className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] font-mono text-zinc-500">
                      No discrete GPU detected (nvidia-smi / rocm-smi not found) — CPU/RAM/Storage telemetry is live.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <SkeletonCard className="xl:col-span-2" />
              <SkeletonCard />
            </div>
            <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60 text-center text-[11px] font-mono text-zinc-500">
              Reading live hardware metrics from the host runtime — first sample lands within 15s.
            </div>
          </div>
        )}
      </section>

      {/* ═══ 3. PROVIDER POOL GRID ═══ */}
      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-cyan-400" />
            Provider Pool
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">
            {connectedProviders.length}/{providers.length} connected
          </span>
        </div>

        {providers.length === 0 ? (
          <div className="p-8 rounded-2xl bg-zinc-900/30 border border-dashed border-zinc-800 text-center space-y-2">
            <Zap className="w-8 h-8 text-zinc-600 mx-auto" />
            <div className="text-sm font-medium text-zinc-300">No providers loaded</div>
            <p className="text-xs text-zinc-500">
              The local node and built-in free integrations are seeded automatically on first dashboard load.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 max-h-[720px] overflow-y-auto nx-scroll pr-1 -mr-1">
            {providers.map((p) => {
              const isLocal = p.type === 'local';
              const result = testResults[p.id];
              const allocVcpuPct = pct(p.allocated?.vCpu ?? 0, p.capacity?.vCpu ?? 0);
              const allocRamPct = pct(p.allocated?.ramGb ?? 0, p.capacity?.ramGb ?? 0);
              return (
                <div
                  key={p.id}
                  className="bg-[#0d0f16] border border-zinc-800 hover:border-zinc-700/80 rounded-2xl p-5 space-y-4 flex flex-col transition"
                >
                  {/* Title row */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-white truncate" title={p.name}>
                        {p.name}
                      </h4>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <TypeBadge type={p.type} />
                        <CategoryBadge category={p.category} />
                        {p.isBuiltInFree && (
                          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                            Built-in FREE
                          </span>
                        )}
                      </div>
                    </div>
                    <StatusPill status={p.status} isBuiltIn={p.isBuiltInFree || p.record?.isBuiltIn === true} />
                  </div>

                  {/* Capacity grid */}
                  <div className="grid grid-cols-3 gap-2 bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/80 text-xs font-mono">
                    <div>
                      <span className="text-[10px] text-zinc-500 block uppercase">vCPUs</span>
                      <span className="text-cyan-300 font-bold">{p.capacity?.vCpu ?? 0}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-500 block uppercase">RAM</span>
                      <span className="text-indigo-300 font-bold">{p.capacity?.ramGb ?? 0} GB</span>
                    </div>
                    {p.capacity?.gpuModel ? (
                      <div className="min-w-0">
                        <span className="text-[10px] text-zinc-500 block uppercase">GPU</span>
                        <span className="text-amber-300 font-bold truncate block" title={`${p.capacity.gpuModel}${p.capacity.vramGb ? ` · ${p.capacity.vramGb} GB` : ''}`}>
                          {p.capacity.gpuModel}
                          {p.capacity.vramGb ? ` · ${p.capacity.vramGb} GB` : ''}
                        </span>
                      </div>
                    ) : (
                      <div>
                        <span className="text-[10px] text-zinc-500 block uppercase">Storage</span>
                        <span className="text-emerald-300 font-bold">{p.capacity?.storageGb ?? 0} GB</span>
                      </div>
                    )}
                  </div>

                  {/* Allocated usage vs capacity bars */}
                  <div className="space-y-2">
                    <Meter
                      label="vCPU allocated"
                      percent={allocVcpuPct}
                      tone="bg-gradient-to-r from-cyan-500 to-blue-500"
                      sub={`${p.allocated?.vCpu ?? 0} / ${p.capacity?.vCpu ?? 0} vCPU (${Math.round(allocVcpuPct)}%)`}
                    />
                    <Meter
                      label="RAM allocated"
                      percent={allocRamPct}
                      tone="bg-gradient-to-r from-indigo-500 to-purple-500"
                      sub={`${p.allocated?.ramGb ?? 0} / ${p.capacity?.ramGb ?? 0} GB (${Math.round(allocRamPct)}%)`}
                    />
                  </div>

                  {/* Meta */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-500">
                    <span>
                      Ping: <span className="text-zinc-300">{fmtMs(p.pingLatencyMs)}</span>
                    </span>
                    <span>
                      Checked: <span className="text-zinc-300">{relTime(p.lastChecked)}</span>
                    </span>
                    <span>
                      Services: <span className="text-zinc-300">{p.allocated?.servicesCount ?? 0}</span>
                    </span>
                    {p.accountEmail && <span className="max-w-full truncate text-zinc-400">{p.accountEmail}</span>}
                  </div>

                  {/* Local node note */}
                  {isLocal && p.status === 'connected' && (
                    <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-400">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </span>
                      Always connected — live telemetry from this machine
                    </div>
                  )}

                  {/* Last test result */}
                  {result && <ResultBanner result={result} />}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-1 mt-auto">
                    <button
                      type="button"
                      onClick={() => handleTest(p.id, p.name)}
                      disabled={testingId === p.id}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-zinc-800/80 text-zinc-200 border border-zinc-700/80 hover:bg-zinc-800 hover:text-white disabled:opacity-50 transition"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testingId === p.id ? 'animate-spin' : ''}`} />
                      {testingId === p.id ? 'Testing…' : 'Test'}
                    </button>

                    {!isLocal && p.status !== 'connected' && (
                      <button
                        type="button"
                        onClick={() => openConnect(p)}
                        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50 transition"
                      >
                        <PlugZap className="w-3.5 h-3.5" />
                        {p.status === 'error' ? 'Reconnect' : 'Connect'}
                      </button>
                    )}

                    {p.status === 'connected' && !isLocal && (
                      <button
                        type="button"
                        onClick={() => handleDisconnect(p)}
                        disabled={disconnectBusyId === p.id}
                        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-900/60 hover:bg-rose-900/40 disabled:opacity-50 transition"
                      >
                        <Unplug className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ═══ 4. CUSTOM NODES SECTION ═══ */}
      <section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-cyan-400" />
              Custom Nodes &amp; Remote Servers ({nodes.length})
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Your own VPS, dedicated boxes and GPU rigs — live metrics come from real agent heartbeats or probes.
            </p>
          </div>
          <button
            type="button"
            onClick={openAddModal}
            className="self-start sm:self-auto inline-flex items-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 transition"
          >
            <Plus className="w-3.5 h-3.5 text-cyan-400" />
            <span>Add Server</span>
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="p-8 rounded-2xl bg-zinc-900/30 border border-dashed border-zinc-800 text-center space-y-3">
            <Server className="w-8 h-8 text-zinc-600 mx-auto" />
            <div className="text-sm font-medium text-zinc-300">No custom servers connected yet</div>
            <p className="text-xs text-zinc-500 max-w-md mx-auto">
              Add any self-hosted VPS, dedicated server, or home GPU workstation via the 1-line curl agent command or a
              health probe URL.
            </p>
            <button
              type="button"
              onClick={openAddModal}
              className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-500 text-zinc-950 hover:bg-cyan-400 transition"
            >
              Connect First Custom Server
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 max-h-[720px] overflow-y-auto nx-scroll pr-1 -mr-1">
            {nodes.map((node) => {
              const st = NODE_STATUS[node.status] || NODE_STATUS.offline;
              const result = testResults[node.id];
              return (
                <div
                  key={node.id}
                  className="bg-[#0d0f16] border border-zinc-800 hover:border-zinc-700/80 rounded-2xl p-5 space-y-4 flex flex-col transition"
                >
                  {/* Title row */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-white truncate flex items-center gap-2">
                        {node.name}
                        <span className="text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-indigo-800/50 bg-indigo-950/40 text-indigo-300">
                          {METHOD_LABELS[node.connectionMethod] || node.connectionMethod}
                        </span>
                      </h4>
                      <p className="text-[11px] text-zinc-500 font-mono mt-0.5 truncate">{node.ipOrHost}</p>
                    </div>
                    <span
                      className={`shrink-0 inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800 ${st.text}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      {st.label}
                    </span>
                  </div>

                  {/* Live telemetry meters (real agent heartbeats) */}
                  {node.liveMetrics && (
                    <div className="grid grid-cols-2 gap-3 bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/80">
                      <Meter label="CPU" percent={node.liveMetrics.cpuPercent} tone="bg-cyan-500" />
                      <Meter label="RAM" percent={node.liveMetrics.ramPercent} tone="bg-indigo-500" />
                      <Meter label="Disk" percent={node.liveMetrics.diskPercent} tone="bg-emerald-500" />
                      {node.liveMetrics.gpuPercent != null && (
                        <Meter label="GPU" percent={node.liveMetrics.gpuPercent} tone="bg-amber-500" />
                      )}
                    </div>
                  )}

                  {/* Capacity + heartbeat meta */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-500">
                    <span>
                      vCPU: <span className="text-cyan-300">{node.hardware?.vCpu ?? 0}</span>
                    </span>
                    <span>
                      RAM: <span className="text-indigo-300">{node.hardware?.ramGb ?? 0} GB</span>
                    </span>
                    <span>
                      Disk: <span className="text-emerald-300">{node.hardware?.storageGb ?? 0} GB</span>
                    </span>
                    {node.hardware?.gpuModel && (
                      <span className="text-amber-300 max-w-full truncate">
                        GPU: {node.hardware.gpuModel}
                        {node.hardware.vramGb ? ` · ${node.hardware.vramGb} GB` : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-500">
                    <span>
                      Heartbeat: <span className="text-zinc-300">{relTime(node.lastHeartbeat)}</span>
                    </span>
                    <span>
                      Ping: <span className="text-zinc-300">{fmtMs(node.pingMs)}</span>
                    </span>
                    {node.osInfo && <span className="max-w-full truncate text-zinc-400">{node.osInfo}</span>}
                  </div>

                  {/* Tags */}
                  {node.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {node.tags.map((tag, idx) => (
                        <span
                          key={idx}
                          className="text-[10px] font-mono bg-zinc-800/60 text-zinc-300 px-2 py-0.5 rounded border border-zinc-700/50"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Agent install hint (real relative URL, copyable) */}
                  {node.connectionMethod === 'agent' && node.agentToken && (
                    <div className="flex items-center justify-between gap-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2">
                      <code
                        className="font-mono text-[10px] text-emerald-300 truncate nx-scroll"
                        title={`/api/agent/install?token=${node.agentToken}`}
                      >
                        /api/agent/install?token={node.agentToken}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopyInstallUrl(node)}
                        aria-label="Copy agent install URL"
                        className="shrink-0 w-11 h-11 flex items-center justify-center rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 transition"
                      >
                        {copiedNodeId === node.id ? (
                          <Check className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  )}

                  {/* Last test result */}
                  {result && <ResultBanner result={result} />}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-1 mt-auto">
                    <button
                      type="button"
                      onClick={() => handleTest(node.id, node.name)}
                      disabled={testingId === node.id}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-zinc-800/80 text-zinc-200 border border-zinc-700/80 hover:bg-zinc-800 hover:text-white disabled:opacity-50 transition"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testingId === node.id ? 'animate-spin' : ''}`} />
                      {testingId === node.id ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteNode(node)}
                      disabled={deleteBusyId === node.id}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-900/60 hover:bg-rose-900/40 disabled:opacity-50 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ═══ 5. ADD COMPUTE PANEL ═══ */}
      <section className="space-y-4">
        <div className="rounded-2xl border border-zinc-800 bg-[#0d0f16] p-6 relative overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Plus className="w-5 h-5 text-cyan-400" />
                Add Compute Capacity
              </h2>
              <p className="text-xs text-zinc-400 max-w-xl">
                Register a VPS or GPU rig with the 1-line agent (real telemetry every 15s), probe any HTTP endpoint, or
                enter the specs manually. Every add is verified for real on submit.
              </p>
            </div>
            <button
              type="button"
              onClick={openAddModal}
              className="self-start sm:self-auto inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-zinc-950 transition shadow-lg shadow-cyan-500/20 active:scale-95 shrink-0"
            >
              <Server className="w-4 h-4" />
              Connect Custom Server / GPU
            </button>
          </div>
        </div>
      </section>

      {/* ═══ 6. FOOTER INFO STRIP ═══ */}
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-4 flex items-start gap-2.5">
        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <p className="text-[11px] font-mono text-zinc-500">
          All connection states are verified live. Tokens are stored obfuscated at rest. Local node telemetry is
          measured from the real machine (os, statfs, /proc, nvidia-smi).
        </p>
      </div>

      {/* ═══ MODAL 1: CONNECT PROVIDER (token verification) ═══ */}
      {connectTarget && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl animate-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto nx-scroll">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Key className="w-5 h-5 text-cyan-400" />
                  Connect {connectTarget.name}
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Your token is verified directly against the real provider API before the provider joins the pool.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConnectTarget(null)}
                aria-label="Close connect dialog"
                className="w-11 h-11 flex items-center justify-center text-zinc-500 hover:text-zinc-300 text-lg rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="cnv-connect-token" className="text-xs font-medium text-zinc-300 block mb-1.5">
                  {TOKEN_LABELS[connectTarget.type] || 'API Token'}
                  {connectTarget.type === 'custom_probe' && <span className="text-zinc-500"> (optional)</span>}
                </label>
                <input
                  id="cnv-connect-token"
                  type="password"
                  value={connectToken}
                  onChange={(e) => setConnectToken(e.target.value)}
                  placeholder="paste token — verified live on submit"
                  autoComplete="off"
                  className={`${INPUT_CLASS} font-mono`}
                />
                {TOKEN_HINTS[connectTarget.type] && (
                  <p className="text-[11px] text-zinc-500 mt-1.5 flex items-center gap-1 flex-wrap">
                    <span>Where to get it: {TOKEN_HINTS[connectTarget.type]}</span>
                    {TOKEN_HINT_URLS[connectTarget.type] && (
                      <a
                        href={TOKEN_HINT_URLS[connectTarget.type]}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5"
                      >
                        open <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </p>
                )}
                {connectTarget.type === 'custom_agent' && (
                  <p className="text-[11px] text-zinc-500 mt-1.5">
                    No token needed — agent nodes verify via their latest real heartbeat to{' '}
                    <span className="font-mono text-zinc-400">/api/agent/heartbeat</span>.
                  </p>
                )}
              </div>

              {connectNeedsEndpoint && (
                <div>
                  <label htmlFor="cnv-connect-endpoint" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Endpoint URL <span className="text-rose-400">*</span>
                  </label>
                  <input
                    id="cnv-connect-endpoint"
                    type="url"
                    value={connectEndpoint}
                    onChange={(e) => setConnectEndpoint(e.target.value)}
                    placeholder="https://status.example.com/health"
                    className={`${INPUT_CLASS} font-mono`}
                  />
                </div>
              )}

              {/* Real verify result shown inside the modal before closing */}
              {connectResult && <ResultBanner result={connectResult} />}
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setConnectTarget(null)}
                className="min-h-[44px] px-4 py-2 text-xs font-medium rounded-lg text-zinc-400 hover:text-zinc-200 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConnectSubmit}
                disabled={
                  connectBusy ||
                  (connectNeedsToken && !connectToken.trim()) ||
                  (connectNeedsEndpoint && !connectEndpoint.trim())
                }
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50 transition"
              >
                {connectBusy ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Verify &amp; Connect
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL 2: ADD SERVER (agent / probe / manual tabs) ═══ */}
      {addOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl animate-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto nx-scroll">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Server className="w-5 h-5 text-cyan-400" />
                  Connect Custom Server or GPU Rig
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Add any remote machine to the real capacity pool — the verification result below is a real response.
                </p>
              </div>
              <button
                type="button"
                onClick={closeAddModal}
                aria-label="Close add-server dialog"
                className="w-11 h-11 flex items-center justify-center text-zinc-500 hover:text-zinc-300 text-lg rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Connection method tabs */}
            <div className="grid grid-cols-3 gap-2 bg-zinc-900/80 p-1 rounded-xl border border-zinc-800/80 text-xs font-medium">
              <button
                type="button"
                onClick={() => setAddTab('agent')}
                className={`min-h-[44px] py-2 px-2 rounded-lg transition ${
                  addTab === 'agent' ? 'bg-zinc-800 text-white font-semibold shadow' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                1-Line Agent (Recommended)
              </button>
              <button
                type="button"
                onClick={() => setAddTab('probe')}
                className={`min-h-[44px] py-2 px-2 rounded-lg transition ${
                  addTab === 'probe' ? 'bg-zinc-800 text-white font-semibold shadow' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                HTTP Probe
              </button>
              <button
                type="button"
                onClick={() => setAddTab('manual')}
                className={`min-h-[44px] py-2 px-2 rounded-lg transition ${
                  addTab === 'manual' ? 'bg-zinc-800 text-white font-semibold shadow' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Manual Specs
              </button>
            </div>

            {/* Shared name field */}
            <div>
              <label htmlFor="cnv-add-name" className="text-xs font-medium text-zinc-300 block mb-1.5">
                Node name <span className="text-rose-400">*</span>
              </label>
              <input
                id="cnv-add-name"
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. AI-Inference-Rig-RTX4090 or my-hetzner-vps"
                className={INPUT_CLASS}
              />
            </div>

            {/* TAB: AGENT */}
            {addTab === 'agent' && (
              <div className="space-y-4">
                <div className="p-3.5 rounded-xl bg-zinc-900/80 border border-zinc-800/90 space-y-2">
                  <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    How it works
                  </span>
                  <p className="text-[11px] text-zinc-400">
                    After the node is added you get a one-liner that installs a tiny bash agent on your Linux server. It
                    reads real CPU / RAM / disk from <span className="font-mono">/proc</span> and{' '}
                    <span className="font-mono">df</span>, queries <span className="font-mono">nvidia-smi</span> /{' '}
                    <span className="font-mono">rocm-smi</span> for GPUs, and heartbeats live telemetry to this dashboard
                    every 15 seconds.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="cnv-add-tags" className="text-xs font-medium text-zinc-300 block mb-1.5">
                      Tags <span className="text-zinc-500">(comma separated)</span>
                    </label>
                    <input
                      id="cnv-add-tags"
                      type="text"
                      value={addTags}
                      onChange={(e) => setAddTags(e.target.value)}
                      placeholder="gpu, home-lab, eu"
                      className={INPUT_CLASS}
                    />
                  </div>
                  <div>
                    <label htmlFor="cnv-add-notes" className="text-xs font-medium text-zinc-300 block mb-1.5">
                      Notes <span className="text-zinc-500">(optional)</span>
                    </label>
                    <input
                      id="cnv-add-notes"
                      type="text"
                      value={addNotes}
                      onChange={(e) => setAddNotes(e.target.value)}
                      placeholder="Anything worth remembering…"
                      className={INPUT_CLASS}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* TAB: PROBE */}
            {addTab === 'probe' && (
              <div className="space-y-4">
                <div>
                  <label htmlFor="cnv-add-endpoint" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Endpoint health / metrics URL <span className="text-rose-400">*</span>
                  </label>
                  <input
                    id="cnv-add-endpoint"
                    type="url"
                    value={addEndpoint}
                    onChange={(e) => setAddEndpoint(e.target.value)}
                    placeholder="https://my-vps.example.com/health or http://192.168.1.100:8000"
                    className={`${INPUT_CLASS} font-mono`}
                  />
                  <p className="text-[11px] text-zinc-500 mt-1.5">
                    The platform sends one real HTTP request to measure live status and latency — no simulated probe.
                  </p>
                </div>
                <CapacityFields
                  vCpu={addVCpu}
                  ram={addRam}
                  gpu={addGpu}
                  vram={addVram}
                  storage={addStorage}
                  onVCpu={setAddVCpu}
                  onRam={setAddRam}
                  onGpu={setAddGpu}
                  onVram={setAddVram}
                  onStorage={setAddStorage}
                />
              </div>
            )}

            {/* TAB: MANUAL */}
            {addTab === 'manual' && (
              <div className="space-y-4">
                <p className="text-[11px] text-zinc-500">
                  Specs are recorded as-is and the node joins the pool with the capacity you enter. Give it an agent
                  later to replace manual numbers with real telemetry.
                </p>
                <CapacityFields
                  vCpu={addVCpu}
                  ram={addRam}
                  gpu={addGpu}
                  vram={addVram}
                  storage={addStorage}
                  onVCpu={setAddVCpu}
                  onRam={setAddRam}
                  onGpu={setAddGpu}
                  onVram={setAddVram}
                  onStorage={setAddStorage}
                />
                <div>
                  <label htmlFor="cnv-add-notes-manual" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Notes <span className="text-zinc-500">(optional)</span>
                  </label>
                  <input
                    id="cnv-add-notes-manual"
                    type="text"
                    value={addNotes}
                    onChange={(e) => setAddNotes(e.target.value)}
                    placeholder="Anything worth remembering…"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
            )}

            {/* Inline result banners */}
            {addError && (
              <div className="p-3 rounded-xl text-xs flex items-start gap-2.5 bg-rose-950/50 border border-rose-800/80 text-rose-300">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span className="font-mono break-words">{addError}</span>
              </div>
            )}
            {addResult && <ResultBanner result={addResult} />}

            {/* Agent token + install command panel (real token from the API) */}
            {agentTokenInfo && (
              <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-950/30 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                  <Terminal className="w-4 h-4" />
                  Agent install command — run this on your server
                </div>
                <div className="relative bg-zinc-950 border border-zinc-800 rounded-lg p-3 pr-16 font-mono text-[11px] text-emerald-300">
                  <code className="nx-scroll block overflow-x-auto whitespace-nowrap">
                    {buildAgentCommand(agentTokenInfo.token, agentTokenInfo.name)}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyAgentCommand}
                    aria-label="Copy agent install command"
                    className="absolute top-1.5 right-1.5 w-11 h-11 flex items-center justify-center rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 transition"
                  >
                    {copiedAgent ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500">
                  The agent reports real CPU / RAM / disk / GPU telemetry every 15s to{' '}
                  <span className="font-mono text-zinc-400">/api/agent/heartbeat</span>. The node appears under Custom
                  Nodes as soon as the first heartbeat lands.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-zinc-800/80">
              <p className="text-[11px] text-zinc-500">
                {addResult
                  ? 'Added — you can close this dialog or register another node.'
                  : 'The node is verified immediately on submit.'}
              </p>
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={closeAddModal}
                  className="min-h-[44px] px-4 py-2 text-xs font-medium rounded-lg text-zinc-400 hover:text-zinc-200 transition flex-1 sm:flex-none"
                >
                  {addResult ? 'Close' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleAddSubmit}
                  disabled={addBusy || !addName.trim()}
                  className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50 transition flex-1 sm:flex-none"
                >
                  {addBusy ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Adding &amp; verifying…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Add &amp; Verify Node
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Capacity input row (probe + manual tabs) ─────────────────────────────── */

function CapacityFields({
  vCpu,
  ram,
  gpu,
  vram,
  storage,
  onVCpu,
  onRam,
  onGpu,
  onVram,
  onStorage,
}: {
  vCpu: string;
  ram: string;
  gpu: string;
  vram: string;
  storage: string;
  onVCpu: (v: string) => void;
  onRam: (v: string) => void;
  onGpu: (v: string) => void;
  onVram: (v: string) => void;
  onStorage: (v: string) => void;
}) {
  return (
    <div>
      <span className="text-xs font-medium text-zinc-300 block mb-1.5">
        Capacity <span className="text-zinc-500">(optional — feeds the pool math until real telemetry arrives)</span>
      </span>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <input
          type="number"
          min={0}
          step="any"
          value={vCpu}
          onChange={(e) => onVCpu(e.target.value)}
          placeholder="vCPU"
          aria-label="vCPU capacity"
          className={INPUT_CLASS}
        />
        <input
          type="number"
          min={0}
          step="any"
          value={ram}
          onChange={(e) => onRam(e.target.value)}
          placeholder="RAM GB"
          aria-label="RAM capacity in GB"
          className={INPUT_CLASS}
        />
        <input
          type="text"
          value={gpu}
          onChange={(e) => onGpu(e.target.value)}
          placeholder="GPU model"
          aria-label="GPU model"
          className={INPUT_CLASS}
        />
        <input
          type="number"
          min={0}
          step="any"
          value={vram}
          onChange={(e) => onVram(e.target.value)}
          placeholder="VRAM GB"
          aria-label="VRAM capacity in GB"
          className={INPUT_CLASS}
        />
        <input
          type="number"
          min={0}
          step="any"
          value={storage}
          onChange={(e) => onStorage(e.target.value)}
          placeholder="Storage GB"
          aria-label="Storage capacity in GB"
          className={INPUT_CLASS}
        />
      </div>
    </div>
  );
}
