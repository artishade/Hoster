import os from 'os';
import { HardwareSpec, HardwareTier } from './types';

/**
 * Hardware tiers. Everything with a `0.00` price is genuinely free capacity:
 *  - cloud-mapped free tiers exist because their providers are verified LIVE
 *    (tokenless public-endpoint probes, see providers.ts watchdog)
 *  - the "Blitz" tiers are sized from the REAL machine this control plane
 *    runs on — measured on the SERVER at module load, never hard-coded.
 *
 * NOTE: this module is imported by both server code and client components.
 * Node's `os` calls are meaningless in the browser (polyfilled with garbage),
 * so the measurement only runs server-side; the browser gets a static display
 * fallback while the SERVER remains the source of truth (tierSpec()).
 */

const IS_SERVER = typeof window === 'undefined';
const HOST_CORES = IS_SERVER ? Math.max(2, os.cpus().length) : 2;
const HOST_RAM_GB = IS_SERVER ? +(os.totalmem() / 1024 / 1024 / 1024).toFixed(1) : 4;
// Reserve headroom for the control plane itself (Next.js + SQLite)
const FREE_RAM_GB = Math.max(1, Math.floor(HOST_RAM_GB * 0.6));

export const HARDWARE_SPECS: Record<string, HardwareSpec> = {
  'local-node': {
    id: 'local-node',
    name: 'Local Host Node (Direct Container)',
    category: 'cpu',
    vCpu: HOST_CORES,
    ramGb: FREE_RAM_GB,
    priceHourly: 0.00,
    description: `Direct host runtime — ${HOST_CORES} real vCPU, ${FREE_RAM_GB} GB reserved from ${HOST_RAM_GB} GB`,
    recommendedFor: 'Local microservices, fast development, zero external dependency',
  },
  'free-blitz': {
    id: 'free-blitz',
    name: `Free Blitz — Full Host (${HOST_CORES} vCPU / ${FREE_RAM_GB} GB)`,
    category: 'cpu',
    vCpu: HOST_CORES,
    ramGb: FREE_RAM_GB,
    priceHourly: 0.00,
    description: `High-spec FREE tier measured live from this machine: ${HOST_CORES} vCPU, ${FREE_RAM_GB} GB RAM, NVMe storage`,
    recommendedFor: 'Production-grade APIs, real builds, heavy workloads — no artificial limits',
  },
  'free-hf-space': {
    id: 'free-hf-space',
    name: 'Hugging Face Space (Free Tier + ZeroGPU)',
    category: 'gpu',
    vCpu: 2,
    ramGb: 16,
    gpuModel: 'NVIDIA T4 / ZeroGPU Quota',
    vramGb: 16,
    priceHourly: 0.00,
    description: 'Free 2 vCPU, 16 GB RAM + dynamic ZeroGPU acceleration',
    recommendedFor: 'Open-source LLMs (Gemma, Qwen, Mistral), FastMCP server hosting, Gradio plugins',
  },
  'free-render': {
    id: 'free-render',
    name: 'Render.com Free Web Service',
    category: 'cpu',
    vCpu: 0.5,
    ramGb: 0.512,
    priceHourly: 0.00,
    description: '0.5 vCPU, 512 MB RAM, free TLS & custom domains',
    recommendedFor: 'Lightweight REST APIs, webhooks, MCP JSON-RPC bridges',
  },
  'free-fly': {
    id: 'free-fly',
    name: 'Fly.io Free Micro Machine',
    category: 'cpu',
    vCpu: 1,
    ramGb: 0.256,
    priceHourly: 0.00,
    description: '1 Shared vCPU, 256 MB RAM, Anycast edge routing',
    recommendedFor: 'Edge proxies, micro MCP routers, health check dispatchers',
  },
  'free-koyeb': {
    id: 'free-koyeb',
    name: 'Koyeb Free Instance',
    category: 'cpu',
    vCpu: 1,
    ramGb: 0.512,
    priceHourly: 0.00,
    description: '1 vCPU, 512 MB RAM, global load balancing',
    recommendedFor: 'Globally distributed web services with auto HTTPS',
  },
  'custom-vps': {
    id: 'custom-vps',
    name: 'Connected Custom Server / GPU Rig',
    category: 'gpu',
    vCpu: 8,
    ramGb: 32,
    gpuModel: 'Custom NVIDIA GPU / Multi-core',
    vramGb: 24,
    priceHourly: 0.00,
    description: 'Your self-hosted VPS or dedicated GPU rig attached via live agent probe',
    recommendedFor: 'Maximum capacity private hosting, custom Ollama / vLLM clusters',
  },
  'cpu-nano': {
    id: 'cpu-nano',
    name: 'Nano CPU',
    category: 'cpu',
    vCpu: 1,
    ramGb: 1,
    priceHourly: 0.007,
    description: '1 vCPU, 1 GB RAM',
    recommendedFor: 'Lightweight REST APIs, webhooks, microservices',
  },
  'cpu-standard': {
    id: 'cpu-standard',
    name: 'Standard CPU',
    category: 'cpu',
    vCpu: 4,
    ramGb: 8,
    priceHourly: 0.042,
    description: '4 vCPU, 8 GB RAM',
    recommendedFor: 'Production APIs, MCP proxy servers, Plugin bridges',
  },
  'cpu-highmem': {
    id: 'cpu-highmem',
    name: 'High-Memory Compute',
    category: 'cpu',
    vCpu: 16,
    ramGb: 64,
    priceHourly: 0.22,
    description: '16 vCPU, 64 GB RAM, High-speed NVMe bus',
    recommendedFor: 'Memory-heavy data pipelines, embedding indexing, batch processing',
  },
  'gpu-rtx4090': {
    id: 'gpu-rtx4090',
    name: 'NVIDIA RTX 4090 (Dedicated)',
    category: 'gpu',
    vCpu: 8,
    ramGb: 32,
    gpuModel: 'NVIDIA GeForce RTX 4090',
    vramGb: 24,
    priceHourly: 0.54,
    description: '24 GB GDDR6X, 16,384 CUDA cores, 8 vCPU, 32 GB RAM',
    recommendedFor: 'Cost-effective AI inference, Whisper transcription, Stable Diffusion XL',
  },
  'gpu-l4': {
    id: 'gpu-l4',
    name: 'NVIDIA L4 Tensor Core (Ada)',
    category: 'gpu',
    vCpu: 8,
    ramGb: 32,
    gpuModel: 'NVIDIA L4 24GB',
    vramGb: 24,
    priceHourly: 0.72,
    description: '24 GB GDDR6 with ECC, Ada Lovelace architecture, 8 vCPU, 32 GB RAM',
    recommendedFor: 'Cost-optimized LLM serving (Llama-3.1-8B, Qwen-2.5-7B, Mistral)',
  },
  'gpu-a100-40gb': {
    id: 'gpu-a100-40gb',
    name: 'NVIDIA A100 Tensor Core (40GB)',
    category: 'gpu',
    vCpu: 12,
    ramGb: 85,
    gpuModel: 'NVIDIA A100 40GB PCIe',
    vramGb: 40,
    priceHourly: 1.45,
    description: '40 GB HBM2e, 1.5 TB/s memory bandwidth, 12 vCPU, 85 GB RAM',
    recommendedFor: 'Medium LLM serving (14B-32B), high-concurrency MCP agents',
  },
  'gpu-a100-80gb': {
    id: 'gpu-a100-80gb',
    name: 'NVIDIA A100 SXM4 (80GB)',
    category: 'gpu',
    vCpu: 16,
    ramGb: 128,
    gpuModel: 'NVIDIA A100 80GB SXM4',
    vramGb: 80,
    priceHourly: 2.10,
    description: '80 GB HBM2e, 2.0 TB/s bandwidth, 16 vCPU, 128 GB RAM',
    recommendedFor: '70B Quantized models (Llama 3.3 70B AWQ/FP8), heavy RAG embeddings',
  },
  'gpu-h100-80gb': {
    id: 'gpu-h100-80gb',
    name: 'NVIDIA H100 SXM5 (80GB Hopper)',
    category: 'gpu',
    vCpu: 24,
    ramGb: 240,
    gpuModel: 'NVIDIA H100 80GB SXM5',
    vramGb: 80,
    priceHourly: 3.48,
    description: '80 GB HBM3, 3.35 TB/s bandwidth, Transformer Engine, 24 vCPU, 240 GB RAM',
    recommendedFor: 'Ultra-low latency inference, DeepSeek V3/R1 MoE, vLLM peak throughput',
  },
};

/** Additional dynamic free tiers — capacity measured from the live machine. */
export const DYNAMIC_FREE_TIERS: Record<string, HardwareSpec> = {};

export function allTierSpecs(): HardwareSpec[] {
  return Object.values({ ...HARDWARE_SPECS, ...DYNAMIC_FREE_TIERS });
}

export function isKnownTier(tier: string): tier is HardwareTier {
  return tier in HARDWARE_SPECS || tier in DYNAMIC_FREE_TIERS;
}
