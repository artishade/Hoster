import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/services/[id]/log-file — REAL on-disk log history.
 *
 * The live terminal shows the rate-limited DB buffer (~60 lines / 30s); this
 * endpoint reads the service's actual app.log file — the complete, unfiltered
 * stdout+stderr record of the deployed process.
 *
 *   ?tail=N        last N lines (default 300, max 5000)
 *   ?download=1    stream the whole file as a text attachment
 */
const DEPLOY_ROOT = path.join(process.cwd(), 'deployments');
const MAX_READ_BYTES = 16 * 1024 * 1024; // cap in-memory reads at 16 MB

function appLogPath(name: string): string {
  return path.join(DEPLOY_ROOT, name, 'app.log');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const svc = await db.service.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!svc) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    const logPath = appLogPath(svc.name);
    const url = new URL(req.url);

    // Whole-file download (streams from disk — no size cap).
    if (url.searchParams.get('download')) {
      const exists = await fsp
        .access(logPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) return NextResponse.json({ error: 'No app.log on disk for this service yet.' }, { status: 404 });
      const data = await fsp.readFile(logPath);
      return new NextResponse(new Uint8Array(data), {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${svc.name}-app.log"`,
        },
      });
    }

    const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 300, 1), 5000);

    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(logPath);
    } catch {
      return NextResponse.json({
        data: {
          exists: false,
          lines: [],
          sizeBytes: 0,
          truncated: false,
          requestedTail: tail,
          message: 'No app.log on disk yet — git-deployed services create it on first boot.',
        },
      });
    }

    // Read at most the last MAX_READ_BYTES; count lines within that window.
    const readFrom = Math.max(0, st.size - MAX_READ_BYTES);
    const fh = await fsp.open(logPath, 'r');
    try {
      const length = st.size - readFrom;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, readFrom);
      const allLines = buf.toString('utf8').split('\n');
      if (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();

      const fromByte = readFrom;
      const windowLines = allLines.length;
      const lines = allLines.slice(Math.max(0, windowLines - tail));
      const firstLineIndex = Math.max(0, windowLines - tail);

      return NextResponse.json({
        data: {
          exists: true,
          lines,
          sizeBytes: st.size,
          sizeMb: +(st.size / (1024 * 1024)).toFixed(2),
          truncated: readFrom > 0,
          truncatedBytes: readFrom,
          totalLinesInWindow: windowLines,
          firstLineIndex,
          requestedTail: tail,
          showingLines: lines.length,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
        },
      });
    } finally {
      await fh.close().catch(() => {});
    }
  } catch (err) {
    console.error('[api/services/[id]/log-file] GET failed', err);
    return NextResponse.json({ error: 'Failed to read log file' }, { status: 500 });
  }
}
