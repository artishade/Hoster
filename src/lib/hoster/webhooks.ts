import crypto from 'crypto';
import { db } from '@/lib/db';
import { startDeployment, stopDeployment } from './deployer';
import { stopRuntime } from './runtime';
import { addLog, recomputeAllocations } from './server';

/**
 * REAL deploy webhooks — GitHub push (or any compatible CI) triggers a full
 * re-run of the git clone → build → run pipeline for every service whose
 * repoUrl + branch match the event. Signatures are verified with HMAC-SHA256
 * exactly like GitHub does (x-hub-signature-256), so a leaked webhook URL
 * alone cannot redeploy arbitrary code.
 */

export function generateWebhookSecret(): string {
  return `wh_${crypto.randomBytes(24).toString('hex')}`;
}

/** Normalize a git URL for matching: strip protocol, auth, .git, trailing slashes. */
export function normalizeRepoUrl(url: string): string {
  let u = (url || '').trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/^ssh:\/\//, '');
  u = u.replace(/^[^@/]+@/, ''); // user:pass@ or git@ leftovers
  u = u.replace(/\.git$/, '');
  u = u.replace(/\/+$/, '');
  return u;
}

/** Constant-time HMAC-SHA256 comparison against GitHub's `sha256=<hex>` header. */
export function verifyGithubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = m[1].toLowerCase();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** Repo URL candidates from a GitHub webhook payload, all normalized. */
export function repoCandidatesFromPayload(payload: {
  repository?: { html_url?: string; clone_url?: string; url?: string; full_name?: string };
  repo?: { html_url?: string; clone_url?: string; url?: string; full_name?: string };
}): { urls: string[]; fullName: string } {
  const r = payload.repository ?? payload.repo ?? {};
  const urls = [r.html_url, r.clone_url, r.url]
    .filter((x): x is string => typeof x === 'string')
    .map(normalizeRepoUrl)
    .filter(Boolean);
  let fullName = r.full_name ?? '';
  if (!fullName && urls[0]) {
    fullName = urls[0].split('/').slice(-2).join('/');
  }
  return { urls, fullName };
}

export interface DeliveryRecord {
  serviceId: string | null;
  source: 'github' | 'generic';
  event: string;
  repo: string;
  branch: string;
  sender: string;
  commitSha: string;
  result: 'accepted' | 'skipped' | 'rejected' | 'error';
  detail: string;
}

export async function recordDelivery(d: DeliveryRecord): Promise<void> {
  try {
    await db.webhookDelivery.create({
      data: {
        serviceId: d.serviceId,
        source: d.source,
        event: d.event,
        repo: d.repo.slice(0, 300),
        branch: d.branch.slice(0, 200),
        sender: d.sender.slice(0, 200),
        commitSha: d.commitSha.slice(0, 80),
        result: d.result,
        detail: d.detail.slice(0, 500),
      },
    });
  } catch (err) {
    console.error('[webhooks] failed to record delivery', err);
  }
}

/**
 * Trigger the REAL redeploy pipeline for a git-backed service:
 * kill the old process tree, flip the lifecycle state, re-clone + rebuild.
 * Mirrors the operator "Restart" action exactly.
 */
export async function triggerRedeploy(serviceId: string, reason: string): Promise<void> {
  const fresh = await db.service.findUnique({ where: { id: serviceId } });
  if (!fresh) throw new Error('service vanished');
  if (!fresh.repoUrl) throw new Error('service has no repoUrl — nothing to redeploy');

  await db.service.update({
    where: { id: serviceId },
    data: { status: 'building', lifecycleStartedAt: new Date() },
  });
  await stopDeployment(fresh);
  await stopRuntime(fresh);

  await addLog({
    serviceId,
    scope: 'deploy',
    message: `Webhook redeploy started for "${fresh.name}" (${reason}). Old process tree killed, git clone → build → run pipeline re-running.`,
    source: 'webhook',
  });
  void recomputeAllocations().catch(() => {});

  void startDeployment({
    id: fresh.id,
    name: fresh.name,
    repoUrl: fresh.repoUrl,
    branch: fresh.branch,
    buildCommand: fresh.buildCommand,
    startCommand: fresh.startCommand,
    port: fresh.port,
    envVarsJson: fresh.envVarsJson,
    volumeMountsJson: fresh.volumeMountsJson,
  }).catch(async (err) => {
    console.error('[webhooks] redeploy crashed', err);
    await db.service.update({ where: { id: serviceId }, data: { status: 'failed' } }).catch(() => {});
  });
}

/** Ensure a service has a webhook secret (lazily generates + persists one). */
export async function ensureWebhookSecret(serviceId: string): Promise<string> {
  const row = await db.service.findUnique({ where: { id: serviceId }, select: { webhookSecret: true } });
  if (row?.webhookSecret) return row.webhookSecret;
  const secret = generateWebhookSecret();
  await db.service.update({ where: { id: serviceId }, data: { webhookSecret: secret } });
  return secret;
}
