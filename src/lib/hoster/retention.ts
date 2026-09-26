import fsSync from 'fs';
import { db } from '@/lib/db';

/**
 * Data retention policy — keeps the control-plane database bounded.
 *
 * The platform writes REAL rows constantly (every deploy step, every provider
 * sweep, every usage sample, every webhook delivery): left alone the LogEntry
 * table grows by thousands of rows per day. This module gives operators a
 * persisted, editable retention policy and a pruning pass that runs for real:
 *
 *   - LogEntry rows older than `logRetentionDays` are DELETEd (default 7 days)
 *   - WebhookDelivery rows older than `webhookDeliveryRetentionDays` (default 30)
 *   - the 15s host sampler calls maybePrune() which self-throttles to one real
 *     pass every `pruneIntervalMin` minutes (default 10) when autoPrune is on
 *   - every prune that actually deletes something is recorded as a LogEntry
 *     (source 'retention') — the feed proves the policy works
 *
 * Config priority: DB row (PlatformSetting 'log-retention', edited in the
 * Activity view) → env (NX_RETENTION_*) → defaults.
 */

export interface RetentionConfig {
  logRetentionDays: number;
  webhookDeliveryRetentionDays: number;
  autoPrune: boolean;
  pruneIntervalMin: number;
}

export const RETENTION_CONFIG_KEY = 'log-retention';

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  logRetentionDays: 7,
  webhookDeliveryRetentionDays: 30,
  autoPrune: true,
  pruneIntervalMin: 10,
};

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 1440;
const CACHE_TTL_MS = 15_000;

interface RetentionGlobal {
  __nxRetentionConfig?: {
    cachedAt: number;
    cached: RetentionConfig;
    source: 'db' | 'env' | 'default';
  };
  __nxRetentionPolicy?: {
    lastPruneAt: number;
    lastPruneResult?: { at: number; logsPruned: number; deliveriesPruned: number };
  };
}
const g = globalThis as RetentionGlobal;

function envRetentionConfig(): RetentionConfig {
  const cfg: RetentionConfig = { ...DEFAULT_RETENTION_CONFIG };
  const envNum = (name: string): number | null => {
    const raw = process.env[name];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const days = envNum('NX_RETENTION_LOG_DAYS');
  if (days !== null) cfg.logRetentionDays = clampDays(days, DEFAULT_RETENTION_CONFIG.logRetentionDays);
  const whDays = envNum('NX_RETENTION_WEBHOOK_DAYS');
  if (whDays !== null) cfg.webhookDeliveryRetentionDays = clampDays(whDays, DEFAULT_RETENTION_CONFIG.webhookDeliveryRetentionDays);
  const interval = envNum('NX_RETENTION_PRUNE_INTERVAL_MIN');
  if (interval !== null) cfg.pruneIntervalMin = clampInterval(interval, DEFAULT_RETENTION_CONFIG.pruneIntervalMin);
  if (process.env.NX_RETENTION_AUTO_PRUNE === '0' || process.env.NX_RETENTION_AUTO_PRUNE === 'false') cfg.autoPrune = false;
  return cfg;
}

function clampDays(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= MIN_DAYS ? Math.min(MAX_DAYS, Math.round(v)) : fallback;
}

function clampInterval(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= MIN_INTERVAL_MIN ? Math.min(MAX_INTERVAL_MIN, Math.round(v)) : fallback;
}

function isEnvCustomized(cfg: RetentionConfig): boolean {
  return (
    cfg.logRetentionDays !== DEFAULT_RETENTION_CONFIG.logRetentionDays ||
    cfg.webhookDeliveryRetentionDays !== DEFAULT_RETENTION_CONFIG.webhookDeliveryRetentionDays ||
    cfg.autoPrune !== DEFAULT_RETENTION_CONFIG.autoPrune ||
    cfg.pruneIntervalMin !== DEFAULT_RETENTION_CONFIG.pruneIntervalMin
  );
}

/** Parse + validate raw input (API body or DB row). Returns typed errors. */
export function validateRetentionConfigInput(
  raw: unknown
): { ok: true; config: RetentionConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['body must be a JSON object'] };
  const o = raw as Record<string, unknown>;

  const dayField = (v: unknown, name: string): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < MIN_DAYS || n > MAX_DAYS) {
      errors.push(`${name} must be a number of days between ${MIN_DAYS} and ${MAX_DAYS}`);
      return null;
    }
    return Math.round(n);
  };

  const logDays = dayField(o.logRetentionDays, 'logRetentionDays') ?? DEFAULT_RETENTION_CONFIG.logRetentionDays;
  const whDays =
    dayField(o.webhookDeliveryRetentionDays, 'webhookDeliveryRetentionDays') ??
    DEFAULT_RETENTION_CONFIG.webhookDeliveryRetentionDays;
  const intervalRaw =
    o.pruneIntervalMin === undefined || o.pruneIntervalMin === null || o.pruneIntervalMin === ''
      ? DEFAULT_RETENTION_CONFIG.pruneIntervalMin
      : typeof o.pruneIntervalMin === 'number'
        ? o.pruneIntervalMin
        : Number(o.pruneIntervalMin);
  if (!Number.isFinite(intervalRaw) || intervalRaw < MIN_INTERVAL_MIN || intervalRaw > MAX_INTERVAL_MIN) {
    errors.push(`pruneIntervalMin must be between ${MIN_INTERVAL_MIN} and ${MAX_INTERVAL_MIN} minutes`);
  }
  if (whDays < logDays) {
    // not an error — just an odd combination; deliveries are lower-volume so
    // the default keeps them longer. Allow any combination.
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    config: {
      logRetentionDays: logDays,
      webhookDeliveryRetentionDays: whDays,
      autoPrune: o.autoPrune === undefined ? DEFAULT_RETENTION_CONFIG.autoPrune : Boolean(o.autoPrune),
      pruneIntervalMin: clampInterval(intervalRaw, DEFAULT_RETENTION_CONFIG.pruneIntervalMin),
    },
  };
}

