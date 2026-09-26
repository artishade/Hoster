'use client';

/**
 * UsageView — REAL usage metering, budget alerts & the "what you'd pay
 * elsewhere" meter.
 *
 * All numbers are measured: instance-hours = uptime × live instance count
 * (banked by the 15s sampler), requests = every proxied ingress request,
 * egress = response bytes when content-length is known. The equivalent-cost
 * figure multiplies this REAL usage by public cloud list prices — the
 * platform itself bills $0.00 (free tier), shown side by side.
 *
 * The alerts card surfaces the usage-meter's REAL LogEntry warnings
 * (thresholds crossed today), and the projection card is autoscale-aware:
 * live instance counts × tier rates × 720h, at the current footprint AND
 * at each service's configured autoscaler max.
 */

import React, { useEffect, useState } from 'react';
import { useUsage } from '@/hooks/useHoster';
import {
  Receipt,
  Clock3,
  ArrowUpDown,
  Globe,
  Wallet,
  Info,
  Loader2,
  Server,
  TrendingUp,
  BellRing,
  Scale,
  Gauge,
  AlertTriangle,
  XCircle,
  CheckCircle2,
} from 'lucide-react';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-400',
  building: 'bg-amber-400 animate-pulse',
  deploying: 'bg-amber-400 animate-pulse',
  failed: 'bg-red-400',
  stopped: 'bg-zinc-500',
};

function fmtHours(h: number): string {
  if (h >= 100) return h.toFixed(0);
  if (h >= 10) return h.toFixed(1);
  return h.toFixed(2);
}

function fmtUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(mb * 1024).toFixed(0)} KB`;
}

function relTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

interface AlertRow {
  id: string;
  level: string;
  message: string;
  timestamp: string; // serialized LogEntry field (ISO string)
}

export default function UsageView() {
  const [days, setDays] = useState(30);
  const usageQ = useUsage(days);
  const report = usageQ.data;

  // REAL usage alert rows (scope 'usage' — written by the usage-meter)
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/logs?scope=usage&limit=12', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as { data?: AlertRow[] };
          if (alive && Array.isArray(json.data)) setAlerts(json.data);
        }
      } catch {
        /* best-effort */
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-full">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2.5">
            <Receipt className="w-5 h-5 text-cyan-400" />
            Usage & Spend Metering
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 max-w-2xl leading-relaxed">
            Real metered usage — instance-hours from live processes, every proxied request, measured egress — with a
            transparent <span className="text-zinc-200">equivalent-cost</span> comparison at public cloud list prices. The
            platform itself bills <span className="text-emerald-300 font-semibold">$0.00</span>: every tier is free.
          </p>
        </div>
        <div className="flex items-center gap-1.5 p-1 rounded-lg border border-zinc-800 bg-zinc-900/70 text-[11px] font-mono">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded-md transition ${
                days === d ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/60' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              aria-pressed={days === d}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {usageQ.isLoading && !report && (
        <div className="flex items-center justify-center gap-2 py-16 text-zinc-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> measuring real usage…
        </div>
      )}

      {usageQ.isError && (
        <div className="p-4 rounded-xl border border-red-900/50 bg-red-950/20 text-xs text-red-300 font-mono">
          failed to load usage report: {(usageQ.error as Error).message}
        </div>
      )}

      {report && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider flex items-center gap-1.5">
                <Clock3 className="w-3.5 h-3.5 text-cyan-400" /> instance-hours
              </span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1.5 tabular-nums">{fmtHours(report.global.instanceHours)}</div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">
                real uptime × live instances · last {report.windowDays}d
                {report.global.liveInstances > 0 && (
                  <span className="text-emerald-400/90"> · {report.global.liveInstances} live now</span>
                )}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider flex items-center gap-1.5">
                <ArrowUpDown className="w-3.5 h-3.5 text-violet-400" /> proxied requests
              </span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1.5 tabular-nums">
                {report.global.requests.toLocaleString()}
                {report.global.unflushedRequests > 0 && (
                  <span className="text-[11px] text-cyan-400/90 ml-1.5">+{report.global.unflushedRequests} live</span>
                )}
              </div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">every request through the edge ingress</p>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-emerald-400" /> egress
              </span>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1.5 tabular-nums">{fmtMb(report.global.egressMb)}</div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">measured response bytes (content-length known)</p>
            </div>
            <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-950/40 to-zinc-900/60 border border-emerald-800/40">
              <span className="text-[10px] text-emerald-400/90 font-mono uppercase tracking-wider flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5" /> your bill
              </span>
              <div className="text-2xl font-bold font-mono text-emerald-300 mt-1.5 tabular-nums">$0.00</div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1.5">
                equivalent elsewhere: <span className="text-zinc-300">{fmtUsd(report.global.equivalentCostUsd)}</span> at list prices
              </p>
            </div>
          </div>

          {/* Usage alerts — REAL LogEntry rows from the usage-meter */}
          <UsageAlertsCard alerts={alerts} todayRunRate={report.today} />

          {/* 30-day chart */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-cyan-400" />
                Daily usage — last {report.windowDays} days
              </h3>
              <span className="text-[10px] font-mono text-zinc-600">bars: instance-hours · line: requests</span>
            </div>
            <div className="overflow-x-auto custom-scrollbar -mx-1 px-1">
              <div className="min-w-[560px]">
                <DailyUsageChart perDay={report.perDay} />
              </div>
            </div>
          </div>

          {/* Autoscale-aware cost projection */}
          <ProjectionCard projection={report.projection} today={report.today} />

          {/* Per-service table */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80 bg-zinc-950/60">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Server className="w-4 h-4 text-cyan-400" />
                Per-service metering
              </h3>
              <span className="text-[10px] font-mono text-zinc-600">{report.perService.length} services</span>
            </div>
            {report.perService.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-zinc-500 font-mono">
                no usage recorded yet — deploy a service to start metering
              </div>
            ) : (
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800/80 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                      <th className="text-left font-medium px-4 py-2.5">service</th>
                      <th className="text-left font-medium px-3 py-2.5">tier</th>
                      <th className="text-right font-medium px-3 py-2.5">instance-hrs</th>
                      <th className="text-right font-medium px-3 py-2.5">requests</th>
                      <th className="text-right font-medium px-3 py-2.5">egress</th>
                      <th className="text-right font-medium px-3 py-2.5">rate/hr</th>
                      <th className="text-right font-medium px-4 py-2.5">equiv. cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {report.perService.map((s) => (
                      <tr key={s.serviceId} className="hover:bg-zinc-900/60 transition">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status] ?? 'bg-zinc-600'}`} />
                            <span className="font-mono text-zinc-200">{s.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-zinc-500">{s.tier}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-200 tabular-nums">{fmtHours(s.instanceHours)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-300 tabular-nums">{s.requests.toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-400 tabular-nums">{fmtMb(s.egressMb)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-zinc-500 tabular-nums">${s.ratePerHourUsd.toFixed(4)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="font-mono text-zinc-300 tabular-nums">{fmtUsd(s.equivalentCostUsd)}</span>
                          <span className="text-emerald-400 text-[10px] ml-1.5">→ $0.00</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Methodology */}
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4 flex items-start gap-3">
            <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-zinc-400 leading-relaxed space-y-1.5">
              <p>
                <span className="text-zinc-200 font-semibold">How the meter works.</span> The host sampler banks 15s of
                uptime per live instance (primary + scale-out workers) for every running service; the ingress proxy
                accumulates each request and its measured response bytes; both flush into a daily{' '}
                <code className="text-cyan-300/90 bg-cyan-950/30 px-1 rounded text-[10px]">UsageDaily</code> row.
              </p>
              <p>
                <span className="text-zinc-200 font-semibold">Equivalent-cost formula:</span>{' '}
                <code className="text-cyan-300/90 bg-cyan-950/30 px-1 rounded text-[10px]">{report.rates.formula}</code>{' '}
                — the ballpark of shared-CPU cloud VM list prices (Fly.io / Render / Koyeb class).{' '}
                {report.rates.note}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── usage alerts card ────────────────────────────────────────────────────────

function UsageAlertsCard({
  alerts,
  todayRunRate,
}: {
  alerts: AlertRow[];
  todayRunRate: { day: string; equivalentUsd: number; hoursElapsed: number; runRateUsdPerDay: number };
}) {
  const todayAlerts = alerts.filter((a) => (a.timestamp ?? '').slice(0, 10) === todayRunRate.day);
  const warnCount = todayAlerts.filter((a) => a.level === 'warn' || a.level === 'error').length;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80 bg-zinc-950/60 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <BellRing className={`w-4 h-4 ${warnCount > 0 ? 'text-amber-400 animate-pulse' : 'text-teal-400'}`} />
          Usage alerts — budget warnings
          {todayAlerts.length > 0 && (
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
              warnCount > 0
                ? 'bg-amber-950/50 border-amber-800/60 text-amber-300'
                : 'bg-teal-950/50 border-teal-800/60 text-teal-300'
            }`}>
              {todayAlerts.length} today{warnCount > 0 ? ` · ${warnCount} warn+` : ''}
            </span>
          )}
        </h3>
        <span className="text-[10px] font-mono text-zinc-600">real LogEntry rows from the usage-meter · 10s poll</span>
      </div>

      {/* threshold ladder */}
      <div className="px-4 py-2.5 border-b border-zinc-800/60 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] font-mono text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Gauge className="w-3 h-3 text-teal-400" />
          instance-hours: <span className="text-zinc-300">2h · 6h · 12h</span> /day
        </span>
        <span className="flex items-center gap-1.5">
          <Wallet className="w-3 h-3 text-amber-400" />
          equiv. cost: <span className="text-zinc-300">$0.10 · $0.50 · $2.00</span> /day
        </span>
        <span className="flex items-center gap-1.5">
          <Scale className="w-3 h-3 text-rose-400" />
          platform budget: <span className="text-zinc-300">$1.00</span> /day
        </span>
      </div>

      {todayAlerts.length === 0 ? (
        <div className="px-4 py-5 flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-500/80 shrink-0 mt-0.5" />
          <div className="text-[11px] text-zinc-500 font-mono leading-relaxed">
            no thresholds crossed today — today so far:{' '}
            <span className="text-zinc-300">{fmtUsd(todayRunRate.equivalentUsd)}</span> equivalent over{' '}
            <span className="text-zinc-300">{todayRunRate.hoursElapsed}h</span> elapsed
            {todayRunRate.runRateUsdPerDay > 0 && (
              <> · run-rate <span className="text-zinc-300">{fmtUsd(todayRunRate.runRateUsdPerDay)}/day</span></>
            )}
          </div>
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto custom-scrollbar divide-y divide-zinc-800/40">
          {todayAlerts.map((a) => {
            const isErr = a.level === 'error';
            const isWarn = a.level === 'warn';
            return (
              <div key={a.id} className="px-4 py-2.5 flex items-start gap-2.5 hover:bg-zinc-900/50 transition">
                {isErr ? (
                  <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                ) : isWarn ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                ) : (
                  <Gauge className="w-3.5 h-3.5 text-teal-400 shrink-0 mt-0.5" />
                )}
                <p className="text-[11px] font-mono text-zinc-300 leading-relaxed flex-1 min-w-0 break-words">
                  {a.message}
                </p>
                <span className="text-[10px] font-mono text-zinc-600 shrink-0 whitespace-nowrap mt-0.5">{relTime(a.timestamp)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── autoscale-aware cost projection card ─────────────────────────────────────

function ProjectionCard({
  projection,
  today,
}: {
  projection: {
    hoursPerMonth: number;
    globalCurrentUsd: number;
    globalMaxUsd: number;
    perService: {
      serviceId: string;
      name: string;
      status: string;
      tier: string;
      ratePerHourUsd: number;
      currentInstances: number;
      maxInstances: number;
      autoscaleCapable: boolean;
      projectedCurrentUsd: number;
      projectedMaxUsd: number;
    }[];
  };
  today: { runRateUsdPerDay: number; equivalentUsd: number; hoursElapsed: number };
}) {
  const scalable = projection.perService.filter((p) => p.autoscaleCapable);
  const maxBar = Math.max(0.01, ...projection.perService.map((p) => p.projectedMaxUsd));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80 bg-zinc-950/60 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Scale className="w-4 h-4 text-amber-400" />
          Cost projection — next 30 days ({projection.hoursPerMonth}h)
        </h3>
        <span className="text-[10px] font-mono text-zinc-600">
          autoscale-aware · live instances × tier rate × 720h
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-zinc-800/60">
        <div className="bg-zinc-900/60 px-4 py-3.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono flex items-center gap-1.5">
            <Server className="w-3 h-3 text-cyan-400" /> at current footprint
          </div>
          <div className="text-xl font-bold font-mono text-zinc-100 mt-1 tabular-nums">
            {fmtUsd(projection.globalCurrentUsd)}
          </div>
          <p className="text-[10px] text-zinc-500 font-mono mt-1">live instances only · you pay $0.00</p>
        </div>
        <div className="bg-zinc-900/60 px-4 py-3.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono flex items-center gap-1.5">
            <Scale className="w-3 h-3 text-amber-400" /> at autoscaler max
          </div>
          <div className="text-xl font-bold font-mono text-amber-200 mt-1 tabular-nums">
            {fmtUsd(projection.globalMaxUsd)}
          </div>
          <p className="text-[10px] text-zinc-500 font-mono mt-1">
            all services pinned at configured max instances
          </p>
        </div>
        <div className="bg-zinc-900/60 px-4 py-3.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono flex items-center gap-1.5">
            <TrendingUp className="w-3 h-3 text-emerald-400" /> today's run-rate
          </div>
          <div className="text-xl font-bold font-mono text-zinc-100 mt-1 tabular-nums">
            {fmtUsd(today.runRateUsdPerDay)}
            <span className="text-xs text-zinc-500 font-normal">/day</span>
          </div>
          <p className="text-[10px] text-zinc-500 font-mono mt-1">
            {fmtUsd(today.equivalentUsd)} metered over {today.hoursElapsed}h elapsed → 30d ≈ {fmtUsd(today.runRateUsdPerDay * 30)}
          </p>
        </div>
      </div>

      {projection.perService.length > 0 && (
        <div className="max-h-72 overflow-y-auto custom-scrollbar divide-y divide-zinc-800/40">
          {projection.perService.slice(0, 8).map((p) => (
            <div key={p.serviceId} className="px-4 py-2.5 flex items-center gap-3">
              <div className="flex items-center gap-2 w-40 sm:w-48 shrink-0 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[p.status] ?? 'bg-zinc-600'}`} />
                <span className="font-mono text-[11px] text-zinc-300 truncate">{p.name}</span>
              </div>

              {/* dual bar: current (cyan) within max (amber outline) */}
              <div className="flex-1 min-w-0 h-4 relative rounded bg-zinc-950/70 border border-zinc-800/60 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-amber-500/15 border-r border-amber-700/40"
                  style={{ width: `${Math.max(2, (p.projectedMaxUsd / maxBar) * 100)}%` }}
                  title={`at max: ${fmtUsd(p.projectedMaxUsd)} (${p.maxInstances} instances)`}
                />
                <div
                  className="absolute inset-y-0 left-0 bg-cyan-600/60"
                  style={{ width: `${Math.max(1, (p.projectedCurrentUsd / maxBar) * 100)}%` }}
                  title={`at current: ${fmtUsd(p.projectedCurrentUsd)} (${p.currentInstances} live)`}
                />
                <span className="absolute inset-y-0 right-2 flex items-center text-[10px] font-mono text-zinc-400 tabular-nums pointer-events-none">
                  {fmtUsd(p.projectedCurrentUsd)} → {fmtUsd(p.projectedMaxUsd)}
                </span>
              </div>

              <div className="hidden sm:flex items-center gap-2 shrink-0">
                <span className="font-mono text-[10px] text-zinc-500 tabular-nums">
                  {p.currentInstances}/{p.maxInstances} inst
                </span>
                {p.autoscaleCapable ? (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-950/50 border border-amber-800/60 text-amber-300">
                    scales ×{p.maxInstances}
                  </span>
                ) : (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-500">
                    fixed
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-2.5 border-t border-zinc-800/60 flex items-start gap-2">
        <Info className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
        <p className="text-[10px] text-zinc-500 font-mono leading-relaxed">
          {scalable.length > 0
            ? `${scalable.length} service${scalable.length === 1 ? '' : 's'} autoscale-enabled: workers multiply instance-hours, so the max-scale column is the worst-case what-you'd-pay-elsewhere. `
            : 'no autoscale-enabled services yet — set max instances > 1 on a service to see the scaled projection. '}
          every tier bills $0.00 on this platform — projections are the equivalent-cloud-cost comparison only.
        </p>
      </div>
    </div>
  );
}

// ─── lightweight dual-axis chart (bars: instance-hours, line: requests) ───────

function DailyUsageChart({
  perDay,
}: {
  perDay: { day: string; instanceHours: number; requests: number; egressMb: number; equivalentCostUsd: number }[];
}) {
  const W = 760;
  const H = 190;
  const PAD = { l: 40, r: 40, t: 18, b: 20 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const maxHours = Math.max(0.1, ...perDay.map((d) => d.instanceHours));
  const maxReq = Math.max(1, ...perDay.map((d) => d.requests));
  const n = Math.max(1, perDay.length);
  const barW = Math.max(1.5, (innerW / n) * 0.55);

  const reqPath = perDay
    .map((d, i) => {
      const x = PAD.l + (innerW / n) * (i + 0.5);
      const y = PAD.t + innerH - (d.requests / maxReq) * innerH;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const labelEvery = Math.ceil(n / 10);
  const lastDay = perDay[perDay.length - 1]?.day;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[190px]" role="img" aria-label="Daily instance-hours and requests chart">
        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PAD.l}
            x2={W - PAD.r}
            y1={PAD.t + innerH * f}
            y2={PAD.t + innerH * f}
            stroke="#27272a"
            strokeWidth="0.6"
            strokeDasharray={f === 1 ? '' : '2 3'}
          />
        ))}
        {/* bars: instance-hours */}
        {perDay.map((d, i) => {
          const x = PAD.l + (innerW / n) * i + (innerW / n - barW) / 2;
          const h = Math.max(0, (d.instanceHours / maxHours) * innerH);
          const y = PAD.t + innerH - h;
          const isToday = d.day === lastDay;
          return (
            <rect
              key={d.day}
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={Math.min(2, barW / 2)}
              fill={isToday ? '#22d3ee' : '#0e7490'}
              opacity={d.instanceHours > 0 ? (isToday ? 0.9 : 0.85) : 0.25}
            >
              <title>{`${d.day}${isToday ? ' (today)' : ''}: ${fmtHours(d.instanceHours)} instance-hrs · ${d.requests} req · ${fmtUsd(d.equivalentCostUsd)}`}</title>
            </rect>
          );
        })}
        {/* requests line */}
        {n > 1 && <path d={reqPath} fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeLinejoin="round" />}
        {n > 1 && (
          <circle
            cx={PAD.l + (innerW / n) * (n - 1 + 0.5)}
            cy={PAD.t + innerH - (perDay[n - 1].requests / maxReq) * innerH}
            r="3"
            fill="#a78bfa"
          />
        )}
        {/* axis labels — anchored inside the left/right gutters, clear of the title */}
        <text x={PAD.l - 6} y={PAD.t + 4} fontSize="8.5" fill="#52525b" fontFamily="monospace" textAnchor="end">
          {fmtHours(maxHours)}h
        </text>
        <text x={PAD.l - 6} y={PAD.t + innerH} fontSize="8.5" fill="#52525b" fontFamily="monospace" textAnchor="end">
          0h
        </text>
        <text x={W - PAD.r + 6} y={PAD.t + 4} fontSize="8.5" fill="#52525b" fontFamily="monospace">
          {maxReq >= 1000 ? `${(maxReq / 1000).toFixed(1)}k` : maxReq}
        </text>
        <text x={W - PAD.r + 6} y={PAD.t + innerH} fontSize="8.5" fill="#52525b" fontFamily="monospace">
          0
        </text>
        {perDay.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={d.day}
              x={PAD.l + (innerW / n) * (i + 0.5)}
              y={H - 6}
              fontSize="8.5"
              fill={d.day === lastDay ? '#67e8f9' : '#52525b'}
              fontFamily="monospace"
              textAnchor="middle"
            >
              {d.day.slice(5)}
            </text>
          ) : null
        )}
      </svg>
      <div className="flex items-center gap-4 mt-1 text-[10px] font-mono text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-cyan-700/90 inline-block" /> instance-hours
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-violet-400 inline-block rounded" /> requests
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400 inline-block" /> today
        </span>
      </div>
    </div>
  );
}
