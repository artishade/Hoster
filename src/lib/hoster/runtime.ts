import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import type { ServiceRuntime } from './types';

/**
 * Real service runtime.
 *
 * Every service in "running" state gets a REAL HTTP server bound to a real
 * 127.0.0.1 port inside the control-plane host. Requests reach it through the
 * same-origin ingress proxy (/api/ingress/<name>) so deployed projects are
 * actually visitable AND interactive — no DNS records required.
 *
 * Each runner serves:
 *   - a live interactive console at / (API playground, persistent KV data
 *     store, real-time request feed, SSE stream for streaming services)
 *   - real JSON endpoints: /health, /api/meta, /api/stats, /api/time,
 *     /api/echo, /api/kv[/:key], /api/requests, /sse
 *   - genuine persistent state (SQLite-backed ServiceData KV store) and
 *     genuine request metrics that survive restarts
 *
 * The pretty hostname (https://<name>.nexushost.dev) remains the "custom
 * domain" view: it only resolves once a wildcard DNS record points at this
 * server, exactly like any real platform. The UI marks it as DNS-pending.
 */

// Survives dev-server hot reloads via globalThis.
type RunnerGlobal = typeof globalThis & {
  __serviceRunners?: Map<string, http.Server>;
  __serviceLiveStates?: Map<string, LiveState>;
};
const g = globalThis as RunnerGlobal;
const runners = g.__serviceRunners ?? new Map<string, http.Server>();
g.__serviceRunners = runners;

const PORT_BASE = 42100;
const PORT_RANGE = 900;
const MAX_PORT_TRIES = 40;
const HEALTH_TIMEOUT_MS = 900;

/** Bump when the runner app changes so hot-reloaded servers get replaced. */
const RUNNER_VERSION = 5;

const RING_CAP = 50;
const LATENCY_CAP = 200;
const STATS_KEY = '__stats';
const MAX_KEY_LEN = 120;
const MAX_VALUE_BYTES = 64 * 1024;

type PathStat = { count: number; totalMs: number };

interface LiveState {
  stats: {
    totalRequests: number;
    okResponses: number;
    errorResponses: number;
    totalMs: number;
    byPath: Record<string, PathStat>;
    lastRequestAt: string | null;
  };
  ring: { method: string; path: string; status: number; ms: number; at: string }[];
  latencies: number[];
  flushTimer: NodeJS.Timeout | null;
}

type RuntimeState = ServiceRuntime;

// ─── small local helpers (runtime.ts must not import server.ts → no cycles) ──

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

async function writeLog(serviceId: string | null, message: string, source = 'service-runner'): Promise<void> {
  try {
    await db.logEntry.create({ data: { serviceId, scope: 'service', level: 'info', message, source } });
  } catch {
    /* logging must never break the runtime */
  }
}

/** Public log writer used by the git deployer for app stdout/stderr lines. */
export async function writeRunnerLog(serviceId: string, message: string, source = 'app'): Promise<void> {
  try {
    await db.logEntry.create({ data: { serviceId, scope: 'service', level: 'info', message: message.slice(0, 2000), source } });
  } catch {
    /* logging must never break the runtime */
  }
}

// ─── networking helpers ──────────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function portForService(id: string): number {
  const hash = crypto.createHash('sha1').update(id).digest();
  return PORT_BASE + (hash.readUInt16BE(0) % PORT_RANGE);
}

async function allocatePort(id: string): Promise<number> {
  const preferred = portForService(id);
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const candidate = PORT_BASE + (((preferred - PORT_BASE + i) % PORT_RANGE) + PORT_RANGE) % PORT_RANGE;
    if (await isPortFree(candidate)) return candidate;
  }
  return preferred; // let listen() surface the error if truly exhausted
}
export { allocatePort, portForService };

export async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── per-service live metrics (real request tracking) ────────────────────────

const liveStates = g.__serviceLiveStates ?? new Map<string, LiveState>();
g.__serviceLiveStates = liveStates;

function emptyStats(): LiveState['stats'] {
  return { totalRequests: 0, okResponses: 0, errorResponses: 0, totalMs: 0, byPath: {}, lastRequestAt: null };
}

function getLiveState(serviceId: string): LiveState {
  let st = liveStates.get(serviceId);
  if (!st) {
    st = { stats: emptyStats(), ring: [], latencies: [], flushTimer: null };
    liveStates.set(serviceId, st);
  }
  return st;
}

async function loadPersistedStats(serviceId: string): Promise<void> {
  try {
    const row = await db.serviceData.findUnique({
      where: { serviceId_key: { serviceId, key: STATS_KEY } },
      select: { valueJson: true },
    });
    if (!row) return;
    const saved = safeParse<Partial<LiveState['stats']> | null>(row.valueJson, null);
    if (saved && typeof saved.totalRequests === 'number') {
      const st = getLiveState(serviceId);
      st.stats = { ...emptyStats(), ...saved, byPath: saved.byPath ?? {} };
    }
  } catch {
    /* stats are best-effort */
  }
}

function scheduleStatsFlush(serviceId: string): void {
  const st = getLiveState(serviceId);
  if (st.flushTimer) return;
  st.flushTimer = setTimeout(() => {
    st.flushTimer = null;
    const snapshot = JSON.stringify(st.stats);
    db.serviceData
      .upsert({
        where: { serviceId_key: { serviceId, key: STATS_KEY } },
        update: { valueJson: snapshot },
        create: { serviceId, key: STATS_KEY, valueJson: snapshot },
      })
      .catch(() => {});
  }, 2500);
  st.flushTimer.unref?.();
}

