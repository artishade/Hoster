/**
 * NexusHost Terminal Service — real per-service PTY web terminal.
 *
 * Runtime: NODE (node-pty's fork() is incompatible with bun's multithreaded
 * runtime — children die instantly; verified working under node 24).
 *
 * - socket.io server on port 3031 (path '/', fronted by the sandbox gateway
 *   via ?XTransformPort=3031 — see Caddyfile).
 * - 'attach' {service, cols, rows} → validates the service against the REAL
 *   control plane API (localhost:3000/api/services), then spawns a REAL bash
 *   PTY (node-pty) with cwd = the service's deployment workspace.
 * - Bidirectional streaming: 'data' (server→client), 'input' (client→server),
 *   'resize' {cols, rows} → pty.resize (real TIOCSWINSZ).
 * - Guardrails: name regex, control-plane existence check, workspace on disk,
 *   max 6 concurrent sessions (max 2 per service), 30-min idle reaper,
 *   PTY killed on disconnect. Sessions are recorded as REAL LogEntry rows
 *   via POST /api/logs so they appear in the platform Activity feed.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { spawn } from 'node-pty';
import { Server } from 'socket.io';

const PORT = 3031;
const CONTROL_PLANE = 'http://localhost:3000';
const DEPLOYMENTS_ROOT = '/home/z/my-project/deployments';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_SESSIONS = 6;
const MAX_PER_SERVICE = 2;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** @typedef {{ pty: import('node-pty').IPty, service: string, socketId: string, lastActivity: number, idleTimer: NodeJS.Timeout, closed: boolean }} Session */
/** @type {Map<string, Session>} */
const sessions = new Map(); // socketId → session

// ── Control-plane integration (single source of truth) ──────────────────────
let servicesCache = { at: 0, data: [] };

async function fetchServices() {
  if (Date.now() - servicesCache.at < 10_000) return servicesCache.data;
  try {
    const res = await fetch(`${CONTROL_PLANE}/api/services`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json();
      servicesCache = { at: Date.now(), data: Array.isArray(json?.data) ? json.data : [] };
    }
  } catch {
    /* fall back to stale cache */
  }
  return servicesCache.data;
}

async function lookupService(name) {
  const services = await fetchServices();
  const svc = services.find((s) => s?.name === name);
  if (!svc) return null;
  // Prefer the runtime-reported workspace; fall back to the on-disk path —
  // failed deployments keep their workspace and a shell there is exactly
  // how you debug why the readiness probe failed.
  const repoDir = svc?.runtime?.repoDir || `${DEPLOYMENTS_ROOT}/${name}/repo`;
  return { id: svc.id, status: svc.status, repoDir };
}

async function platformLog(serviceId, level, message) {
  try {
    await fetch(`${CONTROL_PLANE}/api/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceId: serviceId ?? null,
        scope: serviceId ? 'service' : 'system',
        level,
        message,
        source: 'terminal-service',
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* logging is best-effort */
  }
}

const httpServer = createServer((req, res) => {
  // NOTE: with socket.io path '/', engine.io takes over ALL http requests on
  // this server — this handler only runs for requests engine.io rejects.
  // Liveness check = any HTTP response (e.g. "Transport unknown" body).
  res.writeHead(404);
  res.end('not found');
});

const io = new Server(httpServer, {
  // DO NOT change the path — the gateway (Caddy) forwards ?XTransformPort=3031
  // to this port and socket.io must serve its transport on '/'.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
});

function killSession(session, reason) {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.idleTimer);
  try {
    session.pty.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(session.socketId);
  console.log(`[terminal] session closed (${session.service}/${session.socketId}): ${reason}`);
}

io.on('connection', (socket) => {
  socket.on('attach', async (payload, ack) => {
    const reply = (r) => ack?.(r);

    // ── Validation ──────────────────────────────────────────────────────
    const service = typeof payload?.service === 'string' ? payload.service : '';
    const cols = Math.min(Math.max(Number(payload?.cols) || 80, 10), 500);
    const rows = Math.min(Math.max(Number(payload?.rows) || 24, 6), 300);

    if (!NAME_RE.test(service)) return reply({ ok: false, error: 'invalid service name' });
    if (sessions.size >= MAX_SESSIONS) return reply({ ok: false, error: 'terminal pool full (6 sessions) — detach one first' });
    const perService = [...sessions.values()].filter((s) => s.service === service).length;
    if (perService >= MAX_PER_SERVICE) return reply({ ok: false, error: `service already has ${MAX_PER_SERVICE} active terminals` });

    const svc = await lookupService(service);
    if (!svc) return reply({ ok: false, error: `unknown service "${service}"` });
    if (!svc.repoDir || !existsSync(svc.repoDir)) {
      return reply({ ok: false, error: 'no deployment workspace on disk (builtin runners run in-process — no shell)' });
    }

    // ── Spawn REAL bash PTY inside the service workspace ────────────────
    let pty;
    try {
      pty = spawn('bash', ['--noprofile', '--norc'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: svc.repoDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          PS1: '\\[\\e[38;5;51m\\]\\u@nexushost\\[\\e[0m\\]:\\[\\e[38;5;220m\\]\\W\\[\\e[0m\\]$ ',
          NEXUSHOST_SERVICE: service,
          NEXUSHOST_DEPLOY_ROOT: svc.repoDir,
        },
      });
    } catch (e) {
      return reply({ ok: false, error: `spawn failed: ${e?.message ?? e}` });
    }

    const session = {
      pty,
      service,
      socketId: socket.id,
      lastActivity: Date.now(),
      closed: false,
      idleTimer: null,
    };
    session.idleTimer = setTimeout(() => killSession(session, 'idle timeout (30 min)'), IDLE_TIMEOUT_MS);
    sessions.set(socket.id, session);

    platformLog(svc.id, 'info', `Web terminal attached to workspace deployments/${service}/repo (pty pid ${pty.pid})`);

    pty.onData((data) => {
      if (!session.closed) socket.emit('data', data);
    });
    pty.onExit(({ exitCode }) => {
      socket.emit('exit', { code: exitCode });
      killSession(session, `shell exited (${exitCode})`);
      platformLog(svc.id, 'info', `Web terminal detached (shell exit ${exitCode})`);
    });

    socket.on('input', (data) => {
      if (typeof data !== 'string' || session.closed) return;
      session.lastActivity = Date.now();
      pty.write(data);
    });
    socket.on('resize', (r) => {
      if (session.closed) return;
      const c = Math.min(Math.max(Number(r?.cols) || 80, 10), 500);
      const rw = Math.min(Math.max(Number(r?.rows) || 24, 6), 300);
      try {
        pty.resize(c, rw);
        session.lastActivity = Date.now();
      } catch {
        /* resize after exit */
      }
    });
    socket.on('detach', () => killSession(session, 'client detached'));
    socket.on('disconnect', () => killSession(session, 'socket disconnected'));

    reply({ ok: true, pid: pty.pid, cwd: svc.repoDir, status: svc.status });
  });
});

// ── Idle reaper (belt & suspenders beyond per-session timers) ───────────────
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastActivity > IDLE_TIMEOUT_MS) killSession(s, 'idle reaper');
  }
}, 60_000).unref();

httpServer.listen(PORT, () => {
  console.log(`[terminal] NexusHost terminal service listening on :${PORT} (node ${process.version}, socket.io path "/")`);
});

process.on('SIGTERM', () => {
  for (const s of sessions.values()) killSession(s, 'service shutting down');
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
