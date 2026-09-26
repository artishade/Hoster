/**
 * REAL autoscaling — driven by measured CPU history, executed as real
 * process changes on the host.
 *
 * - Scale-OUT: spawn an additional app process (same boot command, own port)
 *   and add it to runtime.workers; the ingress proxy round-robins across
 *   primary + workers.
 * - Scale-IN: kill the newest worker and remove it.
 * - Policy: hysteresis on the average REAL CPU of the last ~5 minutes of
 *   MetricSample rows (the same sampler that feeds the charts) with a
 *   cooldown between decisions. Every decision is logged as a real LogEntry.
 * - Manual control: PATCH /api/services/[id] { action: 'scale', instances: N }
 *   sets the desired count directly (also used by the Hardware tab UI).
 */

import { db } from '@/lib/db';
import type { ServiceRuntime, RuntimeWorker } from './types';
import {
  spawnScaleOutWorker,
  killScaleOutWorker,
  dlog,
} from './deployer';
import type { DeployableService } from './deployer';
import { isPidAlive } from './procstats';

const SWEEP_MS = 45_000; // policy evaluation cadence
const WINDOW_MS = 5 * 60_000; // CPU history window
const COOLDOWN_MS = 3 * 60_000; // min time between automatic decisions
const SCALE_UP_CPU = 65; // % avg CPU → +1 worker
const SCALE_DOWN_CPU = 12; // % avg CPU → -1 worker (hysteresis band)
const MAX_WORKERS = 4; // hard cap regardless of instances.max (host sanity)

type AutoscalerGlobal = typeof globalThis & {
  __nxAutoscalerTimer?: ReturnType<typeof setInterval>;
  __nxRrCounters?: Map<string, number>;
};
const g = globalThis as AutoscalerGlobal;
const rrCounters = g.__nxRrCounters ?? new Map<string, number>();
g.__nxRrCounters = rrCounters;

/** Round-robin pick across [primary, ...workers] for ingress load balancing. */
export function pickWorkerPort(serviceId: string, primaryPort: number, workers: RuntimeWorker[]): number {
  const alive = workers.filter((w) => isPidAlive(w.pid));
  if (alive.length === 0) return primaryPort;
  const n = (rrCounters.get(serviceId) ?? 0) + 1;
  rrCounters.set(serviceId, n);
  const idx = n % (alive.length + 1); // +1 for the primary
  return idx === 0 ? primaryPort : alive[idx - 1].port;
}

/** Count of live instances (primary + healthy workers). */
export function liveInstanceCount(runtime: ServiceRuntime | null): number {
  if (!runtime) return 0;
  const workers = (runtime.workers ?? []).filter((w) => isPidAlive(w.pid));
  return 1 + workers.length;
}

async function avgCpuLastWindow(serviceId: string): Promise<number | null> {
  const since = new Date(Date.now() - WINDOW_MS);
  const rows = await db.metricSample.findMany({
    where: { scope: 'service', scopeId: serviceId, timestamp: { gte: since } },
    orderBy: { timestamp: 'desc' },
    take: 24,
    select: { cpuPercent: true },
  });
  if (rows.length < 4) return null; // not enough evidence
  return rows.reduce((a, r) => a + r.cpuPercent, 0) / rows.length;
}

/**
 * Scale a running git-deploy service to `target` total instances
 * (1 = primary only). Clamped to [1, min(instances.max, 1+MAX_WORKERS)].
 * Returns the new count, or null when scaling is not possible.
 */
