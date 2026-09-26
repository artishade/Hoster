import { NextResponse } from 'next/server';
import dns from 'dns/promises';
import { db } from '@/lib/db';
import { getEdgeInfo } from '@/lib/hoster/edge';
import { ensureProviderWatchdog } from '@/lib/hoster/providers';
import { addLog } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/edge — real edge network status:
 *  - this host as a live PoP (region, hardware, uptime — all measured)
 *  - host-header routing table (wildcard + custom domains)
 *  - live upstream provider latency probes (run right now)
 *
 * POST /api/edge — verify DNS for a domain NOW:
 *  body { domain } → resolves CNAME/A records via the real resolver and
 *  reports whether the records point anywhere (real DNS, real answers).
 */
export async function GET() {
  try {
    ensureProviderWatchdog();
    const info = await getEdgeInfo();
    return NextResponse.json({ data: info });
  } catch (err) {
    console.error('[api/edge] GET failed', err);
    return NextResponse.json({ error: 'Failed to load edge status' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const domain = String((body as { domain?: unknown }).domain ?? '').trim().toLowerCase();
    if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      return NextResponse.json({ error: 'A valid domain is required' }, { status: 400 });
    }

    const started = Date.now();
    const result: Record<string, unknown> = { domain, resolver: 'dns.promises (real)' };

    try {
      const cname = await dns.resolveCname(domain);
      result.cname = cname;
      result.cnameMatchesEdge = cname.some((c) => c.toLowerCase() === 'edge.nexushost.dev');
    } catch (err) {
      result.cname = [];
      result.cnameError = (err as NodeJS.ErrnoException).code ?? 'NO_CNAME';
      result.cnameMatchesEdge = false; // no CNAME at all → definitely not pointing at the edge
    }

    try {
      const a = await dns.resolve4(domain);
      result.a = a;
    } catch (err) {
      result.a = [];
      result.aError = (err as NodeJS.ErrnoException).code ?? 'NO_A';
    }

    try {
      const aaaa = await dns.resolve6(domain);
      result.aaaa = aaaa;
    } catch {
      result.aaaa = [];
    }

    result.hasAnyRecord = (result.cname as string[]).length > 0 || (result.a as string[]).length > 0;
    result.elapsedMs = Date.now() - started;

    await addLog({
      scope: 'domain',
      message: `Edge DNS check for ${domain}: ${(result.cname as string[]).length} CNAME, ${(result.a as string[]).length} A records (${result.cnameMatchesEdge ? 'points at edge' : 'no edge CNAME match'}) — resolved in ${result.elapsedMs}ms`,
      source: 'edge-dns',
    });

    return NextResponse.json({ data: result });
  } catch (err) {
    console.error('[api/edge] POST failed', err);
    return NextResponse.json({ error: 'DNS check failed' }, { status: 500 });
  }
}
