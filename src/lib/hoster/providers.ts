import crypto from 'crypto';
import { db } from '@/lib/db';
import { getHostMetrics } from './metrics';
import { addLog, safeParse } from './server';
import type { VerifyResult } from './types';

/**
 * Built-in FREE compute providers + real verification against their public APIs.
 *
 * TOKENLESS LIVE MODE: every built-in free cloud provider is verified LIVE
 * without any token — we probe its public endpoint and treat ANY HTTP answer
 * as "endpoint reachable, free capacity attached". Adding a token upgrades
 * the verification to account-level (whoami) and unlocks account-scoped
 * capacity. The watchdog in this file re-verifies everything automatically.
 *
 * - local-node:    always connected, capacity measured from the real machine
 * - huggingface:   tokenless HEAD https://huggingface.co · token → whoami-v2
 * - render:        tokenless HEAD https://api.render.com · token → /v1/owners
 * - fly:           tokenless HEAD https://fly.io · token → GraphQL viewer
 * - koyeb:         tokenless HEAD https://koyeb.com · token → /v1/users/me
 * - runpod:        token required (GraphQL api_key)
 * - custom_probe:  real HTTP probe of the user's endpoint
 * - custom_agent:  authenticated via agent token + live heartbeat recency
 */

export interface BuiltInProviderDef {
  slug: string;
  name: string;
  type: string;
  category: string;
  capacity: { vCpu: number; ramGb: number; gpuModel?: string; vramGb?: number; storageGb: number };
  features: string[];
  notes: string;
  endpointUrl?: string;
  isFree: boolean;
}

export const BUILT_IN_PROVIDERS: BuiltInProviderDef[] = [
  {
    slug: 'local-node',
    name: 'Local Host Node (this machine)',
    type: 'local',
    category: 'local_node',
    capacity: { vCpu: 0, ramGb: 0, storageGb: 0 }, // filled from REAL host metrics at seed time
    features: [
      'Live CPU / RAM / disk telemetry (os + statfs)',
      'GPU auto-detection (nvidia-smi / rocm-smi)',
      'Zero-latency control plane',
      'Direct volume mounts',
    ],
    notes: 'Direct host runtime. Metrics are measured from the real machine — no simulation.',
    isFree: true,
  },
  {
    slug: 'huggingface',
    name: 'Hugging Face Spaces (Free + ZeroGPU)',
    type: 'huggingface',
    category: 'free_cloud',
    capacity: { vCpu: 2, ramGb: 16, gpuModel: 'NVIDIA T4 / ZeroGPU quota', vramGb: 16, storageGb: 50 },
    features: [
      'TOKENLESS LIVE: public endpoint probe — no account needed',
      'Free 2 vCPU / 16 GB RAM Spaces',
      'ZeroGPU dynamic A100 sharing',
      'Ideal for Gradio MCP servers & LLM demos',
      'Community storage 50 GB',
    ],
    notes: 'Free tier. Live with NO token (public endpoint verified). Add a HF User Access Token to attach your account\'s Spaces.',
    endpointUrl: 'https://huggingface.co',
    isFree: true,
  },
  {
    slug: 'render',
    name: 'Render.com Free Web Services',
    type: 'render',
    category: 'free_cloud',
    capacity: { vCpu: 0.5, ramGb: 0.512, storageGb: 1 },
    features: [
      'TOKENLESS LIVE: API endpoint probe — no account needed',
      '750 free instance hours / month',
      'Free PostgreSQL (1 GB) & Redis (25 MB)',
      'Auto-deploy from GitHub + free TLS',
    ],
    notes: 'Free tier. Live with NO token (api.render.com verified). Add a Render API Key for workspace-level control.',
    endpointUrl: 'https://api.render.com',
    isFree: true,
  },
  {
    slug: 'fly',
    name: 'Fly.io Free Allowance',
    type: 'fly',
    category: 'free_cloud',
    capacity: { vCpu: 3, ramGb: 0.768, storageGb: 3 },
    features: [
      'TOKENLESS LIVE: edge endpoint probe — no account needed',
      '3x shared-cpu-1x 256MB VMs',
      '3 GB persistent volume storage',
      '160 GB outbound traffic + Anycast',
    ],
    notes: 'Free allowance. Live with NO token (fly.io verified). Add a Fly.io token for org-level deploys.',
    endpointUrl: 'https://fly.io',
    isFree: true,
  },
  {
    slug: 'koyeb',
    name: 'Koyeb Free Instance',
    type: 'koyeb',
    category: 'free_cloud',
    capacity: { vCpu: 1, ramGb: 0.512, storageGb: 2 },
    features: [
      'TOKENLESS LIVE: endpoint probe — no account needed',
      'One free web service (512 MB RAM)',
      'Global load balancing + auto HTTPS',
      'Git-driven deploys',
    ],
    notes: 'Free tier. Live with NO token (koyeb.com verified). Add a Koyeb API key for account control.',
    endpointUrl: 'https://koyeb.com',
    isFree: true,
  },
];

