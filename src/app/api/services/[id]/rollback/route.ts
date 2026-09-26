import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startDeployment, isDeploymentBusy } from '@/lib/hoster/deployer';
import { addLog } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/services/[id]/rollback — one-click rollback to a past commit.
 *
 * Body: { deploymentId?: string, commit?: string } (either one; deploymentId
 * must reference a SUCCESSFUL past run of THIS service).
 *
 * This re-runs the REAL pipeline with the repo checked out at the requested
 * commit: git clone (branch tip) → git fetch --depth 1 origin <sha> →
 * git checkout --detach <sha> → install → build → spawn → HTTP probe.
 * The rollback itself is recorded in the Deployment history (trigger=rollback),
 * so you can always roll forward again by rolling back to the newer commit.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { deploymentId?: string; commit?: string };

    const svc = await db.service.findUnique({ where: { id } });
    if (!svc) return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    if (!svc.repoUrl) {
      return NextResponse.json({ error: 'Only git-backed services can be rolled back (this service has no repo).' }, { status: 400 });
    }
    if (svc.status === 'building' || svc.status === 'deploying' || isDeploymentBusy(svc.id)) {
      return NextResponse.json({ error: `A deployment is already in flight (status "${svc.status}") — wait for it to finish before rolling back.` }, { status: 409 });
    }

    // Resolve the target commit — either directly, or via a past deployment id.
    let targetCommit = (body.commit ?? '').trim();
    let commitMessage = '';
    if (body.deploymentId) {
      const dep = await db.deployment.findUnique({ where: { id: body.deploymentId } });
      if (!dep || dep.serviceId !== svc.id) {
        return NextResponse.json({ error: 'Deployment not found for this service.' }, { status: 404 });
      }
      if (dep.status !== 'success') {
        return NextResponse.json({ error: 'Can only roll back to a deployment that succeeded (the commit may never have booted).' }, { status: 400 });
      }
      if (!dep.commit) {
        return NextResponse.json({ error: 'That deployment record has no commit hash.' }, { status: 400 });
      }
      targetCommit = dep.commit;
      commitMessage = dep.commitMessage;
    }
    if (!/^[0-9a-f]{7,40}$/i.test(targetCommit)) {
      return NextResponse.json({ error: 'Invalid commit hash — expected a git SHA (7–40 hex chars) or a deploymentId.' }, { status: 400 });
    }
    if (targetCommit === svc.commitHash && svc.status === 'running') {
      return NextResponse.json({ error: `Already running commit ${targetCommit}.` }, { status: 409 });
    }

    await db.service.update({ where: { id }, data: { status: 'building' } });
    await addLog({
      serviceId: svc.id,
      scope: 'deploy',
      message: `Rollback requested → re-running the real pipeline pinned to commit ${targetCommit}${commitMessage ? ` (${commitMessage})` : ''}. Old process tree will be killed before the new one spawns.`,
      source: 'rollback',
    });

    void startDeployment(
      {
        id: svc.id,
        name: svc.name,
        repoUrl: svc.repoUrl,
        branch: svc.branch,
        buildCommand: svc.buildCommand,
        startCommand: svc.startCommand,
        port: svc.port,
        envVarsJson: svc.envVarsJson,
        volumeMountsJson: svc.volumeMountsJson,
      },
      { trigger: 'rollback', checkoutCommit: targetCommit }
    ).catch(async (err) => {
      console.error('[rollback] pipeline crashed', err);
      await db.service.update({ where: { id: svc.id }, data: { status: 'failed' } }).catch(() => {});
    });

    return NextResponse.json({
      data: {
        ok: true,
        message: `Rollback to ${targetCommit} started — full pipeline re-running (clone → fetch ${targetCommit} → checkout → install → build → run).`,
        commit: targetCommit,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Rollback failed' }, { status: 500 });
  }
}
