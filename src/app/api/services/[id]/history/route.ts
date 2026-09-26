import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * REAL service metric history.
 *
 * Every point comes from MetricSample rows the host sampler actually
 * recorded for this service: real /proc CPU+RAM of the deployed process and
 * real request counters (rpm / p95 latency in extraJson). If a service has no
 * samples yet (deployed seconds ago) an empty series is returned — never a
 * fabricated one.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    const url = new URL(req.url);
    const rawPoints = Number(url.searchParams.get('points') ?? '40');
    const points = Math.min(120, Math.max(1, Number.isFinite(rawPoints) ? Math.round(rawPoints) : 40));

    const samples = await db.metricSample.findMany({
      where: { scope: 'service', scopeId: id },
      orderBy: { timestamp: 'desc' },
      take: points,
    });
    samples.reverse(); // oldest → newest for charting

    const data = samples.map((s) => {
      let extra: { requestsPerMin?: number; latencyP95Ms?: number } = {};
      try {
        extra = s.extraJson ? JSON.parse(s.extraJson) : {};
      } catch {
        extra = {};
      }
      return {
        timestamp: s.timestamp,
        cpuPercent: s.cpuPercent,
        ramUsedGb: s.ramUsedGb,
        ramTotalGb: s.ramTotalGb,
        requestsPerMin: extra.requestsPerMin ?? 0,
        latencyP95Ms: extra.latencyP95Ms ?? 0,
      };
    });

    return NextResponse.json({ data });
  } catch (err) {
    console.error('[api/services/[id]/history] GET failed', err);
    return NextResponse.json({ error: 'Failed to load service history' }, { status: 500 });
  }
}
