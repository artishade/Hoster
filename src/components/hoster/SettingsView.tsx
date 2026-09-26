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
  MemoryStick,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
  X,
  Zap,
} from 'lucide-react';
import { ConnectedProvider, CustomServerNode } from '@/lib/hoster/types';

/* ─── Public contract ───────────────────────────────────────────────────────── */

export interface NewProviderPayload {
  name: string;
  type: string;
  endpointUrl?: string;
  token?: string;
  capacity?: { vCpu?: number; ramGb?: number; gpuModel?: string; vramGb?: number; storageGb?: number };
  tags?: string[];
  notes?: string;
}

export type SettingsViewProvider = ConnectedProvider & {
  record?: { token: string | null; endpointUrl: string | null; slug: string; isBuiltIn: boolean };
};

interface SettingsViewProps {
  providers: SettingsViewProvider[];
  nodes: CustomServerNode[];
  onAddProvider: (payload: NewProviderPayload) => Promise<{ success: boolean; error?: string; verify?: { success: boolean; message?: string; error?: string }; agentToken?: string | null }>;
  onConnectProvider: (id: string, token: string | null, endpointUrl?: string | null) => Promise<{ success: boolean; error?: string; verify?: { success: boolean; message?: string; error?: string } }>;
  onDisconnectProvider: (id: string) => Promise<{ success: boolean; error?: string }>;
  onTestProvider: (id: string) => Promise<{ success: boolean; error?: string; verify?: { success: boolean; latencyMs?: number; message?: string; error?: string } }>;
  onDeleteProvider: (id: string) => Promise<{ success: boolean; error?: string }>;
}

/* ─── Constants & helpers ───────────────────────────────────────────────────── */

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
  manual: 'Manual',
};

const ADD_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'custom_agent', label: 'My own server (live agent telemetry)' },
  { value: 'custom_probe', label: 'HTTP probe (any URL)' },
  { value: 'runpod', label: 'RunPod (GPU cloud)' },
  { value: 'huggingface', label: 'Hugging Face (another account/token)' },
  { value: 'render', label: 'Render.com' },
  { value: 'fly', label: 'Fly.io' },
  { value: 'koyeb', label: 'Koyeb' },
];

const CLOUD_TOKEN_TYPES = ['runpod', 'huggingface', 'render', 'fly', 'koyeb'];
const CUSTOM_TYPES = ['custom_agent', 'custom_probe'];

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

const INPUT_CLASS =
  'w-full min-h-[44px] bg-zinc-900 border border-zinc-800 rounded-lg px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500';

