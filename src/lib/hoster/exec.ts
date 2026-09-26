import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from '@/lib/db';
import { DEPLOY_ROOT } from './deployer';

/**
 * REAL one-shot command execution inside a service's deployment workspace.
 *
 * The PTY terminal (mini-services/terminal-service) is for interactive
 * sessions; this module powers quick, single commands — `git log -3`,
 * `cat package.json`, `du -sh .` — with hard guardrails so the control
 * plane stays healthy:
 *
 *   - command length cap (2 000 chars), timeout cap (60s), output cap
 *     (128 KB per stream), one concurrent exec per service, global
 *     concurrency cap, and a per-service history ring (in-memory, last 25).
 *
 * Everything runs with `bash -lc` exactly like the deploy pipeline itself,
 * with cwd pinned to deployments/<name>/repo — the same workspace the PTY
 * uses. Results are recorded as REAL LogEntry rows so execs show up in the
 * global Activity feed.
 */

export const EXEC_MIN_TIMEOUT_SEC = 5;
export const EXEC_MAX_TIMEOUT_SEC = 60;
export const EXEC_DEFAULT_TIMEOUT_SEC = 30;
const MAX_CMD_LEN = 2_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const HISTORY_CAP = 25;
const GLOBAL_CONCURRENCY = 4;

export interface ExecResult {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  at: string;
}

interface ExecGlobal {
  __nxExecInFlight?: Map<string, true>;
  __nxExecHistory?: Map<string, ExecResult[]>;
  __nxExecSeq?: number;
}
const g = globalThis as ExecGlobal;

function historyFor(serviceId: string): ExecResult[] {
  const hist = g.__nxExecHistory ?? new Map<string, ExecResult[]>();
  g.__nxExecHistory = hist;
  let h = hist.get(serviceId);
  if (!h) {
    h = [];
    hist.set(serviceId, h);
  }
  return h;
}

/** The service's real workspace repo dir, or null when it doesn't exist on disk. */
export function workspaceForService(name: string): string | null {
  const repoDir = path.join(DEPLOY_ROOT, name, 'repo');
  try {
    const st = fs.statSync(repoDir);
    return st.isDirectory() ? repoDir : null;
  } catch {
    return null;
  }
}

export interface RunExecError {
  status: number;
  error: string;
}

/**
 * Runs a single command in the service workspace. Throws a structured
 * RunExecError for guardrail violations (callers map to HTTP codes).
 */
export async function runServiceExec(
  svc: { id: string; name: string; runtimeJson?: string | null },
  command: string,
  timeoutSec: number
): Promise<ExecResult> {
  const cmd = command.trim();
  if (!cmd) {
    throw { status: 400, error: 'command is required' } as RunExecError;
  }
  if (cmd.length > MAX_CMD_LEN) {
    throw { status: 400, error: `command too long (${cmd.length} > ${MAX_CMD_LEN} chars)` } as RunExecError;
  }
  const timeout = Math.min(EXEC_MAX_TIMEOUT_SEC, Math.max(EXEC_MIN_TIMEOUT_SEC, Math.round(timeoutSec) || EXEC_DEFAULT_TIMEOUT_SEC));

  const repoDir = workspaceForService(svc.name);
  if (!repoDir) {
    throw {
      status: 409,
      error: 'no deployment workspace on disk for this service (git-deploy a repository first — builtin runners execute in-process)',
    } as RunExecError;
  }

  // concurrency guardrails: one exec per service, bounded globally
  const inflight = g.__nxExecInFlight ?? new Map<string, true>();
  g.__nxExecInFlight = inflight;
  if (inflight.has(svc.id)) {
    throw { status: 429, error: 'an exec is already running for this service — wait for it to finish' } as RunExecError;
  }
  if (inflight.size >= GLOBAL_CONCURRENCY) {
    throw { status: 429, error: 'exec queue is saturated platform-wide — retry in a moment' } as RunExecError;
  }
  inflight.set(svc.id, true);

  const t0 = Date.now();
  try {
    const result = await new Promise<ExecResult>((resolve) => {
      const child = spawn('bash', ['-lc', cmd], {
        cwd: repoDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out: Buffer = Buffer.alloc(0);
      let err: Buffer = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const cap = (buf: Buffer, chunk: Buffer): Buffer => {
        if (buf.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return buf;
        }
        const room = MAX_OUTPUT_BYTES - buf.length;
        if (chunk.length > room) {
          truncated = true;
          return Buffer.concat([buf, chunk.subarray(0, room)]);
        }
        return Buffer.concat([buf, chunk]);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        out = cap(out, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err = cap(err, chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL'); // hard kill — the operator asked for bounded time
      }, timeout * 1000);

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const seq = (g.__nxExecSeq ?? 0) + 1;
        g.__nxExecSeq = seq;
        resolve({
          id: `exec-${seq}-${Date.now().toString(36)}`,
          command: cmd,
          cwd: repoDir,
          exitCode: timedOut ? null : code,
          timedOut,
          durationMs: Date.now() - t0,
          stdout: out.toString('utf8'),
          stderr: err.toString('utf8'),
          truncated,
          at: new Date().toISOString(),
        });
      };

      child.on('exit', (code) => finish(code));
      child.on('error', (e) => {
        err = cap(err, Buffer.from(`spawn failed: ${e.message}\n`));
        finish(null);
      });
    });

    // record in the per-service history ring (in-memory)
    const hist = historyFor(svc.id);
    hist.unshift(result);
    if (hist.length > HISTORY_CAP) hist.length = HISTORY_CAP;

    // record as a REAL log entry → global Activity feed
    try {
      const head = result.command.length > 120 ? `${result.command.slice(0, 120)}…` : result.command;
      await db.logEntry.create({
        data: {
          serviceId: svc.id,
          scope: 'service',
          level: result.timedOut ? 'warn' : result.exitCode === 0 ? 'info' : 'error',
          message: `exec ▸ ${head} → ${result.timedOut ? `timeout after ${timeout}s` : `exit ${result.exitCode}`} in ${result.durationMs}ms${result.truncated ? ' (output truncated)' : ''}`,
          source: 'exec',
        },
      });
    } catch {
      /* logging must never break the exec result */
    }

    return result;
  } finally {
    inflight.delete(svc.id);
  }
}

/** Recent one-shot execs for a service (newest first, in-memory ring). */
export function getExecHistory(serviceId: string): ExecResult[] {
  return [...historyFor(serviceId)];
}
