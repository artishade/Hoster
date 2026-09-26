import { NextRequest, NextResponse } from 'next/server';
import fsp from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { addLog, measureVolumeUsedGb, serializeVolume, volumesRoot } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

interface PatchVolumeBody {
  sizeGb?: unknown;
  attachedToServiceId?: unknown;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.volume.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Volume not found' }, { status: 404 });

    let body: PatchVolumeBody;
    try {
      body = (await req.json()) as PatchVolumeBody;
    } catch {
      body = {};
    }

    const data: { sizeGb?: number; attachedToServiceId?: string | null } = {};
    let attachMessage: string | null = null;

    if (body.sizeGb !== undefined) {
      const sizeGb = typeof body.sizeGb === 'number' && Number.isFinite(body.sizeGb) ? body.sizeGb : NaN;
      if (!(sizeGb >= 1 && sizeGb <= 500)) {
        return NextResponse.json({ error: 'sizeGb must be a number between 1 and 500' }, { status: 400 });
      }
      data.sizeGb = sizeGb;
    }

    if (body.attachedToServiceId !== undefined) {
      if (body.attachedToServiceId === null) {
        data.attachedToServiceId = null; // detach
      } else if (typeof body.attachedToServiceId === 'string' && body.attachedToServiceId.trim() !== '') {
        const serviceId = body.attachedToServiceId.trim();
        const service = await db.service.findUnique({ where: { id: serviceId } });
        if (!service) {
          return NextResponse.json({ error: 'Target service not found' }, { status: 400 });
        }
        data.attachedToServiceId = service.id;
        attachMessage = `Volume "${row.name}" attached to service.`;
      } else {
        return NextResponse.json({ error: 'attachedToServiceId must be a service id or null to detach' }, { status: 400 });
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update (pass sizeGb and/or attachedToServiceId)' }, { status: 400 });
    }

    const updated = await db.volume.update({ where: { id }, data });

    if (attachMessage) {
      // attaching exports the volume's real directory to the service via a
      // bind-path env var (VOLUME_<MOUNT>) on its next (re)deployment
      await addLog({ scope: 'storage', message: attachMessage, source: 'volume-provisioner' });
    }

    const usedGb = await measureVolumeUsedGb(updated.name);
    return NextResponse.json({ data: serializeVolume({ ...updated, usedGb }) });
  } catch (err) {
    console.error('[api/volumes/[id]] PATCH failed', err);
    return NextResponse.json({ error: 'Failed to update volume' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.volume.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: 'Volume not found' }, { status: 404 });

    // Remove the REAL backing directory (data is unrecoverably gone, like a real volume)
    const dir = path.join(volumesRoot(), row.name);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

    await db.volume.delete({ where: { id } });
    await addLog({ scope: 'storage', message: `Volume "${row.name}" deleted — backing directory ${dir} removed from disk.`, source: 'volume-provisioner' });
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error('[api/volumes/[id]] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to delete volume' }, { status: 500 });
  }
}
