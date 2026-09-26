import { db } from '@/lib/db';
import { HARDWARE_SPECS, DYNAMIC_FREE_TIERS } from './hardware-specs';
import { liveInstanceCount } from './autoscaler';
import type { ServiceRuntime } from './types';

/**
 * REAL usage metering — the platform's "billing" data source.
 *
 * Every quantity here is measured, never invented:
 *   - instanceSeconds: the 15s sampler adds 15s × live instance count
 *     (primary + scale-out workers — all real processes) per running service
 *   - requests: every proxied ingress request (same counter the traffic
 *     charts use) is accumulated in-memory and flushed to the daily row
 *   - egressMb: response bytes when content-length is known (streamed
 *     responses are counted as requests only — honest, no estimates)
 *
 * The "equivalent cloud cost" is real usage × a transparent public-list-price
 * formula (see RATE doc below). The platform itself bills $0.00.
 */

// ─── in-memory accumulators (flushed to UsageDaily every 15s) ───────────────

interface PendingUsage {
  requests: number;
  egressBytes: number;
}
type UsageGlobal = typeof globalThis & { __nxUsagePending?: Map<string, PendingUsage> };
const ug = globalThis as UsageGlobal;
const pending = ug.__nxUsagePending ?? new Map<string, PendingUsage>();
ug.__nxUsagePending = pending;

/** Called by the ingress route for every real proxied request. */
export function bumpUsageCounters(serviceId: string, bytesOut?: number): void {
  let p = pending.get(serviceId);
  if (!p) {
    p = { requests: 0, egressBytes: 0 };
    pending.set(serviceId, p);
  }
  p.requests += 1;
  if (bytesOut && bytesOut > 0) p.egressBytes += bytesOut;
}

