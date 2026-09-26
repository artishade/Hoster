import { db } from '@/lib/db';

/**
 * Alert & budget configuration — operator-editable, persisted in the DB
 * (PlatformSetting key 'usage-alerts'), falling back to environment
 * variables, then to sane defaults. Priority: DB row > env > default.
 *
 * What it configures (all consumed by the usage-alerts sweep):
 *   - hourThresholds   per-service instance-hour ladder per UTC day (info pacing)
 *   - costThresholds   per-service equivalent-cost ladder (warn … error)
 *   - budgetWarnUsd    platform-wide daily equivalent budget → warn
 *   - budgetErrorUsd   platform-wide daily equivalent budget → error
 *   - webhookUrl       optional HTTP(S) endpoint that receives fan-out POSTs
 *   - webhookMinLevel  minimum alert level that fans out ('none'|'warn'|'error')
 */

export interface AlertConfig {
  hourThresholds: number[];
  costThresholds: number[];
  budgetWarnUsd: number;
  budgetErrorUsd: number;
  webhookUrl: string;
  webhookMinLevel: 'none' | 'warn' | 'error';
}

export const ALERT_CONFIG_KEY = 'usage-alerts';

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  hourThresholds: [2, 6, 12],
  costThresholds: [0.1, 0.5, 2.0],
  budgetWarnUsd: 1.0,
  budgetErrorUsd: 2.0,
  webhookUrl: '',
  webhookMinLevel: 'none',
};

const MAX_LADDER = 6;
const CACHE_TTL_MS = 15_000;

interface AlertConfigGlobal {
  __nxAlertConfig?: {
    cachedAt: number;
    cached: AlertConfig;
    source: 'db' | 'env' | 'default';
  };
}
const g = globalThis as AlertConfigGlobal;

function parseEnvNums(name: string, defaults: readonly number[]): number[] {
  const raw = process.env[name];
  if (!raw) return [...defaults];
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return parsed.length ? parsed.slice(0, MAX_LADDER) : [...defaults];
}

/** Env-derived config (used when no DB row exists). */
function envAlertConfig(): AlertConfig {
  return {
    ...DEFAULT_ALERT_CONFIG,
    hourThresholds: parseEnvNums('NX_USAGE_ALERT_HOUR_THRESHOLDS', DEFAULT_ALERT_CONFIG.hourThresholds),
    costThresholds: parseEnvNums('NX_USAGE_ALERT_COST_THRESHOLDS', DEFAULT_ALERT_CONFIG.costThresholds),
  };
}

function normalizeLadder(nums: number[]): number[] {
  return [...new Set(nums.map((n) => Number(n.toFixed(6))))].sort((a, b) => a - b).slice(0, MAX_LADDER);
}

/** Parse + validate raw input (API body or DB row). Returns typed errors. */
export function validateAlertConfigInput(raw: unknown): { ok: true; config: AlertConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['body must be a JSON object'] };
  const o = raw as Record<string, unknown>;

  const hours = parseLadderField(o.hourThresholds, 'hourThresholds', errors);
  const costs = parseLadderField(o.costThresholds, 'costThresholds', errors);

  const budgetWarn = numField(o.budgetWarnUsd, 'budgetWarnUsd', errors);
  const budgetError = numField(o.budgetErrorUsd, 'budgetErrorUsd', errors);
  if (budgetWarn !== null && budgetError !== null && budgetWarn >= budgetError) {
    errors.push('budgetWarnUsd must be lower than budgetErrorUsd');
  }

  const webhookUrl = typeof o.webhookUrl === 'string' ? o.webhookUrl.trim() : '';
  if (webhookUrl && !/^https?:\/\/.+/i.test(webhookUrl)) {
    errors.push('webhookUrl must be an http(s) URL (or empty to disable)');
  }
  if (webhookUrl.length > 500) errors.push('webhookUrl too long (max 500 chars)');

  const minLevel = o.webhookMinLevel;
  if (minLevel !== undefined && !['none', 'warn', 'error'].includes(String(minLevel))) {
    errors.push("webhookMinLevel must be one of 'none' | 'warn' | 'error'");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    config: {
      hourThresholds: normalizeLadder(hours ?? DEFAULT_ALERT_CONFIG.hourThresholds),
      costThresholds: normalizeLadder(costs ?? DEFAULT_ALERT_CONFIG.costThresholds),
      budgetWarnUsd: budgetWarn ?? DEFAULT_ALERT_CONFIG.budgetWarnUsd,
      budgetErrorUsd: budgetError ?? DEFAULT_ALERT_CONFIG.budgetErrorUsd,
      webhookUrl,
      webhookMinLevel: (['none', 'warn', 'error'].includes(String(minLevel)) ? minLevel : 'none') as AlertConfig['webhookMinLevel'],
    },
  };
}