/** Effective config with a short cache — readers hit this every prune window. */
export async function getRetentionConfig(): Promise<{ config: RetentionConfig; source: 'db' | 'env' | 'default' }> {
  const st = g.__nxRetentionConfig;
  if (st && Date.now() - st.cachedAt < CACHE_TTL_MS) return { config: st.cached, source: st.source };

  let config: RetentionConfig | null = null;
  let source: 'db' | 'env' | 'default' = 'default';
  try {
    const row = await db.platformSetting.findUnique({ where: { key: RETENTION_CONFIG_KEY } });
    if (row) {
      const parsed = validateRetentionConfigInput(JSON.parse(row.valueJson));
      if (parsed.ok) {
        config = parsed.config;
        source = 'db';
      }
    }
  } catch {
    /* fall through to env */
  }
  if (!config) {
    config = envRetentionConfig();
    source = isEnvCustomized(config) ? 'env' : 'default';
  }

  g.__nxRetentionConfig = { cachedAt: Date.now(), cached: config, source };
  return { config, source };
}

/** Persist (upsert) an operator config; invalidates the cache. */
export async function saveRetentionConfig(config: RetentionConfig): Promise<void> {
  await db.platformSetting.upsert({
    where: { key: RETENTION_CONFIG_KEY },
    update: { valueJson: JSON.stringify(config) },
    create: { key: RETENTION_CONFIG_KEY, valueJson: JSON.stringify(config) },
  });
  g.__nxRetentionConfig = { cachedAt: Date.now(), cached: config, source: 'db' };
}

/** Remove the DB row → falls back to env/defaults; invalidates the cache. */
export async function resetRetentionConfig(): Promise<void> {
  await db.platformSetting.deleteMany({ where: { key: RETENTION_CONFIG_KEY } });
  g.__nxRetentionConfig = undefined;
}

// ─── The real prune pass ─────────────────────────────────────────────────────

export interface PruneResult {
  logsPruned: number;
  deliveriesPruned: number;
  ms: number;
  skipped?: string;
}

/** Delete rows older than the configured cutoffs. REAL deletes, measured. */
export async function pruneNow(config: RetentionConfig): Promise<PruneResult> {
  const started = Date.now();
  const logCutoff = new Date(Date.now() - config.logRetentionDays * 86_400_000);
  const whCutoff = new Date(Date.now() - config.webhookDeliveryRetentionDays * 86_400_000);

  const logsPruned = await db.logEntry.deleteMany({ where: { createdAt: { lt: logCutoff } } }).then((r) => r.count);
  const deliveriesPruned = await db.webhookDelivery
    .deleteMany({ where: { createdAt: { lt: whCutoff } } })
    .then((r) => r.count);

  const result: PruneResult = { logsPruned, deliveriesPruned, ms: Date.now() - started };
  g.__nxRetentionPolicy = {
    lastPruneAt: Date.now(),
    lastPruneResult: { at: Date.now(), logsPruned, deliveriesPruned },
  };
  return result;
}

