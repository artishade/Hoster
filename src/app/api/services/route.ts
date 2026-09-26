import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getHostMetrics } from '@/lib/hoster/metrics';
import { reconcileRuntimes, ensureRuntime } from '@/lib/hoster/runtime';
import { startDeployment, ensureDeployWatchdog, stopDeployment } from '@/lib/hoster/deployer';
import {
  addLog,
  advanceServiceLifecycle,
  ensureHostSampler,
  recomputeAllocations,
  serializeService,
  tierSpec,
} from '@/lib/hoster/server';
import { HARDWARE_SPECS, DYNAMIC_FREE_TIERS } from '@/lib/hoster/hardware-specs';
import { generateWebhookSecret } from '@/lib/hoster/webhooks';
import { ensureAutoscaler } from '@/lib/hoster/autoscaler';
import type { Service } from '@/lib/hoster/types';

export const dynamic = 'force-dynamic';

const VALID_TYPES: readonly string[] = ['api', 'mcp', 'plugin'];
const VALID_PROTOCOLS: readonly string[] = ['http', 'sse', 'stdio-proxy', 'websocket'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

interface CreateServiceBody {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  hardwareTier?: unknown;
  region?: unknown;
  repoUrl?: unknown;
  branch?: unknown;
  buildCommand?: unknown;
  startCommand?: unknown;
  port?: unknown;
  protocol?: unknown;
  envVars?: unknown;
  attachedPostgresId?: unknown;
  attachedRedisId?: unknown;
  s3BucketId?: unknown;
  volumeMounts?: unknown;
  mcpDetails?: unknown;
  pluginDetails?: unknown;
  instances?: unknown;
}

function slugifyName(raw: unknown): string {
  return typeof raw === 'string' ? raw.toLowerCase().trim().replace(/\s+/g, '-') : '';
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function normalizeEnvVars(raw: unknown): { key: string; value: string; isSecret: boolean }[] {
  if (!Array.isArray(raw)) return [];
  const out: { key: string; value: string; isSecret: boolean }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.key !== 'string' || rec.key.trim() === '') continue;
    out.push({ key: rec.key.trim(), value: String(rec.value ?? ''), isSecret: Boolean(rec.isSecret) });
  }
  return out;
}

function normalizeVolumeMounts(raw: unknown): { volumeId: string; mountPath: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { volumeId: string; mountPath: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.volumeId !== 'string' || rec.volumeId.trim() === '') continue;
    out.push({ volumeId: rec.volumeId.trim(), mountPath: str(rec.mountPath, '/') || '/' });
  }
  return out;
}

function normalizeInstances(raw: unknown): {
  min: number;
  max: number;
  current: number;
  scaleToZero: boolean;
  scaleToZeroDelaySec: number;
} {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (!raw || typeof raw !== 'object') {
    return { min: 1, max: 1, current: 1, scaleToZero: false, scaleToZeroDelaySec: 300 };
  }
  const r = raw as Record<string, unknown>;
  return {
    min: Math.max(0, Math.round(num(r.min, 1))),
    max: Math.max(1, Math.round(num(r.max, 1))),
    current: Math.max(0, Math.round(num(r.current, 1))),
    scaleToZero: Boolean(r.scaleToZero),
    scaleToZeroDelaySec: Math.max(0, Math.round(num(r.scaleToZeroDelaySec, 300))),
  };
}

