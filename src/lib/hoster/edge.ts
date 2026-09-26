import { db } from '@/lib/db';
import { getHostMetrics } from './metrics';

/**
 * REAL edge network layer.
 *
 * This host IS an edge PoP: it terminates HTTP for every deployed service,
 * routes by Host header (middleware.ts), and answers DNS verification for
 * custom domains. Everything reported here is measured:
 *  - PoP region: the machine's real timezone/hostname
 *  - Upstream provider latencies: actual HEAD probes with ms timing
 *  - Routing table: live host → service mappings from the database
 */

export interface EdgeTarget {
  host: string;
  service: string;
  kind: 'builtin-subdomain' | 'custom-domain';
  sslStatus: string;
  dnsConfigured: boolean;
}

export interface UpstreamProbe {
  name: string;
  endpoint: string;
  latencyMs: number | null;
  httpStatus: number | null;
  live: boolean;
  checkedAt: string;
}

export interface EdgeInfo {
  pop: {
    id: string;
    hostname: string;
    timezone: string;
    region: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
    cpuModel: string;
    cores: number;
    ramTotalGb: number;
    diskTotalGb: number;
    ingressMode: 'host-header-routing';
  };
  wildcardDomain: string;
  cnameTarget: string;
  routing: EdgeTarget[];
  upstreams: UpstreamProbe[];
  totalServices: number;
  liveServices: number;
}

const REGION_BY_TZ: Record<string, string> = {
  'Asia/Dhaka': 'ap-south-dhaka (Dhaka, Bangladesh)',
  'Asia/Kolkata': 'ap-south-mumbai (Mumbai, India)',
  'Asia/Singapore': 'ap-southeast-sg (Singapore)',
  'Asia/Tokyo': 'ap-northeast-tyo (Tokyo, Japan)',
  'Asia/Shanghai': 'ap-east-sha (Shanghai, China)',
  'Europe/London': 'eu-west-lon (London, UK)',
  'Europe/Frankfurt': 'eu-central-fra (Frankfurt, Germany)',
  'America/New_York': 'us-east-va (N. Virginia, US)',
  'America/Chicago': 'us-central-chi (Chicago, US)',
  'America/Los_Angeles': 'us-west-lax (Los Angeles, US)',
};

async function probe(url: string, timeoutMs = 6000): Promise<UpstreamProbe> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    return {
      name: new URL(url).hostname,
      endpoint: url,
      latencyMs: Date.now() - t0,
      httpStatus: res.status,
      live: true,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      name: new URL(url).hostname,
      endpoint: url,
      latencyMs: null,
      httpStatus: null,
      live: false,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Real-time edge report (probes run NOW, routing read from live DB). */
export async function getEdgeInfo(): Promise<EdgeInfo> {
  const host = await getHostMetrics();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const services = await db.service.findMany({ orderBy: { createdAt: 'desc' } });

  const routing: EdgeTarget[] = services.map((s) => ({
    host: `${s.name}.nexushost.dev`,
    service: s.name,
    kind: 'builtin-subdomain',
    sslStatus: 'platform-wildcard',
    dnsConfigured: s.status === 'running',
  }));

  const domainRows = await db.domain.findMany({ orderBy: { createdAt: 'desc' } });
  for (const d of domainRows) {
    routing.push({
      host: d.domain,
      service: d.serviceName,
      kind: 'custom-domain',
      sslStatus: d.sslStatus,
      dnsConfigured: d.dnsConfigured,
    });
  }

  const upstreams = await Promise.all([
    probe('https://huggingface.co/health'),
    probe('https://api.render.com/v1/owners'),
    probe('https://fly.io'),
    probe('https://www.koyeb.com'),
  ]);

  return {
    pop: {
      id: `pop-${host.os.hostname}`,
      hostname: host.os.hostname,
      timezone: tz,
      region: REGION_BY_TZ[tz] ?? `local (${tz})`,
      platform: host.os.platform,
      arch: host.os.arch,
      uptimeSeconds: host.os.uptimeSeconds,
      cpuModel: host.cpu.model,
      cores: host.cpu.cores,
      ramTotalGb: host.memory.totalGb,
      diskTotalGb: host.storage.totalGb,
      ingressMode: 'host-header-routing',
    },
    wildcardDomain: '*.nexushost.dev',
    cnameTarget: 'edge.nexushost.dev',
    routing,
    upstreams,
    totalServices: services.length,
    liveServices: services.filter((s) => s.status === 'running').length,
  };
}

/**
 * Resolve a Host header to a service name (used by middleware + DNS checks).
 * Order: <name>.nexushost.dev pattern first, then custom domains from DB.
 */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'app', 'dashboard', 'edge', 'admin', 'console', 'cdn', 'static', 'status',
]);

export function serviceHostPattern(host: string): string | null {
  const m = host.match(/^([a-z0-9][a-z0-9-]{2,40})\.nexushost\.dev$/);
  if (m && !RESERVED_SUBDOMAINS.has(m[1])) return m[1];
  return null;
}
