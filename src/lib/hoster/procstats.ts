import fs from 'fs';
import os from 'os';

/**
 * REAL per-process metrics, read straight from /proc (Linux).
 *
 * - CPU %: delta of the child's utime+stime jiffies vs wall-clock jiffies
 *   between two reads (exactly how ps/top compute it).
 * - RAM: VmRSS from /proc/<pid>/status (true resident set, in GB).
 *
 * No estimation, no PRNG — if /proc is unavailable the reads simply fail and
 * callers fall back to "no data" (never to fake numbers).
 */

export interface ProcStats {
  cpuPercent: number;
  ramUsedGb: number;
  uptimeSec: number;
}

interface ProcSnapshot {
  utimeJiffies: number;
  stimeJiffies: number;
  atMs: number;
}

const CLK_TCK = 100; // USER_HZ on virtually all Linux builds

type ProcGlobal = typeof globalThis & {
  __nxProcPrev?: Map<number, ProcSnapshot>;
};
const g = globalThis as ProcGlobal;
const prevSnapshots = g.__nxProcPrev ?? new Map<number, ProcSnapshot>();
g.__nxProcPrev = prevSnapshots;

function readTotalJiffies(): number {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const cpuLine = stat.split('\n')[0];
    const parts = cpuLine.split(/\s+/).slice(1).map(Number);
    return parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  } catch {
    return 0;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Real CPU/RAM of one process. Returns null when unreadable (non-Linux / dead pid). */
export function readProcStats(pid: number): ProcStats | null {
  if (!Number.isFinite(pid) || pid <= 1) return null;
  try {
    // ── CPU (jiffies deltas) ──────────────────────────────────────────────
    const statRaw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // field 14 utime, 15 stime (1-based); comm may contain spaces → parse from the end
    const close = statRaw.lastIndexOf(')');
    const fields = statRaw.slice(close + 2).split(/\s+/);
    const utime = Number(fields[11] ?? 0); // utime  (field 14 overall)
    const stime = Number(fields[12] ?? 0); // stime  (field 15 overall)
    const startTimeJiffies = Number(fields[19] ?? 0); // field 22 overall

    const nowMs = Date.now();
    const snap: ProcSnapshot = { utimeJiffies: utime, stimeJiffies: stime, atMs: nowMs };
    const prev = prevSnapshots.get(pid);

    let cpuPercent = 0;
    if (prev && nowMs > prev.atMs) {
      const procDelta = utime + stime - prev.utimeJiffies - prev.stimeJiffies;
      const wallJiffies = ((nowMs - prev.atMs) / 1000) * CLK_TCK;
      if (wallJiffies > 0 && procDelta >= 0) {
        // Normalize to a single-core basis so 100% = one full core
        cpuPercent = Math.min(100, +((procDelta / wallJiffies) * 100).toFixed(1));
      }
    }
    prevSnapshots.set(pid, snap);

    // ── RAM (VmRSS) ───────────────────────────────────────────────────────
    const statusRaw = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssMatch = statusRaw.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const ramUsedGb = rssMatch ? +(Number(rssMatch[1]) / 1024 / 1024).toFixed(3) : 0;

    const uptimeSec = Math.max(0, Math.round(Number(os.uptime()) - startTimeJiffies / CLK_TCK));

    return { cpuPercent, ramUsedGb, uptimeSec };
  } catch {
    prevSnapshots.delete(pid);
    return null;
  }
}

/** Drop bookkeeping for a dead pid. */
export function forgetPid(pid: number): void {
  prevSnapshots.delete(pid);
}