function parseLadderField(v: unknown, name: string, errors: string[]): number[] | null {
  if (v === undefined || v === null) return null;
  let nums: number[] = [];
  if (Array.isArray(v)) {
    nums = v.map((x) => (typeof x === 'number' ? x : Number(x)));
  } else if (typeof v === 'string') {
    nums = v.split(',').map((s) => Number(s.trim()));
  } else {
    errors.push(`${name} must be an array of numbers or a comma-separated string`);
    return null;
  }
  const bad = nums.some((n) => !Number.isFinite(n) || n <= 0);
  if (bad || nums.length === 0) {
    errors.push(`${name} must contain only positive numbers (at least one)`);
    return null;
  }
  if (nums.length > MAX_LADDER) errors.push(`${name} allows at most ${MAX_LADDER} thresholds`);
  return nums.filter((n) => Number.isFinite(n) && n > 0).slice(0, MAX_LADDER);
}

function numField(v: unknown, name: string, errors: string[]): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`${name} must be a positive number`);
    return null;
  }
  return n;
}

/** Effective config with a short cache — readers hit this every sweep. */
export async function getAlertConfig(): Promise<{ config: AlertConfig; source: 'db' | 'env' | 'default' }> {
  const st = g.__nxAlertConfig;
  if (st && Date.now() - st.cachedAt < CACHE_TTL_MS) return { config: st.cached, source: st.source };

  let config: AlertConfig | null = null;
  let source: 'db' | 'env' | 'default' = 'default';
  try {
    const row = await db.platformSetting.findUnique({ where: { key: ALERT_CONFIG_KEY } });
    if (row) {
      const parsed = validateAlertConfigInput(JSON.parse(row.valueJson));
      if (parsed.ok) {
        config = parsed.config;
        source = 'db';
      }
    }
  } catch {
    /* fall through to env */
  }
  if (!config) {
    config = envAlertConfig();
    source = config.hourThresholds.join() !== DEFAULT_ALERT_CONFIG.hourThresholds.join() ||
      config.costThresholds.join() !== DEFAULT_ALERT_CONFIG.costThresholds.join()
      ? 'env'
      : 'default';
  }

  g.__nxAlertConfig = { cachedAt: Date.now(), cached: config, source };
  return { config, source };
}

/** Persist (upsert) an operator config; invalidates the cache. */
export async function saveAlertConfig(config: AlertConfig): Promise<void> {
  await db.platformSetting.upsert({
    where: { key: ALERT_CONFIG_KEY },
    update: { valueJson: JSON.stringify(config) },
    create: { key: ALERT_CONFIG_KEY, valueJson: JSON.stringify(config) },
  });
  g.__nxAlertConfig = { cachedAt: Date.now(), cached: config, source: 'db' };
}

/** Remove the DB row → falls back to env/default; invalidates the cache. */
export async function resetAlertConfig(): Promise<void> {
  await db.platformSetting.deleteMany({ where: { key: ALERT_CONFIG_KEY } });
  g.__nxAlertConfig = undefined;
}
