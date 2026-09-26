import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { db } from '@/lib/db';
import { allocatePort, recordExternalRequest, stopRuntime, writeRunnerLog, getLiveStateSnapshot } from './runtime';
import { readProcStats, isPidAlive, forgetPid } from './procstats';
import type { ServiceRuntime } from './types';
/**
 * REAL deployer: git clone → detect stack → install deps → build → spawn →
 * health-check. There are no timers anywhere in this pipeline — every state
 * transition is caused by an actual process exit code, an actual HTTP
 * response, or an actual filesystem artifact.
 *
 * Lifecycle (driven by real events):
 *   building   — git clone + dependency install + build command are running
 *   deploying  — app process spawned, waiting for the port to answer HTTP
 *   running    — the spawned process answered; runtimeJson now holds its
 *                REAL pid + port + commit
 *   failed     — a step exited non-zero (the real stderr tail is in the logs)
 *
 * Services created WITHOUT a repoUrl fall back to the interactive builtin
 * runner (runtime.ts) which is itself a real HTTP server.
 */

export const DEPLOY_ROOT = path.join(process.cwd(), 'deployments');

const GIT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 240_000;
const BUILD_TIMEOUT_MS = 300_000;
const BOOT_TIMEOUT_MS = 60_000;
const BOOT_POLL_MS = 500;
const LOG_TAIL_BYTES = 8_000;

export interface DeployHandle {
  pid: number;
  port: number;
  startedAt: string;
  commit: string;
  repoDir: string;
}

interface DeployGlobal {
  __nxDeploys?: Map<string, DeployHandle>;
  __nxDeploysBusy?: Set<string>;
  __nxDeployChildren?: Map<string, ChildProcess>;
  __nxDeployOps?: Map<string, number>; // real op counters per service
  __nxLogTails?: Map<string, { offset: number; timer: NodeJS.Timeout }>;
  __nxSelfHeals?: Map<string, number[]>; // timestamps of self-heals per service
}
/** Path of a service's persistent app log file. */
function appLogPath(workspace: string): string {
  return path.join(workspace, 'app.log');
}

/**
 * Tail a service's app.log file → LogEntry rows (source 'app').
 * Survives control-plane restarts, streams at ~1s granularity, and caps
 * the persisted line rate so a chatty app can't flood the DB.
 */
function tailAppLog(serviceId: string, logPath: string): void {
  const g = globalThis as DeployGlobal;
  const tails = g.__nxLogTails ?? new Map<string, { offset: number; timer: NodeJS.Timeout }>();
  g.__nxLogTails = tails;

  const prev = tails.get(serviceId);
  if (prev) {
    clearInterval(prev.timer);
    tails.delete(serviceId);
  }

  // start at current end (history is on disk; only NEW lines stream)
  let offset = 0;
  try {
    offset = fs.statSync(logPath).size;
  } catch {
    offset = 0;
  }

  const BUDGET_WINDOW_MS = 30_000;
  const BUDGET_LINES = 60; // max persisted lines per 30s window
  const budgetTimes: number[] = [];

  const timer = setInterval(() => {
    try {
      const st = fs.statSync(logPath);
      if (st.size <= offset) return;
      const fd = fs.openSync(logPath, 'r');
      const length = Math.min(st.size - offset, 512 * 1024);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      fs.closeSync(fd);
      offset += length;
      const text = buf.toString('utf8');

      // trim the in-window budget
      const now = Date.now();
      while (budgetTimes.length && now - budgetTimes[0] > BUDGET_WINDOW_MS) budgetTimes.shift();

      for (const line of text.split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        if (budgetTimes.length >= BUDGET_LINES) continue; // rate-limited, not lost on disk
        budgetTimes.push(now);
        void writeRunnerLog(serviceId, line.trimEnd().slice(0, 2000), 'app');
      }
    } catch {
      /* file rotated/removed */
    }
  }, 1000);
  timer.unref?.();
  tails.set(serviceId, { offset, timer });
}

/** Stop the log tailer for a service (process exited / service stopped). */
function stopAppLogTail(serviceId: string): void {
  const g = globalThis as DeployGlobal;
  const tails = g.__nxLogTails;
  const t = tails?.get(serviceId);
  if (t) {
    clearInterval(t.timer);
    tails?.delete(serviceId);
  }
}

