import { db } from '@/lib/db';
import { tierRatePerHourUsd } from './usage';

/**
 * REAL usage-based alerts — budget warnings in the Activity feed.
 *
 * Nothing here is synthetic: thresholds compare the day's METERED usage
 * (UsageDaily rows written by the 15s sampler + ingress counters) and every
 * fired alert is a real LogEntry (scope 'usage', source 'usage-meter'), so
 * alerts appear in the global Activity feed and /api/logs?scope=usage.
 *
 * Ladders (per service, per UTC day):
 *   - instance-hours: 2h → info, 6h → info, 12h → info  (pacing signals)
 *   - equivalent cost: $0.10 → warn, $0.50 → warn, $2.00 → error (runaway)
 *   - platform-wide daily budget: $1.00 → warn, $2.00 → error
 *
 * Dedupe: one row per (day, service, threshold). Fired markers live in
 * memory; after a control-plane restart they are rebuilt by parsing today's
 * existing alert rows from the DB (messages carry stable phrasings), so a
 * restart never double-fires an already-sent alert.
 */

const CHECK_MIN_INTERVAL_MS = 60_000;

/** Threshold ladders — env-overridable so operators can tune their alerting
 *  (comma-separated numbers): NX_USAGE_ALERT_HOUR_THRESHOLDS, NX_USAGE_ALERT_COST_THRESHOLDS. */
function parseEnvNums(name: string, defaults: readonly number[]): number[] {
  const raw = process.env[name];
  if (!raw) return [...defaults];
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return parsed.length ? parsed.slice(0, 6) : [...defaults];
}

export const HOUR_THRESHOLDS = parseEnvNums('NX_USAGE_ALERT_HOUR_THRESHOLDS', [2, 6, 12]);
export const COST_THRESHOLDS = parseEnvNums('NX_USAGE_ALERT_COST_THRESHOLDS', [0.1, 0.5, 2.0]);
export const GLOBAL_BUDGET_USD = 1.0;
export const GLOBAL_BUDGET_ERROR_USD = 2.0;

interface UsageAlertGlobal {
  __nxUsageAlertState?: {
    lastCheckAt: number;
    fired: Set<string>;
  };
}
const g = globalThis as UsageAlertGlobal;