export async function GET() {
  try {
    ensureHostSampler();
    ensureDeployWatchdog();
    ensureAutoscaler();
    // Reconcile real runtimes in the background: start missing listeners for
    // running services, stop orphans, refresh health flags.
    void reconcileRuntimes().catch(() => {});
    const rows = await db.service.findMany({ orderBy: { createdAt: 'desc' } });
    const host = await getHostMetrics();
    // Last REAL successful pipeline run per service (one aggregate query) —
    // powers the honest "Deployed X ago" + run count on service cards.
    const depAgg = await db.deployment.groupBy({
      by: ['serviceId'],
      where: { status: 'success' },
      _max: { startedAt: true },
      _count: { _all: true },
    });
    const lastDeploys = new Map<string, { at: Date; count: number }>(
      depAgg
        .filter((d) => d._max.startedAt)
        .map((d) => [d.serviceId, { at: d._max.startedAt as Date, count: d._count._all }])
    );
    const data: Service[] = [];
    for (const row of rows) {
      const life = await advanceServiceLifecycle(row);
      data.push(
        serializeService(row, host, {
          statusOverride: life.status,
          lastSuccessDeploy: lastDeploys.get(row.id) ?? null,
        })
      );
    }
    // Lazy webhook-secret migration: any legacy service still missing a
    // deploy-webhook secret gets one (single write per service, then never).
    const missing = rows.filter((r) => !r.webhookSecret);
    if (missing.length) {
      void (async () => {
        for (const m of missing) {
          await db.service.update({ where: { id: m.id }, data: { webhookSecret: generateWebhookSecret() } }).catch(() => {});
        }
      })();
    }
    void recomputeAllocations().catch(() => {});
    return NextResponse.json({ data });
  } catch (err) {
    console.error('[api/services] GET failed', err);
    return NextResponse.json({ error: 'Failed to load services' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: CreateServiceBody;
  try {
    body = (await req.json()) as CreateServiceBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const name = slugifyName(body.name);
    if (!NAME_RE.test(name)) {
      return NextResponse.json(
        { error: 'Name must be 3-41 characters: lowercase letters, numbers and dashes, starting with a letter or digit' },
        { status: 400 }
      );
    }

    const type = str(body.type, 'api') || 'api';
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json({ error: `Invalid type "${type}" (expected api, mcp or plugin)` }, { status: 400 });
    }

    const hardwareTier = str(body.hardwareTier, 'cpu-nano') || 'cpu-nano';
    if (!HARDWARE_SPECS[hardwareTier] && !DYNAMIC_FREE_TIERS[hardwareTier]) {
      return NextResponse.json({ error: `Unknown hardware tier "${hardwareTier}"` }, { status: 400 });
    }

    const protocol = str(body.protocol, 'http') || 'http';
    if (!VALID_PROTOCOLS.includes(protocol)) {
      return NextResponse.json({ error: `Invalid protocol "${protocol}"` }, { status: 400 });
    }

    const existing = await db.service.findUnique({ where: { name } });
    if (existing) {
      return NextResponse.json({ error: 'A service with this name already exists' }, { status: 409 });
    }

    const branch = str(body.branch) || 'main';
    const repoUrl = str(body.repoUrl);
    const buildCommand = str(body.buildCommand);
    const startCommand = str(body.startCommand);
    const port = typeof body.port === 'number' && Number.isFinite(body.port) ? Math.max(1, Math.round(body.port)) : undefined;

    // Repo-backed services deploy a REAL commit; blank-repo services boot the
    // interactive builtin runner instead (also a real server).
    const commitHash = repoUrl ? 'pending' : crypto.randomUUID().replace(/-/g, '').slice(0, 7);
    const commitMessage = repoUrl ? `Cloning ${repoUrl} (${branch})` : `Initial deployment of ${name} from ${branch}`;
    const url = `https://${name}.nexushost.dev${protocol === 'sse' ? '/sse' : ''}`;
    const instances = normalizeInstances(body.instances);
    const envVars = normalizeEnvVars(body.envVars);
    const volumeMounts = normalizeVolumeMounts(body.volumeMounts);
    const spec = tierSpec(hardwareTier);

    const created = await db.service.create({
      data: {
        name,
        description: str(body.description),
        type,
        status: 'building',
        repoUrl,
        branch,
        commitHash,
        commitMessage,
        url,
        hardwareTier,
        region: str(body.region) || undefined,
        instancesJson: JSON.stringify(instances),
        metricsJson: JSON.stringify({
          cpuPercent: 0,
          ramUsedGb: 0,
          ramTotalGb: spec.ramGb,
          requestsPerMin: 0,
          latencyP95Ms: 0,
          bandwidthInMb: 0,
          bandwidthOutMb: 0,
        }),
        buildCommand,
        startCommand,
        port: port ?? undefined,
        protocol,
        envVarsJson: JSON.stringify(envVars),
        volumeMountsJson: JSON.stringify(volumeMounts),
        customDomainsJson: JSON.stringify([]),
        attachedPostgresId: typeof body.attachedPostgresId === 'string' && body.attachedPostgresId ? body.attachedPostgresId : null,
        attachedRedisId: typeof body.attachedRedisId === 'string' && body.attachedRedisId ? body.attachedRedisId : null,
        s3BucketId: typeof body.s3BucketId === 'string' && body.s3BucketId ? body.s3BucketId : null,
        mcpDetailsJson: body.mcpDetails && typeof body.mcpDetails === 'object' ? JSON.stringify(body.mcpDetails) : null,
        pluginDetailsJson: body.pluginDetails && typeof body.pluginDetails === 'object' ? JSON.stringify(body.pluginDetails) : null,
        webhookSecret: generateWebhookSecret(),
        lifecycleStartedAt: new Date(),
      },
    });

    await addLog({ serviceId: created.id, scope: 'deploy', message: `Deployment queued for "${name}" (${type} service, tier ${hardwareTier})` });

    if (repoUrl) {
      // ── REAL deployment: git clone → install → build → spawn ────────────
      await addLog({ serviceId: created.id, scope: 'deploy', message: `Starting REAL deployment pipeline: git clone ${repoUrl} (branch: ${branch}) → install deps → build → run.`, source: 'git-deployer' });
      void startDeployment({
        id: created.id,
        name,
        repoUrl,
        branch,
        buildCommand,
        startCommand,
        port,
        envVarsJson: JSON.stringify(envVars),
        volumeMountsJson: JSON.stringify(volumeMounts),
      }, { trigger: 'deploy' }).catch(async (err) => {
        console.error('[api/services] deploy pipeline crashed', err);
        await db.service.update({ where: { id: created.id }, data: { status: 'failed' } }).catch(() => {});
      });
    } else {
      // ── no repo → boot the interactive builtin runner NOW (real server) ──
      await addLog({ serviceId: created.id, scope: 'deploy', message: `No repo URL provided — booting the interactive builtin runner (a real HTTP server with live endpoints).`, source: 'orchestrator' });
      await db.service.update({ where: { id: created.id }, data: { status: 'deploying' } });
      try {
        await ensureRuntime({ ...created, status: 'running' });
        await db.service.update({ where: { id: created.id }, data: { status: 'running' } });
      } catch (err) {
        console.error('[api/services] builtin runner start failed', err);
        await db.service.update({ where: { id: created.id }, data: { status: 'failed' } }).catch(() => {});
      }
    }
    void recomputeAllocations().catch(() => {});

    const host = await getHostMetrics();
    return NextResponse.json({ data: serializeService(created, host, { statusOverride: 'building' }) }, { status: 201 });
  } catch (err) {
    console.error('[api/services] POST failed', err);
    return NextResponse.json({ error: 'Failed to create service' }, { status: 500 });
  }
}
