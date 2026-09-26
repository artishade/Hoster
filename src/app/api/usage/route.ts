import { NextRequest, NextResponse } from 'next/server';
import { getUsageReport } from '@/lib/hoster/usage';

/**
 * GET /api/usage?days=30
 *   → REAL usage metering: instance-hours (uptime × live instances),
 *     proxied requests, measured egress — plus a transparent
 *     "equivalent cloud cost" (real usage × public list prices).
 *     The platform itself bills $0.00 (free tier).
 */

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const daysRaw = Number(req.nextUrl.searchParams.get('days') ?? '30');
    const days = Number.isFinite(daysRaw) ? daysRaw : 30;
    const report = await getUsageReport(days);
    return NextResponse.json({ data: report });
  } catch (err) {
    console.error('[api/usage] GET failed', err);
    return NextResponse.json({ error: 'Failed to build usage report' }, { status: 500 });
  }
}