function policyState(): { lastPruneAt: number; lastPruneResult?: { at: number; logsPruned: number; deliveriesPruned: number } } {
  if (!g.__nxRetentionPolicy) g.__nxRetentionPolicy = { lastPruneAt: 0 };
  return g.__nxRetentionPolicy;
}

/**
 * Throttled auto-prune — called from the 15s host sampler. Runs one real pass
 * per configured interval when autoPrune is on. Records a LogEntry only when
 * something was actually deleted (no feed spam on idle passes). Never throws.
 */
export async function maybePrune(): Promise<void> {
  try {
    const { config } = await getRetentionConfig();
    if (!config.autoPrune) return;
    const st = policyState();
    const intervalMs = config.pruneIntervalMin * 60_000;
    if (Date.now() - st.lastPruneAt < intervalMs) return;

    const result = await pruneNow(config);
    if (result.logsPruned > 0 || result.deliveriesPruned > 0) {
      await db.logEntry
        .create({
          data: {
            scope: 'system',
            level: 'info',
            message: `retention ▸ auto-prune deleted ${result.logsPruned} log rows (>${config.logRetentionDays}d) and ${result.deliveriesPruned} webhook deliveries (>${config.webhookDeliveryRetentionDays}d) in ${result.ms}ms`,
            source: 'retention',
          },
        })
        .catch(() => undefined);
    }
  } catch {
    /* retention must never break the sampler */
  }
}

/** Manual prune (API) — always logs the outcome so the operator sees it in the feed. */
export async function manualPrune(): Promise<PruneResult> {
  const { config } = await getRetentionConfig();
  const result = await pruneNow(config);
  await db.logEntry
    .create({
      data: {
        scope: 'system',
        level: 'info',
        message: `retention ▸ manual prune deleted ${result.logsPruned} log rows (>${config.logRetentionDays}d retention) and ${result.deliveriesPruned} webhook deliveries (>${config.webhookDeliveryRetentionDays}d) in ${result.ms}ms`,
        source: 'retention',
      },
    })
    .catch(() => undefined);
  return result;
}

// ─── Live stats (measured, for the UI) ───────────────────────────────────────

export interface RetentionStats {
  logEntryCount: number;
  webhookDeliveryCount: number;
  oldestLogAt: string | null;
  newestLogAt: string | null;
  rowsLast24h: number;
  estRowsPerDay: number;
  dbFileMb: number;
  lastPrune: { at: string; logsPruned: number; deliveriesPruned: number } | null;
  nextAutoPruneInMs: number | null;
}

/** Real row counts, age of the oldest row, real growth rate, DB file size. */
export async function getRetentionStats(): Promise<RetentionStats> {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const [logEntryCount, webhookDeliveryCount, oldest, newest, rowsLast24h] = await Promise.all([
    db.logEntry.count(),
    db.webhookDelivery.count(),
    db.logEntry.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    db.logEntry.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    db.logEntry.count({ where: { createdAt: { gte: dayAgo } } }),
  ]);

  let dbFileMb = 0;
  try {
    const p = (process.env.DATABASE_URL ?? 'file:db/custom.db').replace(/^file:/, '');
    const st = fsSync.statSync(p);
    dbFileMb = +(st.size / 1024 / 1024).toFixed(2);
  } catch {
    /* stat failed — report 0 */
  }

  const st = policyState();
  const { config } = await getRetentionConfig();
  const nextAutoPruneInMs = config.autoPrune
    ? Math.max(0, st.lastPruneAt + config.pruneIntervalMin * 60_000 - Date.now())
    : null;

  // growth estimate: rows written in the last 24h, or — when the window is
  // younger — a rate scaled from real elapsed time
  let estRowsPerDay = rowsLast24h;
  if (oldest && newest) {
    const spanMs = new Date(newest.createdAt).getTime() - new Date(oldest.createdAt).getTime();
    if (spanMs > 0 && spanMs < 86_400_000 && logEntryCount > 0) {
      estRowsPerDay = Math.round((logEntryCount / spanMs) * 86_400_000);
    }
  }

  return {
    logEntryCount,
    webhookDeliveryCount,
    oldestLogAt: oldest ? new Date(oldest.createdAt).toISOString() : null,
    newestLogAt: newest ? new Date(newest.createdAt).toISOString() : null,
    rowsLast24h,
    estRowsPerDay,
    dbFileMb,
    lastPrune: st.lastPruneResult ? { ...st.lastPruneResult, at: new Date(st.lastPruneResult.at).toISOString() } : null,
    nextAutoPruneInMs,
  };
}