function state() {
  if (!g.__nxUsageAlertState) g.__nxUsageAlertState = { lastCheckAt: 0, fired: new Set() };
  return g.__nxUsageAlertState;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function startOfTodayMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function fmtUsd(v: number): string {
  return v === 0 ? '$0.00' : v < 0.01 ? `$${v.toFixed(4)}` : v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** Canonical threshold → marker-key fragment (same string on fire & rebuild). */
function normTh(v: number): string {
  return String(Number(v.toFixed(6)));
}

/** Trailing machine-readable tag so markers can be rebuilt after a restart
 *  (canonical threshold value — never a formatted/pretty variant). */
function tag(kind: 'h' | 'c' | 'b', v: number): string {
  return ` [${kind}:${normTh(v)}]`;
}

async function fireAlert(serviceId: string | null, level: 'info' | 'warn' | 'error', message: string, marker: string): Promise<void> {
  state().fired.add(marker);
  try {
    await db.logEntry.create({
      data: {
        serviceId,
        scope: 'usage',
        level,
        message,
        source: 'usage-meter',
      },
    });
  } catch {
    /* alerting must never break the sampler */
  }
}

/** Rebuild today's fired markers from the real LogEntry rows (restart-safe).
 *  Parses the canonical trailing tags — robust against decimal thresholds. */
async function rebuildFiredMarkers(): Promise<Set<string>> {
  const fired = state().fired;
  const rows = await db.logEntry.findMany({
    where: { source: 'usage-meter', createdAt: { gte: new Date(startOfTodayMs()) } },
    select: { serviceId: true, message: true },
    take: 200,
  });
  for (const r of rows) {
    const svc = r.serviceId ?? 'platform';
    const m = r.message.match(/\[(h|c|b):([\d.]+)\]\s*$/);
    if (m) {
      const kind = m[1] === 'h' ? 'hour' : m[1] === 'c' ? 'cost' : 'budget';
      fired.add(`${todayKey()}|${svc}|${kind}:${normTh(Number(m[2]))}`);
    }
  }
  return fired;
}

/**
 * Sweep — called from the 15s host sampler; internally throttled to one real
 * check per minute. Emits at most a handful of LogEntry rows per day.
 */
export async function checkUsageAlerts(): Promise<void> {
  const st = state();
  const now = Date.now();
  if (now - st.lastCheckAt < CHECK_MIN_INTERVAL_MS) return;
  st.lastCheckAt = now;

  const day = todayKey();
  const fired = await rebuildFiredMarkers();

  const services = await db.service.findMany({
    select: { id: true, name: true, hardwareTier: true },
  });
  const rows = await db.usageDaily.findMany({
    where: { day },
    select: { serviceId: true, instanceSeconds: true },
  });

  const hoursBy = new Map<string, number>();
  for (const r of rows) hoursBy.set(r.serviceId, r.instanceSeconds / 3600);

  // ── per-service ladders ────────────────────────────────────────────────
  let globalCostToday = 0;
  const costBy = new Map<string, number>();
  for (const svc of services) {
    const hours = hoursBy.get(svc.id) ?? 0;
    const rate = tierRatePerHourUsd(svc.hardwareTier);
    const cost = hours * rate;
    globalCostToday += cost;
    costBy.set(svc.id, cost);

    for (const h of HOUR_THRESHOLDS) {
      if (hours >= h && !fired.has(`${day}|${svc.id}|hour:${normTh(h)}`)) {
        await fireAlert(
          svc.id,
          'info',
          `usage ▸ "${svc.name}" crossed ${h} instance-hours today (${hours.toFixed(2)}h metered) — pacing signal, equivalent ${fmtUsd(cost)} at list prices, your bill stays $0.00${tag('h', h)}`,
          `${day}|${svc.id}|hour:${normTh(h)}`
        );
      }
    }
    for (const c of COST_THRESHOLDS) {
      if (cost >= c && !fired.has(`${day}|${svc.id}|cost:${normTh(c)}`)) {
        const level = c >= COST_THRESHOLDS[COST_THRESHOLDS.length - 1] ? 'error' : 'warn';
        await fireAlert(
          svc.id,
          level,
          `usage ▸ "${svc.name}" daily equivalent cost crossed ${fmtUsd(c)} (${fmtUsd(cost)} from ${hours.toFixed(2)} instance-hours) — free tier still bills $0.00, this is the what-you'd-pay-elsewhere meter${tag('c', c)}`,
          `${day}|${svc.id}|cost:${normTh(c)}`
        );
      }
    }
  }

  // ── platform-wide budget ───────────────────────────────────────────────
  if (globalCostToday >= GLOBAL_BUDGET_USD && !fired.has(`${day}|platform|budget:${normTh(GLOBAL_BUDGET_USD)}`)) {
    await fireAlert(
      null,
      'warn',
      `usage ▸ platform-wide daily equivalent crossed ${fmtUsd(GLOBAL_BUDGET_USD)} (${fmtUsd(globalCostToday)} across ${services.length} services) — heaviest: ${heaviest(costBy, services)}${tag('b', GLOBAL_BUDGET_USD)}`,
      `${day}|platform|budget:${normTh(GLOBAL_BUDGET_USD)}`
    );
  }
  if (globalCostToday >= GLOBAL_BUDGET_ERROR_USD && !fired.has(`${day}|platform|budget:${normTh(GLOBAL_BUDGET_ERROR_USD)}`)) {
    await fireAlert(
      null,
      'error',
      `usage ▸ platform-wide daily equivalent crossed ${fmtUsd(GLOBAL_BUDGET_ERROR_USD)} (${fmtUsd(globalCostToday)}) — runaway workload territory; consider scale-in or stopping idle services${tag('b', GLOBAL_BUDGET_ERROR_USD)}`,
      `${day}|platform|budget:${normTh(GLOBAL_BUDGET_ERROR_USD)}`
    );
  }
}

function heaviest(costBy: Map<string, number>, services: { id: string; name: string }[]): string {
  let best = { name: 'n/a', cost: 0 };
  for (const svc of services) {
    const c = costBy.get(svc.id) ?? 0;
    if (c > best.cost) best = { name: svc.name, cost: c };
  }
  return `${best.name} ${fmtUsd(best.cost)}`;
}