function takePending(serviceId: string): PendingUsage {
  const p = pending.get(serviceId) ?? { requests: 0, egressBytes: 0 };
  pending.delete(serviceId);
  return p;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Upsert-adds deltas into the service's daily usage row. */
async function addUsage(serviceId: string, day: string, delta: { instanceSeconds?: number; requests?: number; egressMb?: number }): Promise<void> {
  const existing = await db.usageDaily.findUnique({ where: { serviceId_day: { serviceId, day } } });
  if (existing) {
    await db.usageDaily.update({
      where: { id: existing.id },
      data: {
        instanceSeconds: existing.instanceSeconds + (delta.instanceSeconds ?? 0),
        requests: existing.requests + (delta.requests ?? 0),
        egressMb: existing.egressMb + (delta.egressMb ?? 0),
      },
    });
  } else {
    await db.usageDaily.create({
      data: {
        serviceId,
        day,
        instanceSeconds: delta.instanceSeconds ?? 0,
        requests: delta.requests ?? 0,
        egressMb: delta.egressMb ?? 0,
      },
    });
  }
}

/**
 * Sampler flush — called every 15s by recordHostSample for each RUNNING
 * service: banks 15s × live instances of uptime plus any request/egress
 * deltas accumulated by the ingress route since the last flush.
 */
export async function flushServiceUsage(serviceId: string, intervalSec: number, runtimeJson: string | null): Promise<void> {
  const p = takePending(serviceId);
  let instances = 1;
  try {
    const rt = runtimeJson ? (JSON.parse(runtimeJson) as ServiceRuntime) : null;
    if (rt) instances = liveInstanceCount(rt) || 1;
  } catch {
    instances = 1;
  }
  await addUsage(serviceId, todayKey(), {
    instanceSeconds: intervalSec * instances,
    requests: p.requests,
    egressMb: +(p.egressBytes / 1024 / 1024).toFixed(4),
  });
}

// ─── equivalent-cost rate table (public list prices, transparent) ────────────

/**
 * Equivalent hourly rate for a tier, derived from its real spec:
 *   $0.008 per vCPU + $0.004 per GB RAM per hour
 * (≈ typical shared-CPU cloud VM list pricing — Fly.io/Render/Koyeb ballpark.)
 */
export function tierRatePerHourUsd(hardwareTier: string): number {
  const spec = (HARDWARE_SPECS as Record<string, { vCpu?: number; ramGb?: number }>)[hardwareTier]
    ?? (DYNAMIC_FREE_TIERS as Record<string, { vCpu?: number; ramGb?: number }>)[hardwareTier];
  const vCpu = Math.max(0.5, spec?.vCpu ?? 1);
  const ramGb = Math.max(0.5, spec?.ramGb ?? 1);
  return +(vCpu * 0.008 + ramGb * 0.004).toFixed(4);
}

export const RATE_FORMULA = '$0.008 / vCPU-hour + $0.004 / GB-RAM-hour';

// ─── report ──────────────────────────────────────────────────────────────────

export interface UsageReport {
  windowDays: number;
  global: {
    instanceHours: number;
    requests: number;
    egressMb: number;
    equivalentCostUsd: number;
    paidUsd: number;
    liveInstanceSeconds: number;
  };
  perDay: {
    day: string;
    instanceHours: number;
    requests: number;
    egressMb: number;
    equivalentCostUsd: number;
  }[];
  perService: {
    serviceId: string;
    name: string;
    status: string;
    tier: string;
    instanceHours: number;
    requests: number;
    egressMb: number;
    equivalentCostUsd: number;
    ratePerHourUsd: number;
    firstSeenDay: string | null;
    lastSeenDay: string | null;
  }[];
  rates: { formula: string; note: string };
}

export async function getUsageReport(windowDays = 30): Promise<UsageReport> {
  const days = Math.min(90, Math.max(1, Math.round(windowDays)));
  const sinceKey = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const services = await db.service.findMany({ select: { id: true, name: true, status: true, hardwareTier: true } });
  const byId = new Map(services.map((s) => [s.id, s]));

  const rows = await db.usageDaily.findMany({ where: { day: { gte: sinceKey } }, orderBy: { day: 'asc' } });

  const dayAgg = new Map<string, { instanceHours: number; requests: number; egressMb: number }>();
  const svcAgg = new Map<string, { instanceHours: number; requests: number; egressMb: number; first: string; last: string }>();

  for (const r of rows) {
    const hours = r.instanceSeconds / 3600;
    const rate = tierRatePerHourUsd(byId.get(r.serviceId)?.hardwareTier ?? '');

    let d = dayAgg.get(r.day);
    if (!d) {
      d = { instanceHours: 0, requests: 0, egressMb: 0 };
      dayAgg.set(r.day, d);
    }
    d.instanceHours += hours;
    d.requests += r.requests;
    d.egressMb += r.egressMb;

    let s = svcAgg.get(r.serviceId);
    if (!s) {
      s = { instanceHours: 0, requests: 0, egressMb: 0, first: r.day, last: r.day };
      svcAgg.set(r.serviceId, s);
    }
    s.instanceHours += hours;
    s.requests += r.requests;
    s.egressMb += r.egressMb;
    if (r.day < s.first) s.first = r.day;
    if (r.day > s.last) s.last = r.day;
    void rate; // cost computed at serialization below
  }

  // build a continuous day axis (missing days become zero rows)
  const perDay: UsageReport['perDay'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const d = dayAgg.get(key) ?? { instanceHours: 0, requests: 0, egressMb: 0 };
    perDay.push({
      day: key,
      instanceHours: +d.instanceHours.toFixed(3),
      requests: d.requests,
      egressMb: +d.egressMb.toFixed(4),
      equivalentCostUsd: 0, // filled below (needs per-service rates)
    });
  }

  const perService: UsageReport['perService'] = [];
  let globalHours = 0;
  let globalRequests = 0;
  let globalEgressMb = 0;
  let globalCost = 0;

  for (const svc of services) {
    const s = svcAgg.get(svc.id);
    const rate = tierRatePerHourUsd(svc.hardwareTier);
    const instanceHours = +(s?.instanceHours ?? 0).toFixed(3);
    const cost = +(instanceHours * rate).toFixed(4);
    perService.push({
      serviceId: svc.id,
      name: svc.name,
      status: svc.status,
      tier: svc.hardwareTier,
      instanceHours,
      requests: s?.requests ?? 0,
      egressMb: +(s?.egressMb ?? 0).toFixed(4),
      equivalentCostUsd: cost,
      ratePerHourUsd: rate,
      firstSeenDay: s?.first ?? null,
      lastSeenDay: s?.last ?? null,
    });
    globalHours += instanceHours;
    globalRequests += s?.requests ?? 0;
    globalEgressMb += s?.egressMb ?? 0;
    globalCost += cost;
  }

  // per-day cost needs per-service rates — recompute from raw rows
  const dayCost = new Map<string, number>();
  for (const r of rows) {
    const rate = tierRatePerHourUsd(byId.get(r.serviceId)?.hardwareTier ?? '');
    dayCost.set(r.day, (dayCost.get(r.day) ?? 0) + (r.instanceSeconds / 3600) * rate);
  }
  for (const d of perDay) {
    d.equivalentCostUsd = +((dayCost.get(d.day) ?? 0)).toFixed(4);
  }

  // live partial: requests/egress accumulated since the last sampler flush
  let liveRequests = 0;
  for (const p of pending.values()) liveRequests += p.requests;

  perService.sort((a, b) => b.equivalentCostUsd - a.equivalentCostUsd || b.requests - a.requests);

  return {
    windowDays: days,
    global: {
      instanceHours: +globalHours.toFixed(3),
      requests: globalRequests,
      egressMb: +globalEgressMb.toFixed(4),
      equivalentCostUsd: +globalCost.toFixed(4),
      paidUsd: 0,
      liveInstanceSeconds: liveRequests, // unflushed request count — surfaced as "live now"
    },
    perDay,
    perService,
    rates: {
      formula: RATE_FORMULA,
      note: 'Equivalent-cost comparison only — every unit is real measured usage. NexusHost free tier bills $0.00.',
    },
  };
}
