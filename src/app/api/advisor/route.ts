import { NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';
import { db } from '@/lib/db';
import { getHostMetrics } from '@/lib/hoster/metrics';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';

export const dynamic = 'force-dynamic';

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface AdvisorServiceRef {
  name: string;
  type: string;
  hardwareTier: string;
  status: string;
}

interface AdvisorResult {
  summary: string;
  recommendedTier: string;
  recommendedRegion?: string;
  rationale: string[];
  databaseAdvice?: string;
  scalingAdvice?: string;
  estimatedMonthlyCostUsd?: number;
  // Rich fields consumed by the advisor modal UI
  explanation?: string;
  volumeRecommendation?: string;
  databaseRecommendation?: string;
  dockerfileSnippet?: string;
  scaleToZeroAdvice?: string;
  raw?: boolean;
}

const FALLBACK_TIER = 'cpu-standard';

// ─── Small safe helpers (no `any`) ───────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return (m ? m[1] : trimmed).trim();
}

function extractCompletionContent(completion: unknown): string {
  if (!completion || typeof completion !== 'object') return '';
  const choices = (completion as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

function sanitizeServices(raw: unknown): AdvisorServiceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AdvisorServiceRef[] = [];
  for (const item of raw.slice(0, 25)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    out.push({
      name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'unnamed',
      type: typeof rec.type === 'string' ? rec.type : 'api',
      hardwareTier: typeof rec.hardwareTier === 'string' ? rec.hardwareTier : 'cpu-nano',
      status: typeof rec.status === 'string' ? rec.status : 'unknown',
    });
  }
  return out;
}

function buildTierCatalog(): string {
  return Object.values(HARDWARE_SPECS)
    .map(
      (s) =>
        `- ${s.id} | ${s.vCpu} vCPU | ${s.ramGb} GB RAM | ${
          s.gpuModel ? `${s.gpuModel} (${s.vramGb ?? 0} GB VRAM)` : 'no GPU'
        } | $${s.priceHourly.toFixed(3)}/hr | ${s.recommendedFor}`
    )
    .join('\n');
}

// ─── Strict-JSON response parsing ────────────────────────────────────────────

function coerceAdvisor(rawText: string): AdvisorResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
  if (!summary) return null;

  const rationale = Array.isArray(rec.rationale)
    ? rec.rationale
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .slice(0, 10)
    : [];

  const out: AdvisorResult = {
    summary,
    recommendedTier:
      typeof rec.recommendedTier === 'string' && rec.recommendedTier.trim()
        ? rec.recommendedTier.trim()
        : FALLBACK_TIER,
    rationale: rationale.length > 0 ? rationale : [summary],
  };

  if (typeof rec.recommendedRegion === 'string' && rec.recommendedRegion.trim()) {
    out.recommendedRegion = rec.recommendedRegion.trim();
  }
  if (typeof rec.databaseAdvice === 'string' && rec.databaseAdvice.trim()) {
    out.databaseAdvice = rec.databaseAdvice.trim();
    out.databaseRecommendation = rec.databaseAdvice.trim();
  }
  if (typeof rec.databaseRecommendation === 'string' && rec.databaseRecommendation.trim()) {
    out.databaseRecommendation = rec.databaseRecommendation.trim();
    out.databaseAdvice = out.databaseAdvice ?? rec.databaseRecommendation.trim();
  }
  if (typeof rec.scalingAdvice === 'string' && rec.scalingAdvice.trim()) {
    out.scalingAdvice = rec.scalingAdvice.trim();
    out.scaleToZeroAdvice = rec.scalingAdvice.trim();
  }
  if (typeof rec.scaleToZeroAdvice === 'string' && rec.scaleToZeroAdvice.trim()) {
    out.scaleToZeroAdvice = rec.scaleToZeroAdvice.trim();
    out.scalingAdvice = out.scalingAdvice ?? rec.scaleToZeroAdvice.trim();
  }
  if (typeof rec.explanation === 'string' && rec.explanation.trim()) {
    out.explanation = rec.explanation.trim();
  }
  if (typeof rec.volumeRecommendation === 'string' && rec.volumeRecommendation.trim()) {
    out.volumeRecommendation = rec.volumeRecommendation.trim();
  }
  if (typeof rec.dockerfileSnippet === 'string' && rec.dockerfileSnippet.trim()) {
    out.dockerfileSnippet = rec.dockerfileSnippet.trim();
  }
  if (typeof rec.estimatedMonthlyCostUsd === 'number' && Number.isFinite(rec.estimatedMonthlyCostUsd)) {
    out.estimatedMonthlyCostUsd = Math.round(rec.estimatedMonthlyCostUsd * 100) / 100;
  }
  return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const rec = body as Record<string, unknown>;

    const goal =
      typeof rec.goal === 'string' && rec.goal.trim()
        ? rec.goal.trim()
        : typeof rec.workloadDescription === 'string' && rec.workloadDescription.trim()
          ? rec.workloadDescription.trim()
          : '';
    if (!goal) {
      return NextResponse.json({ error: "'goal' (non-empty string) is required" }, { status: 400 });
    }
    const serviceTypeHint = typeof rec.serviceType === 'string' ? rec.serviceType.trim() : '';
    const trafficHint = typeof rec.targetTraffic === 'string' || typeof rec.targetTraffic === 'number' ? String(rec.targetTraffic) : '';
    const serviceRefs = sanitizeServices(rec.services);
    const includeHostMetrics = rec.includeHostMetrics !== false;

    // Real host telemetry (graceful degradation — advisor still works without it)
    let hostBlock = '';
    if (includeHostMetrics) {
      try {
        const m = await getHostMetrics();
        const gpu = m.gpu;
        const gpuLine = gpu.detected
          ? `${[gpu.vendor, gpu.model].filter(Boolean).join(' ') || 'GPU'}${
              gpu.vramTotalMb ? `, ${Math.round((gpu.vramTotalMb / 1024) * 10) / 10} GB VRAM` : ''
            }, util ${gpu.utilPercent ?? 0}%`
          : 'none detected (CPU-only host)';
        hostBlock = [
          'REAL HOST CAPACITY (live telemetry):',
          `- Host: ${m.os.hostname} (${m.os.platform}/${m.os.arch}), uptime ${Math.round(m.os.uptimeSeconds / 3600)}h`,
          `- CPU: ${m.cpu.cores} cores (${m.cpu.model}), usage ${m.cpu.usagePercent}%, load avg ${m.cpu.loadAvg.join('/')}`,
          `- RAM: ${m.memory.totalGb} GB total, ${m.memory.usedGb} GB used (${m.memory.usedPercent}%)`,
          `- Disk: ${m.storage.totalGb} GB total, ${m.storage.usedGb} GB used (${m.storage.usedPercent}%)${m.storage.filesystem ? `, ${m.storage.filesystem}` : ''}`,
          `- GPU: ${gpuLine}`,
        ].join('\n');
      } catch {
        hostBlock = 'REAL HOST CAPACITY: telemetry temporarily unavailable.';
      }
    }

    // Live platform counts
    const [svcCount, pgCount, redisCount, volumeCount, connectedProviderCount] = await Promise.all([
      db.service.count(),
      db.postgresDb.count(),
      db.redisDb.count(),
      db.volume.count(),
      db.provider.count({ where: { status: 'connected' } }),
    ]);

    const SYSTEM = [
      "You are the NexusHost AI Architecture Advisor, an expert cloud infrastructure architect. Given the user's workload goal, real host capacity, and the hardware tier catalog, recommend a complete architecture. Respond with STRICT JSON only, no markdown fences, matching exactly:",
      '{ summary: string (2-3 sentences), recommendedTier: string (one tier id from the catalog — prefer FREE tiers when the workload fits: local-node, free-hf-space, free-render, free-fly), recommendedRegion: string, rationale: string[] (3-5 short bullet reasons), explanation: string (2-4 sentences of technical sizing detail, mention VRAM/CPU/RAM math when relevant), volumeRecommendation?: string (persistent volume advice incl. mount path), databaseRecommendation?: string (PostgreSQL/Redis advice, mention pgvector if embeddings involved), dockerfileSnippet?: string (a short realistic Dockerfile or start command), scaleToZeroAdvice?: string (min/max instances + idle strategy), estimatedMonthlyCostUsd?: number }',
      '',
      'HARDWARE TIER CATALOG:',
      buildTierCatalog(),
    ].join('\n');

    const userParts: string[] = ['WORKLOAD GOAL:', goal];
    if (serviceTypeHint) userParts.push(`WORKLOAD TYPE: ${serviceTypeHint}`);
    if (trafficHint) userParts.push(`EXPECTED TRAFFIC / SCALE: ${trafficHint}`);

    if (serviceRefs.length > 0) {
      userParts.push('', `CURRENTLY DEPLOYED SERVICES (${serviceRefs.length}):`);
      for (const s of serviceRefs) {
        userParts.push(`- ${s.name} | type=${s.type} | tier=${s.hardwareTier} | status=${s.status}`);
      }
    }
    if (hostBlock) userParts.push('', hostBlock);
    userParts.push(
      '',
      'PLATFORM STATE (live):',
      `- services deployed: ${svcCount}`,
      `- postgres databases: ${pgCount}`,
      `- redis databases: ${redisCount}`,
      `- persistent volumes: ${volumeCount}`,
      `- connected providers: ${connectedProviderCount}`
    );

    let content: string;
    try {
      const zai = await ZAI.create();
      const completion: unknown = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: SYSTEM },
          { role: 'user', content: userParts.join('\n') },
        ],
        thinking: { type: 'disabled' },
      });
      content = extractCompletionContent(completion);
    } catch (err) {
      return NextResponse.json({ error: `AI backend unavailable: ${errorMessage(err)}` }, { status: 502 });
    }

    const parsed = coerceAdvisor(content);
    if (parsed) {
      return NextResponse.json({ data: parsed });
    }

    // Parse failure → unstructured fallback so the UI still has something to render
    const text = content.trim() || 'The advisor could not produce a structured recommendation for this goal.';
    const fallback: AdvisorResult = {
      summary: text,
      recommendedTier: FALLBACK_TIER,
      rationale: [text],
      raw: true,
    };
    return NextResponse.json({ data: fallback });
  } catch (err) {
    return NextResponse.json({ error: `Advisor failed: ${errorMessage(err)}` }, { status: 500 });
  }
}
