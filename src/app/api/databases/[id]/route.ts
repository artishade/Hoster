import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getHostMetrics } from '@/lib/hoster/metrics';
import { addLog, serializePostgres, serializeRedis } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

interface PatchDatabaseBody {
  action?: unknown;
  kind?: unknown;
}

function resolveKind(req: NextRequest, body: PatchDatabaseBody): 'postgres' | 'redis' | null {
  const queryKind = new URL(req.url).searchParams.get('kind');
  const raw = queryKind ?? (typeof body.kind === 'string' ? body.kind : null);
  if (raw === 'postgres' || raw === 'redis') return raw;
  return null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    let body: PatchDatabaseBody;
    try {
      body = (await req.json()) as PatchDatabaseBody;
    } catch {
      body = {};
    }

    const kind = resolveKind(req, body);
    if (!kind) {
      return NextResponse.json({ error: 'kind must be "postgres" or "redis" (pass ?kind= or body.kind)' }, { status: 400 });
    }

    if (body.action !== 'stop' && body.action !== 'start') {
      return NextResponse.json({ error: 'Invalid action (expected "stop" or "start")' }, { status: 400 });
    }

    const row =
      kind === 'postgres'
        ? await db.postgresDb.findUnique({ where: { id } })
        : await db.redisDb.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Database not found' }, { status: 404 });

    const status = body.action === 'stop' ? 'stopped' : 'available';
    const label = kind === 'postgres' ? 'PostgreSQL' : 'Redis';
    const message =
      body.action === 'stop'
        ? `${label} instance "${row.name}" stopped by operator. Connections drained.`
        : `${label} instance "${row.name}" started — accepting connections.`;

    if (kind === 'postgres') {
      const updated = await db.postgresDb.update({ where: { id }, data: { status } });
      await addLog({ scope: 'database', message });
      const host = await getHostMetrics();
      return NextResponse.json({ data: serializePostgres(updated, host) });
    }

    const updated = await db.redisDb.update({ where: { id }, data: { status } });
    await addLog({ scope: 'database', message });
    const host = await getHostMetrics();
    return NextResponse.json({ data: serializeRedis(updated, host) });
  } catch (err) {
    console.error('[api/databases/[id]] PATCH failed', err);
    return NextResponse.json({ error: 'Failed to update database' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const pg = await db.postgresDb.findUnique({ where: { id } });
    if (pg) {
      await db.postgresDb.delete({ where: { id } });
      await addLog({ scope: 'database', message: `Database "${pg.name}" deleted — storage reclaimed.` });
      return NextResponse.json({ data: { ok: true } });
    }

    const redis = await db.redisDb.findUnique({ where: { id } });
    if (redis) {
      await db.redisDb.delete({ where: { id } });
      await addLog({ scope: 'database', message: `Database "${redis.name}" deleted — storage reclaimed.` });
      return NextResponse.json({ data: { ok: true } });
    }

    return NextResponse.json({ error: 'Database not found' }, { status: 404 });
  } catch (err) {
    console.error('[api/databases/[id]] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to delete database' }, { status: 500 });
  }
}
