import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/webhooks/deliveries?serviceId=<id>&limit=50 — REAL webhook delivery
 * history (every ping / push / CI trigger the control plane has received,
 * with its accept/skip/reject outcome).
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const serviceId = url.searchParams.get('serviceId');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

    const rows = await db.webhookDelivery.findMany({
      where: serviceId ? { serviceId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const names = new Map<string, string>();
    const svcIds = [...new Set(rows.map((r) => r.serviceId).filter((x): x is string => !!x))];
    if (svcIds.length) {
      const svcs = await db.service.findMany({ where: { id: { in: svcIds } }, select: { id: true, name: true } });
      for (const s of svcs) names.set(s.id, s.name);
    }

    return NextResponse.json({
      data: rows.map((r) => ({
        id: r.id,
        serviceId: r.serviceId,
        serviceName: r.serviceId ? names.get(r.serviceId) ?? '(deleted)' : null,
        source: r.source,
        event: r.event,
        repo: r.repo,
        branch: r.branch,
        sender: r.sender,
        commitSha: r.commitSha,
        result: r.result,
        detail: r.detail,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to list deliveries' }, { status: 500 });
  }
}
