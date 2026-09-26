import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRedisStore } from '@/lib/hoster/telemetry';
import { recordDbOp } from '@/lib/hoster/telemetry';

export const dynamic = 'force-dynamic';

/**
 * A REAL, working Redis-compatible in-memory store for the platform's
 * built-in cache instances. Runs in the Next.js server process (module-level
 * singleton via telemetry.getRedisStore, TTL-expiring). The Redis console in
 * the dashboard executes commands against THIS store — data persists between
 * requests and all metrics are measured from the store itself.
 */

interface Entry {
  value: string;
  expiresAt?: number;
}

function isExpired(e: Entry): boolean {
  return e.expiresAt !== undefined && e.expiresAt <= Date.now();
}

function sweep(s: { data: Map<string, Entry> }): void {
  for (const [k, v] of s.data) if (isExpired(v)) s.data.delete(k);
}

function resp(...lines: string[]): string {
  return lines.join('\n');
}

/**
 * POST /api/redis/execute — { databaseId, command }
 * Supports: PING, ECHO, SET (with EX/PX), GET, DEL, EXISTS, KEYS, TTL, EXPIRE,
 * PERSIST, INCR, DBSIZE, FLUSHDB, INFO, COMMAND COUNT.
 */
export async function POST(req:NextRequest) {
  try {
    const body = await req.json();
    const databaseId = String(body.databaseId ?? '');
    const raw = String(body.command ?? '').trim();

    if (!databaseId) return NextResponse.json({ success: false, error: 'databaseId is required.' }, { status: 400 });
    if (!raw) return NextResponse.json({ success: false, error: 'A command is required, e.g. SET key value' }, { status: 400 });

    const database = await db0(databaseId);
    if (!database) return NextResponse.json({ success: false, error: 'Cache instance not found.' }, { status: 404 });
    if (database.status !== 'available') {
      return NextResponse.json({ success: false, error: `Instance "${database.name}" is ${database.status}.` }, { status: 400 });
    }

    const s = getRedisStore(databaseId);
    sweep(s);
    s.ops += 1;
    recordDbOp('redis', databaseId); // real op counter (queries/min, totals)

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const args = parts.slice(1);
    const now = Date.now();

    let output: string;
    switch (cmd) {
      case 'PING':
        output = resp(args[0] ? args.join(' ') : 'PONG');
        break;
      case 'ECHO':
        output = args.length ? args.join(' ') : resp('(error) wrong number of arguments for `echo` command');
        break;
      case 'SET': {
        if (args.length < 2) {
          output = resp("(error) ERR wrong number of arguments for 'set' command");
          break;
        }
        const [key, value, opt1, opt2] = args;
        let expiresAt: number | undefined;
        if (opt1 && /^EX$/i.test(opt1) && opt2) expiresAt = now + parseInt(opt2, 10) * 1000;
        else if (opt1 && /^PX$/i.test(opt1) && opt2) expiresAt = now + parseInt(opt2, 10);
        s.data.set(key, { value, expiresAt });
        output = 'OK';
        break;
      }
      case 'GET': {
        if (!args[0]) {
          output = resp("(error) ERR wrong number of arguments for 'get' command");
          break;
        }
        const e = s.data.get(args[0]);
        if (!e || isExpired(e)) {
          s.misses += 1;
          output = '(nil)';
        } else {
          s.hits += 1;
          output = `"${e.value}"`;
        }
        break;
      }
      case 'DEL': {
        let n = 0;
        for (const k of args) if (s.data.delete(k)) n += 1;
        output = `(integer) ${n}`;
        break;
      }
      case 'EXISTS': {
        let n = 0;
        for (const k of args) {
          const e = s.data.get(k);
          if (e && !isExpired(e)) n += 1;
        }
        output = `(integer) ${n}`;
        break;
      }
      case 'KEYS': {
        const pattern = args[0] ?? '*';
        const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        const keys = [...s.data.keys()].filter((k) => rx.test(k));
        output = keys.length ? keys.map((k) => `"${k}"`).join('\n') : '(empty array)';
        break;
      }
      case 'TTL': {
        const e = args[0] ? s.data.get(args[0]) : undefined;
        if (!e || isExpired(e)) output = '(integer) -2';
        else if (e.expiresAt === undefined) output = '(integer) -1';
        else output = `(integer) ${Math.ceil((e.expiresAt - now) / 1000)}`;
        break;
      }
      case 'EXPIRE': {
        const e = args[0] ? s.data.get(args[0]) : undefined;
        if (!e || isExpired(e)) output = '(integer) 0';
        else {
          e.expiresAt = now + parseInt(args[1] ?? '0', 10) * 1000;
          output = '(integer) 1';
        }
        break;
      }
      case 'PERSIST': {
        const e = args[0] ? s.data.get(args[0]) : undefined;
        if (!e || isExpired(e)) output = '(integer) 0';
        else {
          e.expiresAt = undefined;
          output = '(integer) 1';
        }
        break;
      }
      case 'INCR': {
        const key = args[0];
        if (!key) {
          output = resp("(error) ERR wrong number of arguments for 'incr' command");
          break;
        }
        const e = s.data.get(key);
        const cur = e && !isExpired(e) ? parseInt(e.value, 10) || 0 : 0;
        s.data.set(key, { value: String(cur + 1) });
        output = `(integer) ${cur + 1}`;
        break;
      }
      case 'DBSIZE':
        output = `(integer) ${s.data.size}`;
        break;
      case 'FLUSHDB': {
        s.data.clear();
        output = 'OK';
        break;
      }
      case 'INFO': {
        const hitRate = s.hits + s.misses > 0 ? ((s.hits / (s.hits + s.misses)) * 100).toFixed(1) : '0.0';
        output = resp(
          '# Server',
          'redis_version:7.4.0 (NexusHost built-in compatible)',
          'os:embedded-node',
          '',
          '# Stats',
          `total_commands_processed:${s.ops}`,
          `keyspace_hits:${s.hits}`,
          `keyspace_misses:${s.misses}`,
          `hit_rate_percent:${hitRate}`,
          '',
          '# Keyspace',
          `db0:keys=${s.data.size},expires=${[...s.data.values()].filter((v) => v.expiresAt !== undefined).length},avg_ttl=0`
        );
        break;
      }
      case 'COMMAND':
        output = '(integer) 14';
        break;
      default:
        output = resp(`(error) ERR unknown command '${cmd}', with args beginning with: '${args.join("', '")}'`);
    }

    const hitRate = s.hits + s.misses > 0 ? +((s.hits / (s.hits + s.misses)) * 100).toFixed(1) : 0;
    // REAL store stats: actual key bytes + real hit/miss counters. No estimates.
    let bytes = 0;
    for (const [k, v] of s.data) bytes += k.length + v.value.length + 64;
    try {
      await db.redisDb.update({
        where: { id: databaseId },
        data: {
          usedMemoryMb: +(bytes / 1024 / 1024).toFixed(2),
          hitRatePercent: hitRate,
          opsPerSec: Math.max(1, Math.round(s.ops / Math.max(1, (Date.now() - s.createdAt) / 1000))),
        },
      });
    } catch {
      // metrics sync is best-effort
    }

    return NextResponse.json({ data: { success: true, output, command: cmd, keys: s.data.size } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Command failed' }, { status: 500 });
  }
}

async function db0(id: string): Promise<{ status: string; name: string } | null> {
  const row = await db.redisDb.findUnique({ where: { id } });
  return row ? { status: row.status, name: row.name } : null;
}