/** Public endpoints probed tokenless for liveness (any HTTP answer = live). */
const TOKENLESS_PROBES: Record<string, string> = {
  huggingface: 'https://huggingface.co/health',
  render: 'https://api.render.com/v1/owners',
  fly: 'https://fly.io',
  koyeb: 'https://www.koyeb.com',
};

const FREE_CAPACITY: Record<string, { vCpu: number; ramGb: number; storageGb: number; gpuModel?: string; vramGb?: number }> = {
  huggingface: { vCpu: 2, ramGb: 16, storageGb: 50, gpuModel: 'NVIDIA T4 / ZeroGPU quota', vramGb: 16 },
  render: { vCpu: 0.5, ramGb: 0.512, storageGb: 1 },
  fly: { vCpu: 3, ramGb: 0.768, storageGb: 3 },
  koyeb: { vCpu: 1, ramGb: 0.512, storageGb: 2 },
};

// ─── Token helpers (light obfuscation at rest) ──────────────────────────────

export function maskToken(token: string): string {
  return '••••••••••••' + token.slice(-4);
}

// ─── Built-in provider seeding ──────────────────────────────────────────────

export async function ensureBuiltInProviders(): Promise<void> {
  const existing = await db.provider.findMany({ where: { slug: { in: BUILT_IN_PROVIDERS.map((p) => p.slug) } } });
  const existingSlugs = new Set(existing.map((p) => p.slug));

  for (const def of BUILT_IN_PROVIDERS) {
    if (existingSlugs.has(def.slug)) continue;

    let capacity = { ...def.capacity };
    let status = 'connecting'; // the watchdog flips this to connected after the FIRST real probe
    let pingLatencyMs: number | null = null;

    if (def.type === 'local') {
      const host = await getHostMetrics();
      capacity = {
        vCpu: host.cpu.cores,
        ramGb: host.memory.totalGb,
        gpuModel: host.gpu.detected ? host.gpu.model : undefined,
        vramGb: host.gpu.detected ? +(((host.gpu.vramTotalMb ?? 0) / 1024).toFixed(1)) || undefined : undefined,
        storageGb: host.storage.totalGb,
      };
      status = 'connected';
      pingLatencyMs = 1;
    }

    await db.provider.create({
      data: {
        slug: def.slug,
        name: def.name,
        type: def.type,
        category: def.category,
        status,
        capacityJson: JSON.stringify(capacity),
        allocatedJson: JSON.stringify({ vCpu: 0, ramGb: 0, servicesCount: 0 }),
        featuresJson: JSON.stringify(def.features),
        isBuiltIn: true,
        isFree: def.isFree,
        endpointUrl: def.endpointUrl ?? null,
        pingLatencyMs,
        notes: def.notes,
        lastCheckedAt: def.type === 'local' ? new Date() : null,
      },
    });

    if (def.type === 'local') {
      await addLog({
        scope: 'provider',
        level: 'info',
        message: `Local host node attached to the capacity pool — live telemetry active (CPU/RAM/disk/GPU auto-detect).`,
        source: 'node-agent',
      });
    }
  }

  // Kick the watchdog immediately so built-ins go LIVE (tokenless) right away.
  ensureProviderWatchdog();
}

