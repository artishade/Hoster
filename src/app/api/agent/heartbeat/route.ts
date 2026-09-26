import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addLog } from '@/lib/hoster/server';

export const dynamic = 'force-dynamic';

interface HeartbeatBody {
  agentToken?: string;
  nodeName?: string;
  osInfo?: string;
  metrics?: {
    cpuPercent?: number;
    ramTotalMb?: number;
    ramUsedMb?: number;
    diskTotalGb?: number;
    diskUsedGb?: number;
    gpu?: {
      model?: string;
      vramTotalMb?: number;
      vramUsedMb?: number;
      utilPercent?: number;
      tempC?: number;
    } | null;
  };
}

/**
 * POST /api/agent/heartbeat — REAL telemetry ingestion from machines running
 * the NexusHost node agent (any VPS / GPU rig). The bash agent POSTs actual
 * /proc + nvidia-smi measurements here every ~15s.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as HeartbeatBody;
    const agentToken = body.agentToken?.trim();

    if (!agentToken) {
      return NextResponse.json({ error: 'agentToken is required' }, { status: 400 });
    }

    const provider = await db.provider.findUnique({ where: { agentToken } });
    if (!provider) {
      return NextResponse.json({ error: 'Unknown agent token' }, { status: 404 });
    }

    const m = body.metrics ?? {};
    const wasOffline = provider.status !== 'connected';

    const liveMetrics = {
      cpuPercent: clampNum(m.cpuPercent, 0, 100),
      ramPercent:
        m.ramTotalMb && m.ramUsedMb !== undefined
          ? +((m.ramUsedMb / Math.max(1, m.ramTotalMb)) * 100).toFixed(1)
          : undefined,
      ramUsedMb: m.ramUsedMb,
      ramTotalMb: m.ramTotalMb,
      diskPercent:
        m.diskTotalGb && m.diskUsedGb !== undefined
          ? +((m.diskUsedGb / Math.max(1, m.diskTotalGb)) * 100).toFixed(1)
          : undefined,
      gpuPercent: m.gpu?.utilPercent,
      gpuTempC: m.gpu?.tempC,
      gpuModel: m.gpu?.model,
      gpuVramUsedMb: m.gpu?.vramUsedMb,
      gpuVramTotalMb: m.gpu?.vramTotalMb,
    };

    // Keep measured hardware totals as the node capacity (real machine specs).
    const capacity = safeParse<Record<string, unknown>>(provider.capacityJson, {});
    const patch: Record<string, unknown> = {};
    if (m.ramTotalMb && !capacity.ramGb) patch.ramGb = +(m.ramTotalMb / 1024).toFixed(2);
    if (m.diskTotalGb && !capacity.storageGb) patch.storageGb = m.diskTotalGb;
    if (m.gpu?.model && !capacity.gpuModel) {
      patch.gpuModel = m.gpu.model;
      if (m.gpu.vramTotalMb) patch.vramGb = +(m.gpu.vramTotalMb / 1024).toFixed(1);
    }
    const merged = { ...capacity, ...patch };

    await db.provider.update({
      where: { id: provider.id },
      data: {
        status: 'connected',
        lastHeartbeatAt: new Date(),
        lastCheckedAt: new Date(),
        osInfo: body.osInfo ?? provider.osInfo,
        name: body.nodeName ? String(body.nodeName).slice(0, 60) : provider.name,
        liveMetricsJson: JSON.stringify(liveMetrics),
        capacityJson: JSON.stringify(merged),
      },
    });

    if (wasOffline) {
      await addLog({
        scope: 'provider',
        level: 'info',
        message: `Custom node "${body.nodeName ?? provider.name}" came ONLINE — real agent telemetry streaming (CPU ${liveMetrics.cpuPercent ?? '?'}%, RAM ${liveMetrics.ramPercent ?? '?'}%).`,
        source: 'node-agent',
      });
    }

    return NextResponse.json({ data: { ok: true, nextHeartbeatSec: 15 } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Heartbeat failed' }, { status: 500 });
  }
}

/**
 * GET /api/agent/heartbeat — agent poll channel (reserved for future
 * remote commands; agents currently only push telemetry).
 */
export async function GET() {
  return NextResponse.json({ data: { commands: [] } });
}

function clampNum(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (Number.isNaN(n)) return undefined;
  return +Math.min(max, Math.max(min, n)).toFixed(1);
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
