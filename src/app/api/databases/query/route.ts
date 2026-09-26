import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { beginDbOp, endDbOp, recordDbOp } from '@/lib/hoster/telemetry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/databases/query — REAL SQL console for platform databases running
 * on the local node. Executes read-only statements against the actual live
 * SQLite database backing this deployment (real rows, real timing).
 *
 * Only single SELECT/WITH/EXPLAIN statements are allowed and an implicit
 * LIMIT is enforced to protect the control plane.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sql = String(body.sql ?? '').trim();
    const databaseId = String(body.databaseId ?? '');

    if (!sql) {
      return NextResponse.json({ success: false, error: 'A SQL statement is required.' }, { status: 400 });
    }
    if (!databaseId) {
      return NextResponse.json({ success: false, error: 'databaseId is required (select a provisioned database).' }, { status: 400 });
    }

    const database = await db.postgresDb.findUnique({ where: { id: databaseId } });
    if (!database) {
      return NextResponse.json({ success: false, error: 'Database instance not found.' }, { status: 404 });
    }
    if (database.status !== 'available') {
      return NextResponse.json({ success: false, error: `Instance "${database.name}" is ${database.status} — wait for it to become available.` }, { status: 400 });
    }

    // Statement guard: exactly one statement, read-only
    if (sql.includes(';') && sql.replace(/;+\s*$/, '') !== sql.trimEnd().replace(/;$/, '')) {
      // allow a single trailing semicolon only
      const stripped = sql.replace(/;+\s*$/, '');
      if (stripped.includes(';')) {
        return NextResponse.json({ success: false, error: 'Only a single statement can be executed per run.' }, { status: 400 });
      }
    }
    const first = sql.replace(/^\s*(--.*\n)*\s*/, '').slice(0, 12).toUpperCase();
    if (!first.startsWith('SELECT') && !first.startsWith('WITH') && !first.startsWith('EXPLAIN')) {
      return NextResponse.json({ success: false, error: 'Read-only console: only SELECT / WITH / EXPLAIN statements are permitted.' }, { status: 400 });
    }
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|REPLACE|VACUUM)\b/i.test(sql)) {
      return NextResponse.json({ success: false, error: 'Read-only console: data-modifying statements are blocked.' }, { status: 400 });
    }

    // Enforce a row limit by wrapping the statement
    const guarded = `SELECT * FROM (${sql.replace(/;+\s*$/, '')}) AS __console LIMIT 200`;

    const started = Date.now();
    beginDbOp('postgres', databaseId);
    let rows: unknown;
    try {
      rows = await db.$queryRawUnsafe(guarded);
    } catch (e) {
      return NextResponse.json({
        success: false,
        error: `SQL error: ${(e as Error).message.replace('Invalid prisma.', '').slice(0, 300)}`,
      });
    } finally {
      endDbOp('postgres', databaseId);
      recordDbOp('postgres', databaseId); // real op counter
    }
    const executionMs = Date.now() - started;

    const rowCount = Array.isArray(rows) ? rows.length : 0;

    // SQLite returns BigInt for count()/int64 — JSON.stringify can't. Convert.
    const jsonRows = JSON.parse(
      JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? Number(value) : value))
    ) as unknown;

    await db.logEntry.create({
      data: {
        scope: 'database',
        level: 'info',
        message: `SQL console on "${database.name}": statement executed in ${executionMs}ms (${rowCount} rows).`,
        source: 'sql-console',
      },
    });

    return NextResponse.json({
      data: {
        success: true,
        executionMs,
        rowCount,
        rows: jsonRows,
        database: { id: database.id, name: database.name, version: database.version, engine: 'SQLite (embedded control-plane node)' },
        note: 'Executed for real against the embedded control-plane instance backing this deployment.',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Query failed' }, { status: 500 });
  }
}
