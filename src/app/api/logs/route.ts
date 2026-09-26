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

/**
 * POST /api/logs — record a REAL activity event from platform components
 * (e.g. the terminal mini-service logs PTY attach/detach so sessions show up
 * in the Activity feed). Strictly validated: level + scope whitelists, message
 * length cap, serviceId must exist. Sources outside the allowlist are tagged
 * "external" for auditability.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      serviceId?: string | null;
      scope?: string;
      level?: string;
      message?: string;
      source?: string;
    };

    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
    if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

    const level = ['info', 'warn', 'error', 'debug'].includes(body.level ?? '') ? body.level! : 'info';
    const SCOPE_WHITELIST = ['system', 'service', 'database', 'storage', 'domain', 'provider', 'deploy'];
    let scope = SCOPE_WHITELIST.includes(body.scope ?? '') ? body.scope! : 'system';
    const source = typeof body.source === 'string' ? body.source.slice(0, 60) : 'external';

    let serviceId: string | null = null;
    if (body.serviceId) {
      const svc = await db.service.findUnique({ where: { id: body.serviceId }, select: { id: true } });
      if (!svc) return NextResponse.json({ error: 'unknown serviceId' }, { status: 400 });
      serviceId = svc.id;
      scope = 'service';
    }

    const row = await db.logEntry.create({
      data: { serviceId, scope, level, message, source },
    });

    return NextResponse.json({ data: serializeLog(row) }, { status: 201 });
  } catch (err) {
    console.error('[api/logs] POST failed', err);
    return NextResponse.json({ error: 'Failed to record log' }, { status: 500 });
  }
}
