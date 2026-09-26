import { NextResponse } from 'next/server';
import os from 'os';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';

export const dynamic = 'force-dynamic';

/**
 * GET /api/hardware-specs — the tier catalogue with REAL server-measured specs.
 *
 * The client bundle can't measure the host (os is polyfilled in browsers), so
 * it imports static display fallbacks. This endpoint serves the authoritative
 * server-side measurements: same tier ids, true vCPU / RAM / capacity numbers.
 */
export async function GET() {
  try {
    const cpus = os.cpus();
    const totalGb = +(os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const specs = Object.values(HARDWARE_SPECS).map((spec) => ({
      ...spec,
      // server-side override: these entries embed live-measured host values
      vCpu: HARDWARE_SPECS[spec.id]?.vCpu ?? spec.vCpu,
      ramGb: HARDWARE_SPECS[spec.id]?.ramGb ?? spec.ramGb,
    }));

    return NextResponse.json({
      data: {
        specs,
        host: {
          cores: cpus.length,
          cpuModel: cpus[0]?.model?.trim() ?? 'Generic vCPU',
          ramTotalGb: totalGb,
          measuredAt: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
