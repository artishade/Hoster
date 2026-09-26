import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addLog, serializeBucket } from '@/lib/hoster/server';
import type { S3BucketConfig } from '@/lib/hoster/types';

export const dynamic = 'force-dynamic';

const VALID_PROVIDERS: readonly string[] = ['aws-s3', 'cloudflare-r2', 'minio', 'built-in-storage'];

interface CreateBucketBody {
  name?: unknown;
  provider?: unknown;
  bucketName?: unknown;
  region?: unknown;
  endpointUrl?: unknown;
  accessKeyId?: unknown;
  isPublic?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** REAL reachability probe: any HTTP response counts as reachable; network failure = error. */
async function probeEndpoint(endpointUrl: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await fetch(endpointUrl, { method: 'GET', signal: AbortSignal.timeout(6000) });
    return { ok: true, latencyMs: Math.max(1, Date.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.max(1, Date.now() - started),
      error: err instanceof Error ? err.message : 'network error',
    };
  }
}

export async function GET() {
  try {
    const rows = await db.bucket.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json({ data: rows.map(serializeBucket) });
  } catch (err) {
    console.error('[api/buckets] GET failed', err);
    return NextResponse.json({ error: 'Failed to load buckets' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: CreateBucketBody;
  try {
    body = (await req.json()) as CreateBucketBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const name = str(body.name);
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const bucketName = str(body.bucketName);
    if (!bucketName) {
      return NextResponse.json({ error: 'bucketName is required' }, { status: 400 });
    }

    const provider = str(body.provider) || 'built-in-storage';
    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json(
        { error: `Invalid provider "${provider}" (expected aws-s3, cloudflare-r2, minio or built-in-storage)` },
        { status: 400 }
      );
    }

    const region = str(body.region) || 'auto';
    const accessKeyId = str(body.accessKeyId);
    const isPublic = Boolean(body.isPublic);

    const existing = await db.bucket.findUnique({ where: { name } });
    if (existing) {
      return NextResponse.json({ error: 'A bucket with this name already exists' }, { status: 409 });
    }

    // Resolve endpoint: user-provided → derived for AWS S3 → none for built-in storage.
    let endpointUrl = str(body.endpointUrl) || null;
    if (endpointUrl && !/^https?:\/\//.test(endpointUrl)) {
      endpointUrl = `https://${endpointUrl}`;
    }
    if (!endpointUrl && provider === 'aws-s3') {
      endpointUrl = `https://${bucketName}.s3.${region === 'auto' ? 'us-east-1' : region}.amazonaws.com`;
    }
    if (!endpointUrl && provider !== 'built-in-storage') {
      return NextResponse.json({ error: 'endpointUrl is required for external storage providers' }, { status: 400 });
    }

    let status: 'connected' | 'error' = 'connected';
    let latencyMs = 1;
    let probeError: string | undefined;

    if (endpointUrl) {
      const probe = await probeEndpoint(endpointUrl);
      latencyMs = probe.latencyMs;
      probeError = probe.error;
      status = probe.ok ? 'connected' : 'error';
    }

    const created = await db.bucket.create({
      data: {
        name,
        provider,
        bucketName,
        region,
        endpointUrl,
        accessKeyId,
        isPublic,
        totalObjects: 0,
        totalSizeMb: 0,
        status,
      },
    });

    if (endpointUrl) {
      await addLog({
        scope: 'storage',
        level: status === 'connected' ? 'info' : 'warn',
        message:
          status === 'connected'
            ? `Bucket "${name}" connected to ${endpointUrl} (${provider}) — endpoint reachable in ${latencyMs} ms.`
            : `Bucket "${name}" endpoint check failed for ${endpointUrl} (${provider}) — ${probeError ?? 'network error'}.`,
      });
    } else {
      await addLog({
        scope: 'storage',
        message: `Bucket "${name}" created on built-in platform storage (region ${region}) — local ping ~${latencyMs} ms.`,
      });
    }

    return NextResponse.json({ data: serializeBucket(created) }, { status: 201 });
  } catch (err) {
    console.error('[api/buckets] POST failed', err);
    return NextResponse.json({ error: 'Failed to create bucket' }, { status: 500 });
  }
}