/** Bounded self-heal accounting: max 3 restarts per 2h per service. */
function maySelfHeal(serviceId: string): boolean {
  const g = globalThis as DeployGlobal;
  const heals = g.__nxSelfHeals ?? new Map<string, number[]>();
  g.__nxSelfHeals = heals;
  const now = Date.now();
  const WINDOW_MS = 2 * 60 * 60 * 1000;
  const times = (heals.get(serviceId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= 3) {
    heals.set(serviceId, times);
    return false; // chronic crashing — stop auto-restarting
  }
  times.push(now);
  heals.set(serviceId, times);
  return true;
}
const g = globalThis as DeployGlobal;
const deploys = g.__nxDeploys ?? new Map<string, DeployHandle>();
g.__nxDeploys = deploys;
const busy = g.__nxDeploysBusy ?? new Set<string>();
g.__nxDeploysBusy = busy;
const children = g.__nxDeployChildren ?? new Map<string, ChildProcess>();
g.__nxDeployChildren = children;
const opCounters = g.__nxDeployOps ?? new Map<string, number>();
g.__nxDeployOps = opCounters;

// ─── logging ────────────────────────────────────────────────────────────────

async function dlog(serviceId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  try {
    await db.logEntry.create({
      data: { serviceId, scope: 'deploy', level, message, source: 'git-deployer' },
    });
  } catch {
    /* logging must never break deploys */
  }
}

function tailText(buf: Buffer, max = 400): string {
  const t = buf.toString('utf8');
  return t.length > max ? '…' + t.slice(t.length - max) : t;
}

// ─── process runner with REAL streaming logs ─────────────────────────────────

interface RunOpts {
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
  onLine?: (line: string, source: 'stdout' | 'stderr') => void;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function run(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];
    let outCarry = '';
    let errCarry = '';

    child.stdout?.on('data', (c: Buffer) => {
      chunksOut.push(c);
      if (chunksOut.reduce((n, b) => n + b.length, 0) > 512 * 1024) chunksOut.shift();
      if (opts.onLine) {
        outCarry += c.toString('utf8');
        // \r (progress bars) starts a new line too
        const lines = outCarry.split(/[\r\n]+/);
        outCarry = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) opts.onLine(l.trimEnd(), 'stdout');
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      chunksErr.push(c);
      if (chunksErr.reduce((n, b) => n + b.length, 0) > 512 * 1024) chunksErr.shift();
      if (opts.onLine) {
        errCarry += c.toString('utf8');
        const lines = errCarry.split(/[\r\n]+/);
        errCarry = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) opts.onLine(l.trimEnd(), 'stderr');
      }
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(chunksOut), stderr: Buffer.from(String(err)) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.onLine) {
        if (outCarry.trim()) opts.onLine(outCarry.trimEnd(), 'stdout');
        if (errCarry.trim()) opts.onLine(errCarry.trimEnd(), 'stderr');
      }
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunksOut), stderr: Buffer.concat(chunksErr) });
    });
  });
}

