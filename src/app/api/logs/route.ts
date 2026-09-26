import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { serializeLog } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get('scope');
    const serviceId = url.searchParams.get('serviceId');
    const level = url.searchParams.get('level');
    const rawLimit = Number(url.searchParams.get('limit') ?? '60');
    const limit = Math.min(300, Math.max(1, Number.isFinite(rawLimit) ? Math.round(rawLimit) : 60));

    const where: Prisma.LogEntryWhereInput = {};
    if (scope) where.scope = scope;
    if (serviceId) where.serviceId = serviceId;
    if (level) where.level = level;

    const rows = await db.logEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return NextResponse.json({ data: rows.map(serializeLog) });
  } catch (err) {
    console.error('[api/logs] GET failed', err);
    return NextResponse.json({ error: 'Failed to load logs' }, { status: 500 });
  }
}
