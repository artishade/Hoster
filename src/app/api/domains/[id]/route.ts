import { NextRequest, NextResponse } from 'next/server';
import dns from 'dns/promises';
import { db } from '@/lib/db';
import { addLog, serializeDomain } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

interface PatchDomainBody {
  action?: unknown;
}

/** REAL DNS check: CNAME first, then any A/AAAA records. */
async function checkDnsConfigured(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveCname(domain);
    if (records.length > 0) return true;
  } catch {
    // fall through to generic resolve
  }
  try {
    const records = await dns.resolve(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.domain.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

    let body: PatchDomainBody;
    try {
      body = (await req.json()) as PatchDomainBody;
    } catch {
      body = {};
    }

    if (body.action !== 'recheck_dns') {
      return NextResponse.json({ error: 'Invalid action (expected "recheck_dns")' }, { status: 400 });
    }

    const dnsConfigured = await checkDnsConfigured(row.domain);

    let sslStatus = row.sslStatus;
    if (dnsConfigured && sslStatus === 'failed') sslStatus = 'pending';
    if (!dnsConfigured && sslStatus === 'pending') sslStatus = 'failed';

    const updated = await db.domain.update({
      where: { id },
      data: { dnsConfigured, sslStatus, checkCount: { increment: 1 } },
    });

    await addLog({
      scope: 'domain',
      message: `DNS recheck for ${row.domain}: ${
        dnsConfigured ? 'records found — certificate issuance continues' : 'no records found yet'
      }`,
    });

    return NextResponse.json({ data: serializeDomain(updated) });
  } catch (err) {
    console.error('[api/domains/[id]] PATCH failed', err);
    return NextResponse.json({ error: 'Failed to recheck domain' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.domain.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

    await db.domain.delete({ where: { id } });
    await addLog({
      scope: 'domain',
      message: `Domain ${row.domain} removed from service "${row.serviceName}" — certificate revoked.`,
    });
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error('[api/domains/[id]] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to delete domain' }, { status: 500 });
  }
}
