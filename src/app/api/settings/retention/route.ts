import { NextRequest, NextResponse } from 'next/server';
import {
  getRetentionConfig,
  saveRetentionConfig,
  resetRetentionConfig,
  validateRetentionConfigInput,
  manualPrune,
  getRetentionStats,
  DEFAULT_RETENTION_CONFIG,
} from '@/lib/hoster/retention';

/**
 * GET    /api/settings/retention — effective retention config + live DB stats
 * PUT    /api/settings/retention — validate + persist operator config (DB row)
 * DELETE /api/settings/retention — remove the DB row → env/defaults take over
 * POST   /api/settings/retention — prune NOW (real deletes, receipt in the feed)
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [{ config, source }, stats] = await Promise.all([getRetentionConfig(), getRetentionStats()]);
    return NextResponse.json({ data: { config, source, defaults: DEFAULT_RETENTION_CONFIG, stats } });
  } catch (err) {
    console.error('[api/settings/retention] GET failed', err);
    return NextResponse.json({ error: 'Failed to read retention config' }, { status: 500 });
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
    const parsed = validateRetentionConfigInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: `validation failed: ${parsed.errors.join('; ')}` }, { status: 422 });
    }
    await saveRetentionConfig(parsed.config);
    return NextResponse.json({ data: { config: parsed.config, source: 'db' as const } });
  } catch (err) {
    console.error('[api/settings/retention] PUT failed', err);
    return NextResponse.json({ error: 'Failed to save retention config' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await resetRetentionConfig();
    const { config, source } = await getRetentionConfig();
    return NextResponse.json({ data: { config, source } });
  } catch (err) {
    console.error('[api/settings/retention] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to reset retention config' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await manualPrune();
    const stats = await getRetentionStats();
    return NextResponse.json({ data: { result, stats } });
  } catch (err) {
    console.error('[api/settings/retention] POST failed', err);
    return NextResponse.json({ error: 'Failed to prune' }, { status: 500 });
  }
}