function recordRequest(serviceId: string, entry: { method: string; path: string; status: number; ms: number }): void {
  const st = getLiveState(serviceId);
  st.stats.totalRequests += 1;
  if (entry.status < 400) st.stats.okResponses += 1;
  else st.stats.errorResponses += 1;
  st.stats.totalMs += entry.ms;
  st.stats.lastRequestAt = new Date().toISOString();

  const bucket = st.stats.byPath[entry.path] ?? { count: 0, totalMs: 0 };
  bucket.count += 1;
  bucket.totalMs += entry.ms;
  st.stats.byPath[entry.path] = bucket;

  st.ring.push({ ...entry, at: new Date().toISOString() });
  if (st.ring.length > RING_CAP) st.ring.splice(0, st.ring.length - RING_CAP);

  st.latencies.push(entry.ms);
  if (st.latencies.length > LATENCY_CAP) st.latencies.splice(0, st.latencies.length - LATENCY_CAP);

  scheduleStatsFlush(serviceId);
}

/** Ingress-level traffic recorder — counts REAL proxied requests for git-deployed apps. */
export function recordExternalRequest(serviceId: string, entry: { method: string; path: string; status: number; ms: number }): void {
  recordRequest(serviceId, entry);
}

/** Snapshot of the real live state (request counters, latency samples, ring). */
export function getLiveStateSnapshot(serviceId: string): LiveState {
  const st = getLiveState(serviceId);
  return { stats: { ...st.stats, byPath: { ...st.stats.byPath } }, ring: [...st.ring], latencies: [...st.latencies], flushTimer: null };
}

export function liveRequestsLastMinute(serviceId: string): number {
  const st = getLiveState(serviceId);
  const cutoff = Date.now() - 60_000;
  return st.ring.filter((r) => new Date(r.at).getTime() >= cutoff).length;
}

export function liveLatencyP95(serviceId: string): number {
  return percentile(getLiveState(serviceId).latencies, 95);
}

export function liveLatencyAvg(serviceId: string): number {
  const st = getLiveState(serviceId);
  return st.stats.totalRequests ? Math.round(st.stats.totalMs / st.stats.totalRequests) : 0;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
}

// ─── the deployed application's interactive console page ─────────────────────

interface RunnerMeta {
  type: string;
  commit: string;
  branch: string;
  tier: string;
  region: string;
  description: string;
  protocol: string;
}

