import { NextRequest, NextResponse } from 'next/server';

/**
 * NexusHost EDGE — real host-header routing (Next.js 16 proxy convention).
 *
 * This proxy turns the control plane into an edge router: requests that
 * arrive with a service hostname in their Host header are rewritten to that
 * service's ingress, exactly like a real CDN/anycast edge routes vhosts.
 *
 * Routing rules (deterministic, DB-backed via the internal resolver):
 *   1. Host: <name>.nexushost.dev   → /api/ingress/<name>/<rest>
 *      (reserved subdomains — www/api/app/... — stay on the platform)
 *   2. Host: <custom-domain>        → resolved against the Domain table via
 *      /api/edge/resolve (only domains the operator added route to services)
 *   3. anything else                → platform dashboard (passthrough)
 *
 * Test it for real:
 *   curl -H "Host: myservice.nexushost.dev" http://localhost:3000/
 *   curl -H "Host: myservice.nexushost.dev" http://localhost:3000/api/time
 */

const PLATFORM_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '']);
const RESERVED = new Set([
  'www', 'api', 'app', 'dashboard', 'edge', 'admin', 'console', 'cdn', 'static', 'status',
]);

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export default async function proxy(req: NextRequest) {
  const rawHost = (req.headers.get('host') ?? '').trim().toLowerCase();
  const host = rawHost.split(':')[0].replace(/^\[|\]$/g, '');

  if (PLATFORM_HOSTS.has(host)) return NextResponse.next();
  // internal platform requests must never be re-routed
  if (req.headers.get('x-nx-internal') === 'edge') return NextResponse.next();
  // already an ingress path — never double-rewrite
  if (req.nextUrl.pathname.startsWith('/api/ingress/')) return NextResponse.next();

  let serviceName: string | null = null;

  // Rule 1 — platform wildcard: <name>.nexushost.dev
  const m = host.match(/^([a-z0-9][a-z0-9-]{2,40})\.nexushost\.dev$/);
  if (m && !RESERVED.has(m[1])) {
    serviceName = m[1];
  }

  // Rule 2 — custom domain registered in the Domain table (via internal resolver)
  if (!serviceName) {
    try {
      const port = req.nextUrl.port || (req.nextUrl.protocol === 'https:' ? '443' : '80');
      const res = await fetch(`http://127.0.0.1:${port}/api/edge/resolve?host=${encodeURIComponent(host)}`, {
        headers: { 'x-nx-internal': 'edge' },
        signal: AbortSignal.timeout(2500),
        cache: 'no-store',
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { service?: string | null } };
        if (json.data?.service) serviceName = json.data.service;
      }
    } catch {
      // resolver unavailable — treat as platform traffic
    }
  }

  if (!serviceName) return NextResponse.next();

  // Rewrite to the same-origin ingress for that service.
  const url = req.nextUrl.clone();
  const rest = req.nextUrl.pathname.replace(/^\/+/, '');
  url.pathname = `/api/ingress/${serviceName}${rest ? `/${rest}` : ''}`;
  url.search = req.nextUrl.search;

  const res = NextResponse.rewrite(url);
  res.headers.set('x-nexushost-edge', host);
  res.headers.set('x-nexushost-service', serviceName);
  return res;
}
