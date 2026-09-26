'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Radio,
  Pause,
  Play,
  Rocket,
  Layers,
  Server,
  Database,
  Globe,
  HardDrive,
  Cpu,
  AlertTriangle,
  XCircle,
  Info,
  Search,
  ChevronDown,
  Activity,
  Webhook,
  Gauge,
} from 'lucide-react';
import { useLogs, useRetentionConfig, useSaveRetentionConfig, useResetRetentionConfig, usePruneNow, type RetentionConfigPayload } from '@/hooks/useHoster';
import type { LogEntry } from '@/lib/hoster/types';
import { toast } from 'sonner';
import { Trash2, DatabaseZap, RefreshCw, Timer, Package, FileClock, TrendingUp, ShieldCheck, Settings2 } from 'lucide-react';

/** One REAL webhook delivery row (GitHub push / generic CI trigger). */
interface DeliveryRow {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  event: string;
  repo: string;
  branch: string;
  sender: string;
  commitSha: string;
  result: string;
  detail: string;
  createdAt: string;
}

/**
 * Global Activity & Events feed — a LIVE stream of everything the platform
 * actually did: real deploy pipelines (git clone → build → run), provider
 * watchdog transitions, DNS checks, database ops, volume provisioning.
 * Every row is a real LogEntry written by a real event — nothing simulated.
 */

const SCOPES = [
  { id: 'deploy', label: 'Deployments', icon: Rocket, color: 'text-cyan-400', dot: 'bg-cyan-400' },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook, color: 'text-fuchsia-400', dot: 'bg-fuchsia-400' },
  { id: 'provider', label: 'Providers', icon: Layers, color: 'text-violet-400', dot: 'bg-violet-400' },
  { id: 'service', label: 'Services', icon: Server, color: 'text-emerald-400', dot: 'bg-emerald-400' },
  { id: 'database', label: 'Databases', icon: Database, color: 'text-rose-400', dot: 'bg-rose-400' },
  { id: 'domain', label: 'Domains/DNS', icon: Globe, color: 'text-sky-400', dot: 'bg-sky-400' },
  { id: 'storage', label: 'Storage', icon: HardDrive, color: 'text-amber-400', dot: 'bg-amber-400' },
  { id: 'usage', label: 'Usage', icon: Gauge, color: 'text-teal-400', dot: 'bg-teal-400' },
  { id: 'system', label: 'System', icon: Cpu, color: 'text-zinc-400', dot: 'bg-zinc-400' },
] as const;

function relTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function exactTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const sourceLabels: Record<string, string> = {
  'git-deployer': 'git-deployer',
  app: 'app stdout',
  watchdog: 'watchdog',
  'node-agent': 'node-agent',
  'db-provisioner': 'db-provisioner',
  'volume-provisioner': 'volume-provisioner',
  'edge-dns': 'edge-dns',
  orchestrator: 'orchestrator',
  'build-runner': 'build-runner',
  'sql-console': 'sql-console',
  settings: 'settings',
  'nexus-platform': 'platform',
  'service-runner': 'service-runner',
  'terminal-service': 'terminal',
  exec: 'exec',
  'webhook-receiver': 'webhook',
  'usage-meter': 'usage-meter',
  'alert-webhook': 'alert-webhook',
  retention: 'retention',
};

