import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { buildAgentScript, generateAgentToken } from '@/lib/hoster/providers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agent/install?token=<agentToken>
 * Returns the REAL bash agent script that streams hardware telemetry from any
 * Linux machine to this dashboard. The script uses actual /proc, free, df and
 * nvidia-smi/rocm-smi measurements.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'Missing ?token=<agentToken> query parameter' }, { status: 400 });
  }

  const provider = await db.provider.findUnique({ where: { agentToken: token } });
  if (!provider) {
    return NextResponse.json({ error: 'Unknown agent token' }, { status: 404 });
  }

  // Derive the public base URL from incoming headers (works behind proxies).
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const baseUrl = `${proto}://${host}`;

  const script = buildAgentScript(baseUrl, token, provider.name);

  return new NextResponse(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="nh-agent-${provider.slug}.sh"`,
    },
  });
}

/**
 * POST /api/agent/install — (re)generate an agent token for a custom node.
 * Body: { providerId }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const providerId = String(body.providerId ?? '');
    const provider = await db.provider.findUnique({ where: { id: providerId } });
    if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    if (provider.type !== 'custom_agent') {
      return NextResponse.json({ error: 'Only agent-based custom nodes support agent tokens.' }, { status: 400 });
    }

    const agentToken = generateAgentToken();
    await db.provider.update({ where: { id: provider.id }, data: { agentToken } });
    return NextResponse.json({ data: { agentToken } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