async function waitHttpOk(port: number, timeoutMs: number, pathToTry: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathToTry}`, {
        signal: AbortSignal.timeout(1200),
        cache: 'no-store',
        redirect: 'manual',
      });
      // Any HTTP answer (including 4xx/5xx) means the app is REALLY serving.
      if (res.status < 500 || res.status === 501) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
  }
  return false;
}

// ─── stack detection ─────────────────────────────────────────────────────────

interface DetectedStack {
  runtime: 'node' | 'python' | 'static' | 'unknown';
  startCommand: string;
  buildCommand: string | null;
  reason: string;
}

async function detectStack(repoDir: string, pkg: Record<string, unknown> | null, hasIndexHtml: boolean): Promise<DetectedStack> {
  if (pkg && typeof pkg === 'object' && typeof (pkg as Record<string, unknown>).scripts !== 'undefined') {
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    if (scripts.start) {
      return { runtime: 'node', startCommand: `bun run start`, buildCommand: scripts.build ? 'bun run build' : null, reason: 'package.json with a start script' };
    }
    if (scripts.dev && !scripts.start) {
      return { runtime: 'node', startCommand: `bun run dev`, buildCommand: scripts.build ? 'bun run build' : null, reason: 'package.json with a dev script (dev-style repo)' };
    }
    // package.json with no start/dev scripts but dependencies → likely a library; run main if present
    const main = typeof (pkg as Record<string, unknown>).main === 'string' ? (pkg as Record<string, string>).main : null;
    if (main) {
      return { runtime: 'node', startCommand: `bun ${main}`, buildCommand: null, reason: `package.json main entry (${main})` };
    }
  }
  const hasPy = await fsp
    .access(path.join(repoDir, 'requirements.txt'))
    .then(() => true)
    .catch(() => false);
  const hasAppPy = await fsp
    .access(path.join(repoDir, 'app.py'))
    .then(() => true)
    .catch(() => false);
  const hasMainPy = await fsp
    .access(path.join(repoDir, 'main.py'))
    .then(() => true)
    .catch(() => false);
  if (hasPy && (hasAppPy || hasMainPy)) {
    return { runtime: 'python', startCommand: `python3 ${hasAppPy ? 'app.py' : 'main.py'}`, buildCommand: null, reason: 'Python project (requirements.txt)' };
  }
  if (hasIndexHtml) {
    return { runtime: 'static', startCommand: '__static__', buildCommand: null, reason: 'static index.html at repo root' };
  }
  return { runtime: 'unknown', startCommand: '', buildCommand: null, reason: 'no recognizable stack' };
}

// ─── static file server child ────────────────────────────────────────────────

function spawnStaticServer(repoDir: string, port: number, serviceId: string): ChildProcess {
  // A real Node static file server for the cloned repo's root.
  const script = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = ${JSON.stringify(repoDir)};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, path.normalize(p).replace(/^([.][.][/\\\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(root, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found', path: p })); }
        else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(d2); }
      });
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(${port}, '127.0.0.1', () => console.log('static server on ' + ${port}));
`;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, cwd: repoDir, detached: true });
  child.stdout?.on('data', (c: Buffer) => {
    const line = c.toString('utf8').trim();
    if (line) void writeRunnerLog(serviceId, line, 'app');
  });
  child.stderr?.on('data', (c: Buffer) => {
    const line = c.toString('utf8').trim();
    if (line) void writeRunnerLog(serviceId, line, 'app');
  });
  return child;
}

// ─── the deploy pipeline ─────────────────────────────────────────────────────

export interface DeployableService {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  buildCommand: string;
  startCommand: string;
  port?: number;
  envVarsJson: string;
  volumeMountsJson: string;
}

interface EnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

async function setStatus(serviceId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.service.update({ where: { id: serviceId }, data: { status, ...extra } });
}

/**
 * Execute the REAL deployment pipeline for a service. Fire-and-forget safe:
 * every transition is persisted; failures set status=failed with real stderr.
 */
