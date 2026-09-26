import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getHostMetrics } from '@/lib/hoster/metrics';
import {
  addLog,
  advanceDatabaseLifecycle,
  ensureHostSampler,
  genPassword,
  serializePostgres,
  serializeRedis,
} from '@/lib/hoster/server';
import type { PostgresDatabase, RedisDatabase } from '@/lib/hoster/types';

export const dynamic = 'force-dynamic';

const NAME_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;
const VALID_EVICTION: readonly string[] = ['allkeys-lru', 'volatile-lru', 'noeviction'];

interface CreateDatabaseBody {
  kind?: unknown;
  name?: unknown;
  region?: unknown;
  storageGb?: unknown;
  pgvectorEnabled?: unknown;
  memoryLimitMb?: unknown;
  evictionPolicy?: unknown;
}

function slugifyName(raw: unknown): string {
  return typeof raw === 'string' ? raw.toLowerCase().trim().replace(/\s+/g, '-') : '';
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function positiveNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export async function GET(req: NextRequest) {
  try {
    ensureHostSampler();
    const kindParam = new URL(req.url).searchParams.get('kind');
    const kind = kindParam === 'postgres' || kindParam === 'redis' ? kindParam : null;
    const host = await getHostMetrics();

    const postgres: PostgresDatabase[] = [];
    const redis: RedisDatabase[] = [];

    if (!kind || kind === 'postgres') {
      const rows = await db.postgresDb.findMany({ orderBy: { createdAt: 'desc' } });
      for (const row of rows) {
        const status = await advanceDatabaseLifecycle(row, 'postgres');
        postgres.push(serializePostgres(row, host, status));
      }
    }
    if (!kind || kind === 'redis') {
      const rows = await db.redisDb.findMany({ orderBy: { createdAt: 'desc' } });
      for (const row of rows) {
        const status = await advanceDatabaseLifecycle(row, 'redis');
        redis.push(serializeRedis(row, host, status));
      }
    }

    return NextResponse.json({ data: { postgres, redis } });
  } catch (err) {
    console.error('[api/databases] GET failed', err);
    return NextResponse.json({ error: 'Failed to load databases' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: CreateDatabaseBody;
  try {
    body = (await req.json()) as CreateDatabaseBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const kind = body.kind === 'postgres' || body.kind === 'redis' ? body.kind : null;
    if (!kind) {
      return NextResponse.json({ error: 'kind must be "postgres" or "redis"' }, { status: 400 });
    }

    const name = slugifyName(body.name);
    if (!NAME_RE.test(name)) {
      return NextResponse.json(
        { error: 'Name must be 3-41 characters: lowercase letters, numbers and dashes, starting with a letter or digit' },
        { status: 400 }
      );
    }

    const region = str(body.region) || undefined;

    if (kind === 'postgres') {
      const existing = await db.postgresDb.findUnique({ where: { name } });
      if (existing) {
        return NextResponse.json({ error: 'A PostgreSQL database with this name already exists' }, { status: 409 });
      }

      const storageGb = positiveNumber(body.storageGb) ?? 1;
      const created = await db.postgresDb.create({
        data: {
          name,
          region,
          storageGb,
          pgvectorEnabled: Boolean(body.pgvectorEnabled),
          connectionString: `postgresql://postgres:${genPassword()}@pg-${name}.internal:5432/main`,
          pooledConnectionString: `postgresql://postgres:${genPassword()}@pg-${name}-pool.internal:6543/main`,
          maxConnections: 100,
          status: 'provisioning',
          lifecycleStartedAt: new Date(),
        },
      });

      await addLog({
        scope: 'database',
        message: `Provisioning PostgreSQL ${created.version} instance "${name}" (${storageGb} GB${
          created.pgvectorEnabled ? ', pgvector enabled' : ''
        })...`,
      });

      const host = await getHostMetrics();
      return NextResponse.json({ data: serializePostgres(created, host) }, { status: 201 });
    }

    // kind === 'redis'
    const existing = await db.redisDb.findUnique({ where: { name } });
    if (existing) {
      return NextResponse.json({ error: 'A Redis database with this name already exists' }, { status: 409 });
    }

    const evictionPolicy = str(body.evictionPolicy) || undefined;
    if (evictionPolicy && !VALID_EVICTION.includes(evictionPolicy)) {
      return NextResponse.json(
        { error: `Invalid evictionPolicy "${evictionPolicy}" (expected allkeys-lru, volatile-lru or noeviction)` },
        { status: 400 }
      );
    }

    const memoryLimitMb = positiveNumber(body.memoryLimitMb) ?? 25;
    const created = await db.redisDb.create({
      data: {
        name,
        region,
        memoryLimitMb,
        evictionPolicy,
        connectionString: `redis://default:${genPassword()}@redis-${name}.internal:6379`,
        status: 'provisioning',
        lifecycleStartedAt: new Date(),
      },
    });

    await addLog({
      scope: 'database',
      message: `Provisioning Redis ${created.version} instance "${name}" (${memoryLimitMb} MB limit, eviction: ${created.evictionPolicy})...`,
    });

    const host = await getHostMetrics();
    return NextResponse.json({ data: serializeRedis(created, host) }, { status: 201 });
  } catch (err) {
    console.error('[api/databases] POST failed', err);
    return NextResponse.json({ error: 'Failed to create database' }, { status: 500 });
  }
}