function renderAppPage(name: string, meta: RunnerMeta, streamEnabled: boolean): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

  const methodChip = (m: string) => {
    const cls = m === 'GET' ? 'm-get' : m === 'POST' ? 'm-post' : m === 'PUT' ? 'm-put' : m === 'DELETE' ? 'm-del' : 'm-other';
    return `<span class="method ${cls}">${m}</span>`;
  };

  const endpoints: [string, string, string][] = [
    ['GET', '/health', 'Liveness probe used by the platform health checker'],
    ['GET', '/api/meta', 'Service metadata & runtime info'],
    ['GET', '/api/stats', 'Real request counters, latency percentiles, per-path breakdown'],
    ['GET', '/api/time', 'Server clock (RFC 3339 + epoch ms)'],
    ['POST', '/api/echo', 'Echoes your request body back with envelope metadata'],
    ['GET', '/api/kv', 'List the persistent data store contents'],
    ['PUT', '/api/kv/{key}', 'Create or update a key — survives restarts & redeploys'],
    ['DELETE', '/api/kv/{key}', 'Remove a key'],
    ['GET', '/api/requests', 'Last 50 requests served by this runner'],
  ];
  if (streamEnabled) endpoints.push(['GET', '/sse', 'Server-Sent Events stream — live heartbeats every second']);

  const endpointRows = endpoints
    .map(
      ([m, p, d]) =>
        `<div class="ep">${methodChip(m)}<span class="path">${esc(p)}</span><span class="epdesc">${esc(d)}</span></div>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(name)} — live on NexusHost</title>
<style>
  :root { color-scheme: dark; --bg:#090a0f; --card:#101116; --line:#26262c; --line2:#1d1d23;
          --txt:#e4e4e7; --dim:#a1a1aa; --faint:#61616b; --ok:#34d399; --warn:#fbbf24;
          --teal:#2dd4bf; --red:#f87171; --accent:#f4f4f5; }
  * { box-sizing:border-box; margin:0; }
  html { -webkit-text-size-adjust:100%; }
  body { background:var(--bg); color:var(--txt); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
         font-size:14px; line-height:1.5; padding-bottom:env(safe-area-inset-bottom); }
  .wrap { max-width:880px; margin:0 auto; padding:0 14px 40px; }
  header { position:sticky; top:0; z-index:10; background:rgba(9,10,15,.94); backdrop-filter:blur(8px);
           border-bottom:1px solid var(--line2); padding:12px 0; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .dot { width:9px; height:9px; border-radius:99px; background:var(--ok); box-shadow:0 0 10px #34d39988; flex:none; }
  .brand { font-weight:700; font-size:16px; color:var(--accent); }
  .chip { font-size:10px; letter-spacing:1.5px; text-transform:uppercase; border:1px solid var(--line);
          border-radius:99px; padding:2px 8px; color:var(--dim); }
  #uptime { margin-left:auto; font-size:11px; color:var(--dim); white-space:nowrap; }
  .stats { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; margin:16px 0 14px; }
  @media(min-width:640px){ .stats{grid-template-columns:repeat(4,1fr);} }
  .stat { background:var(--card); border:1px solid var(--line2); border-radius:12px; padding:10px 12px; }
  .stat b { display:block; font-size:16px; color:var(--accent); font-variant-numeric:tabular-nums; }
  .stat span { font-size:10px; letter-spacing:1.5px; color:var(--faint); text-transform:uppercase; }
  nav.tabs { display:flex; gap:2px; overflow-x:auto; border-bottom:1px solid var(--line2); margin-bottom:14px;
             scrollbar-width:none; -webkit-overflow-scrolling:touch; }
  nav.tabs::-webkit-scrollbar { display:none; }
  .tab { flex:none; background:none; border:none; color:var(--dim); font:inherit; font-size:12.5px; padding:11px 13px;
         cursor:pointer; border-bottom:2px solid transparent; min-height:44px; }
  .tab[aria-selected="true"] { color:var(--accent); border-bottom-color:var(--ok); }
  .pane { display:none; }
  .pane.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line2); border-radius:14px; padding:16px; margin-bottom:12px; }
  h2 { font-size:12px; letter-spacing:1.5px; text-transform:uppercase; color:var(--dim); margin-bottom:12px; }
  p.desc { color:var(--dim); font-size:13px; margin-bottom:14px; }
  table.meta { width:100%; border-collapse:collapse; font-size:12px; }
  table.meta td { padding:8px 0; border-bottom:1px solid var(--line2); color:var(--dim); }
  table.meta td:last-child { color:var(--txt); text-align:right; }
  table.meta tr:last-child td { border-bottom:none; }
  .ok { color:var(--ok); }
  .ep { display:flex; align-items:center; gap:8px; padding:9px 0; border-bottom:1px solid var(--line2);
        font-size:12px; flex-wrap:wrap; }
  .ep:last-child { border-bottom:none; }
  .epdesc { color:var(--faint); font-size:11px; flex-basis:100%; padding-left:2px; }
  .method { font-size:10px; font-weight:700; border-radius:6px; padding:2px 7px; letter-spacing:1px; flex:none; }
  .m-get { background:#0f2e22; color:var(--ok); }
  .m-post { background:#2e260f; color:var(--warn); }
  .m-put { background:#0f2b28; color:var(--teal); }
  .m-del { background:#2e1414; color:var(--red); }
  .m-other { background:#232329; color:var(--dim); }
  .path { color:var(--txt); word-break:break-all; }
  button.btn { font:inherit; font-size:12.5px; background:#1a1a21; color:var(--txt); border:1px solid var(--line);
               border-radius:9px; padding:10px 16px; min-height:44px; cursor:pointer; }
  button.btn:active { background:#24242c; }
  button.btn:disabled { opacity:.55; cursor:wait; }
  button.btn.primary { background:#12241d; border-color:#1e4033; color:var(--ok); }
  label { display:block; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:var(--faint); margin:12px 0 5px; }
  textarea, input[type="text"] { width:100%; background:#0c0d12; border:1px solid var(--line); border-radius:9px;
         color:var(--txt); font:inherit; font-size:12.5px; padding:10px 12px; }
  textarea { min-height:88px; resize:vertical; }
  textarea:focus, input:focus { outline:1px solid #3f3f46; }
  pre.out { background:#0c0d12; border:1px solid var(--line2); border-radius:10px; padding:12px; font-size:11.5px;
            overflow-x:auto; max-height:340px; overflow-y:auto; white-space:pre; margin:0; }
  .res-head { display:flex; gap:8px; align-items:center; margin:12px 0 7px; flex-wrap:wrap; font-size:11px; color:var(--dim); }
  .res-head .spacer { margin-left:auto; }
  .copy { min-height:32px; padding:4px 10px; font-size:11px; border-radius:7px; }
  .status-pill { font-weight:700; border-radius:6px; padding:2px 8px; font-size:10px; letter-spacing:1px; }
  .sp-ok { background:#0f2e22; color:var(--ok); }
  .sp-err { background:#2e1414; color:var(--red); }
  .rows { display:flex; flex-direction:column; gap:6px; }
  .row { display:flex; gap:8px; align-items:center; background:#0c0d12; border:1px solid var(--line2);
         border-radius:9px; padding:9px 11px; font-size:11.5px; flex-wrap:wrap; }
  .row .p { color:var(--txt); word-break:break-all; }
  .row .meta2 { color:var(--faint); font-size:10px; margin-left:auto; white-space:nowrap; }
  .row .v { color:var(--dim); flex-basis:100%; font-size:11px; word-break:break-all; }
  .del { color:var(--red); background:none; border:1px solid #7f1d1d; border-radius:9px; min-height:44px;
         min-width:44px; cursor:pointer; font:inherit; font-size:11px; padding:4px 10px; }
  .muted { color:var(--faint); font-size:12px; }
  .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
  .toolbar .spacer { margin-left:auto; }
  footer { margin-top:26px; font-size:11px; color:var(--faint); text-align:center; line-height:1.7; }
  footer code { background:#18181b; border:1px solid var(--line); padding:1px 6px; border-radius:6px; font-size:10.5px; }
  #toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:#1a1a21; border:1px solid var(--line);
           border-radius:10px; padding:10px 18px; font-size:12px; opacity:0; transition:opacity .18s; pointer-events:none;
           z-index:50; max-width:88vw; }
  #toast.show { opacity:1; }
  .sse-stat { display:flex; gap:8px; align-items:center; font-size:12px; color:var(--dim); flex-wrap:wrap; }
  .pulse { width:8px; height:8px; border-radius:99px; background:var(--faint); }
  .pulse.on { background:var(--ok); box-shadow:0 0 8px #34d39988; }
</style></head>
<body>
<div class="wrap">
  <header>
    <span class="dot" id="dot"></span>
    <span class="brand">${esc(name)}</span>
    <span class="chip">${esc(meta.type)}</span>
    <span class="chip">${esc(meta.protocol)}</span>
    <span id="uptime">uptime —</span>
  </header>

  <div class="stats">
    <div class="stat"><b id="s-reqs">—</b><span>requests</span></div>
    <div class="stat"><b id="s-avg">—</b><span>avg latency</span></div>
    <div class="stat"><b id="s-p95">—</b><span>p95 latency</span></div>
    <div class="stat"><b id="s-err">—</b><span>errors</span></div>
  </div>

  <nav class="tabs" role="tablist">
    <button class="tab" role="tab" aria-selected="true" data-tab="overview">Overview</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="playground">API Playground</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="data">Data Store</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="feed">Live Feed</button>
  </nav>

  <section class="pane active" id="pane-overview" role="tabpanel">
    <div class="card">
      <p class="desc">${esc(meta.description || 'Deployed and served by the NexusHost builtin runner — every button on this page sends real HTTP requests to this running service.')}</p>
      <table class="meta">
        <tr><td>Commit</td><td>${esc(meta.commit)} (${esc(meta.branch)})</td></tr>
        <tr><td>Hardware tier</td><td>${esc(meta.tier)}</td></tr>
        <tr><td>Region</td><td>${esc(meta.region)}</td></tr>
        <tr><td>Health check</td><td class="ok">passing — <span style="color:var(--dim)">GET /health</span></td></tr>
        <tr><td>Runner</td><td>builtin · pid <span id="m-pid">…</span> · port <span id="m-port">…</span></td></tr>
      </table>
    </div>
    <div class="card">
      <h2>Endpoints — all live, try them in the Playground</h2>
      ${endpointRows}
    </div>
  </section>

  <section class="pane" id="pane-playground" role="tabpanel">
    <div class="card">
      <h2>Request</h2>
      <div class="ep" style="border:none;padding-top:0">${methodChip('GET')}<span class="path">/health</span>
        <span class="epdesc" style="flex-basis:100%">Platform liveness probe</span>
        <button class="btn primary" id="go-health" style="margin-left:auto">Send</button></div>
      <div class="ep" style="border:none">${methodChip('GET')}<span class="path">/api/time</span>
        <span class="epdesc" style="flex-basis:100%">Server clock</span>
        <button class="btn primary" id="go-time" style="margin-left:auto">Send</button></div>
      <div class="ep" style="border:none">${methodChip('GET')}<span class="path">/api/stats</span>
        <span class="epdesc" style="flex-basis:100%">Real traffic metrics for this deployment</span>
        <button class="btn primary" id="go-stats" style="margin-left:auto">Send</button></div>
      <label for="echo-body">POST /api/echo — request body (JSON)</label>
      <textarea id="echo-body" spellcheck="false">{"hello":"world","from":"${esc(name)}"}</textarea>
      <div style="margin-top:10px;display:flex;justify-content:flex-end">
        <button class="btn primary" id="go-echo">Send echo</button></div>
    </div>
    <div class="card" id="res-card">
      <h2>Response</h2>
      <p class="muted" id="res-empty">Send a request — the response, status code and real latency will show up here.</p>
      <div id="res-out"></div>
    </div>
  </section>

  <section class="pane" id="pane-data" role="tabpanel">
    <div class="card">
      <h2>Persistent key/value store — stored in the control-plane database</h2>
      <label for="kv-key">Key</label>
      <input type="text" id="kv-key" placeholder="e.g. greeting" autocomplete="off" />
      <label for="kv-value">Value (raw text or JSON)</label>
      <textarea id="kv-value" spellcheck="false" style="min-height:64px">{"msg":"saved at runtime"}</textarea>
      <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" id="kv-refresh">Refresh</button>
        <button class="btn primary" id="kv-save">Save key</button>
      </div>
    </div>
    <div class="card">
      <h2>Stored entries <span class="muted" id="kv-count"></span></h2>
      <div class="rows" id="kv-rows"><p class="muted">Loading…</p></div>
    </div>
  </section>

  <section class="pane" id="pane-feed" role="tabpanel">
    ${streamEnabled ? `<div class="card">
      <h2>SSE live stream — GET /sse</h2>
      <div class="sse-stat"><span class="pulse" id="sse-pulse"></span><span id="sse-state">connecting…</span>
        <span class="chip" id="sse-count" style="margin-left:auto">0 events</span></div>
      <pre class="out" id="sse-log" style="margin-top:10px;max-height:200px">waiting for events…</pre>
    </div>` : ''}
    <div class="card">
      <div class="toolbar"><h2 style="margin:0">Requests served by this runner</h2>
        <span class="spacer"></span><button class="btn" id="feed-toggle">Pause</button></div>
      <div class="rows" id="feed-rows"><p class="muted">Loading…</p></div>
    </div>
  </section>

  <footer>
    Served by the NexusHost builtin runner · ingress <code>/api/ingress/${esc(name)}</code><br/>
    custom hostname <code>${esc(name)}.nexushost.dev</code> resolves once wildcard DNS points at this host
  </footer>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  'use strict';
  var BASE = location.pathname.replace(/\\/+$/, '') + '/';
  var STREAM = ${streamEnabled ? 'true' : 'false'};
  var STARTED_AT = Date.now();

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pretty(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
  function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms'; }
  function fmtUptime(sec) {
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    var out = '';
    if (d) out += d + 'd ';
    if (d || h) out += h + 'h ';
    if (d || h || m) out += m + 'm ';
    out += s + 's';
    return out;
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 1700);
  }
  function copyText(txt) {
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = txt;
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied to clipboard'); } catch (e) { toast('Copy failed'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Copied to clipboard'); }, fallback);
    } else fallback();
  }

  // ── tabs ──
  var tabs = document.querySelectorAll('.tab');
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (t) { t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
      var panes = document.querySelectorAll('.pane');
      Array.prototype.forEach.call(panes, function (p) { p.classList.toggle('active', p.id === 'pane-' + tab.dataset.tab); });
      if (tab.dataset.tab === 'data') loadKV();
      if (tab.dataset.tab === 'feed') { loadFeed(); if (STREAM && !sseConnected) connectSSE(); }
    });
  });

  // ── request sender ──
  function send(method, path, body, btn) {
    var t0 = performance.now();
    if (btn) { btn.disabled = true; btn._old = btn.textContent; btn.textContent = 'Sending…'; }
    var opts = { method: method, cache: 'no-store' };
    if (body != null) { opts.headers = { 'content-type': 'application/json' }; opts.body = body; }
    fetch(BASE + path.replace(/^\\/+/, ''), opts)
      .then(function (r) {
        return r.text().then(function (txt) { return { status: r.status, ok: r.ok, txt: txt }; });
      })
      .then(function (res) {
        var ms = performance.now() - t0;
        var parsed = null, bodyTxt = res.txt;
        try { parsed = JSON.parse(res.txt); bodyTxt = pretty(parsed); } catch (e) { if (!res.txt) bodyTxt = '(empty body)'; }
        $('res-empty').style.display = 'none';
        var pill = res.ok ? 'sp-ok' : 'sp-err';
        var html = '<div class="res-head">' +
          '<span class="status-pill ' + pill + '">' + res.status + '</span>' +
          '<span>' + fmtMs(ms) + '</span>' + '<span>' + esc(method) + ' ' + esc(path) + '</span>' +
          '<span class="spacer"></span><button class="btn copy" id="res-copy">Copy</button></div>' +
          '<pre class="out">' + esc(bodyTxt) + '</pre>';
        $('res-out').innerHTML = html;
        $('res-copy').addEventListener('click', function () { copyText(bodyTxt); });
        refreshStats();
      })
      .catch(function (err) {
        $('res-empty').style.display = 'none';
        $('res-out').innerHTML = '<div class="res-head"><span class="status-pill sp-err">ERR</span></div>' +
          '<pre class="out">request failed: ' + esc(String(err)) + '</pre>';
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = btn._old; }
      });
  }

  $('go-health').addEventListener('click', function () { send('GET', '/health', null, this); });
  $('go-time').addEventListener('click', function () { send('GET', '/api/time', null, this); });
  $('go-stats').addEventListener('click', function () { send('GET', '/api/stats', null, this); });
  $('go-echo').addEventListener('click', function () {
    var raw = $('echo-body').value;
    send('POST', '/api/echo', raw.trim() === '' ? null : raw, this);
  });

  // ── stats strip + uptime ──
  function refreshStats() {
    fetch(BASE + 'api/stats', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.startedAtMs) STARTED_AT = s.startedAtMs;
        if (s.runtime) { $('m-pid').textContent = s.runtime.pid; $('m-port').textContent = s.runtime.port; }
        $('s-reqs').textContent = s.totalRequests;
        $('s-avg').textContent = s.totalRequests ? fmtMs(s.totalMs / s.totalRequests) : '—';
        $('s-p95').textContent = s.totalRequests ? fmtMs(s.p95LatencyMs) : '—';
        $('s-err').textContent = s.errorResponses;
      })
      .catch(function () {});
  }
  setInterval(function () { $('uptime').textContent = 'uptime ' + fmtUptime((Date.now() - STARTED_AT) / 1000); }, 1000);
  setInterval(function () { if (!document.hidden) refreshStats(); }, 5000);
  refreshStats();

  // ── kv store ──
  function loadKV() {
    fetch(BASE + 'api/kv', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var entries = data.data || [];
        $('kv-count').textContent = entries.length ? '(' + entries.length + ')' : '';
        if (!entries.length) { $('kv-rows').innerHTML = '<p class="muted">No keys yet — save one above, it persists in the control-plane database.</p>'; return; }
        var html = '';
        Array.prototype.forEach.call(entries, function (e) {
          html += '<div class="row"><span class="method m-put">' + esc(e.key) + '</span>' +
            '<span class="meta2">' + esc(new Date(e.updatedAt).toLocaleString()) + '</span>' +
            '<button class="del" data-key="' + esc(e.key) + '">Delete</button>' +
            '<span class="v">' + esc(typeof e.value === 'string' ? e.value : pretty(e.value)) + '</span></div>';
        });
        $('kv-rows').innerHTML = html;
        var dels = $('kv-rows').querySelectorAll('.del');
        Array.prototype.forEach.call(dels, function (btn) {
          btn.addEventListener('click', function () {
            var key = btn.dataset.key;
            btn.disabled = true;
            fetch(BASE + 'api/kv/' + encodeURIComponent(key), { method: 'DELETE' })
              .then(function (r) { toast(r.ok ? 'Deleted "' + key + '"' : 'Delete failed'); loadKV(); refreshStats(); })
              .catch(function () { toast('Delete failed'); btn.disabled = false; });
          });
        });
      })
      .catch(function () { $('kv-rows').innerHTML = '<p class="muted">Failed to load entries.</p>'; });
  }
  $('kv-refresh').addEventListener('click', loadKV);
  $('kv-save').addEventListener('click', function () {
    var key = $('kv-key').value.trim();
    if (!key) { toast('Enter a key first'); return; }
    var raw = $('kv-value').value;
    var btn = this; btn.disabled = true;
    fetch(BASE + 'api/kv/' + encodeURIComponent(key), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw,
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        toast(res.ok ? 'Saved "' + key + '" to the data store' : (res.j.error || 'Save failed'));
        if (res.ok) loadKV();
        refreshStats();
      })
      .catch(function () { toast('Save failed'); })
      .then(function () { btn.disabled = false; });
  });

  // ── live feed ──
  var feedPaused = false;
  $('feed-toggle').addEventListener('click', function () {
    feedPaused = !feedPaused;
    this.textContent = feedPaused ? 'Resume' : 'Pause';
    if (!feedPaused) loadFeed();
  });
  function statusPill(code) {
    var cls = code < 400 ? 'sp-ok' : 'sp-err';
    return '<span class="status-pill ' + cls + '">' + code + '</span>';
  }
  function methodChip(m) {
    var cls = m === 'GET' ? 'm-get' : m === 'POST' ? 'm-post' : m === 'PUT' ? 'm-put' : m === 'DELETE' ? 'm-del' : 'm-other';
    return '<span class="method ' + cls + '">' + esc(m) + '</span>';
  }
  function loadFeed() {
    if (feedPaused) return;
    fetch(BASE + 'api/requests', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rows = (data.data || []).slice().reverse();
        if (!rows.length) { $('feed-rows').innerHTML = '<p class="muted">No requests yet — hit Send in the Playground or refresh the page.</p>'; return; }
        var html = '';
        Array.prototype.forEach.call(rows, function (r) {
          html += '<div class="row">' + methodChip(r.method) + '<span class="p">' + esc(r.path) + '</span>' +
            statusPill(r.status) + '<span class="meta2">' + fmtMs(r.ms) + ' · ' + esc(new Date(r.at).toLocaleTimeString()) + '</span></div>';
        });
        $('feed-rows').innerHTML = html;
      })
      .catch(function () {});
  }
  setInterval(function () { if (!document.hidden) loadFeed(); }, 2500);
  loadFeed();

  // ── sse stream ──
  var sseConnected = false, sseEvents = 0;
  function connectSSE() {
    if (!STREAM || sseConnected) return;
    sseConnected = true;
    var es = new EventSource(BASE + 'sse');
    function onEvent(ev) {
      sseEvents += 1;
      $('sse-count').textContent = sseEvents + ' events';
      $('sse-state').textContent = 'connected — heartbeats arriving live';
      $('sse-pulse').classList.add('on');
      $('sse-log').textContent = (sseEvents > 1 ? $('sse-log').textContent + '\\n' : '') + ev.data;
      var lines = $('sse-log').textContent.split('\\n');
      if (lines.length > 8) $('sse-log').textContent = lines.slice(-8).join('\\n');
    }
    es.addEventListener('heartbeat', onEvent);
    es.onopen = function () { $('sse-state').textContent = 'connected — heartbeats arriving live'; $('sse-pulse').classList.add('on'); };
    es.onerror = function () { $('sse-state').textContent = 'reconnecting…'; $('sse-pulse').classList.remove('on'); };
  }
  if (STREAM) connectSSE();
})();
</script>
</body></html>`;
}