export async function startDeployment(svc: DeployableService): Promise<void> {
  if (busy.has(svc.id)) return;
  busy.add(svc.id);
  const workspace = path.join(DEPLOY_ROOT, svc.name);
  const repoDir = path.join(workspace, 'repo');
  const envVars = safeParse<EnvVar[]>(svc.envVarsJson, []);

  try {
    await fsp.mkdir(workspace, { recursive: true });

    // ── 1. git clone (fresh) ────────────────────────────────────────────
    await setStatus(svc.id, 'building');
    await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await dlog(svc.id, `git clone ${svc.repoUrl} (branch ${svc.branch}, depth 1) → ${repoDir}`);

    const clone = await run('git', ['clone', '--depth', '1', '--branch', svc.branch, '--progress', svc.repoUrl, repoDir], {
      timeoutMs: GIT_TIMEOUT_MS,
      onLine: (line, src) => void dlog(svc.id, `[git] ${line}`, src === 'stderr' ? 'info' : 'info'),
    });
    if (clone.code !== 0) {
      const tail = tailText(clone.stderr, 600) || tailText(clone.stdout, 600) || `git exited with code ${clone.code}`;
      await dlog(svc.id, `Clone FAILED (exit ${clone.code}): ${tail}`, 'error');
      await setStatus(svc.id, 'failed');
      return;
    }
    await dlog(svc.id, `Clone OK — repo on disk at ${repoDir} (${(await dirSizeMb(repoDir)).toFixed(1)} MB)`);

    // ── 2. real commit metadata ─────────────────────────────────────────
    const hashRes = await run('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 10_000 });
    const msgRes = await run('git', ['-C', repoDir, 'log', '-1', '--pretty=%s'], { timeoutMs: 10_000 });
    const commitHash = hashRes.stdout.toString('utf8').trim() || 'unknown';
    const commitMessage = msgRes.stdout.toString('utf8').trim() || `Deployed from ${svc.branch}`;

    // ── 3. detect stack ──────────────────────────────────────────────────
    let pkg: Record<string, unknown> | null = null;
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(repoDir, 'package.json'), 'utf8'));
    } catch {
      pkg = null;
    }
    const hasIndexHtml = await fsp
      .access(path.join(repoDir, 'index.html'))
      .then(() => true)
      .catch(() => false);
    const detected = await detectStack(repoDir, pkg, hasIndexHtml);

    const buildCmd = svc.buildCommand || detected.buildCommand || '';
    const startCmd = svc.startCommand || detected.startCommand || '';
    await dlog(svc.id, `Stack detected: ${detected.reason} → runtime=${detected.runtime}${buildCmd ? `, build="${buildCmd}"` : ''}, start="${startCmd || '(static server)'}"`);

    if (detected.runtime === 'unknown' && !startCmd) {
      await dlog(svc.id, 'No runnable entrypoint found (no package.json start/dev, no python app, no index.html). Deployment failed.', 'error');
      await setStatus(svc.id, 'failed');
      return;
    }

    // ── 4. install dependencies (node) ───────────────────────────────────
    if (detected.runtime === 'node') {
      await dlog(svc.id, 'Installing dependencies with bun install...');
      const install = await run('bun', ['install'], {
        cwd: repoDir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: (line) => void dlog(svc.id, `[bun install] ${line}`),
      });
      if (install.code !== 0) {
        // retry with npm if bun failed (some repos need npm semantics)
        await dlog(svc.id, 'bun install failed — retrying with npm install...', 'warn');
        const install2 = await run('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: repoDir,
          timeoutMs: INSTALL_TIMEOUT_MS,
          onLine: (line) => void dlog(svc.id, `[npm install] ${line}`),
        });
        if (install2.code !== 0) {
          await dlog(svc.id, `Install FAILED: ${tailText(install2.stderr, 600)}`, 'error');
          await setStatus(svc.id, 'failed');
          return;
        }
      }
      await dlog(svc.id, 'Dependencies installed.');
    } else if (detected.runtime === 'python') {
      await dlog(svc.id, 'Installing python dependencies with pip (user site)...');
      const pip = await run('python3', ['-m', 'pip', 'install', '--user', '-r', 'requirements.txt'], {
        cwd: repoDir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: (line) => void dlog(svc.id, `[pip] ${line}`),
      });
      if (pip.code !== 0) {
        await dlog(svc.id, `pip install FAILED: ${tailText(pip.stderr, 600)} — continuing, app may still boot`, 'warn');
      }
    }

    // ── 5. build ─────────────────────────────────────────────────────────
    if (buildCmd) {
      await dlog(svc.id, `Running build: ${buildCmd}`);
      const build = await run('bash', ['-lc', buildCmd], {
        cwd: repoDir,
        timeoutMs: BUILD_TIMEOUT_MS,
        onLine: (line, src) => void dlog(svc.id, `[build] ${line}`),
      });
      if (build.code !== 0) {
        await dlog(svc.id, `Build FAILED (exit ${build.code}): ${tailText(build.stderr, 800)}`, 'error');
        await setStatus(svc.id, 'failed');
        return;
      }
      await dlog(svc.id, 'Build completed successfully.');
    }

    // ── 6. spawn the app process ─────────────────────────────────────────
    await setStatus(svc.id, 'deploying');
    await stopRuntime(svc); // release any previous listener

    // reap stray processes still holding this workspace (pre-restart zombies)
    const strays = killStrayWorkspaceProcesses(workspace);
    if (strays > 0) {
      await dlog(svc.id, `Reaped ${strays} stray process(es) left in the workspace from a previous run before spawning.`, 'warn');
    }

    const port = svc.port && svc.port > 1024 && svc.port < 65536 ? await portOrAllocate(svc) : await portOrAllocate(svc);
    const childEnv: Record<string, string> = {
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      BUN_ENV: 'production',
    };
    for (const v of envVars) childEnv[v.key] = v.value;
    // REAL volume mounts → the app gets a bind path env var + a symlinked dir
    const mounts = safeParse<{ volumeId: string; mountPath: string }[]>(svc.volumeMountsJson, []);
    for (const m of mounts) {
      try {
        const vol = await db.volume.findUnique({ where: { id: m.volumeId } });
        if (vol) {
          const volDir = path.join(process.cwd(), 'volumes-data', vol.name);
          await fsp.mkdir(volDir, { recursive: true });
          const envKey = 'VOLUME_' + m.mountPath.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
          childEnv[envKey] = volDir;
          await dlog(svc.id, `Volume "${vol.name}" bind path ${volDir} exported as ${envKey}`);
        }
      } catch {
        /* volume mount is best-effort */
      }
    }

    let child: ChildProcess;
    if (detected.runtime === 'static') {
      child = spawnStaticServer(repoDir, port, svc.id);
    } else {
      // App stdout/stderr go straight to a FILE (restart-proof): the log
      // survives control-plane restarts, a tailer streams it into LogEntry,
      // and the app can never EPIPE-crash when the parent server dies.
      const logFd = fs.openSync(appLogPath(workspace), 'a');
      child = spawn('bash', ['-lc', startCmd], {
        cwd: repoDir,
        env: { ...process.env, ...childEnv },
        stdio: ['ignore', logFd, logFd],
        detached: true, // own process group → clean tree kill
      });
      try {
        fs.closeSync(logFd);
      } catch {
        /* fd dup'ed into the child */
      }
    }
    tailAppLog(svc.id, appLogPath(workspace));

    children.set(svc.id, child);
    const pid = child.pid ?? -1;
    await dlog(svc.id, `App process spawned (pid ${pid}) — waiting for HTTP on 127.0.0.1:${port}...`);

    child.on('exit', (code, signal) => {
      children.delete(svc.id);
      deploys.delete(svc.id);
      forgetPid(pid);
      stopAppLogTail(svc.id);
      void (async () => {
        // Guard against stale exit handlers: only fail the service if the DB
        // still points at THIS process (a restart replaces runtimeJson first).
        const row = await db.service.findUnique({ where: { id: svc.id }, select: { status: true, runtimeJson: true } }).catch(() => null);
        if (!row) return;
        const runtime = safeParse<{ pid?: number } | null>(row.runtimeJson, null);
        if (runtime?.pid !== pid) return; // superseded by a newer deployment
        if (row.status === 'running') {
          if (maySelfHeal(svc.id)) {
            await dlog(svc.id, `App process exited unexpectedly (code=${code ?? '?'} signal=${signal ?? '?'}) — SELF-HEALING with a fresh deployment (bounded: max 3 per 2h).`, 'warn');
            await setStatus(svc.id, 'building');
            const fresh = await db.service.findUnique({ where: { id: svc.id } }).catch(() => null);
            if (fresh) void startDeployment(fresh).catch(() => {});
          } else {
            await dlog(svc.id, `App process exited (code=${code ?? '?'} signal=${signal ?? '?'}) — self-heal budget exhausted (3 restarts in the last 2h), marking failed.`, 'error');
            await setStatus(svc.id, 'failed');
          }
        }
      })();
    });

    const ok = await waitHttpOk(port, BOOT_TIMEOUT_MS, '/');
    if (!ok) {
      await dlog(svc.id, `App did not answer on port ${port} within ${BOOT_TIMEOUT_MS / 1000}s — killing process tree and marking failed.`, 'error');
      killTree(child);
      await setStatus(svc.id, 'failed');
      return;
    }

    // ── 7. running ────────────────────────────────────────────────────────
    const runtime: ServiceRuntime & { commit?: string; repoDir?: string } = {
      pid,
      port,
      startedAt: new Date().toISOString(),
      mode: 'git-deploy',
      healthy: true,
      commit: commitHash,
      repoDir,
    };
    deploys.set(svc.id, { pid, port, startedAt: runtime.startedAt, commit: commitHash, repoDir });
    await db.service.update({
      where: { id: svc.id },
      data: {
        status: 'running',
        commitHash,
        commitMessage,
        port,
        runtimeJson: JSON.stringify(runtime),
      },
    });
    await dlog(
      svc.id,
      `Service is LIVE — ${svc.name} answering on 127.0.0.1:${port} (pid ${pid}, commit ${commitHash}). Ingress: /api/ingress/${svc.name} · host route: ${svc.name}.nexushost.dev`
    );
  } catch (err) {
    console.error(`[deployer] pipeline error for ${svc.name}`, err);
    await dlog(svc.id, `Deployer error: ${(err as Error).message}`, 'error');
    await setStatus(svc.id, 'failed').catch(() => {});
  } finally {
    busy.delete(svc.id);
  }
}

