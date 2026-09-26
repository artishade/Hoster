import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import crypto from 'crypto';
import { recordDelivery, triggerRedeploy, ensureWebhookSecret } from '@/lib/hoster/webhooks';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/deploy — generic token-authenticated deploy trigger for
 * any CI (GitLab, Gitea, shell scripts, cron…).
 *
 *   curl -X POST "https://<host>/api/webhooks/deploy?name=<service>&secret=<secret>"
 *   curl -X POST "https://<host>/api/webhooks/deploy" \
 *        -H 'content-type: application/json' \
 *        -d '{"name":"<service>","secret":"<secret>"}'
 *
 * Auth options (any one suffices):
 *   - ?secret= / body.secret   — the service's webhook secret
 *   - Authorization: Bearer <secret>
 * The secret is compared in constant time.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  const raw = await req.text();
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      // tolerate empty / non-JSON bodies — params may carry everything
    }
  }

  const url = new URL(req.url);
  const name = String(body.name ?? url.searchParams.get('name') ?? '').trim().toLowerCase();
  let secret = String(body.secret ?? url.searchParams.get('secret') ?? '').trim();
  if (!secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) secret = auth.slice(7).trim();
  }

  if (!name) return NextResponse.json({ error: 'Missing "name" (service name).' }, { status: 400 });
  if (!secret) return NextResponse.json({ error: 'Missing "secret" (query param, body field, or Bearer header).' }, { status: 400 });

  const svc = await db.service.findUnique({ where: { name } });
  if (!svc) return NextResponse.json({ error: `No service named "${name}".` }, { status: 404 });

  const actual = svc.webhookSecret ?? (await ensureWebhookSecret(svc.id));
  const given = Buffer.from(secret, 'utf8');
  const expected = Buffer.from(actual, 'utf8');
  const authed = given.length === expected.length && crypto.timingSafeEqual(given, expected);

  if (!authed) {
    await recordDelivery({
      serviceId: svc.id, source: 'generic', event: 'manual', repo: svc.repoUrl,
      branch: svc.branch, sender: 'ci', commitSha: '',
      result: 'rejected', detail: 'Invalid webhook secret.',
    });
    await db.logEntry.create({
      data: {
        serviceId: svc.id,
        scope: 'deploy',
        level: 'warn',
        message: `Rejected webhook deploy for "${svc.name}" — secret mismatch.`,
        source: 'webhook',
      },
    });
    return NextResponse.json({ error: 'Invalid secret.' }, { status: 401 });
  }

  if (!svc.repoUrl) {
    await recordDelivery({
      serviceId: svc.id, source: 'generic', event: 'manual', repo: '', branch: svc.branch,
      sender: 'ci', commitSha: '', result: 'skipped',
      detail: 'Service is a builtin runner (no git repo) — nothing to redeploy.',
    });
    return NextResponse.json({ error: 'Service has no repoUrl — only git-deployed services can be webhook-triggered.' }, { status: 400 });
  }

  if (svc.status === 'building' || svc.status === 'deploying') {
    await recordDelivery({
      serviceId: svc.id, source: 'generic', event: 'manual', repo: svc.repoUrl,
      branch: svc.branch, sender: 'ci', commitSha: svc.commitHash, result: 'skipped',
      detail: 'Deployment already in progress.',
    });
    return NextResponse.json({ ok: true, skipped: true, message: 'A deployment is already in progress.' });
  }

  try {
    await triggerRedeploy(svc.id, 'generic webhook (CI)');
    await recordDelivery({
      serviceId: svc.id, source: 'generic', event: 'manual', repo: svc.repoUrl,
      branch: svc.branch, sender: 'ci', commitSha: svc.commitHash, result: 'accepted',
      detail: `Webhook deploy accepted — re-running pipeline for ${svc.commitHash || svc.branch}.`,
    });
    return NextResponse.json({ ok: true, accepted: true, service: svc.name, message: 'Redeploy triggered.' }, { status: 202 });
  } catch (err) {
    await recordDelivery({
      serviceId: svc.id, source: 'generic', event: 'manual', repo: svc.repoUrl,
      branch: svc.branch, sender: 'ci', commitSha: '', result: 'error',
      detail: (err as Error).message,
    });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** GET — usage instructions (handy for curl / browser sanity checks). */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/webhooks/deploy',
    method: 'POST',
    auth: 'secret via ?secret=..., JSON body {name,secret}, or Authorization: Bearer <secret>',
    example: 'curl -X POST "<origin>/api/webhooks/deploy?name=my-service&secret=wh_..."',
  });
}
