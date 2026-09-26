import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client'

/**
 * Resolve a usable SQLite URL at runtime.
 *
 * Self-hosted (default): DATABASE_URL points at db/custom.db on a writable
 * disk — behaviour is unchanged.
 *
 * Serverless (e.g. Vercel): the deployment filesystem is READ-ONLY, so opening
 * the bundled database for writes fails ("attempt to write a readonly
 * database") and every API route starts erroring — which shows up in the UI as
 * an endless "Connecting…" state. In that case we transparently copy the
 * bundled database into the only writable directory (/tmp) and point Prisma at
 * the copy. Data lives per warm instance — good enough for demos; run
 * self-hosted or switch DATABASE_URL to Turso/Postgres for real durability.
 */
function resolveSqliteUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith('file:')) return url;

  const rawPath = url.slice('file:'.length);
  const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  const dir = path.dirname(absPath);

  try {
    // Writable directory + (if it exists) writable file → use as-is.
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    if (fs.existsSync(absPath)) fs.accessSync(absPath, fs.constants.W_OK);
    return url;
  } catch {
    // Read-only filesystem (serverless) → fall back to a writable copy in /tmp.
    const tmpDb = '/tmp/nexushost-control-plane.db';
    try {
      if (fs.existsSync(absPath) && !fs.existsSync(tmpDb)) {
        fs.copyFileSync(absPath, tmpDb);
      }
      return `file:${tmpDb}`;
    } catch {
      // Nothing else we can do — let Prisma surface the original error.
      return url;
    }
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const resolvedUrl = resolveSqliteUrl();

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    ...(resolvedUrl ? { datasourceUrl: resolvedUrl } : {}),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