export default function ActivityFeedView() {
  const [scopeFilter, setScopeFilter] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const logsQ = useLogs({ limit: 150, refetchMs: paused ? false : 5000 });
  const logs: LogEntry[] = logsQ.data ?? [];

  // REAL webhook deliveries (GitHub push / generic CI) — merged into the
  // global timeline so pushes that triggered real redeploys are visible here.
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/webhooks/deliveries?limit=60', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as { data?: DeliveryRow[] };
          if (alive) setDeliveries(Array.isArray(json.data) ? json.data : []);
        }
      } catch {
        /* deliveries are best-effort */
      }
    };
    void load();
    if (paused) return () => { alive = false; };
    const t = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(t); };
  }, [paused]);

  const webhookRows: LogEntry[] = useMemo(
    () =>
      deliveries.map((d) => ({
        id: `wh-${d.id}`,
        serviceId: d.serviceId ?? null,
        level: (d.result === 'rejected' ? 'error' : d.result === 'skipped' ? 'warn' : 'info') as LogEntry['level'],
        message: `push ${d.repo || '(unknown repo)'}@${d.branch || '-'} by ${d.sender || 'unknown'}${d.commitSha ? ` (${d.commitSha.slice(0, 7)})` : ''} → ${d.result.toUpperCase()}${d.detail ? `: ${d.detail}` : ''}`,
        source: 'webhook-receiver',
        timestamp: d.createdAt,
      })),
    [deliveries]
  );

  const allRows = useMemo(
    () => [...logs, ...webhookRows].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [logs, webhookRows]
  );

  const filtered = useMemo(() => {
    // scope lives on the API row; LogEntry type doesn't carry it — derive from source
    const scopeOf = (l: LogEntry): string => {
      const s = l.source ?? 'nexus-platform';
      if (s === 'git-deployer' || s === 'build-runner' || s === 'orchestrator') return 'deploy';
      if (s === 'webhook-receiver') return 'webhooks';
      if (s === 'usage-meter' || s === 'alert-webhook') return 'usage';
      if (s === 'watchdog' || s === 'node-agent' || s === 'settings') return 'provider';
      if (s === 'app' || s === 'service-runner' || s === 'terminal-service' || s === 'exec') return 'service';
      if (s === 'db-provisioner' || s === 'sql-console') return 'database';
      if (s === 'edge-dns') return 'domain';
      if (s === 'volume-provisioner') return 'storage';
      return 'system';
    };
    let rows = allRows;
    if (scopeFilter) rows = rows.filter((l) => scopeOf(l) === scopeFilter);
    if (levelFilter !== 'all') rows = rows.filter((l) => l.level === levelFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((l) => l.message.toLowerCase().includes(q) || (l.source ?? '').toLowerCase().includes(q));
    }
    return rows;
  }, [allRows, scopeFilter, levelFilter, search]);

  const recentCount = useMemo(
    () => allRows.filter((l) => Date.now() - new Date(l.timestamp).getTime() < 5 * 60_000).length,
    [allRows]
  );
  const errorCount = useMemo(() => allRows.filter((l) => l.level === 'error').length, [allRows]);
  const warnCount = useMemo(() => allRows.filter((l) => l.level === 'warn').length, [allRows]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2.5">
            <span className="p-1.5 rounded-lg bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <Activity className="w-5 h-5" />
            </span>
            Activity &amp; Events
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 font-mono">
            The real platform event stream — every entry was written by an actual deploy, probe, DNS check or console op
          </p>
        </div>
        <button
          onClick={() => setPaused((p) => !p)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-mono transition min-h-[44px] ${
            paused
              ? 'bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-800 text-emerald-300'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'
          }`}
          aria-pressed={paused}
        >
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {paused ? 'Resume stream' : 'Pause stream'}
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        {[
          { label: 'events (buffer)', value: allRows.length, accent: 'text-zinc-100' },
          { label: 'last 5 min', value: recentCount, accent: 'text-cyan-300' },
          { label: 'webhook pushes', value: webhookRows.length, accent: 'text-fuchsia-300' },
          { label: 'warnings', value: warnCount, accent: 'text-amber-300' },
          { label: 'errors', value: errorCount, accent: 'text-red-400' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
            <div className={`text-lg font-bold font-mono ${s.accent}`}>{s.value}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Scope filters">
          <button
            onClick={() => setScopeFilter(null)}
            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono border transition ${
              scopeFilter === null
                ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            All scopes
          </button>
          {SCOPES.map((s) => {
            const Icon = s.icon;
            const active = scopeFilter === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setScopeFilter(active ? null : s.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-mono border transition ${
                  active ? `${s.color} bg-zinc-800 border-zinc-600` : 'text-zinc-400 bg-zinc-900/60 border-zinc-800 hover:text-zinc-200'
                }`}
                aria-pressed={active}
              >
                <Icon className="w-3.5 h-3.5" />
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 lg:ml-auto">
          <div className="relative flex-1 lg:w-64">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter messages…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-cyan-700 focus:outline-none text-xs font-mono text-zinc-200 placeholder:text-zinc-500 transition"
              aria-label="Filter log messages"
            />
          </div>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as typeof levelFilter)}
            className="px-2.5 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-300 focus:outline-none focus:border-cyan-700"
            aria-label="Level filter"
          >
            <option value="all">all levels</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </div>
      </div>

      {/* Data retention policy card — real DB growth made visible + editable */}
      <RetentionCard />

      {/* Live indicator */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-500">
        {paused ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
            stream paused — showing the last snapshot
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <Radio className="w-3 h-3" />
              live
            </span>
            polling every 5s
          </>
        )}
      </div>

      {/* Feed */}
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
        <div className="max-h-[62vh] overflow-y-auto" role="feed" aria-label="Platform activity log">
          {filtered.length === 0 && (
            <div className="p-10 text-center">
              <p className="text-xs text-zinc-500 font-mono">No events match the current filters.</p>
            </div>
          )}
          {filtered.map((l) => {
            const isExpanded = expanded === l.id;
            const isLong = l.message.length > 160;
            const scope = (() => {
              const s = l.source ?? 'nexus-platform';
              if (s === 'git-deployer' || s === 'build-runner' || s === 'orchestrator') return 'deploy';
              if (s === 'webhook-receiver') return 'webhooks';
              if (s === 'usage-meter' || s === 'alert-webhook') return 'usage';
              if (s === 'watchdog' || s === 'node-agent' || s === 'settings') return 'provider';
              if (s === 'app' || s === 'service-runner' || s === 'terminal-service') return 'service';
              if (s === 'db-provisioner' || s === 'sql-console') return 'database';
              if (s === 'edge-dns') return 'domain';
              if (s === 'volume-provisioner') return 'storage';
              return 'system';
            })();
            const scopeMeta = SCOPES.find((s) => s.id === scope) ?? SCOPES[SCOPES.length - 1];
            const LevelIcon = l.level === 'error' ? XCircle : l.level === 'warn' ? AlertTriangle : Info;
            const levelColor =
              l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : 'text-zinc-500';

            return (
              <button
                key={l.id}
                onClick={() => isLong && setExpanded(isExpanded ? null : l.id)}
                className={`w-full text-left flex gap-3 px-4 py-3 border-b border-zinc-800/60 last:border-b-0 transition hover:bg-zinc-900/70 ${isLong ? 'cursor-pointer' : 'cursor-default'}`}
                aria-expanded={isExpanded}
              >
                {/* timeline rail */}
                <div className="flex flex-col items-center flex-none pt-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${scopeMeta.dot} ${l.level === 'error' ? 'ring-2 ring-red-900/60' : ''}`} />
                  <span className="w-px flex-1 bg-zinc-800/70 mt-1" />
                </div>

                {/* body */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-900 ${scopeMeta.color}`}>
                      {scopeMeta.label}
                    </span>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${levelColor}`}>
                      <LevelIcon className="w-3 h-3" />
                      {l.level}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-600">{sourceLabels[l.source ?? ''] ?? l.source ?? 'platform'}</span>
                    <span
                      className="text-[10px] font-mono text-zinc-500 ml-auto shrink-0 pl-2 border-l border-zinc-800/60 whitespace-nowrap"
                      title={exactTime(l.timestamp)}
                    >
                      {relTime(l.timestamp)}
                    </span>
                  </div>
                  <p
                    className={`mt-1 text-xs font-mono leading-relaxed break-words ${
                      l.level === 'error' ? 'text-red-300' : l.level === 'warn' ? 'text-amber-200/90' : 'text-zinc-300'
                    }`}
                  >
                    {isExpanded || !isLong ? l.message : `${l.message.slice(0, 160)}…`}
                  </p>
                  {isLong && !isExpanded && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-600 mt-1">
                      <ChevronDown className="w-3 h-3" /> click to expand full entry
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[10px] text-zinc-600 font-mono">
        Entries persist in the control-plane database — the same stream powers the per-service log terminals.
      </p>
    </div>
  );
}

// ─── Data retention policy card (real DB growth, editable pruning policy) ────

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(0, Math.round(h * 60))}min`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtIn(ms: number | null): string {
  if (ms == null) return 'off';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1min';
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function RetentionCard() {
  const cfgQ = useRetentionConfig();
  const prune = usePruneNow();
  const [editing, setEditing] = useState(false);

  const payload: RetentionConfigPayload | undefined = cfgQ.data;
  const config = payload?.config;
  const stats = payload?.stats;
  const source = payload?.source ?? 'default';

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
      {/* header */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="p-1.5 rounded-lg bg-rose-950/60 border border-rose-900/60 text-rose-400 shrink-0">
          <DatabaseZap className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            Data retention
            <span
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                source === 'db'
                  ? 'border-cyan-800/70 bg-cyan-950/50 text-cyan-400'
                  : source === 'env'
                    ? 'border-amber-800/70 bg-amber-950/50 text-amber-400'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
              }`}
              title={
                source === 'db'
                  ? 'operator-configured (DB row)'
                  : source === 'env'
                    ? 'from NX_RETENTION_* environment variables'
                    : 'platform defaults'
              }
            >
              {source === 'db' ? 'custom config' : source === 'env' ? 'env config' : 'defaults'}
            </span>
          </h2>
          <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
            {config ? (
              <>
                log rows &gt; <span className="text-zinc-300">{config.logRetentionDays}d</span> deleted ·
                webhook deliveries &gt; <span className="text-zinc-300">{config.webhookDeliveryRetentionDays}d</span> ·
                auto-prune {config.autoPrune ? <span className="text-emerald-400">on</span> : <span className="text-zinc-500">off</span>}
                {config.autoPrune && <> every <span className="text-zinc-300">{config.pruneIntervalMin}min</span></>}
              </>
            ) : (
              'loading policy…'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() =>
              prune.mutate(undefined, {
                onSuccess: (r) =>
                  toast.success(
                    `Pruned ${fmtCount(r.result.logsPruned)} log rows + ${fmtCount(r.result.deliveriesPruned)} deliveries in ${r.result.ms}ms — receipt in the feed`
                  ),
                onError: (err: Error) => toast.error(`Prune failed: ${err.message}`),
              })
            }
            disabled={prune.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition disabled:opacity-50 min-h-[36px]"
          >
            {prune.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Prune now
          </button>
          <button
            onClick={() => setEditing((e) => !e)}
            aria-expanded={editing}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono border transition min-h-[36px] ${
              editing
                ? 'bg-cyan-950/60 border-cyan-800 text-cyan-300'
                : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            {editing ? 'Close' : 'Configure'}
          </button>
        </div>
      </div>

      {/* live stats strip — every number measured from the real DB */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-px bg-zinc-800/40 border-t border-zinc-800/60">
          {[
            {
              label: 'log rows',
              value: fmtCount(stats.logEntryCount),
              icon: <Package className="w-3 h-3 text-zinc-400" />,
              title: 'total LogEntry rows in the control-plane DB',
            },
            {
              label: 'webhook rows',
              value: fmtCount(stats.webhookDeliveryCount),
              icon: <Webhook className="w-3 h-3 text-fuchsia-400" />,
              title: 'total WebhookDelivery rows (GitHub push receipts)',
            },
            {
              label: 'oldest row',
              value: fmtAge(stats.oldestLogAt),
              icon: <FileClock className="w-3 h-3 text-amber-400" />,
              title: stats.oldestLogAt ? `oldest LogEntry written ${new Date(stats.oldestLogAt).toLocaleString()}` : 'no rows',
            },
            {
              label: 'growth /day',
              value: `~${fmtCount(stats.estRowsPerDay)}`,
              icon: <TrendingUp className="w-3 h-3 text-cyan-400" />,
              title: 'rows written in the last 24h (real rate)',
            },
            {
              label: 'db file',
              value: `${stats.dbFileMb}MB`,
              icon: <DatabaseZap className="w-3 h-3 text-rose-400" />,
              title: 'control-plane SQLite file size on disk',
            },
            {
              label: 'next auto-prune',
              value: fmtIn(stats.nextAutoPruneInMs),
              icon: <Timer className="w-3 h-3 text-emerald-400" />,
              title: stats.lastPrune
                ? `last pruned ${fmtAge(stats.lastPrune.at)} ago (${fmtCount(stats.lastPrune.logsPruned)} rows)`
                : 'no prune since restart',
            },
          ].map((s) => (
            <div key={s.label} className="bg-zinc-900/60 px-3.5 py-2.5" title={s.title}>
              <div className="text-sm font-bold font-mono text-zinc-100 tabular-nums flex items-center gap-1.5">
                {s.icon}
                {s.value}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-mono mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* editor */}
      {editing && config && <RetentionEditor key={JSON.stringify(config)} config={config} />}
    </div>
  );
}

function RetentionEditor({ config }: { config: RetentionConfigPayload['config'] }) {
  const save = useSaveRetentionConfig();
  const reset = useResetRetentionConfig();

  const [logDays, setLogDays] = useState(String(config.logRetentionDays));
  const [whDays, setWhDays] = useState(String(config.webhookDeliveryRetentionDays));
  const [intervalMin, setIntervalMin] = useState(String(config.pruneIntervalMin));
  const [autoPrune, setAutoPrune] = useState(config.autoPrune);

  const handleSave = () => {
    save.mutate(
      {
        logRetentionDays: Number(logDays),
        webhookDeliveryRetentionDays: Number(whDays),
        pruneIntervalMin: Number(intervalMin),
        autoPrune,
      },
      {
        onSuccess: () => toast.success('Retention policy saved — the sampler applies it on the next window'),
        onError: (err: Error) => toast.error(`Save failed: ${err.message}`),
      }
    );
  };

  const handleReset = () => {
    reset.mutate(undefined, {
      onSuccess: () => toast.success('Retention policy reset — env/defaults take over'),
      onError: (err: Error) => toast.error(`Reset failed: ${err.message}`),
    });
  };

  const inputCls =
    'w-full px-2.5 py-1.5 rounded-lg bg-zinc-950/70 border border-zinc-800 text-zinc-200 text-xs font-mono focus:outline-none focus:border-cyan-700/70 focus:ring-1 focus:ring-cyan-800/40 transition placeholder:text-zinc-500';
  const labelCls = 'text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5';

  return (
    <div className="px-4 py-4 border-t border-zinc-800/60 bg-zinc-950/40 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <div>
          <label className={labelCls} htmlFor="ret-log-days">
            <FileClock className="w-3 h-3 text-amber-400" /> log retention
          </label>
          <input
            id="ret-log-days"
            className={inputCls}
            value={logDays}
            onChange={(e) => setLogDays(e.target.value)}
            inputMode="numeric"
            placeholder="7"
          />
          <p className="text-[9px] text-zinc-600 font-mono mt-1">days · LogEntry rows older than this are deleted (1–365)</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="ret-wh-days">
            <Webhook className="w-3 h-3 text-fuchsia-400" /> webhook deliveries
          </label>
          <input
            id="ret-wh-days"
            className={inputCls}
            value={whDays}
            onChange={(e) => setWhDays(e.target.value)}
            inputMode="numeric"
            placeholder="30"
          />
          <p className="text-[9px] text-zinc-600 font-mono mt-1">days · GitHub push receipts retention (1–365)</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="ret-interval">
            <Timer className="w-3 h-3 text-emerald-400" /> prune interval
          </label>
          <input
            id="ret-interval"
            className={inputCls}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
            inputMode="numeric"
            placeholder="10"
          />
          <p className="text-[9px] text-zinc-600 font-mono mt-1">minutes between auto-prune passes (1–1440)</p>
        </div>
      </div>

      {/* auto-prune toggle */}
      <button
        onClick={() => setAutoPrune((v) => !v)}
        aria-pressed={autoPrune}
        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border text-left transition ${
          autoPrune ? 'border-emerald-800/60 bg-emerald-950/30' : 'border-zinc-800 bg-zinc-900/50'
        }`}
      >
        <span
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition ${autoPrune ? 'bg-emerald-600' : 'bg-zinc-700'}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${autoPrune ? 'left-[18px]' : 'left-0.5'}`}
          />
        </span>
        <span className="min-w-0">
          <span className={`block text-xs font-mono ${autoPrune ? 'text-emerald-300' : 'text-zinc-300'}`}>
            automatic pruning {autoPrune ? 'enabled' : 'disabled'}
          </span>
          <span className="block text-[9px] font-mono text-zinc-600 mt-0.5">
            the 15s host sampler runs one real prune pass per interval — only rows past the cutoffs are deleted
          </span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <button
          onClick={handleSave}
          disabled={save.isPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono bg-cyan-600 hover:bg-cyan-500 text-white transition disabled:opacity-50 min-h-[38px]"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
        <button
          onClick={handleReset}
          disabled={reset.isPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition disabled:opacity-50 min-h-[38px]"
        >
          {reset.isPending ? 'Resetting…' : 'Reset to defaults'}
        </button>
        {save.isError && <span className="text-[10px] font-mono text-red-400">{(save.error as Error).message}</span>}
      </div>

      <p className="text-[9px] text-zinc-600 font-mono leading-relaxed border-t border-zinc-800/50 pt-3">
        priority: DB row → env (<span className="text-zinc-400">NX_RETENTION_LOG_DAYS</span>,{' '}
        <span className="text-zinc-400">NX_RETENTION_WEBHOOK_DAYS</span>,{' '}
        <span className="text-zinc-400">NX_RETENTION_PRUNE_INTERVAL_MIN</span>,{' '}
        <span className="text-zinc-400">NX_RETENTION_AUTO_PRUNE=0</span>) → defaults (7d logs / 30d deliveries / 10min).
        Every prune pass that deletes rows writes a receipt into this very feed (source: retention) — the policy proves
        itself in the stream it governs.
      </p>
    </div>
  );
}
