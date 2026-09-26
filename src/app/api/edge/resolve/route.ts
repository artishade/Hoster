import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/edge/resolve?host=<domain> — internal host-header resolver used by
 * the edge middleware. Looks the host up in the Domain table and returns the
 * target service name (or null for platform traffic).
 */
export async function GET(req: NextRequest) {
  try {
    // Only the edge middleware itself may call this resolver.
    if (req.headers.get('x-nx-internal') !== 'edge') {
      return NextResponse.json({ error: 'Internal resolver' }, { status: 403 });
    }
    const host = (new URL(req.url).searchParams.get('host') ?? '').trim().toLowerCase().split(':')[0];
    if (!host) return NextResponse.json({ data: { service: null } });

    const row = await db.domain.findUnique({
      where: { domain: host },
      select: { serviceName: true },
    });
    return NextResponse.json({ data: { service: row?.serviceName ?? null } });
  } catch {
    return NextResponse.json({ data: { service: null } });
  }
}