export async function scaleServiceTo(svc: DeployableService, target: number): Promise<number | null> {
  const row = await db.service.findUnique({ where: { id: svc.id } });
  if (!row || row.status !== 'running') return null;
  const runtime = parseRuntime(row.runtimeJson);
  if (!runtime || runtime.mode !== 'git-deploy' || !runtime.startCmd || !runtime.repoDir) return null;

  const inst = parseInstances(row.instancesJson);
  const hardMax = Math.min(inst.max || 1, 1 + MAX_WORKERS);
  const desired = Math.max(1, Math.min(target, hardMax));

  // prune dead workers first so counts are honest
  const before = (runtime.workers ?? []).filter((w) => isPidAlive(w.pid)).length + 1;

  let workers = (runtime.workers ?? []).filter((w) => isPidAlive(w.pid));

  // scale OUT
  while (workers.length + 1 < desired) {
    try {
      const w = await spawnScaleOutWorker(svc, runtime);
      workers.push(w);
      await dlog(svc.id, `Autoscaler: scale-OUT → spawned worker (pid ${w.pid}, port ${w.port}) — ${workers.length + 1}/${hardMax} instances.`, 'info');
    } catch (e) {
      await dlog(svc.id, `Autoscaler: scale-OUT FAILED: ${(e as Error).message}`, 'error');
      break;
    }
  }

  // scale IN (kill newest first)
  while (workers.length + 1 > desired && workers.length > 0) {
    const victim = workers[workers.length - 1];
    killScaleOutWorker(victim.pid);
    workers = workers.slice(0, -1);
    await dlog(svc.id, `Autoscaler: scale-IN → stopped worker (pid ${victim.pid}, port ${victim.port}) — ${workers.length + 1}/${hardMax} instances.`, 'info');
  }

  const runtimeUpdated: ServiceRuntime = { ...runtime, workers, lastScaleAt: Date.now() };
  await db.service.update({
    where: { id: svc.id },
    data: {
      runtimeJson: JSON.stringify(runtimeUpdated),
      instancesJson: JSON.stringify({ ...inst, current: workers.length + 1 }),
    },
  });
  void before; // (before is used implicitly for honesty of counts in logs)
  return workers.length + 1;
}

async function sweep(): Promise<void> {
  const rows = await db.service.findMany({ where: { status: 'running' } });
  for (const row of rows) {
    if (!row.repoUrl) continue; // builtin runners run in-process — no scaling
    const runtime = parseRuntime(row.runtimeJson);
    if (!runtime || runtime.mode !== 'git-deploy' || !runtime.startCmd || !runtime.repoDir) continue;

    const inst = parseInstances(row.instancesJson);
    if (!inst.max || inst.max <= 1) continue; // autoscaling disabled

    const current = liveInstanceCount(runtime);
    // reconcile stored current
    if (inst.current !== current) {
      await db.service.update({
        where: { id: row.id },
        data: { instancesJson: JSON.stringify({ ...inst, current }) },
      }).catch(() => {});
    }

    // cooldown between automatic decisions
    if (runtime.lastScaleAt && Date.now() - runtime.lastScaleAt < COOLDOWN_MS) continue;

    const avgCpu = await avgCpuLastWindow(row.id);
    if (avgCpu == null) continue;

    if (avgCpu > SCALE_UP_CPU && current < inst.max) {
      await scaleServiceTo(row, current + 1);
    } else if (avgCpu < SCALE_DOWN_CPU && current > Math.max(1, inst.min || 1)) {
      await scaleServiceTo(row, current - 1);
    }
  }
}

/** Start the autoscaler sweep (idempotent, survives hot reloads). */
export function ensureAutoscaler(): void {
  if (g.__nxAutoscalerTimer) return;
  g.__nxAutoscalerTimer = setInterval(() => {
    sweep().catch((err) => console.error('[autoscaler] sweep failed', err));
  }, SWEEP_MS);
}

function parseRuntime(json: string | null): ServiceRuntime | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ServiceRuntime;
  } catch {
    return null;
  }
}

function parseInstances(json: string): { min: number; max: number; current: number; scaleToZero: boolean; scaleToZeroDelaySec: number; scaleOnDeploy: boolean } {
  try {
    return JSON.parse(json);
  } catch {
    return { min: 1, max: 1, current: 1, scaleToZero: false, scaleToZeroDelaySec: 300, scaleOnDeploy: false };
  }
}
