import { NextResponse } from 'next/server';
import { getHostMetrics } from '@/lib/hoster/metrics';
import { ensureHostSampler } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/realtime-node — legacy alias kept for compatibility,
 * now backed by the REAL telemetry engine (CPU delta / RAM / statfs disk / GPU detect).
 */
export async function GET() {
  try {
    ensureHostSampler();
    const metrics = await getHostMetrics();
    return NextResponse.json(metrics);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to read host metrics' }, { status: 500 });
  }
}