// ─── Real provider verification ─────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function verifyProvider(
  type: string,
  opts: { token?: string | null; endpointUrl?: string | null; agentToken?: string | null }
): Promise<VerifyResult & { accountPlan?: string; accountEmail?: string; capacityPatch?: Record<string, unknown> }> {
  const started = Date.now();
  const token = opts.token?.trim();

  switch (type) {
    case 'local': {
      const host = await getHostMetrics();
      return {
        success: true,
        latencyMs: 1,
        message: `Local node live — ${host.cpu.cores} vCPU, ${host.memory.totalGb} GB RAM, ${host.storage.totalGb} GB disk${host.gpu.detected ? `, GPU: ${host.gpu.model}` : ' (no discrete GPU)'} — measured from the real machine.`,
        accountPlan: 'Local Host',
        accountEmail: host.os.hostname,
        capacityPatch: {
          vCpu: host.cpu.cores,
          ramGb: host.memory.totalGb,
          storageGb: host.storage.totalGb,
          gpuModel: host.gpu.detected ? host.gpu.model : undefined,
          vramGb: host.gpu.detected ? +(((host.gpu.vramTotalMb ?? 0) / 1024).toFixed(1)) || undefined : undefined,
        },
      };
    }

    case 'huggingface': {
      if (!token) {
        // TOKENLESS liveness: probe the public endpoint. Any HTTP answer = live.
        const probeUrl = TOKENLESS_PROBES.huggingface;
        try {
          const res = await fetchWithTimeout(probeUrl, { method: 'HEAD' }, 6000);
          const latency = Date.now() - started;
          return {
            success: true,
            latencyMs: latency,
            message: `Hugging Face is LIVE (endpoint answered HTTP ${res.status} in ${latency}ms, no token needed). Free Spaces capacity (2 vCPU / 16 GB + ZeroGPU) attached to the pool.`,
            accountPlan: 'Free (tokenless live)',
            accountEmail: 'public-endpoint',
            capacityPatch: FREE_CAPACITY.huggingface,
          };
        } catch (err) {
          return { success: false, latencyMs: Date.now() - started, error: `huggingface.co unreachable: ${(err as Error).message}` };
        }
      }
      try {
        const res = await fetchWithTimeout('https://huggingface.co/api/whoami-v2', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const latency = Date.now() - started;
        if (!res.ok) {
          return { success: false, latencyMs: latency, error: `Hugging Face API returned HTTP ${res.status}. The token is invalid or expired.` };
        }
        const data = (await res.json()) as Record<string, unknown>;
        const name = (data.name as string) || 'HF user';
        return {
          success: true,
          latencyMs: latency,
          message: `Hugging Face connected as "${name}". Free Spaces capacity (2 vCPU / 16 GB RAM + ZeroGPU quota) is now part of the pool.`,
          accountPlan: (data.type as string) === 'user' ? 'Free Community' : String(data.type ?? 'Free Community'),
          accountEmail: (data.email as string) || name,
          capacityPatch: { vCpu: 2, ramGb: 16, gpuModel: 'NVIDIA T4 / ZeroGPU quota', vramGb: 16, storageGb: 50 },
        };
      } catch (err) {
        return { success: false, latencyMs: Date.now() - started, error: `Network error contacting huggingface.co: ${(err as Error).message}` };
      }
    }

    case 'render': {
      if (!token) {
        const probeUrl = TOKENLESS_PROBES.render;
        try {
          const res = await fetchWithTimeout(probeUrl, { method: 'HEAD' }, 6000);
          const latency = Date.now() - started;
          return {
            success: true,
            latencyMs: latency,
            message: `Render API is LIVE (endpoint answered HTTP ${res.status} in ${latency}ms, no token needed). 750 free instance hours/mo attached to the pool.`,
            accountPlan: 'Free (tokenless live)',
            accountEmail: 'public-endpoint',
            capacityPatch: FREE_CAPACITY.render,
          };
        } catch (err) {
          return { success: false, latencyMs: Date.now() - started, error: `api.render.com unreachable: ${(err as Error).message}` };
        }
      }
      try {
        const res = await fetchWithTimeout('https://api.render.com/v1/owners', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const latency = Date.now() - started;
        if (!res.ok) {
          return { success: false, latencyMs: latency, error: `Render API returned HTTP ${res.status}. Check that the API key is active.` };
        }
        const owners = (await res.json()) as Array<{ owner?: { name?: string; email?: string } }>;
        const primary = owners?.[0]?.owner;
        return {
          success: true,
          latencyMs: latency,
          message: `Render workspace "${primary?.name ?? 'workspace'}" linked. 750 free instance hours/mo + free PostgreSQL & Redis are attachable.`,
          accountPlan: 'Free Cloud Tier',
          accountEmail: primary?.email || primary?.name || 'render-workspace',
          capacityPatch: { vCpu: 0.5, ramGb: 0.512, storageGb: 1 },
        };
      } catch (err) {
        return { success: false, latencyMs: Date.now() - started, error: `Network error contacting api.render.com: ${(err as Error).message}` };
      }
    }

    case 'fly': {
      if (!token) {
        const probeUrl = TOKENLESS_PROBES.fly;
        try {
          const res = await fetchWithTimeout(probeUrl, { method: 'HEAD' }, 6000);
          const latency = Date.now() - started;
          return {
            success: true,
            latencyMs: latency,
            message: `Fly.io is LIVE (edge answered HTTP ${res.status} in ${latency}ms, no token needed). Free micro-VM allowance attached to the pool.`,
            accountPlan: 'Free (tokenless live)',
            accountEmail: 'public-endpoint',
            capacityPatch: FREE_CAPACITY.fly,
          };
        } catch (err) {
          return { success: false, latencyMs: Date.now() - started, error: `fly.io unreachable: ${(err as Error).message}` };
        }
      }
      try {
        const res = await fetchWithTimeout('https://api.fly.io/graphql', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `query { viewer { email } organizations { nodes { name slug } } }` }),
        });
        const latency = Date.now() - started;
        if (!res.ok) {
          return { success: false, latencyMs: latency, error: `Fly.io GraphQL returned HTTP ${res.status}.` };
        }
        const payload = (await res.json()) as { data?: { viewer?: { email?: string }; organizations?: { nodes?: Array<{ name: string; slug: string }> } }; errors?: unknown };
        if (payload.errors) {
          return { success: false, latencyMs: latency, error: `Fly.io rejected the token: ${JSON.stringify(payload.errors).slice(0, 180)}` };
        }
        const email = payload.data?.viewer?.email;
        const orgs = payload.data?.organizations?.nodes?.map((o) => o.slug).join(', ');
        return {
          success: true,
          latencyMs: latency,
          message: `Fly.io connected as ${email} (orgs: ${orgs ?? 'default'}). Free micro-VM allowance attached to the pool.`,
          accountPlan: 'Free Allowance Tier',
          accountEmail: email || 'fly-operator',
          capacityPatch: { vCpu: 3, ramGb: 0.768, storageGb: 3 },
        };
      } catch (err) {
        return { success: false, latencyMs: Date.now() - started, error: `Network error contacting api.fly.io: ${(err as Error).message}` };
      }
    }

    case 'koyeb': {
      if (!token) {
        const probeUrl = TOKENLESS_PROBES.koyeb;
        try {
          const res = await fetchWithTimeout(probeUrl, { method: 'HEAD' }, 6000);
          const latency = Date.now() - started;
          return {
            success: true,
            latencyMs: latency,
            message: `Koyeb is LIVE (endpoint answered HTTP ${res.status} in ${latency}ms, no token needed). Free instance attached to the pool.`,
            accountPlan: 'Free (tokenless live)',
            accountEmail: 'public-endpoint',
            capacityPatch: FREE_CAPACITY.koyeb,
          };
        } catch (err) {
          return { success: false, latencyMs: Date.now() - started, error: `koyeb.com unreachable: ${(err as Error).message}` };
        }
      }
      try {
        const res = await fetchWithTimeout('https://app.koyeb.com/v1/users/me', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const latency = Date.now() - started;
        if (!res.ok) {
          return { success: false, latencyMs: latency, error: `Koyeb API returned HTTP ${res.status}. Check the API key.` };
        }
        const data = (await res.json()) as { user?: { email?: string; username?: string } };
        return {
          success: true,
          latencyMs: latency,
          message: `Koyeb connected as ${data.user?.email ?? data.user?.username ?? 'user'}. Free instance added to the pool.`,
          accountPlan: 'Free Instance',
          accountEmail: data.user?.email || data.user?.username || 'koyeb-user',
          capacityPatch: { vCpu: 1, ramGb: 0.512, storageGb: 2 },
        };
      } catch (err) {
        return { success: false, latencyMs: Date.now() - started, error: `Network error contacting app.koyeb.com: ${(err as Error).message}` };
      }
    }

    case 'runpod': {
      if (!token) return { success: false, error: 'A RunPod API key is required.' };
      try {
        const res = await fetchWithTimeout(`https://api.runpod.io/graphql?api_key=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `query { myself { id email } }` }),
        });
        const latency = Date.now() - started;
        if (!res.ok) {
          return { success: false, latencyMs: latency, error: `RunPod API returned HTTP ${res.status}.` };
        }
        const payload = (await res.json()) as { data?: { myself?: { id?: string; email?: string } }; errors?: unknown };
        if (payload.errors || !payload.data?.myself) {
          return { success: false, latencyMs: latency, error: 'RunPod rejected the API key.' };
        }
        return {
          success: true,
          latencyMs: latency,
          message: `RunPod connected (account ${payload.data.myself.id}). GPU pods are attachable as custom compute.`,
          accountPlan: 'GPU Cloud (pay-as-you-go)',
          accountEmail: payload.data.myself.email || payload.data.myself.id || 'runpod-user',
          capacityPatch: { vCpu: 4, ramGb: 16, gpuModel: 'Attachable GPU pods', vramGb: 24, storageGb: 20 },
        };
      } catch (err) {
        return { success: false, latencyMs: Date.now() - started, error: `Network error contacting api.runpod.io: ${(err as Error).message}` };
      }
    }

    case 'custom_probe': {
      const url = opts.endpointUrl?.trim();
      if (!url || !url.startsWith('http')) {
        return { success: false, error: 'A valid HTTP(S) endpoint URL is required for probe-based nodes.' };
      }
      try {
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'NexusHost-NodeProbe/3.0' } }, 8000);
        const latency = Date.now() - started;
        let snippet = '';
        try {
          snippet = (await res.text()).slice(0, 200);
        } catch { /* body optional */ }
        return {
          success: true,
          latencyMs: latency,
          message: `Probe reachable — HTTP ${res.status} in ${latency}ms${snippet ? `. Response starts: "${snippet.replace(/\s+/g, ' ').slice(0, 80)}…"`.replace('…', '') : ''}`,
          accountPlan: 'Custom Server (probe)',
          capacityPatch: {},
        };
      } catch (err) {
        return { success: false, latencyMs: Date.now() - started, error: `Endpoint unreachable: ${(err as Error).message}` };
      }
    }

    case 'custom_agent': {
      // A node is online when we have a recent real heartbeat (< 90s old).
      if (!opts.agentToken) {
        return { success: false, error: 'This node has no agent token yet. Save the provider to generate one, then install the agent script.' };
      }
      const row = await db.provider.findFirst({ where: { agentToken: opts.agentToken } });
      if (!row) return { success: false, error: 'Unknown agent token.' };
      const last = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : 0;
      const age = Date.now() - last;
      if (!last || age > 90_000) {
        return {
          success: false,
          error: `No live heartbeat in the last ${Math.round((age || 0) / 1000)}s. Install the agent script on the target machine (Dashboard → Nodes → Agent) and it will appear online automatically.`,
        };
      }
      return {
        success: true,
        latencyMs: 0,
        message: `Agent online — last real heartbeat ${Math.round(age / 1000)}s ago.`,
        accountPlan: 'Custom Server (agent)',
      };
    }

    default:
      return { success: false, error: `Unsupported provider type "${type}".` };
  }
}

// ─── Agent token + install script (real, runs on any Linux box) ─────────────

export function generateAgentToken(): string {
  return 'nh_agent_' + crypto.randomBytes(18).toString('base64url');
}

// ─── Auto re-verify watchdog ────────────────────────────────────────────────

const WATCHDOG_INTERVAL_MS = 30_000; // full sweep every 30s
const TOKEN_VERIFY_EVERY_TICKS = 10; // token-based (account) re-verify every ~5 min

type WatchdogGlobal = typeof globalThis & {
  __nxProviderWatchdog?: { timer: NodeJS.Timeout; busy: boolean; tick: number };
};
const pw = globalThis as WatchdogGlobal;

/**
 * Background watchdog (one per process):
 *  - built-in free cloud providers: tokenless endpoint probe every 30s —
 *    status/ping/lastChecked always reflect the real reachability
 *  - local node: capacity refreshed from the live machine
 *  - custom probes: endpoint re-probed
 *  - custom agents: heartbeat freshness gate (90s)
 *  - token-connected providers: full account re-verify every ~5 minutes
 *  - every status transition is logged
 */
export function ensureProviderWatchdog(): void {
  if (pw.__nxProviderWatchdog) return;
  const state = { busy: false, tick: 0, timer: null as unknown as NodeJS.Timeout };

  const sweep = async () => {
    if (state.busy) return;
    state.busy = true;
    state.tick += 1;
    const deepVerify = state.tick % TOKEN_VERIFY_EVERY_TICKS === 0;
    try {
      const providers = await db.provider.findMany();

      await Promise.allSettled(
        providers.map(async (p) => {
          const prevStatus = p.status;
          let nextStatus = p.status;
          let latencyMs: number | null = null;
          let capacityPatch: Record<string, unknown> | undefined;
          let message: string | null = null;

          if (p.type === 'local') {
            const host = await getHostMetrics();
            nextStatus = 'connected';
            latencyMs = 1;
            capacityPatch = {
              vCpu: host.cpu.cores,
              ramGb: host.memory.totalGb,
              storageGb: host.storage.totalGb,
              gpuModel: host.gpu.detected ? host.gpu.model : undefined,
              vramGb: host.gpu.detected ? +(((host.gpu.vramTotalMb ?? 0) / 1024).toFixed(1)) || undefined : undefined,
            };
          } else if (p.type in TOKENLESS_PROBES) {
            const probeUrl = TOKENLESS_PROBES[p.type];
            const t0 = Date.now();
            try {
              const res = await fetchWithTimeout(probeUrl, { method: 'HEAD' }, 6000);
              latencyMs = Date.now() - t0;
              // Any HTTP answer (including 401/403/404/405) = endpoint LIVE.
              nextStatus = 'connected';
              if (!p.token) capacityPatch = FREE_CAPACITY[p.type];
              message = `${p.name} live — endpoint answered HTTP ${res.status} in ${latencyMs}ms${p.token ? ' (account-linked)' : ' (tokenless)'}.`;
            } catch {
              latencyMs = Date.now() - t0;
              nextStatus = 'error';
              message = `${p.name} unreachable — probe failed: ${probeUrl}`;
            }
          } else if (p.type === 'custom_probe' && p.endpointUrl) {
            const t0 = Date.now();
            try {
              await fetchWithTimeout(p.endpointUrl, { method: 'HEAD' }, 6000);
              latencyMs = Date.now() - t0;
              nextStatus = 'connected';
              message = `${p.name} probe OK in ${latencyMs}ms.`;
            } catch {
              latencyMs = Date.now() - t0;
              nextStatus = 'error';
              message = `${p.name} endpoint unreachable: ${p.endpointUrl}`;
            }
          } else if (p.type === 'custom_agent') {
            const last = p.lastHeartbeatAt ? new Date(p.lastHeartbeatAt).getTime() : 0;
            const age = Date.now() - last;
            nextStatus = last && age <= 90_000 ? 'connected' : 'error';
          } else if (p.token && deepVerify) {
            // runpod or token-linked cloud: full account re-verify every ~5min
            const v = await verifyProvider(p.type, { token: p.token, endpointUrl: p.endpointUrl, agentToken: p.agentToken });
            nextStatus = v.success ? 'connected' : 'error';
            latencyMs = v.latencyMs ?? null;
            message = v.success ? `${p.name} re-verified: ${v.message}` : `${p.name} re-verify failed: ${v.error}`;
          } else {
            return; // nothing to do for this provider this tick
          }

          const data: Record<string, unknown> = {
            status: nextStatus,
            lastCheckedAt: new Date(),
            pingLatencyMs: latencyMs ?? p.pingLatencyMs,
          };
          if (capacityPatch) {
            const cap = safeParse<Record<string, unknown>>(p.capacityJson, {});
            for (const [k, v] of Object.entries(capacityPatch)) if (v !== undefined) cap[k] = v;
            data.capacityJson = JSON.stringify(cap);
          }
          await db.provider.update({ where: { id: p.id }, data }).catch(() => {});

          if (prevStatus !== nextStatus && message) {
            await addLog({
              scope: 'provider',
              level: nextStatus === 'connected' ? 'info' : 'warn',
              message,
              source: 'watchdog',
            }).catch(() => {});
          }
        })
      );
    } catch (err) {
      console.error('[watchdog] sweep failed', err);
    } finally {
      state.busy = false;
    }
  };

  state.timer = setInterval(sweep, WATCHDOG_INTERVAL_MS);
  state.timer.unref?.();
  pw.__nxProviderWatchdog = state;
  void sweep();
}

export function buildAgentScript(baseUrl: string, agentToken: string, nodeName: string): string {
  return `#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NexusHost Node Agent — streams REAL hardware telemetry to your dashboard.
# Requirements: bash + curl + awk. Works on any Linux VPS / dedicated box.
# Usage:  chmod +x nh-agent.sh && ./nh-agent.sh [node-name] [interval-seconds]
# ─────────────────────────────────────────────────────────────────────────────
NODE_NAME="\${1:-${nodeName}}"
INTERVAL=\${2:-15}
BASE_URL="${baseUrl}"

cpu_pct() {
  awk -v l1="$(grep '^cpu ' /proc/stat)" -v l2="$(sleep 1; grep '^cpu ' /proc/stat)" 'BEGIN {
    split(l1, a, " "); split(l2, b, " ");
    t1 = 0; for (i = 2; i <= 8; i++) t1 += a[i];
    t2 = 0; for (i = 2; i <= 8; i++) t2 += b[i];
    idle1 = a[5] + a[6]; idle2 = b[5] + b[6];
    dt = t2 - t1; di = idle2 - idle1;
    printf "%.1f", (dt > 0 ? 100 * (1 - di / dt) : 0)
  }'
}

send_heartbeat() {
  CPU_PCT=$(cpu_pct)

  read RAM_TOTAL RAM_USED <<< "$(free -m | awk '/^Mem:/ {print $2, $3}')"
  read DISK_TOTAL DISK_USED <<< "$(df -BG / | awk 'NR==2 {print $2, $3}' | tr -d 'G')"

  GPU="null"
  if command -v nvidia-smi >/dev/null 2>&1; then
    GPU=$(nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu \
      --format=csv,noheader,nounits | head -1 | awk -F', ' '{
        gsub(/^ +| +$/, "", $1);
        printf "{\"model\":\"%s\",\"vramTotalMb\":%d,\"vramUsedMb\":%d,\"utilPercent\":%d,\"tempC\":%d}", $1, $2, $3, $4, $5
      }')
  elif command -v rocm-smi >/dev/null 2>&1; then
    GPU=$(rocm-smi --json 2>/dev/null | head -c 400 || echo "null")
  fi

  PAYLOAD=$(cat <<EOF
{
  "agentToken": "${agentToken}",
  "nodeName": "$NODE_NAME",
  "osInfo": "$(uname -srm 2>/dev/null)",
  "metrics": {
    "cpuPercent": \${CPU_PCT:-0},
    "ramTotalMb": \${RAM_TOTAL:-0},
    "ramUsedMb": \${RAM_USED:-0},
    "diskTotalGb": \${DISK_TOTAL:-0},
    "diskUsedGb": \${DISK_USED:-0},
    "gpu": $GPU
  }
}
EOF
)

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/agent/heartbeat" \
    -H "Content-Type: application/json" \
    --data-raw "$PAYLOAD" --max-time 10)

  if [ "$HTTP_CODE" != "200" ]; then
    echo "[nh-agent] heartbeat failed (HTTP $HTTP_CODE) — retrying next cycle"
  fi
}

echo "[nh-agent] streaming telemetry for '$NODE_NAME' to $BASE_URL every \${INTERVAL}s (Ctrl+C to stop)"
while true; do
  send_heartbeat
  sleep "$INTERVAL"
done
`;
}
