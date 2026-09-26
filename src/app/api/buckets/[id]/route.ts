import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addLog, serializeBucket } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

interface PatchBucketBody {
  action?: unknown;
  isPublic?: unknown;
  endpointUrl?: unknown;
  accessKeyId?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.bucket.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });

    let body: PatchBucketBody;
    try {
      body = (await req.json()) as PatchBucketBody;
    } catch {
      body = {};
    }

    const data: { isPublic?: boolean; endpointUrl?: string | null; accessKeyId?: string; status?: string } = {};
    let testResult: { success: boolean; latencyMs: number; error?: string } | null = null;

    if (body.isPublic !== undefined) data.isPublic = Boolean(body.isPublic);
    if (body.accessKeyId !== undefined) data.accessKeyId = str(body.accessKeyId);
    if (body.endpointUrl !== undefined) {
      const endpoint = str(body.endpointUrl);
      data.endpointUrl = endpoint ? (/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`) : null;
    }

    if (body.action === 'test_connection') {
      const endpoint = data.endpointUrl !== undefined ? data.endpointUrl : row.endpointUrl;

      if (row.provider === 'built-in-storage' && !endpoint) {
        // Platform-local storage: no network probe needed, instant success.
        testResult = { success: true, latencyMs: 1 };
        data.status = 'connected';
      } else if (endpoint) {
        const started = Date.now();
        try {
          // REAL reachability check — any HTTP response counts as success.
          await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(6000) });
          testResult = { success: true, latencyMs: Math.max(1, Date.now() - started) };
          data.status = 'connected';
        } catch (err) {
          testResult = {
            success: false,
            latencyMs: Math.max(1, Date.now() - started),
            error: err instanceof Error ? err.message : 'network error',
          };
          data.status = 'error';
        }
      } else {
        return NextResponse.json({ error: 'This bucket has no endpointUrl to test' }, { status: 400 });
      }

      await addLog({
        scope: 'storage',
        level: testResult.success ? 'info' : 'warn',
        message: testResult.success
          ? `Connection test for bucket "${row.name}" passed (${testResult.latencyMs} ms).`
          : `Connection test for bucket "${row.name}" failed — ${testResult.error ?? 'network error'}.`,
      });
    } else if (body.action !== undefined) {
      return NextResponse.json({ error: `Invalid action "${String(body.action)}" (expected "test_connection")` }, { status: 400 });
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'Nothing to update (pass action "test_connection" and/or isPublic, endpointUrl, accessKeyId)' },
        { status: 400 }
      );
    }

    const updated = await db.bucket.update({ where: { id }, data });
    const serialized = serializeBucket(updated);

    return NextResponse.json({ data: testResult ? { ...serialized, testResult } : serialized });
  } catch (err) {
    console.error('[api/buckets/[id]] PATCH failed', err);
    return NextResponse.json({ error: 'Failed to update bucket' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.bucket.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });

    await db.bucket.delete({ where: { id } });
    await addLog({ scope: 'storage', message: `Bucket "${row.name}" deleted.` });
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error('[api/buckets/[id]] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to delete bucket' }, { status: 500 });
  }
}
