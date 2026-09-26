import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureHostSampler } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/history?points=60 — persisted REAL host metric samples
 * (collected by the background sampler every 15s). Used for history charts.
 */
export async function GET(req: NextRequest) {
  try {
    ensureHostSampler();
    const points = Math.min(240, Math.max(2, Number(req.nextUrl.searchParams.get('points')) || 60));

    const rows = await db.metricSample.findMany({
      where: { scope: 'host' },
      orderBy: { timestamp: 'desc' },
      take: points,
    });
    rows.reverse();

    return NextResponse.json({
      data: rows.map((r) => ({
        timestamp: r.timestamp,
        cpuPercent: r.cpuPercent,
        ramUsedGb: r.ramUsedGb,
        ramTotalGb: r.ramTotalGb,
        diskUsedGb: r.diskUsedGb,
        diskTotalGb: r.diskTotalGb,
        netInMb: r.netInMb,
        netOutMb: r.netOutMb,
        extra: r.extraJson ? JSON.parse(r.extraJson) : null,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to read history' }, { status: 500 });
  }
}