async function portOrAllocate(svc: DeployableService): Promise<number> {
  return allocatePort(svc.id);
}

function killTree(child: ChildProcess): void {
  try {
    // child was spawned detached → its own process group; killing the group
    // takes out bash + bun + node (the whole real tree) in one shot.
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/**
 * Resolve the deepest alive descendant of a wrapper pid (bash → bun → node).
 * We monitor THE worker that actually serves HTTP, not the shell wrapper.
 */
function resolveWorkerPid(rootPid: number): number {
  let current = rootPid;
  for (let depth = 0; depth < 10; depth++) {
    let next: number | null = null;
    try {
      const childrenRaw = fs.readFileSync(`/proc/${current}/task/${current}/children`, 'utf8').trim();
      const kids = childrenRaw.split(/\s+/).filter(Boolean).map(Number).filter((p) => isPidAlive(p));
      if (kids.length > 0) next = kids[kids.length - 1]; // last-born = the app
    } catch {
      break;
    }
    if (next === null) break;
    current = next;
  }
  return current;
}

export async function stopDeployment(svc: { id: string; name: string }): Promise<void> {
  stopAppLogTail(svc.id);
  const child = children.get(svc.id);
  if (child) {
    killTree(child);
    children.delete(svc.id);
  }
  const handle = deploys.get(svc.id);
  if (handle) {
    try {
      // kill the whole process group first
      process.kill(-handle.pid, 'SIGKILL');
    } catch {
      if (isPidAlive(handle.pid)) {
        try {
          process.kill(handle.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
    }
    deploys.delete(svc.id);
    forgetPid(handle.pid);
    await dlog(svc.id, `Stopped app process tree (pid ${handle.pid}) — port ${handle.port} released.`);
  }
  await db.service.update({ where: { id: svc.id }, data: { runtimeJson: null } }).catch(() => {});
}

/** Real stats for a deployed app: process CPU/RAM + live request counters. */
export function getDeployHandle(serviceId: string): DeployHandle | null {
  return deploys.get(serviceId) ?? null;
}

export function deploymentChildAlive(serviceId: string): boolean {
  const handle = deploys.get(serviceId);
  if (!handle) return false;
  return isPidAlive(handle.pid);
}

/** Process-level real metrics for a deployed app (or null). */
export function deployProcessStats(serviceId: string): { cpuPercent: number; ramUsedGb: number; uptimeSec: number } | null {
  const handle = deploys.get(serviceId);
  if (!handle) return null;
  // monitor the real worker (bash → bun → node), not the shell wrapper
  const workerPid = resolveWorkerPid(handle.pid);
  return readProcStats(workerPid);
}

// ─── orphan adoption: re-bind surviving processes after a restart ──────────

/**
 * When the control plane restarts (dev reload, crash, deploy), its in-memory
 * deploy map is lost — but the detached app processes SURVIVE (own process
 * groups). This re-adopts them: metrics, stop/restart and crash detection all
 * come back online without disturbing the running app.
 */
async function adoptOrphanedDeployment(row: DeployableService & { runtimeJson: string | null }): Promise<void> {
  if (deploys.has(row.id) || busy.has(row.id)) return;
  const runtime = safeParse<(ServiceRuntime & { commit?: string; repoDir?: string }) | null>(row.runtimeJson, null);
  if (!runtime || runtime.mode !== 'git-deploy' || typeof runtime.pid !== 'number') return;

  if (!isPidAlive(runtime.pid)) {
    if (!maySelfHeal(row.id)) {
      await dlog(row.id, `Watchdog: app process (pid ${runtime.pid}) from a previous control-plane run is gone — self-heal budget exhausted, marking failed.`, 'error');
      await setStatus(row.id, 'failed');
      return;
    }
    await dlog(row.id, `Watchdog: app process (pid ${runtime.pid}) from a previous control-plane run is gone — self-healing: relaunching the deployment.`, 'warn');
    await setStatus(row.id, 'building');
    void startDeployment(row).catch(() => {});
    return;
  }

  // the pid exists — verify it is REALLY our app by probing its port
  const answers = await fetch(`http://127.0.0.1:${runtime.port}/`, {
    signal: AbortSignal.timeout(1500),
    cache: 'no-store',
    redirect: 'manual',
  }).catch(() => null);
  if (!answers) {
    // zombie: process alive but not serving — kill the tree and redeploy
    await dlog(
      row.id,
      `Watchdog: process pid ${runtime.pid} is alive but port ${runtime.port} does not answer (zombie after restart) — killing the tree and SELF-HEALING with a fresh deployment.`,
      'warn'
    );
    killTreeByPid(runtime.pid);
    await setStatus(row.id, 'building');
    void startDeployment(row).catch(() => {});
    return;
  }

  deploys.set(row.id, {
    pid: runtime.pid,
    port: runtime.port,
    startedAt: runtime.startedAt,
    commit: runtime.commit ?? '',
    repoDir: runtime.repoDir ?? '',
  });
  watchAdoptedProcess(row.id, runtime.pid);
  // resume streaming the persistent app.log into the activity feed
  const ws = runtime.repoDir ? path.dirname(runtime.repoDir) : path.join(DEPLOY_ROOT, row.name);
  tailAppLog(row.id, appLogPath(ws));
  await dlog(
    row.id,
    `Watchdog: ADOPTED surviving app process (pid ${runtime.pid}, port ${runtime.port}) after control-plane restart — metrics, health checks and lifecycle control re-attached without restarting the app.`
  );
}

/**
 * Kill a process tree by root pid. SAFE group semantics:
 *  - if the pid IS its own process-group leader (detached spawns), kill the
 *    whole group in one shot — bash/bun/node all die together
 *  - otherwise (legacy non-detached processes that share the control plane's
 *    group) walk /proc children and kill only THIS tree, pid by pid — never
 *    the shared group
 */
function killTreeByPid(pid: number): void {
  let pgid: number | null = null;
  try {
    // pgid is field 5 of /proc/<pid>/stat (comm may contain spaces → parse from end)
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    pgid = Number(stat.slice(close + 2).split(/\s+/)[2]);
    if (!Number.isFinite(pgid) || pgid <= 0) pgid = null;
  } catch {
    pgid = null;
  }

  if (pgid !== null && pgid === pid) {
    // own group leader → group kill is safe and complete
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to targeted kill */
    }
  }

  // targeted: kill this pid + every descendant (never the shared group)
  const seen = new Set<number>();
  const killRecursive = (p: number): void => {
    if (seen.has(p)) return;
    seen.add(p);
    try {
      const childrenRaw = fs.readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim();
      for (const kid of childrenRaw.split(/\s+/).filter(Boolean).map(Number)) killRecursive(kid);
    } catch {
      /* no children file */
    }
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* already dead */
    }
  };
  killRecursive(pid);
}

/**
 * Kill stray processes still running inside a service workspace (e.g. left
 * behind by a pre-restart crash). A process is stray when its cwd is inside
 * the workspace directory — the control plane's own cwd never matches.
 */
function killStrayWorkspaceProcesses(workspaceDir: string): number {
  let killed = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return 0;
  }
  for (const pidStr of entries) {
    const pid = Number(pidStr);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pidStr}/cwd`);
      if (cwd && (cwd === workspaceDir || cwd.startsWith(workspaceDir + '/'))) {
        killTreeByPid(pid);
        killed += 1;
      }
    } catch {
      /* unreadable cwd — not ours */
    }
  }
  return killed;
}

/** Poll-based exit detection for adopted (not spawned by us) processes. */
function watchAdoptedProcess(serviceId: string, pid: number): void {
  const timer = setInterval(() => {
    const handle = deploys.get(serviceId);
    if (!handle || handle.pid !== pid) {
      clearInterval(timer);
      return;
    }
    if (!isPidAlive(pid)) {
      clearInterval(timer);
      deploys.delete(serviceId);
      forgetPid(pid);
      void (async () => {
        const row = await db.service.findUnique({ where: { id: serviceId } }).catch(() => null);
        if (!row) return;
        const rt = safeParse<{ pid?: number } | null>(row.runtimeJson, null);
        if (rt?.pid !== pid) return; // superseded
        if (row.status !== 'running') return;
        if (maySelfHeal(serviceId)) {
          await dlog(serviceId, `Adopted app process exited (pid ${pid}) — SELF-HEALING with a fresh deployment (bounded: max 3 per 2h).`, 'warn');
          await setStatus(serviceId, 'building');
          void startDeployment(row).catch(() => {});
        } else {
          await dlog(serviceId, `Adopted app process exited (pid ${pid}) — self-heal budget exhausted (3 restarts in the last 2h), staying failed.`, 'error');
          await setStatus(serviceId, 'failed');
        }
      })();
    }
  }, 5_000);
  timer.unref?.();
}

// ─── watchdog: reconcile running git-deploy services ─────────────────────────

type WatchdogGlobal = typeof globalThis & { __nxDeployWatchdog?: { timer: NodeJS.Timeout; busy: boolean } };
const wg = globalThis as WatchdogGlobal;

/**
 * Started once per process. Every 10s it verifies that every service in
 * "running" state with a git deployment still has a live process + answering
 * port. Crashed processes are marked failed with a real log entry; the
 * runtimeJson health flag always reflects the truth. Surviving orphans from a
 * previous control-plane run are adopted (metrics + lifecycle re-attached).
 */
export function ensureDeployWatchdog(): void {
  if (wg.__nxDeployWatchdog) return;
  const state = { busy: false, timer: null as unknown as NodeJS.Timeout };
  const tick = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      const rows = await db.service.findMany({ where: { status: 'running' } });
      for (const row of rows) {
        const handle = deploys.get(row.id);
        if (!handle) {
          if (row.repoUrl) {
            // git-deployed but no in-memory handle → orphaned by a restart:
            // adopt the survivor, or self-heal (kill zombie + redeploy)
            await adoptOrphanedDeployment(row);
          }
          continue; // builtin-runner services are handled by runtime.ts
        }
        if (!isPidAlive(handle.pid)) {
          // process died without an exit event reaching us (SIGKILL of parent, etc.)
          deploys.delete(row.id);
          await dlog(row.id, `Watchdog: app process (pid ${handle.pid}) is gone — marking service failed.`, 'error');
          await setStatus(row.id, 'failed');
          continue;
        }
        const stats = readProcStats(handle.pid);
        if (!stats) continue;
        // health check: does the port still answer? (cheap, 1s timeout)
        try {
          const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
            signal: AbortSignal.timeout(1000),
            cache: 'no-store',
            redirect: 'manual',
          }).catch(() => null);
          const runtime = safeParse<ServiceRuntime | null>(row.runtimeJson, null);
          const healthy = !!res; // any answer = healthy
          if (runtime && healthy !== runtime.healthy) {
            await db.service
              .update({ where: { id: row.id }, data: { runtimeJson: JSON.stringify({ ...runtime, healthy }) } })
              .catch(() => {});
          }
          if (!res) {
            await dlog(row.id, `Watchdog: port ${handle.port} stopped answering (process alive). Will keep monitoring.`, 'warn');
          }
        } catch {
          /* transient */
        }
      }
    } catch (err) {
      console.error('[deployer] watchdog tick failed', err);
    } finally {
      state.busy = false;
    }
  };
  state.timer = setInterval(tick, 10_000);
  state.timer.unref?.();
  wg.__nxDeployWatchdog = state;
  void tick();
}

// ─── disk usage helper ───────────────────────────────────────────────────────

async function dirSizeMb(dir: string): Promise<number> {
  let total = 0;
  async function walk(d: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          const st = await fsp.stat(p);
          total += st.size;
        } catch {
          /* gone */
        }
      }
    }
  }
  await walk(dir);
  return total / 1024 / 1024;
}

/** Real on-disk size (GB) of a service workspace. */
export async function deploymentDiskGb(name: string): Promise<number> {
  const dir = path.join(DEPLOY_ROOT, name);
  try {
    return +((await dirSizeMb(dir)) / 1024).toFixed(3);
  } catch {
    return 0;
  }
}

/** Ingress calls this so every proxied request is counted (real traffic). */
export function recordIngressRequest(serviceId: string, entry: { method: string; path: string; status: number; ms: number; bytesOut?: number }): void {
  opCounters.set(serviceId, (opCounters.get(serviceId) ?? 0) + 1);
  recordExternalRequest(serviceId, entry);
}

export function getLiveSnapshot(serviceId: string): ReturnType<typeof getLiveStateSnapshot> {
  return getLiveStateSnapshot(serviceId);
}
