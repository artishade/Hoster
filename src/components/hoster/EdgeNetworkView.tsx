'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Globe2,
  Activity,
  MapPin,
  Server,
  ArrowRight,
  Search,
  ShieldCheck,
  Terminal,
  RefreshCw,
  Network,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
} from 'lucide-react';

interface EdgeTarget {
  host: string;
  service: string;
  kind: 'builtin-subdomain' | 'custom-domain';
  sslStatus: string;
  dnsConfigured: boolean;
}

interface UpstreamProbe {
  name: string;
  endpoint: string;
  latencyMs: number | null;
  httpStatus: number | null;
  live: boolean;
  checkedAt: string;
}

interface EdgeInfo {
  pop: {
    id: string;
    hostname: string;
    timezone: string;
    region: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
    cpuModel: string;
    cores: number;
    ramTotalGb: number;
    diskTotalGb: number;
    ingressMode: 'host-header-routing';
  };
  wildcardDomain: string;
  cnameTarget: string;
  routing: EdgeTarget[];
  upstreams: UpstreamProbe[];
  totalServices: number;
  liveServices: number;
}

interface DnsResult {
  domain: string;
  cname: string[];
  cnameError?: string;
  cnameMatchesEdge?: boolean;
  a: string[];
  aaaa: string[];
  hasAnyRecord: boolean;
  elapsedMs: number;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function EdgeNetworkView() {
  const [info, setInfo] = useState<EdgeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dnsDomain, setDnsDomain] = useState('');
  const [dnsBusy, setDnsBusy] = useState(false);
  const [dnsResult, setDnsResult] = useState<DnsResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // real latency history per upstream (for trend chips)
  const historyRef = useRef<Record<string, number[]>>({});
  const [historyVersion, setHistoryVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/edge', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: EdgeInfo; error?: string };
      if (json.data) {
        setInfo(json.data);
        setError(null);
        for (const u of json.data.upstreams) {
          if (u.latencyMs !== null) {
            const arr = historyRef.current[u.endpoint] ?? [];
            arr.push(u.latencyMs);
            if (arr.length > 20) arr.shift();
            historyRef.current[u.endpoint] = arr;
          }
        }
        setHistoryVersion((v) => v + 1);
      } else {
        setError(json.error ?? 'Failed to load edge status');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), 15_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  const runDnsCheck = async () => {
    const domain = dnsDomain.trim().toLowerCase();
    if (!domain || dnsBusy) return;
    setDnsBusy(true);
    setDnsResult(null);
    try {
      const res = await fetch('/api/edge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const json = await res.json();
      if (json.data) setDnsResult(json.data as DnsResult);
      else setError(json.error ?? 'DNS check failed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDnsBusy(false);
    }
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  };

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-6 w-56 rounded bg-zinc-800/60 animate-pulse" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 rounded-xl bg-zinc-900/70 border border-zinc-800/60 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2.5">
            <span className="p-1.5 rounded-lg bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <Network className="w-5 h-5" />
            </span>
            Edge Network
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 font-mono">
            Real host-header routing · live DNS verification · measured upstream latencies — no simulation
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Re-probe now
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/20 px-4 py-3 text-xs text-red-300 font-mono">
          {error}
        </div>
      )}

      {info && (
        <>
          {/* PoP card */}
          <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/60">
              <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-cyan-400" />
                Edge PoP — this host
              </h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/60 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                live · host-header routing
              </span>
            </div>
            <div className="p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {[
                ['PoP ID', info.pop.id.length > 26 ? `${info.pop.id.slice(0, 14)}…${info.pop.id.slice(-4)}` : info.pop.id],
                ['Region', info.pop.region],
                ['Timezone', info.pop.timezone],
                ['Uptime', fmtUptime(info.pop.uptimeSeconds)],
                ['CPU', `${info.pop.cores}× ${info.pop.cpuModel.replace(/\s*\(.*\)\s*/, '')}`],
                ['RAM', `${info.pop.ramTotalGb} GB`],
                ['Disk', `${info.pop.diskTotalGb} GB`],
                ['Ingress', 'Host-header → /api/ingress'],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">{label}</div>
                  <div
                    className="text-xs font-mono text-zinc-200 mt-1 truncate cursor-help"
                    title={label === 'PoP ID' ? info.pop.id : String(value)}
                  >
                    {label === 'PoP ID' ? <span className="text-cyan-300/90">{value}</span> : value}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Routing table */}
            <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/60">
                <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                  <Globe2 className="w-4 h-4 text-cyan-400" />
                  Routing table
                </h2>
                <span className="text-[10px] font-mono text-zinc-500">
                  {info.liveServices}/{info.totalServices} services live
                </span>
              </div>
              <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
                <p className="text-[11px] text-zinc-500 font-mono mb-2">
                  Wildcard <code className="text-cyan-300">{info.wildcardDomain}</code> → matched by the edge proxy on every request.
                </p>
                {info.routing.length === 0 && (
                  <p className="text-xs text-zinc-500 font-mono py-4 text-center">
                    No services deployed yet — deploy one and its hostname appears here instantly.
                  </p>
                )}
                {info.routing.map((r) => (
                  <div
                    key={r.host}
                    className="flex flex-wrap items-center gap-2.5 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-2.5 hover:border-zinc-700 transition"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-none ${r.dnsConfigured ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                    <span className="text-xs font-mono text-zinc-200 truncate flex-1 min-w-0" title={r.host}>{r.host}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 flex-none">
                      {r.kind === 'custom-domain' ? 'custom' : 'wildcard'}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-zinc-600 flex-none" />
                    <span className="text-xs font-mono text-cyan-300 flex items-center gap-1.5 flex-none">
                      <Server className="w-3 h-3" />
                      {r.service}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Upstream probes */}
            <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/60">
                <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  Upstream providers — measured now
                </h2>
                <span className="text-[10px] font-mono text-zinc-500">HEAD probes, re-run every 15s</span>
              </div>
              <div className="p-4 space-y-2" data-history={historyVersion}>
                {info.upstreams.map((u) => {
                  const hist = historyRef.current[u.endpoint] ?? [];
                  const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
                  const trend = prev !== null && u.latencyMs !== null ? u.latencyMs - prev : 0;
                  const trendSign = trend > 15 ? '↑' : trend < -15 ? '↓' : '→';
                  const trendCls = trend > 15 ? 'text-amber-400' : trend < -15 ? 'text-emerald-400' : 'text-zinc-500';
                  const min = hist.length ? Math.min(...hist) : null;
                  const max = hist.length ? Math.max(...hist) : null;
                  return (
                    <div
                      key={u.endpoint}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-2.5"
                    >
                      {u.live ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-none" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-400 flex-none" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono text-zinc-200 truncate">{u.name}</div>
                        <div className="text-[10px] font-mono text-zinc-500 truncate">{u.endpoint}</div>
                      </div>
                      {hist.length >= 2 && (
                        <span className={`text-[11px] font-mono flex-none ${trendCls}`} title="trend vs previous probe">
                          {trendSign} {Math.abs(trend)}ms
                        </span>
                      )}
                      <div className="text-right flex-none">
                        <div className={`text-xs font-mono ${u.latencyMs === null ? 'text-red-400' : u.latencyMs < 300 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {u.latencyMs === null ? 'unreachable' : `${u.latencyMs} ms`}
                        </div>
                        <div className="text-[10px] font-mono text-zinc-500">
                          {min !== null && max !== null ? `range ${min}–${max}ms · ${hist.length} probes` : `HTTP ${u.httpStatus ?? '—'}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="pt-1 text-[10px] text-zinc-500 font-mono">
                  The provider watchdog re-verifies all upstreams every 30s — status flips are logged to the activity feed.
                </div>
              </div>
            </section>
          </div>

          {/* DNS verification tool */}
          <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/60">
              <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                <Search className="w-4 h-4 text-cyan-400" />
                Live DNS verifier — real resolver, real records
              </h2>
              <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3" /> CNAME target: {info.cnameTarget}
              </span>
            </div>
            <div className="p-5">
              <div className="flex flex-col sm:flex-row gap-2.5">
                <input
                  type="text"
                  value={dnsDomain}
                  onChange={(e) => setDnsDomain(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void runDnsCheck()}
                  placeholder="your-domain.com"
                  className="flex-1 px-3.5 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-cyan-700 focus:outline-none text-sm font-mono text-zinc-200 placeholder:text-zinc-500 transition"
                  aria-label="Domain to verify"
                />
                <button
                  onClick={() => void runDnsCheck()}
                  disabled={dnsBusy || !dnsDomain.trim()}
                  className="px-4 py-2.5 rounded-lg bg-cyan-950 hover:bg-cyan-900 border border-cyan-800 text-cyan-300 text-xs font-mono transition disabled:opacity-50 flex items-center justify-center gap-2 min-h-[44px]"
                >
                  {dnsBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  Resolve records
                </button>
              </div>

              {dnsResult && (
                <div className="mt-4 rounded-lg border border-zinc-800/70 bg-zinc-950/60 p-4 space-y-2.5 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400">{dnsResult.domain}</span>
                    <span className="text-zinc-500">{dnsResult.elapsedMs} ms</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-zinc-500 w-16 flex-none">CNAME</span>
                    <span className={dnsResult.cname.length ? 'text-emerald-400' : 'text-zinc-600'}>
                      {dnsResult.cname.length ? dnsResult.cname.join(', ') : `none (${dnsResult.cnameError ?? 'not set'})`}
                    </span>
                  </div>
                  {dnsResult.cnameMatchesEdge !== undefined && (
                    <div className="flex items-start gap-2">
                      <span className="text-zinc-500 w-16 flex-none">Edge?</span>
                      <span className={dnsResult.cnameMatchesEdge ? 'text-emerald-400' : 'text-amber-400'}>
                        {dnsResult.cnameMatchesEdge
                          ? '✓ points at edge.nexushost.dev — traffic will route to the service'
                          : '✗ not pointing at edge.nexushost.dev — add the CNAME to route traffic here'}
                      </span>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <span className="text-zinc-500 w-16 flex-none">A</span>
                    <span className={dnsResult.a.length ? 'text-zinc-300' : 'text-zinc-600'}>
                      {dnsResult.a.length ? dnsResult.a.join(', ') : 'none'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-zinc-500 w-16 flex-none">AAAA</span>
                    <span className={dnsResult.aaaa.length ? 'text-zinc-300' : 'text-zinc-600'}>
                      {dnsResult.aaaa.length ? dnsResult.aaaa.join(', ') : 'none'}
                    </span>
                  </div>
                </div>
              )}

              {/* curl cheatsheet */}
              <div className="mt-5 rounded-lg border border-zinc-800/70 bg-black/40 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-zinc-800/70 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                    Test the edge routing for real
                  </span>
                </div>
                <div className="p-4 space-y-2">
                  {[
                    ['Route by service hostname', `curl -H "Host: <service>.nexushost.dev" <this-host>/`],
                    ['Route to a service path', `curl -H "Host: <service>.nexushost.dev" <this-host>/api/time`],
                  ].map(([label, cmd]) => (
                    <div key={label} className="group flex items-center gap-2 rounded-md bg-zinc-950/70 border border-zinc-800/60 px-3 py-2">
                      <span className="text-[10px] text-zinc-500 w-40 flex-none">{label}</span>
                      <code className="text-[11px] text-emerald-300/90 flex-1 overflow-x-auto whitespace-nowrap">{cmd}</code>
                      <button
                        onClick={() => copyText(cmd, label)}
                        className="opacity-0 group-hover:opacity-100 transition p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                        aria-label={`Copy: ${label}`}
                      >
                        {copied === label ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  ))}
                  <p className="text-[10px] text-zinc-500 font-mono pt-1">
                    The edge proxy inspects every request&apos;s Host header — same-origin ingress paths
                    (<code className="text-cyan-300">/api/ingress/&lt;name&gt;</code>) keep working independently.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
