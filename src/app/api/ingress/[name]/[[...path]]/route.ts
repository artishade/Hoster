import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureRuntime } from '@/lib/hoster/runtime';
import { recordIngressRequest } from '@/lib/hoster/deployer';

/**
 * Same-origin ingress for deployed services.
 *
 * GET https://<control-plane-host>/api/ingress/<service-name>/...
 *   → proxied to the service's real process on 127.0.0.1:<port>
 *   (git-deployed app process OR the builtin runner)
 *
 * This is what makes "Open Endpoint" actually work right after deploy —
 * no DNS records required. The pretty hostname (<name>.nexushost.dev)
 * is routed by the edge middleware via Host header, and resolves publicly
 * once a wildcard DNS record points at the control-plane host.
 */

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ name: string; path?: string[] }> };

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'content-encoding', 'accept-encoding',
]);

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { name, path } = await ctx.params;

  try {
    const row = await db.service.findUnique({ where: { name } });
    if (!row) {
      return NextResponse.json(
        { error: `No deployed service named "${name}" on this control plane` },
        { status: 404 }
      );
    }

    if (row.status !== 'running') {
      return NextResponse.json(
        { error: `Service "${name}" is ${row.status} — endpoint goes live when the deployment finishes`, status: row.status },
        { status: 503 }
      );
    }

    // Ensure the runner exists on this host instance (lazy start — makes the
    // proxy work even right after a cold start / fresh boot).
    let rt: Awaited<ReturnType<typeof ensureRuntime>> = null;
    try {
      rt = await ensureRuntime(row);
    } catch (err) {
      console.error(`[ingress] runtime ensure failed for ${name}`, err);
    }
    if (!rt) {
      return NextResponse.json(
        { error: `Runtime for "${name}" could not be started on this host` },
        { status: 503 }
      );
    }

    const subPath = (path ?? []).map((seg) => encodeURIComponent(seg)).join('/');
    const target = new URL(`http://127.0.0.1:${rt.port}/${subPath}`);
    req.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));

    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key)) headers.set(key, value);
    });
    // real client host for the app (host-header routing evidence)
    headers.set('x-forwarded-host', req.headers.get('host') ?? '');
    headers.set('x-nexushost-edge', 'ingress');

    const method = req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? await req.arrayBuffer() : undefined;

    const t0 = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? body : undefined,
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch {
      recordIngressRequest(row.id, { method, path: `/${subPath}` || '/', status: 502, ms: Date.now() - t0 });
      return NextResponse.json(
        { error: `Service "${name}" runner did not respond on 127.0.0.1:${rt.port}` },
        { status: 502 }
      );
    }

    // count the REAL proxied request (traffic metrics for git-deployed apps)
    recordIngressRequest(row.id, { method, path: `/${subPath}` || '/', status: upstream.status, ms: Date.now() - t0 });

    const resHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key)) resHeaders.set(key, value);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    console.error(`[ingress] proxy failed for ${name}`, err);
    return NextResponse.json({ error: 'Ingress proxy failure' }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