// ─── the runner HTTP app ─────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > MAX_VALUE_BYTES + 4096) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function normalizeUrl(raw: string): string {
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  if (path === '/' || path === '') return '/';
  return path.replace(/\/+$/, '') || '/';
}

function createRunnerApp(
  serviceId: string,
  name: string,
  meta: RunnerMeta,
  port: number
): http.Server {
  const streamEnabled = meta.protocol === 'sse' || meta.type === 'mcp';
  const bootAt = Date.now();

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = normalizeUrl(req.url ?? '/');
    const method = (req.method ?? 'GET').toUpperCase();

    // CORS-friendly preflight (harmless same-origin, useful for direct API use)
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }

    if (url === '/health') {
      sendJson(res, 200, { status: 'ok', service: name, uptimeSec: Math.round((Date.now() - bootAt) / 1000) });
      return;
    }

    if (url === '/api/meta') {
      sendJson(res, 200, {
        service: name,
        type: meta.type,
        protocol: meta.protocol,
        description: meta.description,
        commit: meta.commit,
        branch: meta.branch,
        hardwareTier: meta.tier,
        region: meta.region,
        console: 'GET / opens the interactive console',
        runtime: { mode: 'builtin-runner', version: RUNNER_VERSION },
        endpoints: ['GET /health', 'GET /api/meta', 'GET /api/stats', 'GET /api/time', 'POST /api/echo', 'GET /api/kv', 'PUT /api/kv/{key}', 'DELETE /api/kv/{key}', 'GET /api/requests'].concat(streamEnabled ? ['GET /sse'] : []),
      });
      return;
    }

    if (url === '/api/stats') {
      const st = getLiveState(serviceId);
      const last60 = st.ring.filter((r) => Date.now() - new Date(r.at).getTime() < 60_000);
      sendJson(res, 200, {
        service: name,
        startedAtMs: bootAt,
        startedAt: new Date(bootAt).toISOString(),
        uptimeSec: Math.round((Date.now() - bootAt) / 1000),
        totalRequests: st.stats.totalRequests,
        okResponses: st.stats.okResponses,
        errorResponses: st.stats.errorResponses,
        totalMs: Math.round(st.stats.totalMs),
        avgLatencyMs: st.stats.totalRequests ? Math.round(st.stats.totalMs / st.stats.totalRequests) : 0,
        p95LatencyMs: percentile(st.latencies, 95),
        requestsLast60s: last60.length,
        requestsPerMin: last60.length,
        byPath: st.stats.byPath,
        lastRequestAt: st.stats.lastRequestAt,
        runtime: { pid: process.pid, port, mode: 'builtin-runner' },
      });
      return;
    }

    if (url === '/api/time') {
      const now = new Date();
      sendJson(res, 200, { iso: now.toISOString(), epochMs: now.getTime(), timezone: 'UTC', runnerUptimeSec: Math.round((Date.now() - bootAt) / 1000) });
      return;
    }

    if (url === '/api/echo') {
      let raw = '';
      let payload: unknown = null;
      try {
        raw = (await readBody(req)).toString('utf8');
      } catch {
        sendJson(res, 413, { error: `Body too large (max ${Math.round(MAX_VALUE_BYTES / 1024)} KB)` });
        return;
      }
      payload = raw ? safeParse<unknown>(raw, raw) : null;
      sendJson(res, 200, {
        service: name,
        method,
        receivedAt: new Date().toISOString(),
        contentType: req.headers['content-type'] ?? null,
        bodyBytes: raw.length,
        body: payload,
      });
      return;
    }

    if (url === '/api/kv' && method === 'GET') {
      const rows = await db.serviceData.findMany({
        where: { serviceId },
        orderBy: { updatedAt: 'desc' },
      });
      // NOTE: filter internal "__" keys in JS — SQLite LIKE treats "_" as a
      // wildcard, so a NOT startsWith('__') clause would exclude everything.
      sendJson(res, 200, {
        data: rows
          .filter((r) => !r.key.startsWith('__'))
          .map((r) => ({ key: r.key, value: safeParse<unknown>(r.valueJson, r.valueJson), updatedAt: r.updatedAt })),
      });
      return;
    }

    if (url.startsWith('/api/kv/')) {
      const key = decodeURIComponent(url.slice('/api/kv/'.length));
      if (!key || key.length > MAX_KEY_LEN || key.startsWith('__')) {
        sendJson(res, 400, { error: 'Invalid key (max 120 chars, no __ prefix)' });
        return;
      }

      if (method === 'GET') {
        const row = await db.serviceData.findUnique({ where: { serviceId_key: { serviceId, key } } });
        if (!row) {
          sendJson(res, 404, { error: `Key "${key}" not found`, service: name });
          return;
        }
        sendJson(res, 200, { key: row.key, value: safeParse<unknown>(row.valueJson, row.valueJson), updatedAt: row.updatedAt });
        return;
      }

      if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
        let raw = '';
        try {
          raw = (await readBody(req)).toString('utf8');
        } catch {
          sendJson(res, 413, { error: `Value too large (max ${Math.round(MAX_VALUE_BYTES / 1024)} KB)` });
          return;
        }
        const row = await db.serviceData.upsert({
          where: { serviceId_key: { serviceId, key } },
          update: { valueJson: raw },
          create: { serviceId, key, valueJson: raw },
        });
        sendJson(res, row.createdAt.getTime() === row.updatedAt.getTime() ? 201 : 200, {
          key: row.key,
          value: safeParse<unknown>(row.valueJson, row.valueJson),
          updatedAt: row.updatedAt,
          persisted: true,
        });
        return;
      }

      if (method === 'DELETE') {
        try {
          await db.serviceData.delete({ where: { serviceId_key: { serviceId, key } } });
          sendJson(res, 200, { deleted: true, key });
        } catch {
          sendJson(res, 404, { error: `Key "${key}" not found`, service: name });
        }
        return;
      }

      sendJson(res, 405, { error: `Method ${method} not allowed on /api/kv/{key}` });
      return;
    }

    if (url === '/api/requests') {
      const st = getLiveState(serviceId);
      sendJson(res, 200, { data: st.ring.slice(-RING_CAP), total: st.stats.totalRequests });
      return;
    }

    if (url === '/sse' && streamEnabled) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ service: name, tick, at: new Date().toISOString(), uptimeSec: Math.round((Date.now() - bootAt) / 1000) })}\n\n`);
        if (tick >= 600) { clearInterval(timer); res.end(); }
      }, 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (url === '/' || url === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderAppPage(name, meta, streamEnabled));
      return;
    }

    sendJson(res, 404, { error: 'not found', service: name, path: url, hint: 'GET / opens the interactive console — GET /api/meta lists endpoints' });
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const rawPath = (req.url ?? '/').split('?')[0] || '/';
    const isStream = rawPath === '/sse';
    if (!isStream) {
      res.on('finish', () => {
        try {
          recordRequest(serviceId, { method: (req.method ?? 'GET').toUpperCase(), path: rawPath.slice(0, 120), status: res.statusCode, ms: Date.now() - t0 });
        } catch {
          /* metrics must never break serving */
        }
      });
    }
    route(req, res).catch((err) => {
      console.error(`[runner:${name}] handler error`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal runner error', service: name });
      else res.end();
    });
  });
  (server as http.Server & { __v?: number }).__v = RUNNER_VERSION;
  return server;
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

async function startRuntime(svc: {
  id: string; name: string; type: string; commitHash: string; branch: string;
  hardwareTier: string; region: string; description: string; protocol: string;
}): Promise<ServiceRuntime> {
  const meta: RunnerMeta = {
    type: svc.type,
    commit: svc.commitHash,
    branch: svc.branch,
    tier: svc.hardwareTier,
    region: svc.region,
    description: svc.description,
    protocol: svc.protocol,
  };

  const port = await allocatePort(svc.id);
  const server = createRunnerApp(svc.id, svc.name, meta, port);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  runners.set(svc.id, server);

  const state: RuntimeState = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    mode: 'builtin-runner',
    healthy: true,
  };
  await db.service.update({ where: { id: svc.id }, data: { runtimeJson: JSON.stringify(state) } });
  await loadPersistedStats(svc.id);
  await writeLog(svc.id, `Runtime for "${svc.name}" is listening on 127.0.0.1:${port} (builtin runner v${RUNNER_VERSION}). Interactive console: /api/ingress/${svc.name}`);
  return { ...state, healthy: true };
}

export async function stopRuntime(svc: { id: string; name: string }): Promise<void> {
  const server = runners.get(svc.id);
  if (server) {
    (server as http.Server & { closeIdleConnections?: () => void }).closeIdleConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runners.delete(svc.id);
    await writeLog(svc.id, `Runtime for "${svc.name}" terminated — port released.`);
  }
  const row = await db.service.findUnique({ where: { id: svc.id }, select: { runtimeJson: true } });
  if (row?.runtimeJson) {
    await db.service.update({ where: { id: svc.id }, data: { runtimeJson: null } });
  }
}

async function readRuntimeState(serviceId: string): Promise<RuntimeState | null> {
  const row = await db.service.findUnique({ where: { id: serviceId }, select: { runtimeJson: true } });
  return safeParse<RuntimeState | null>(row?.runtimeJson ?? null, null);
}

/** Replace a stale runner (old app version / unhealthy) with a fresh one. */
async function replaceRuntime(svc: {
  id: string; name: string; status: string; type: string; commitHash: string; branch: string;
  hardwareTier: string; region: string; description: string; protocol: string;
}): Promise<ServiceRuntime | null> {
  const old = runners.get(svc.id);
  if (old) {
    await new Promise<void>((resolve) => old.close(() => resolve()));
    runners.delete(svc.id);
  }
  return startRuntime(svc);
}

/**
 * Reconcile one service with the desired state:
 *  - running  → guarantee a live listener with the CURRENT app version
 *  - anything else → guarantee no listener
 * Returns fresh runtime info for running services.
 *
 * Git-deployed services (repoUrl set) are managed by deployer.ts — their
 * runtimeJson.mode is 'git-deploy' and they own a REAL child process. We only
 * trust + health-check them here, never replacing them with a builtin runner.
 */
export async function ensureRuntime(svc: {
  id: string; name: string; status: string; type: string; commitHash: string; branch: string;
  hardwareTier: string; region: string; description: string; protocol: string;
  repoUrl?: string;
}): Promise<ServiceRuntime | null> {
  if (svc.status !== 'running') {
    await stopRuntime(svc);
    return null;
  }

  // ── git-deployed service: trust the deployer's real child process ──────
  const stored = await readRuntimeState(svc.id);
  if (stored?.mode === 'git-deploy') {
    const healthy = await isHealthy(stored.port);
    if (healthy !== stored.healthy) {
      const updated = { ...stored, healthy };
      await db.service.update({ where: { id: svc.id }, data: { runtimeJson: JSON.stringify(updated) } });
      return updated;
    }
    return { ...stored, healthy };
  }

  const inProcess = runners.get(svc.id);
  if (inProcess) {
    const version = (inProcess as http.Server & { __v?: number }).__v;
    if (version !== RUNNER_VERSION) {
      return replaceRuntime(svc);
    }
    if (stored) {
      const healthy = await isHealthy(stored.port);
      if (healthy !== stored.healthy) {
        const updated = { ...stored, healthy };
        await db.service.update({ where: { id: svc.id }, data: { runtimeJson: JSON.stringify(updated) } });
        return updated;
      }
      return { ...stored, healthy };
    }
  }

  // Not served by THIS process — maybe another worker/instance already serves it.
  if (stored) {
    const healthy = await isHealthy(stored.port);
    if (healthy) {
      if (!stored.healthy) {
        const updated = { ...stored, healthy: true };
        await db.service.update({ where: { id: svc.id }, data: { runtimeJson: JSON.stringify(updated) } });
        return updated;
      }
      return { ...stored, healthy: true };
    }
  }

  const fresh = await startRuntime(svc);
  return fresh;
}

type ReconcileGlobal = typeof globalThis & { __hosterReconcile?: { busy: boolean; lastRun: number } };
const rg = globalThis as ReconcileGlobal;

/** Reconciles all services (started missing runners, stops orphans). Cheap to call often. */
export async function reconcileRuntimes(): Promise<void> {
  rg.__hosterReconcile ??= { busy: false, lastRun: 0 };
  const rec = rg.__hosterReconcile;
  if (rec.busy || Date.now() - rec.lastRun < 2_000) return;
  rec.busy = true;
  try {
    const rows = await db.service.findMany({
      where: { OR: [{ status: 'running' }, { runtimeJson: { not: null } }] },
    });
    for (const row of rows) {
      // git-deployed services run as real child processes owned by deployer.ts;
      // ensureRuntime health-checks them but never spawns a builtin runner.
      try {
        await ensureRuntime(row);
      } catch (err) {
        console.error(`[runtime] reconcile failed for ${row.name}`, err);
      }
    }
  } finally {
    rec.busy = false;
    rec.lastRun = Date.now();
  }
}