function relTime(iso?: string): string {
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

/** The connect/add `verify` contract omits latencyMs even though the backend may send it — widen safely. */
function widenVerify(
  v?: { success: boolean; message?: string; error?: string }
): { success: boolean; message?: string; error?: string; latencyMs?: number } | undefined {
  return v as { success: boolean; message?: string; error?: string; latencyMs?: number } | undefined;
}

function buildAgentCommand(token: string, name: string): string {
  const safeName = name.replace(/"/g, '').trim();
  return `curl -sL "/api/agent/install?token=${token}" -o nh-agent.sh && chmod +x nh-agent.sh && ./nh-agent.sh "${safeName}" 15`;
}

/* ─── Small pure presentational pieces ──────────────────────────────────────── */

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

function StatusPill({ status }: { status: string }) {
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
      Token required
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

function Meter({ label, percent, tone }: { label: string; percent: number; tone: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] font-mono">
        <span className="text-zinc-500 uppercase text-[10px]">{label}</span>
        <span className="text-zinc-300">{Math.round(percent)}%</span>
      </div>
      <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

/* ─── Main view ─────────────────────────────────────────────────────────────── */

export default function SettingsView({
  providers,
  nodes,
  onAddProvider,
  onConnectProvider,
  onDisconnectProvider,
  onTestProvider,
  onDeleteProvider,
}: SettingsViewProps) {
  /* Connect-token inline dialog state */
  const [connectTarget, setConnectTarget] = useState<SettingsViewProvider | null>(null);
  const [connectToken, setConnectToken] = useState('');
  const [connectEndpoint, setConnectEndpoint] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectResult, setConnectResult] = useState<VerifyDisplay | null>(null);

  /* Per-provider test results */
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, VerifyDisplay>>({});

  /* Busy flags */
  const [disconnectBusyId, setDisconnectBusyId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);

  /* Add-provider form state */
  const [formType, setFormType] = useState('custom_agent');
  const [formName, setFormName] = useState('');
  const [formEndpoint, setFormEndpoint] = useState('');
  const [formToken, setFormToken] = useState('');
  const [formVCpu, setFormVCpu] = useState('');
  const [formRamGb, setFormRamGb] = useState('');
  const [formGpuModel, setFormGpuModel] = useState('');
  const [formVramGb, setFormVramGb] = useState('');
  const [formStorageGb, setFormStorageGb] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addResult, setAddResult] = useState<VerifyDisplay | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [agentInfo, setAgentInfo] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  /* ── Derived pool totals (computed from props) ── */
  const connectedProviders = providers.filter((p) => p.status === 'connected');
  const builtInFreeProviders = providers.filter((p) => p.isBuiltInFree || p.record?.isBuiltIn === true);
  const poolTotals = connectedProviders.reduce(
    (acc, p) => ({
      vCpu: acc.vCpu + (p.capacity?.vCpu ?? 0),
      ramGb: acc.ramGb + (p.capacity?.ramGb ?? 0),
      storageGb: acc.storageGb + (p.capacity?.storageGb ?? 0),
    }),
    { vCpu: 0, ramGb: 0, storageGb: 0 }
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
      const res = await onConnectProvider(
        connectTarget.id,
        connectToken.trim() || null,
        connectTarget.type === 'custom_probe' ? connectEndpoint.trim() || null : undefined
      );
      const v = widenVerify(res.verify);
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

  const handleAddProvider = async () => {
    const name = formName.trim();
    if (!name) {
      setAddError('Provider name is required.');
      toast.error('Provider name is required');
      return;
    }
    if (formType === 'custom_probe' && !formEndpoint.trim().startsWith('http')) {
      setAddError('HTTP probe requires a full endpoint URL (https://…).');
      toast.error('Endpoint URL is required for HTTP probe');
      return;
    }
    if (CLOUD_TOKEN_TYPES.includes(formType) && !formToken.trim()) {
      setAddError('API token is required for cloud providers — verification runs against the real API.');
      toast.error('API token is required for this provider type');
      return;
    }

    setAddBusy(true);
    setAddError(null);
    setAddResult(null);
    try {
      const payload: NewProviderPayload = { name, type: formType };
      if ((formType === 'custom_probe' || formType === 'runpod') && formEndpoint.trim()) {
        payload.endpointUrl = formEndpoint.trim();
      }
      if (CLOUD_TOKEN_TYPES.includes(formType) && formToken.trim()) {
        payload.token = formToken.trim();
      }
      if (CUSTOM_TYPES.includes(formType)) {
        const cap: NonNullable<NewProviderPayload['capacity']> = {};
        let hasCap = false;
        const vCpu = parseFloat(formVCpu);
        const ram = parseFloat(formRamGb);
        const vram = parseFloat(formVramGb);
        const stor = parseFloat(formStorageGb);
        if (!Number.isNaN(vCpu)) { cap.vCpu = vCpu; hasCap = true; }
        if (!Number.isNaN(ram)) { cap.ramGb = ram; hasCap = true; }
        if (!Number.isNaN(vram)) { cap.vramGb = vram; hasCap = true; }
        if (!Number.isNaN(stor)) { cap.storageGb = stor; hasCap = true; }
        if (formGpuModel.trim()) { cap.gpuModel = formGpuModel.trim(); hasCap = true; }
        if (hasCap) payload.capacity = cap;
      }
      const tags = formTags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length > 0) payload.tags = tags;
      if (formNotes.trim()) payload.notes = formNotes.trim();

      const res = await onAddProvider(payload);
      const v = widenVerify(res.verify);
      const ok = res.success && (v ? v.success !== false : true);
      const display: VerifyDisplay = {
        success: ok,
        message: v?.message,
        error: res.error || v?.error,
        latencyMs: v?.latencyMs,
      };

      if (!res.success) {
        setAddError(res.error || 'Failed to add provider.');
        toast.error(res.error || 'Failed to add provider');
        return;
      }

      setAddResult(display);
      toast.success(v?.message || `Provider "${name}" added & verified`);

      if (formType === 'custom_agent' && res.agentToken) {
        setAgentInfo({ token: res.agentToken, name });
        toast.success('Agent token generated — run the install command on your server');
      }

      /* Reset form fields (keep the type selected) */
      setFormName('');
      setFormEndpoint('');
      setFormToken('');
      setFormVCpu('');
      setFormRamGb('');
      setFormGpuModel('');
      setFormVramGb('');
      setFormStorageGb('');
      setFormTags('');
      setFormNotes('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error while adding provider';
      setAddError(msg);
      toast.error(msg);
    } finally {
      setAddBusy(false);
    }
  };

  const handleCopyAgentCommand = async () => {
    if (!agentInfo) return;
    const cmd = buildAgentCommand(agentInfo.token, agentInfo.name);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      toast.success('Agent install command copied to clipboard');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Clipboard blocked — select the command text and copy manually');
    }
  };

  /* ── Measured-verification latency rows for the info footer ── */
  const latencyRows: { key: string; label: string; ms: number }[] = providers
    .filter((p) => p.pingLatencyMs != null)
    .map((p) => ({ key: p.id, label: p.name, ms: p.pingLatencyMs as number }));
  for (const [id, r] of Object.entries(testResults)) {
    if (r.success && r.latencyMs != null) {
      const existing = latencyRows.find((row) => row.key === id);
      if (existing) existing.ms = r.latencyMs;
      else latencyRows.push({ key: id, label: providers.find((p) => p.id === id)?.name || id, ms: r.latencyMs });
    }
  }
  const latencyDisplay = latencyRows.slice(0, 6);

  const showEndpointField = formType === 'custom_probe' || formType === 'runpod';
  const showTokenField = CLOUD_TOKEN_TYPES.includes(formType);
  const showCapacityFields = CUSTOM_TYPES.includes(formType);

  /* ─────────────────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* ═══ 1. HEADER HERO (grid pattern, live pool totals) ═══ */}
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
            <span>Settings · Provider Pool Control</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1.5 flex items-center gap-2.5">
            <Settings className="w-6 h-6 text-cyan-400" />
            Dashboard Settings
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 max-w-2xl">
            Provider pool, built-in free integrations &amp; custom nodes — every connection is verified against the
            real provider API.
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
              icon={Zap}
              label="Built-in Free Integrations"
              value={String(builtInFreeProviders.length)}
              sub="permanent, seeded at boot"
              tone="text-emerald-400"
            />
            <StatTile
              icon={Cpu}
              label="Pooled vCPUs"
              value={poolTotals.vCpu.toFixed(1)}
              sub="summed from connected"
              tone="text-cyan-400"
            />
            <StatTile
              icon={MemoryStick}
              label="Pooled RAM"
              value={`${poolTotals.ramGb.toFixed(1)} GB`}
              sub={`${poolTotals.storageGb.toFixed(0)} GB storage attached`}
              tone="text-indigo-400"
            />
          </div>

          <div className="mt-4 text-[11px] font-mono text-zinc-500 flex flex-wrap gap-x-5 gap-y-1">
            <span>
              Custom nodes:{' '}
              <span className="text-zinc-300">
                {nodesOnline}/{nodes.length} online
              </span>
            </span>
            <span>
              Verification:{' '}
              <span className="text-emerald-400">real API responses only</span>
            </span>
          </div>
        </div>
      </div>

      {/* ═══ 2. BUILT-IN FREE PROVIDERS ═══ */}
      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-cyan-400" />
            Built-in Free Providers
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">
            {builtInFreeProviders.length} integrations
          </span>
        </div>

        {builtInFreeProviders.length === 0 ? (
          <div className="p-8 rounded-2xl bg-zinc-900/30 border border-dashed border-zinc-800 text-center space-y-2">
            <Zap className="w-8 h-8 text-zinc-600 mx-auto" />
            <div className="text-sm font-medium text-zinc-300">No built-in providers loaded</div>
            <p className="text-xs text-zinc-500">
              The local node, Hugging Face, Render, Fly.io and Koyeb integrations are seeded automatically on first
              dashboard load.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-h-[640px] overflow-y-auto nx-scroll pr-1 -mr-1">
            {builtInFreeProviders.map((p) => {
              const isLocal = p.type === 'local';
              const canConnect = p.status === 'disconnected' || p.status === 'error';
              const result = testResults[p.id];
              return (
                <div
                  key={p.id}
                  className="bg-[#0d0f16] border border-zinc-800 hover:border-zinc-700/80 rounded-2xl p-5 space-y-4 flex flex-col transition"
                >
                  {/* Title row */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-white truncate">{p.name}</h4>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <TypeBadge type={p.type} />
                        {(p.isBuiltInFree || p.record?.isBuiltIn) && (
                          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                            FREE
                          </span>
                        )}
                      </div>
                    </div>
                    <StatusPill status={p.status} />
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
                        <span className="text-amber-300 font-bold truncate block" title={p.capacity.gpuModel}>
                          {p.capacity.gpuModel}
                        </span>
                      </div>
                    ) : (
                      <div>
                        <span className="text-[10px] text-zinc-500 block uppercase">Storage</span>
                        <span className="text-emerald-300 font-bold">{p.capacity?.storageGb ?? 0} GB</span>
                      </div>
                    )}
                  </div>

                  {/* Allocation + latency meta */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-500">
                    <span>
                      Allocated:{' '}
                      <span className="text-zinc-300">
                        {p.allocated?.vCpu ?? 0} vCPU · {p.allocated?.ramGb ?? 0} GB
                      </span>
                    </span>
                    <span>
                      {p.allocated?.servicesCount ?? 0}{' '}
                      {(p.allocated?.servicesCount ?? 0) === 1 ? 'service' : 'services'}
                    </span>
                    <span>
                      Storage: <span className="text-emerald-300">{p.capacity?.storageGb ?? 0} GB</span>
                    </span>
                    <span>
                      Ping: <span className="text-zinc-300">{fmtMs(p.pingLatencyMs)}</span>
                    </span>
                    <span>Checked: {relTime(p.lastChecked)}</span>
                  </div>

                  {/* Live telemetry note for the local node */}
                  {p.status === 'connected' && isLocal && (
                    <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-400">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </span>
                      Live telemetry streaming from the real host runtime
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

                    {canConnect && (
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

      {/* ═══ 3. ADD CUSTOM PROVIDER ═══ */}
      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Plus className="w-5 h-5 text-cyan-400" />
            Add Custom Provider
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">verified on submit</span>
        </div>

        <div className="bg-[#0d0f16] border border-zinc-800 rounded-2xl p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="add-type" className="text-xs font-medium text-zinc-300 block mb-1.5">
                Provider type
              </label>
              <select
                id="add-type"
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="w-full min-h-[44px] bg-zinc-900 border border-zinc-800 rounded-lg px-3 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
              >
                {ADD_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="add-name" className="text-xs font-medium text-zinc-300 block mb-1.5">
                Display name <span className="text-rose-400">*</span>
              </label>
              <input
                id="add-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My GPU Workstation"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          {(showEndpointField || showTokenField) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {showEndpointField && (
                <div>
                  <label htmlFor="add-endpoint" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Endpoint URL{' '}
                    {formType === 'custom_probe' ? (
                      <span className="text-rose-400">*</span>
                    ) : (
                      <span className="text-zinc-500">(optional)</span>
                    )}
                  </label>
                  <input
                    id="add-endpoint"
                    type="url"
                    value={formEndpoint}
                    onChange={(e) => setFormEndpoint(e.target.value)}
                    placeholder={
                      formType === 'custom_probe' ? 'https://status.example.com/health' : 'https://api.runpod.io/v2'
                    }
                    className={`${INPUT_CLASS} font-mono`}
                  />
                </div>
              )}

              {showTokenField && (
                <div>
                  <label htmlFor="add-token" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    API token <span className="text-rose-400">*</span>
                  </label>
                  <input
                    id="add-token"
                    type="password"
                    value={formToken}
                    onChange={(e) => setFormToken(e.target.value)}
                    placeholder="verified against the real provider API"
                    autoComplete="off"
                    className={`${INPUT_CLASS} font-mono`}
                  />
                  {TOKEN_HINTS[formType] && (
                    <p className="text-[11px] text-zinc-500 mt-1.5 flex items-center gap-1 flex-wrap">
                      <span>Where to get it: {TOKEN_HINTS[formType]}</span>
                      {TOKEN_HINT_URLS[formType] && (
                        <a
                          href={TOKEN_HINT_URLS[formType]}
                          target="_blank"
                          rel="noreferrer"
                          className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5"
                        >
                          open <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {showCapacityFields && (
            <div>
              <span className="text-xs font-medium text-zinc-300 block mb-1.5">
                Capacity <span className="text-zinc-500">(optional — feeds the pool math until real telemetry arrives)</span>
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={formVCpu}
                  onChange={(e) => setFormVCpu(e.target.value)}
                  placeholder="vCPU"
                  aria-label="vCPU capacity"
                  className={INPUT_CLASS}
                />
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={formRamGb}
                  onChange={(e) => setFormRamGb(e.target.value)}
                  placeholder="RAM GB"
                  aria-label="RAM capacity in GB"
                  className={INPUT_CLASS}
                />
                <input
                  type="text"
                  value={formGpuModel}
                  onChange={(e) => setFormGpuModel(e.target.value)}
                  placeholder="GPU model"
                  aria-label="GPU model"
                  className={INPUT_CLASS}
                />
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={formVramGb}
                  onChange={(e) => setFormVramGb(e.target.value)}
                  placeholder="VRAM GB"
                  aria-label="VRAM capacity in GB"
                  className={INPUT_CLASS}
                />
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={formStorageGb}
                  onChange={(e) => setFormStorageGb(e.target.value)}
                  placeholder="Storage GB"
                  aria-label="Storage capacity in GB"
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="add-tags" className="text-xs font-medium text-zinc-300 block mb-1.5">
                Tags <span className="text-zinc-500">(comma separated)</span>
              </label>
              <input
                id="add-tags"
                type="text"
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="gpu, home-lab, eur"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="add-notes" className="text-xs font-medium text-zinc-300 block mb-1.5">
                Notes <span className="text-zinc-500">(optional)</span>
              </label>
              <textarea
                id="add-notes"
                rows={3}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="Anything worth remembering about this provider…"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500 resize-y"
              />
            </div>
          </div>

          {/* Inline result banners */}
          {addError && (
            <div className="p-3 rounded-xl text-xs flex items-start gap-2.5 bg-rose-950/50 border border-rose-800/80 text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span className="font-mono break-words">{addError}</span>
            </div>
          )}
          {addResult && <ResultBanner result={addResult} />}

          {/* Special success panel: custom agent install command */}
          {agentInfo && (
            <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-950/30 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                <Terminal className="w-4 h-4" />
                Agent install command — run this on your server
              </div>
              <div className="relative bg-zinc-950 border border-zinc-800 rounded-lg p-3 pr-16 font-mono text-[11px] text-emerald-300 break-all">
                <code className="nx-scroll block overflow-x-auto whitespace-nowrap">
                  {buildAgentCommand(agentInfo.token, agentInfo.name)}
                </code>
                <button
                  type="button"
                  onClick={handleCopyAgentCommand}
                  aria-label="Copy agent install command"
                  className="absolute top-1.5 right-1.5 w-11 h-11 flex items-center justify-center rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 transition"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                The agent reports real CPU / RAM / disk / GPU telemetry every 15s to{' '}
                <span className="font-mono text-zinc-400">/api/agent/heartbeat</span>. The node will appear under
                Custom Nodes below as soon as the first heartbeat lands.
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-zinc-800/80">
            <p className="text-[11px] text-zinc-500 max-w-xl">
              Added providers are verified immediately against the real provider API — the result (including measured
              latency) is shown here.
            </p>
            <button
              type="button"
              onClick={handleAddProvider}
              disabled={addBusy}
              className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-5 py-2.5 rounded-lg text-xs font-semibold bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50 transition shrink-0"
            >
              {addBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {addBusy ? 'Adding & verifying…' : 'Add & Verify Provider'}
            </button>
          </div>
        </div>
      </section>

      {/* ═══ 4. CUSTOM NODES ═══ */}
      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-cyan-400" />
            Custom Nodes
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">
            {nodesOnline}/{nodes.length} online
          </span>
        </div>

        {nodes.length === 0 ? (
          <div className="p-8 rounded-2xl bg-zinc-900/30 border border-dashed border-zinc-800 text-center space-y-2">
            <Server className="w-8 h-8 text-zinc-600 mx-auto" />
            <div className="text-sm font-medium text-zinc-300">No custom nodes connected yet</div>
            <p className="text-xs text-zinc-500 max-w-md mx-auto">
              Add your own VPS, dedicated server or home GPU workstation above — the agent install command gives you
              live telemetry within ~15 seconds.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-h-[620px] overflow-y-auto nx-scroll pr-1 -mr-1">
            {nodes.map((node) => {
              const st = NODE_STATUS[node.status] || NODE_STATUS.offline;
              const nodeBadgeType =
                node.connectionMethod === 'agent' ? 'custom_agent' : node.connectionMethod === 'probe_url' ? 'custom_probe' : 'manual';
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
                        <TypeBadge type={nodeBadgeType} />
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

                  {/* Live telemetry */}
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

                  {/* Capacity + heartbeat */}
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

      {/* ═══ 5. DANGER ZONE / INFO ═══ */}
      <section>
        <div className="rounded-2xl border border-rose-900/50 bg-gradient-to-br from-rose-950/10 via-[#0d0f16] to-[#0d0f16] p-6 relative overflow-hidden">
          <div className="flex flex-col lg:flex-row gap-6 lg:items-start justify-between relative z-10">
            <div className="space-y-3 max-w-2xl">
              <h3 className="text-sm font-bold text-rose-300 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4" />
                Danger Zone &amp; Data Guarantees
                <Info className="w-3.5 h-3.5 text-zinc-500" />
              </h3>
              <ul className="text-xs text-zinc-400 space-y-1.5 list-disc pl-4">
                <li>
                  Built-in free providers <span className="font-mono text-zinc-300">(local-node, huggingface, render,
                  fly, koyeb)</span> are permanent — they cannot be deleted, only disconnected &amp; reconnected.
                </li>
                <li>
                  API tokens are stored <span className="text-zinc-300">obfuscated at rest</span> and are never returned
                  in full by the API.
                </li>
                <li>
                  Every connect / test result is a <span className="text-zinc-300">real provider API response</span> —
                  measured latencies are listed on the right.
                </li>
                <li>
                  Deleting a custom node permanently removes its token and heartbeat history (confirm-guarded).
                </li>
              </ul>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-800 rounded-xl p-4 text-xs font-mono space-y-2 min-w-[260px] shrink-0">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                Measured verification latency
              </div>
              {latencyDisplay.length === 0 ? (
                <div className="text-zinc-500 text-[11px]">No verification runs yet — hit Test on any provider.</div>
              ) : (
                latencyDisplay.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-4">
                    <span className="text-zinc-400 truncate max-w-[180px]" title={row.label}>
                      {row.label}
                    </span>
                    <span className={row.ms < 100 ? 'text-emerald-400' : 'text-zinc-300'}>{row.ms}ms</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ═══ MODAL: CONNECT BUILT-IN PROVIDER (token verification) ═══ */}
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
                <label htmlFor="connect-token" className="text-xs font-medium text-zinc-300 block mb-1.5">
                  {connectTarget.type === 'huggingface' && 'Hugging Face Access Token (User Read/Write)'}
                  {connectTarget.type === 'render' && 'Render API Key'}
                  {connectTarget.type === 'fly' && 'Fly.io Personal Access Token (flyctl token)'}
                  {connectTarget.type === 'koyeb' && 'Koyeb API Token'}
                  {connectTarget.type === 'runpod' && 'RunPod API Key'}
                  {!['huggingface', 'render', 'fly', 'koyeb', 'runpod'].includes(connectTarget.type) &&
                    'API Token'}
                </label>
                <input
                  id="connect-token"
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
              </div>

              {connectTarget.type === 'custom_probe' && (
                <div>
                  <label htmlFor="connect-endpoint" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Endpoint URL <span className="text-rose-400">*</span>
                  </label>
                  <input
                    id="connect-endpoint"
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
                disabled={connectBusy || (connectTarget.type !== 'custom_probe' && !connectToken.trim())}
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50 transition"
              >
                {connectBusy ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  <>
                    <PlugZap className="w-3.5 h-3.5" />
                    Verify &amp; Connect
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
