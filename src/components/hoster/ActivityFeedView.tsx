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
} from 'lucide-react';
import { useLogs } from '@/hooks/useHoster';
import type { LogEntry } from '@/lib/hoster/types';

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
  'webhook-receiver': 'webhook',
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
      if (s === 'watchdog' || s === 'node-agent' || s === 'settings') return 'provider';
      if (s === 'app' || s === 'service-runner' || s === 'terminal-service') return 'service';
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
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-cyan-700 focus:outline-none text-xs font-mono text-zinc-200 placeholder:text-zinc-600 transition"
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
                    <span className="text-[10px] font-mono text-zinc-500 ml-auto" title={exactTime(l.timestamp)}>
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
