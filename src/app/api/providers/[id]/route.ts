import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyProvider, generateAgentToken } from '@/lib/hoster/providers';
import { serializeProvider, serializeNode, addLog, recomputeAllocations, safeParse } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/providers/[id]
 * Body: { action: 'connect' | 'disconnect' | 'test' | 'update', token?, endpointUrl?, capacity?, tags?, notes?, name? }
 * connect/test perform REAL verification against the provider's API or probe target.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const row = await db.provider.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

    const body = await req.json();
    const action = String(body.action ?? 'update');

    if (action === 'connect' || action === 'test') {
      const token = body.token !== undefined ? String(body.token).trim() : row.token;
      const endpointUrl = body.endpointUrl !== undefined ? String(body.endpointUrl).trim() : row.endpointUrl;

      const verify = await verifyProvider(row.type, { token, endpointUrl, agentToken: row.agentToken });
      const capacity = mergeCapacity(
        body.capacity ? JSON.stringify(body.capacity) : row.capacityJson,
        verify.capacityPatch
      );

      await db.provider.update({
        where: { id: row.id },
        data: {
          token: token ?? null,
          endpointUrl: endpointUrl ?? null,
          status: action === 'connect' ? (verify.success ? 'connected' : 'error') : row.status,
          lastCheckedAt: new Date(),
          pingLatencyMs: verify.latencyMs ?? null,
          accountEmail: verify.accountEmail ?? row.accountEmail,
          accountPlan: verify.accountPlan ?? row.accountPlan,
          capacityJson: capacity,
        },
      });

      if (action === 'connect') {
        await addLog({
          scope: 'provider',
          level: verify.success ? 'info' : 'error',
          message: `Provider "${row.name}" ${verify.success ? 'connected' : 'connection failed'} — ${
            verify.success ? verify.message : verify.error
          }`,
          source: 'settings',
        });
      }

      const updated = await db.provider.findUnique({ where: { id: row.id } });
      const serialized = updated
        ? row.type === 'custom_agent' || row.type === 'custom_probe'
          ? serializeNode(updated)
          : serializeProvider(updated)
        : null;

      return NextResponse.json({
        data: {
          provider: serialized,
          verify: { success: verify.success, latencyMs: verify.latencyMs, message: verify.message, error: verify.error },
        },
      });
    }

    if (action === 'disconnect') {
      if (row.isBuiltIn && row.type === 'local') {
        return NextResponse.json({ error: 'The local host node cannot be disconnected.' }, { status: 400 });
      }
      await db.provider.update({
        where: { id: row.id },
        data: { status: 'disconnected' },
      });
      await addLog({
        scope: 'provider',
        level: 'info',
        message: `Provider "${row.name}" disconnected. Its capacity was removed from the scheduling pool.`,
        source: 'settings',
      });
      void recomputeAllocations().catch(() => {});
      const updated = await db.provider.findUnique({ where: { id: row.id } });
      const serialized = updated
        ? row.type === 'custom_agent' || row.type === 'custom_probe'
          ? serializeNode(updated)
          : serializeProvider(updated)
        : null;
      return NextResponse.json({ data: { provider: serialized } });
    }

    // action === 'update'
    if (row.isBuiltIn && (body.name || body.type)) {
      return NextResponse.json({ error: 'Built-in providers cannot be renamed or retyped.' }, { status: 400 });
    }
    await db.provider.update({
      where: { id: row.id },
      data: {
        name: body.name ? String(body.name).slice(0, 60) : row.name,
        endpointUrl: body.endpointUrl !== undefined ? String(body.endpointUrl) : row.endpointUrl,
        token: body.token !== undefined ? String(body.token) || null : row.token,
        capacityJson: body.capacity ? JSON.stringify(body.capacity) : row.capacityJson,
        tagsJson: Array.isArray(body.tags) ? JSON.stringify(body.tags.map(String).slice(0, 8)) : row.tagsJson,
        notes: body.notes !== undefined ? String(body.notes).slice(0, 500) : row.notes,
        agentToken: row.type === 'custom_agent' && !row.agentToken ? generateAgentToken() : row.agentToken,
      },
    });
    const updated = await db.provider.findUnique({ where: { id: row.id } });
    const serialized = updated
      ? row.type === 'custom_agent' || row.type === 'custom_probe'
        ? serializeNode(updated)
        : serializeProvider(updated)
      : null;
    return NextResponse.json({ data: { provider: serialized } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to update provider' }, { status: 500 });
  }
}

/**
 * DELETE /api/providers/[id] — custom providers only (built-ins are permanent).
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const row = await db.provider.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    if (row.isBuiltIn) {
      return NextResponse.json({ error: 'Built-in free providers cannot be removed — disconnect them instead.' }, { status: 400 });
    }
    await db.provider.delete({ where: { id } });
    await addLog({
      scope: 'provider',
      level: 'info',
      message: `Custom provider "${row.name}" removed from the pool.`,
      source: 'settings',
    });
    void recomputeAllocations().catch(() => {});
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Failed to delete provider' }, { status: 500 });
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
