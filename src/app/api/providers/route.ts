import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { ensureBuiltInProviders, verifyProvider, generateAgentToken } from '@/lib/hoster/providers';
import { serializeProvider, serializeNode, addLog, recomputeAllocations, ensureHostSampler, safeParse } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

const VALID_TYPES = ['local', 'huggingface', 'render', 'fly', 'koyeb', 'runpod', 'custom_agent', 'custom_probe'];

/**
 * GET /api/providers
 * Lists every compute provider in the pool: built-in free providers (auto-seeded,
 * local node always connected with real telemetry) + user-added custom nodes.
 */
export async function GET() {
  try {
    ensureHostSampler();
    await ensureBuiltInProviders();
    void recomputeAllocations().catch(() => {});

    const rows = await db.provider.findMany({ orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }] });

    const cloud = rows
      .filter((r) => r.type !== 'custom_agent' && r.type !== 'custom_probe')
      .map((r) => serializeProvider(r));
    const nodes = rows
      .filter((r) => r.type === 'custom_agent' || r.type === 'custom_probe')
      .map((r) => serializeNode(r));

    return NextResponse.json({ data: { providers: cloud, nodes } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to list providers' }, { status: 500 });
  }
}

/**
 * POST /api/providers — add a CUSTOM provider from Dashboard Settings.
 * Body: { name, type, endpointUrl?, token?, capacity?, tags?, notes? }
 * The provider is verified for REAL immediately (provider API / HTTP probe).
 */
export async function POST(req: NextRequest) {
  try {
    await ensureBuiltInProviders();
    const body = await req.json();

    const name = String(body.name ?? '').trim();
    const type = String(body.type ?? '').trim();
    const endpointUrl = body.endpointUrl ? String(body.endpointUrl).trim() : null;
    const token = body.token ? String(body.token).trim() : null;
    const capacity = body.capacity ?? {};
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String).slice(0, 8) : [];
    const notes = body.notes ? String(body.notes).slice(0, 500) : null;

    if (!name || name.length < 2 || name.length > 60) {
      return NextResponse.json({ error: 'Provider name must be 2-60 characters.' }, { status: 400 });
    }
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Unsupported provider type. Choose one of: ${VALID_TYPES.join(', ')}` },
        { status: 400 }
      );
    }
    if (type === 'custom_probe' && !endpointUrl) {
      return NextResponse.json({ error: 'Probe nodes require an HTTP(S) endpoint URL.' }, { status: 400 });
    }

    const nameExists = await db.provider.findFirst({ where: { name } });
    if (nameExists) {
      return NextResponse.json({ error: 'A provider with this name already exists.' }, { status: 409 });
    }

    const slug = `${type}-${crypto.randomBytes(3).toString('hex')}`;
    const agentToken = type === 'custom_agent' ? generateAgentToken() : null;

    const created = await db.provider.create({
      data: {
        slug,
        name,
        type,
        category: type === 'custom_agent' || type === 'custom_probe' ? 'custom_server' : 'gpu_cloud',
        status: 'connecting',
        endpointUrl,
        token,
        agentToken,
        capacityJson: JSON.stringify({
          vCpu: Number(capacity.vCpu) || 0,
          ramGb: Number(capacity.ramGb) || 0,
          gpuModel: capacity.gpuModel ? String(capacity.gpuModel) : undefined,
          vramGb: capacity.vramGb ? Number(capacity.vramGb) : undefined,
          storageGb: Number(capacity.storageGb) || 0,
        }),
        allocatedJson: JSON.stringify({ vCpu: 0, ramGb: 0, servicesCount: 0 }),
        featuresJson: JSON.stringify(
          type === 'custom_agent'
            ? ['Real-time agent heartbeat telemetry', 'CPU / RAM / disk / GPU from the machine itself']
            : type === 'custom_probe'
              ? ['HTTP probe health checks', 'Real latency measurement']
              : ['Verified provider API integration']
        ),
        isBuiltIn: false,
        isFree: type === 'custom_agent' || type === 'custom_probe',
        tagsJson: JSON.stringify(tags),
        notes,
      },
    });

    // Immediate REAL verification
    const verify = await verifyProvider(type, { token, endpointUrl, agentToken });
    const mergedCapacity = mergeCapacity(created.capacityJson, verify.capacityPatch);
    await db.provider.update({
      where: { id: created.id },
      data: {
        status: verify.success ? 'connected' : 'error',
        lastCheckedAt: new Date(),
        pingLatencyMs: verify.latencyMs ?? null,
        accountEmail: verify.accountEmail ?? null,
        accountPlan: verify.accountPlan ?? null,
        capacityJson: mergedCapacity,
      },
    });

    await addLog({
      scope: 'provider',
      level: verify.success ? 'info' : 'warn',
      message: `Custom provider "${name}" (${type}) added — ${
        verify.success ? `verified in ${verify.latencyMs}ms: ${verify.message}` : `verification failed: ${verify.error}`
      }`,
      source: 'settings',
    });

    const row = await db.provider.findUnique({ where: { id: created.id } });
    const serialized = row
      ? type === 'custom_agent' || type === 'custom_probe'
        ? serializeNode(row)
        : serializeProvider(row)
      : null;

    return NextResponse.json(
      {
        data: {
          provider: serialized,
          verify: { success: verify.success, latencyMs: verify.latencyMs, message: verify.message, error: verify.error },
          agentToken,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to add provider' }, { status: 500 });
  }
}

function mergeCapacity(currentJson: string, patch?: Record<string, unknown>): string {
  const current = safeParse<Record<string, unknown>>(currentJson, {});
  if (!patch) return JSON.stringify(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null && v !== '') current[k] = v;
  }
  return JSON.stringify(current);
}
