import { NextRequest, NextResponse } from 'next/server';
import { getAlertConfig, saveAlertConfig, resetAlertConfig, validateAlertConfigInput, DEFAULT_ALERT_CONFIG } from '@/lib/hoster/alert-config';

/**
 * GET    /api/settings/alerts — effective alert/budget configuration
 *        { config, source: 'db'|'env'|'default', defaults }
 * PUT    /api/settings/alerts — validate + persist operator config (DB row)
 * DELETE /api/settings/alerts — remove the DB row → env/defaults take over
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { config, source } = await getAlertConfig();
    return NextResponse.json({ data: { config, source, defaults: DEFAULT_ALERT_CONFIG } });
  } catch (err) {
    console.error('[api/settings/alerts] GET failed', err);
    return NextResponse.json({ error: 'Failed to read alert config' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const parsed = validateAlertConfigInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: `validation failed: ${parsed.errors.join('; ')}` }, { status: 422 });
    }
    await saveAlertConfig(parsed.config);
    return NextResponse.json({ data: { config: parsed.config, source: 'db' as const } });
  } catch (err) {
    console.error('[api/settings/alerts] PUT failed', err);
    return NextResponse.json({ error: 'Failed to save alert config' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await resetAlertConfig();
    const { config, source } = await getAlertConfig();
    return NextResponse.json({ data: { config, source } });
  } catch (err) {
    console.error('[api/settings/alerts] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to reset alert config' }, { status: 500 });
  }
}
