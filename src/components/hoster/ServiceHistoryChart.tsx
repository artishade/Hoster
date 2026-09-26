'use client';

/**
 * ServiceHistoryChart — REAL per-service metric history.
 *
 * Data comes exclusively from /api/services/[id]/history — MetricSample rows
 * the host sampler actually recorded (real /proc CPU+RAM of the deployed
 * process, real request counters). No synthetic series: if the sampler has
 * no rows yet, the chart says so.
 *
 * Renders a custom SVG chart (2 series: CPU% + RAM share, plus rpm overlay),
 * with min/avg/max stat chips and a live 10s poll.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Activity } from 'lucide-react';

export interface HistoryPoint {
  timestamp: string;
  cpuPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  requestsPerMin: number;
  latencyP95Ms: number;
}

interface Props {
  serviceId: string;
  ramTotalGb: number;
}

const W = 600;
const H = 120;
const POLL_MS = 10_000;

function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export default function ServiceHistoryChart({ serviceId, ramTotalGb }: Props) {
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${serviceId}/history?points=60`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`history fetch failed (${res.status})`);
      const json = (await res.json()) as { data?: HistoryPoint[] };
      setPoints(Array.isArray(json.data) ? json.data : []);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    setLoading(true);
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // ── Series → SVG paths ─────────────────────────────────────────────────────
  const cpuSeries = points.map((p) => Math.min(100, Math.max(0, p.cpuPercent)));
  const ramSeries = points.map((p) =>
    ramTotalGb > 0 ? Math.min(100, Math.max(0, (p.ramUsedGb / ramTotalGb) * 100)) : 0,
  );
  const rpmSeries = points.map((p) => p.requestsPerMin);

  const toPath = (series: number[], max: number) => {
    if (series.length < 2) return null;
    const step = W / (series.length - 1);
    const y = (v: number) => H - 8 - (Math.min(v, max) / max) * (H - 20);
    const pts = series.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
    return { line: `M${pts.join(' L')}`, area: `M${pts.join(' L')} L${W},${H} L0,${H} Z` };
  };

  const cpuPath = toPath(cpuSeries, 100);
  const ramPath = toPath(ramSeries, 100);
  const rpmMax = Math.max(1, ...rpmSeries);
  const rpmPath = toPath(rpmSeries, rpmMax);

  const avg = (s: number[]) => (s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0);
  const stats = [
    { label: 'CPU', value: avg(cpuSeries), unit: '%', color: 'text-emerald-300', bar: 'bg-emerald-400' },
    { label: 'RAM', value: avg(ramSeries), unit: '%', color: 'text-violet-300', bar: 'bg-violet-400' },
    { label: 'Traffic', value: avg(rpmSeries), unit: ' rpm', color: 'text-cyan-300', bar: 'bg-cyan-400' },
    {
      label: 'p95 latency',
      value: points.length ? points[points.length - 1].latencyP95Ms : 0,
      unit: ' ms',
      color: 'text-amber-300',
      bar: 'bg-amber-400',
    },
  ];

  return (
    <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            Live Resource Load &amp; Ingress
            <span className="text-zinc-500 font-mono font-normal">— real sampler history</span>
          </h3>
          <p className="text-[11px] text-zinc-400">
            {points.length > 0
              ? `${points.length} samples · ${fmtTime(points[0].timestamp)} → ${fmtTime(points[points.length - 1].timestamp)} · refreshed ${updatedAt ? fmtTime(updatedAt) : '—'} (10s poll)`
              : 'Metric samples recorded by the 15s host sampler (real /proc CPU + RAM + ingress counters)'}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <span className="flex items-center gap-1.5 text-cyan-400">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
            Traffic (rpm)
          </span>
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
            CPU %
          </span>
          <span className="flex items-center gap-1.5 text-violet-400">
            <span className="w-2.5 h-2.5 rounded-full bg-violet-400" />
            RAM %
          </span>
        </div>
      </div>

      {/* Real sample-driven chart */}
      <div className="relative h-44 w-full bg-zinc-950/80 rounded-xl border border-zinc-800/80 p-3 overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-zinc-500">
            <span className="animate-pulse">loading real metric history…</span>
          </div>
        ) : points.length < 2 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-6">
            <span className="text-[11px] font-mono text-zinc-500">No metric samples recorded yet</span>
            <span className="text-[10px] text-zinc-600">
              The host sampler writes real CPU/RAM rows every 15s — a freshly deployed service needs a minute of runtime.
            </span>
          </div>
        ) : (
          <svg className="w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id="svcCpuGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="svcRamGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
              </linearGradient>
            </defs>

            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1="0"
                y1={H * f}
                x2={W}
                y2={H * f}
                stroke="#27272a"
                strokeDasharray="3 3"
              />
            ))}

            {/* RAM % */}
            {ramPath && (
              <>
                <path d={ramPath.area} fill="url(#svcRamGrad)" />
                <path d={ramPath.line} fill="none" stroke="#a78bfa" strokeWidth="1.6" />
              </>
            )}

            {/* Traffic (rpm, scaled to its own max) */}
            {rpmPath && (
              <path
                d={rpmPath.line}
                fill="none"
                stroke="#06b6d4"
                strokeWidth="1.6"
                strokeDasharray="4 3"
                opacity="0.85"
              />
            )}

            {/* CPU % (top layer) */}
            {cpuPath && (
              <>
                <path d={cpuPath.area} fill="url(#svcCpuGrad)" />
                <path d={cpuPath.line} fill="none" stroke="#10b981" strokeWidth="2" />
              </>
            )}

            {/* Live edge marker */}
            {cpuSeries.length > 1 && (
              <circle
                cx={W}
                cy={H - 8 - (Math.min(cpuSeries[cpuSeries.length - 1], 100) / 100) * (H - 20)}
                r="3"
                fill="#10b981"
              />
            )}
          </svg>
        )}

        {/* Y-axis labels */}
        {points.length >= 2 && (
          <>
            <span className="absolute left-1.5 top-1 text-[9px] font-mono text-zinc-600">100%</span>
            <span className="absolute left-1.5 bottom-1 text-[9px] font-mono text-zinc-600">0%</span>
          </>
        )}
      </div>

      {/* Real stat chips */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg bg-zinc-950/60 border border-zinc-800/80 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">{s.label}</span>
              <span className={`text-xs font-bold font-mono tabular-nums ${s.color}`}>
                {s.value < 10 ? s.value.toFixed(1) : Math.round(s.value)}
                <span className="text-[9px] text-zinc-500 font-normal">{s.unit}</span>
              </span>
            </div>
            <div className="h-1 mt-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${s.bar} transition-all`}
                style={{ width: `${Math.min(100, s.unit === '%' ? s.value : (s.value / Math.max(1, rpmMax)) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="text-[10px] font-mono text-red-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
          {error}
        </p>
      )}
    </div>
  );
}
