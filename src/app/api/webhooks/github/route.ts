import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  verifyGithubSignature,
  repoCandidatesFromPayload,
  recordDelivery,
  triggerRedeploy,
  normalizeRepoUrl,
} from '@/lib/hoster/webhooks';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/github — REAL GitHub webhook receiver.
 *
 * Configure in GitHub → Settings → Webhooks:
 *   Payload URL : https://<this-host>/api/webhooks/github
 *   Content type: application/json
 *   Secret      : the per-service deploy secret (Service → Deploy Webhooks tab)
 *   Events      : Just the push event
 *
 * On every push: every service whose repoUrl matches the pushed repository AND
 * whose branch matches the pushed ref is redeployed through the real
 * git clone → build → run pipeline. The HMAC-SHA256 signature
 * (x-hub-signature-256) must verify against the service's secret.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const event = req.headers.get('x-github-event') ?? 'push';
  const signature = req.headers.get('x-hub-signature-256');
  const deliveryId = req.headers.get('x-github-delivery') ?? '';

  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // GitHub sends a ping right after the webhook is created — ack it.
  if (event === 'ping') {
    await recordDelivery({
      serviceId: null,
      source: 'github',
      event: 'ping',
      repo: repoCandidatesFromPayload(payload as never).fullName,
      branch: '',
      sender: String((payload as { sender?: { login?: string } }).sender?.login ?? ''),
      commitSha: '',
      result: 'accepted',
      detail: 'Webhook ping acknowledged — configuration is reachable.',
    });
    return NextResponse.json({ ok: true, pong: true, message: 'Webhook is configured correctly.' });
  }

  if (event !== 'push') {
    return NextResponse.json({ ok: true, skipped: true, message: `Event "${event}" ignored — only push events trigger deploys.` });
  }

  const pushed = payload as {
    ref?: string;
    after?: string;
    before?: string;
    pusher?: { name?: string };
    sender?: { login?: string };
    repository?: { full_name?: string; html_url?: string; clone_url?: string };
  };

  const ref = String(pushed.ref ?? '');
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const commitSha = String(pushed.after ?? '').slice(0, 12);
  const sender = String(pushed.pusher?.name ?? pushed.sender?.login ?? 'unknown');
  const { urls: candidates, fullName } = repoCandidatesFromPayload(pushed);

  if (!candidates.length) {
    return NextResponse.json({ error: 'Payload has no repository URL' }, { status: 400 });
  }

  // Every git-backed service is a candidate; signature decides which one(s) fire.
  const services = await db.service.findMany({ where: { repoUrl: { not: '' } } });
  const matches = services.filter((s) => candidates.includes(normalizeRepoUrl(s.repoUrl)));

  if (matches.length === 0) {
    await recordDelivery({
      serviceId: null,
      source: 'github',
      event: 'push',
      repo: fullName,
      branch,
      sender,
      commitSha,
      result: 'skipped',
      detail: 'No service is deployed from this repository.',
    });
    // 2xx so GitHub keeps the hook alive — nothing matched, nothing to do.
    return NextResponse.json({ ok: true, matched: 0, message: 'No service tracks this repository.' });
  }

  const results: { service: string; result: 'accepted' | 'skipped' | 'rejected'; detail: string }[] = [];
  let anyAccepted = false;

  for (const svc of matches) {
    if (!svc.webhookSecret) {
      results.push({ service: svc.name, result: 'rejected', detail: 'Service has no webhook secret yet — open its Deploy Webhooks tab to generate one.' });
      await recordDelivery({
        serviceId: svc.id, source: 'github', event: 'push', repo: fullName, branch, sender, commitSha,
        result: 'rejected', detail: 'No webhook secret configured for this service.',
      });
      continue;
    }

    const sigOk = verifyGithubSignature(raw, signature, svc.webhookSecret);
    if (!sigOk) {
      results.push({ service: svc.name, result: 'rejected', detail: 'HMAC signature did not verify for this service.' });
      await recordDelivery({
        serviceId: svc.id, source: 'github', event: 'push', repo: fullName, branch, sender, commitSha,
        result: 'rejected', detail: 'Invalid x-hub-signature-256 — secret mismatch.',
      });
      continue;
    }

    if (svc.branch !== branch) {
      results.push({ service: svc.name, result: 'skipped', detail: `Push was to "${branch}", service tracks "${svc.branch}".` });
      await recordDelivery({
        serviceId: svc.id, source: 'github', event: 'push', repo: fullName, branch, sender, commitSha,
        result: 'skipped', detail: `Branch mismatch: pushed "${branch}", service watches "${svc.branch}".`,
      });
      continue;
    }

    if (svc.status === 'building' || svc.status === 'deploying') {
      results.push({ service: svc.name, result: 'skipped', detail: 'A deployment is already in progress.' });
      await recordDelivery({
        serviceId: svc.id, source: 'github', event: 'push', repo: fullName, branch, sender, commitSha,
        result: 'skipped', detail: 'Deployment already in progress — push ignored to avoid a pipeline race.',
      });
      continue;
    }

    try {
      await triggerRedeploy(svc.id, `push by ${sender} @ ${commitSha || branch}`);
      results.push({ service: svc.name, result: 'accepted', detail: `Redeploying ${commitSha || 'HEAD'} on ${branch}.` });
      anyAccepted = true;
      await recordDelivery({
        serviceId: svc.id, source: 'github', event: 'push', repo: fullName, branch, sender, commitSha,
        result: 'accepted', detail: `Push accepted — git clone → build → run pipeline re-running for ${commitSha || branch}.`,
      });
    } catch (err) {
      results.push({ service: svc.name, result: 'rejected', detail: (err as Error).message });
      await recordDelivery({
        serviceId: svc.id, source: 'github', event: 'push', repo: fullName, branch, sender, commitSha,
        result: 'error', detail: (err as Error).message,
      });
    }
  }

  return NextResponse.json(
    {
      ok: true,
      delivery: deliveryId,
      repo: fullName,
      branch,
      commit: commitSha,
      matched: matches.length,
      results,
      deployed: anyAccepted,
    },
    { status: anyAccepted ? 202 : 200 }
  );
}

/** GET — quick configuration info (also lets operators sanity-check reachability). */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/webhooks/github',
    method: 'POST',
    events: ['push'],
    signature: 'x-hub-signature-256 (HMAC-SHA256, per-service secret)',
    contentType: 'application/json',
  });
}
