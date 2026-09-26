import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runServiceExec, getExecHistory, EXEC_DEFAULT_TIMEOUT_SEC, type RunExecError } from '@/lib/hoster/exec';

/**
 * One-shot command execution inside a service's deployment workspace.
 *
 *   POST /api/services/[id]/exec  { command, timeout? }
 *     → runs `bash -lc <command>` in deployments/<name>/repo (REAL spawn)
 *   GET  /api/services/[id]/exec
 *     → recent exec history for this service (in-memory ring)
 */

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({ where: { id }, select: { id: true } });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    return NextResponse.json({ data: getExecHistory(id) });
  } catch (err) {
    console.error('[api/services/[id]/exec] GET failed', err);
    return NextResponse.json({ error: 'Failed to load exec history' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.service.findUnique({
      where: { id },
      select: { id: true, name: true, runtimeJson: true },
    });
    if (!row) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    let body: { command?: unknown; timeout?: unknown };
    try {
      body = (await req.json()) as { command?: unknown; timeout?: unknown };
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const command = typeof body.command === 'string' ? body.command : '';
    const timeoutRaw = Number(body.timeout);

    const result = await runServiceExec(
      row,
      command,
      Number.isFinite(timeoutRaw) ? timeoutRaw : EXEC_DEFAULT_TIMEOUT_SEC
    );
    return NextResponse.json({ data: result });
  } catch (err) {
    // structured guardrail errors carry their HTTP status
    const e = err as RunExecError;
    if (e && typeof e.status === 'number') {
      return NextResponse.json({ error: e.error }, { status: e.status });
    }
    console.error('[api/services/[id]/exec] POST failed', err);
    return NextResponse.json({ error: 'exec failed' }, { status: 500 });
  }
}
