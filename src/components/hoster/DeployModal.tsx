'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Service, 
  ServiceType, 
  HardwareTier, 
  PostgresDatabase, 
  RedisDatabase, 
  PersistentVolume, 
  S3BucketConfig 
} from '@/lib/hoster/types';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';
import type { HardwareSpec } from '@/lib/hoster/types';
import { 
  X, 
  GitBranch, 
  Github, 
  Cpu, 
  Server, 
  Database, 
  Zap, 
  HardDrive, 
  Check, 
  Globe, 
  Loader2, 
  Terminal, 
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Flame,
  Activity
} from 'lucide-react';

export interface DeployPayload {
  name: string;
  description: string;
  type: ServiceType;
  repoUrl: string;
  branch: string;
  hardwareTier: HardwareTier;
  region: string;
  instances: { min: number; max: number; current: number; scaleToZero: boolean; scaleToZeroDelaySec: number };
  buildCommand: string;
  startCommand: string;
  port?: number;
  protocol: string;
  envVars: { key: string; value: string; isSecret: boolean }[];
  customDomain?: string;
  attachedPostgresId?: string;
  attachedRedisId?: string;
  volumeMounts: { volumeId: string; mountPath: string }[];
  s3BucketId?: string;
}

interface DeployModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDeploy: (payload: DeployPayload) => Promise<{ success: boolean; error?: string; serviceId?: string }>;
  postgresDbs: PostgresDatabase[];
  redisDbs: RedisDatabase[];
  volumes: PersistentVolume[];
  s3Buckets: S3BucketConfig[];
}

export default function DeployModal({
  isOpen,
  onClose,
  onDeploy,
  postgresDbs,
  redisDbs,
  volumes,
  s3Buckets,
}: DeployModalProps) {
  // Step management: 1: Repo & Type, 2: Hardware & GPU, 3: Storage & DBs, 4: Live Build Simulator
  const [step, setStep] = useState<number>(1);

  // Form State
  const [serviceName, setServiceName] = useState('my-ai-mcp-server');
  const [description, setDescription] = useState('High-performance Model Context Protocol server');
  const [serviceType, setServiceType] = useState<ServiceType>('mcp');
  const [repoUrl, setRepoUrl] = useState('https://github.com/anthropic/fastmcp-starter');
  const [branch, setBranch] = useState('main');
  const [hardwareTier, setHardwareTier] = useState<HardwareTier>('gpu-l4');
  const [scaleToZero, setScaleToZero] = useState(true);
  const [scaleToZeroDelay, setScaleToZeroDelay] = useState(300);
  const [minInstances, setMinInstances] = useState(0);
  const [maxInstances, setMaxInstances] = useState(4);
  const [customDomain, setCustomDomain] = useState('');

  // Storage and DB Attachments
  const [attachPostgres, setAttachPostgres] = useState(postgresDbs.length > 0);
  const [selectedPostgresId, setSelectedPostgresId] = useState(postgresDbs[0]?.id || '');
  const [attachRedis, setAttachRedis] = useState(redisDbs.length > 0);
  const [selectedRedisId, setSelectedRedisId] = useState(redisDbs[0]?.id || '');
  const [attachVolume, setAttachVolume] = useState(volumes.length > 0);
  const [volumeMountPath, setVolumeMountPath] = useState('/root/.cache/huggingface');
  const [attachS3, setAttachS3] = useState(s3Buckets.length > 0);
  const [selectedS3Id, setSelectedS3Id] = useState(s3Buckets[0]?.id || '');

  // Live Deploy Simulation
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployFailed, setDeployFailed] = useState(false);
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [buildProgress, setBuildProgress] = useState(0);

  // REAL server-measured tier specs (falls back to the static import client-side)
  const [liveSpecs, setLiveSpecs] = useState<Record<string, HardwareSpec> | null>(null);
  useEffect(() => {
    if (!isOpen || liveSpecs) return;
    let cancelled = false;
    fetch('/api/hardware-specs', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json?.data?.specs) return;
        const map: Record<string, HardwareSpec> = {};
        for (const spec of json.data.specs as HardwareSpec[]) map[spec.id] = spec;
        setLiveSpecs(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, liveSpecs]);
  const specFor = (id: HardwareTier): HardwareSpec => (liveSpecs?.[id] ?? HARDWARE_SPECS[id]) as HardwareSpec;

  if (!isOpen) return null;

  // Presets
  const applyPreset = (presetKey: string) => {
    if (presetKey === 'fastmcp') {
      setServiceName('fastmcp-tools-cluster');
      setDescription('Python FastMCP tool server with SSE transport for Claude Desktop & Cursor');
      setServiceType('mcp');
      setRepoUrl('https://github.com/jlowin/fastmcp-example');
      setHardwareTier('gpu-l4');
      setAttachPostgres(true);
      setAttachRedis(true);
      setAttachVolume(true);
      setVolumeMountPath('/root/.cache/huggingface');
    } else if (presetKey === 'vllm') {
      setServiceName('deepseek-vllm-engine');
      setDescription('Ultra-throughput AI inference engine on NVIDIA H100 with FlashAttention-2');
      setServiceType('api');
      setRepoUrl('https://github.com/vllm-project/vllm');
      setHardwareTier('gpu-h100-80gb');
      setScaleToZero(false);
      setMinInstances(1);
      setMaxInstances(8);
      setAttachVolume(true);
      setVolumeMountPath('/models/deepseek-weights');
    } else if (presetKey === 'plugin') {
      setServiceName('chatgpt-enterprise-plugin');
      setDescription('OpenAPI 3.1 action server with .well-known/ai-plugin.json manifest');
      setServiceType('plugin');
      setRepoUrl('https://github.com/openai/plugins-quickstart');
      setHardwareTier('cpu-standard');
      setAttachPostgres(true);
      setAttachRedis(false);
    } else if (presetKey === 'free-hf') {
      setServiceName('hf-fastmcp-space');
      setDescription('100% Free Hugging Face Space with 16GB RAM + ZeroGPU T4 FastMCP server');
      setServiceType('mcp');
      setRepoUrl('https://github.com/huggingface/mcp-server-demo');
      setHardwareTier('free-hf-space');
      setAttachPostgres(false);
      setAttachRedis(false);
      setAttachVolume(false);
    } else if (presetKey === 'free-render') {
      setServiceName('render-free-api');
      setDescription('Render.com Free Web Service with 512MB RAM + free managed DBs');
      setServiceType('api');
      setRepoUrl('https://github.com/render-examples/fastapi-hello-world');
      setHardwareTier('free-render');
      setAttachPostgres(true);
      setAttachRedis(true);
    }
  };

  const handleStartDeployment = async () => {
    setIsDeploying(true);
    setDeployFailed(false);
    setStep(4);
    setBuildLogs([]);
    setBuildProgress(5);

    const push = (msg: string, progress: number) => {
      setBuildLogs((prev) => [...prev, msg]);
      setBuildProgress((prev) => Math.max(prev, progress));
    };

    push(`[1/5] Handing off to the REAL deployer — git clone → install → build → run.`, 10);
    push(`[2/5] Workload: ${serviceType.toUpperCase()} on tier "${HARDWARE_SPECS[hardwareTier]?.name ?? hardwareTier}"${repoUrl.trim() ? '' : ' (no repo — the interactive builtin runner will boot)'}.`, 20);

    const payload: DeployPayload = {
      name: serviceName.trim(),
      description: description.trim(),
      type: serviceType,
      repoUrl: repoUrl.trim(),
      branch,
      hardwareTier,
      region: 'us-east-va (N. Virginia)',
      instances: {
        min: minInstances,
        max: maxInstances,
        current: minInstances > 0 ? minInstances : 1,
        scaleToZero,
        scaleToZeroDelaySec: scaleToZeroDelay,
      },
      // leave build/start empty → the deployer AUTO-DETECTS the stack from the repo
      buildCommand: '',
      startCommand: '',
      port: undefined,
      protocol: serviceType === 'mcp' ? 'sse' : 'http',
      envVars: [
        { key: 'ENV', value: 'production', isSecret: false },
      ],
      customDomain: customDomain.trim() || undefined,
      attachedPostgresId: attachPostgres ? selectedPostgresId || undefined : undefined,
      attachedRedisId: attachRedis ? selectedRedisId || undefined : undefined,
      volumeMounts: attachVolume ? [{ volumeId: '', mountPath: volumeMountPath }] : [],
      s3BucketId: attachS3 ? selectedS3Id || undefined : undefined,
    };

    if (payload.repoUrl) push(`[3/5] git clone ${payload.repoUrl} (branch: ${branch}, depth 1) — real clone starting on the host...`, 32);

    const result = await onDeploy(payload);

    if (!result.success || !result.serviceId) {
      push(`✖ DEPLOY FAILED: ${result.error || 'The control plane rejected the deployment.'}`, 100);
      setDeployFailed(true);
      setIsDeploying(false);
      return;
    }

    push(`[4/5] Build queued on the orchestrator (service id ${result.serviceId.slice(-8)}). Streaming live build logs...`, 55);

    // Stream REAL build logs + status from the control plane until the service is live.
    const startedAt = Date.now();
    const seenLogIds = new Set<string>();
    let closed = false;

    const poll = async () => {
      try {
        const [svcRes, logRes] = await Promise.all([
          fetch(`/api/services/${result.serviceId}`),
          fetch(`/api/logs?serviceId=${result.serviceId}&limit=60`),
        ]);
        const svcJson = await svcRes.json();
        const logJson = await logRes.json();
        const svc = svcJson?.data;
        const logs: Array<{ id: string; message: string; source?: string }> = logJson?.data ?? [];

        for (const entry of logs.reverse()) {
          if (!seenLogIds.has(entry.id)) {
            seenLogIds.add(entry.id);
            push(`${entry.message}`, Math.min(92, 55 + seenLogIds.size * 6));
          }
        }

        if (svc) {
          if (svc.status === 'running' && !closed) {
            closed = true;
            push(`🚀 SUCCESS: "${svc.name}" is LIVE — real process pid ${svc.runtime?.pid ?? '?'} on port ${svc.runtime?.port ?? '?'}. Ingress: ${svc.ingressPath} · host route: ${svc.name}.nexushost.dev`, 100);
            setTimeout(() => {
              onClose();
            }, 1600);
            return;
          }
          if (svc.status === 'failed' && !closed) {
            closed = true;
            push(`✖ DEPLOY FAILED — the real build/run pipeline exited non-zero. Check the service logs for the exact stderr.`, 100);
            setDeployFailed(true);
            setIsDeploying(false);
            return;
          }
          const elapsed = (Date.now() - startedAt) / 1000;
          if (elapsed > 240 && !closed) {
            closed = true;
            push(`⚠ Deployment is taking longer than expected (status: ${svc.status}). You can follow it in the service logs view.`, 100);
            setTimeout(() => onClose(), 1800);
            return;
          }
        }
        setTimeout(poll, 1500);
      } catch {
        if (!closed) setTimeout(poll, 2500);
      }
    };

    setTimeout(poll, 1200);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl rounded-2xl bg-zinc-950 border border-zinc-800 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-6 py-4 bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <Github className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100">
                Deploy New Service from GitHub
              </h2>
              <p className="text-xs text-zinc-400">
                Automated CI/CD, GPU acceleration, PostgreSQL pgvector &amp; Redis provisioning
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isDeploying}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator */}
        {!isDeploying && (
          <div className="grid grid-cols-3 border-b border-zinc-800 text-xs font-medium">
            <button
              onClick={() => setStep(1)}
              className={`py-3 px-4 text-center border-b-2 transition ${
                step === 1 ? 'border-cyan-400 text-cyan-300 bg-cyan-950/20' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              1. Source &amp; Workload
            </button>
            <button
              onClick={() => setStep(2)}
              className={`py-3 px-4 text-center border-b-2 transition ${
                step === 2 ? 'border-cyan-400 text-cyan-300 bg-cyan-950/20' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              2. GPU &amp; Hardware Tier
            </button>
            <button
              onClick={() => setStep(3)}
              className={`py-3 px-4 text-center border-b-2 transition ${
                step === 3 ? 'border-cyan-400 text-cyan-300 bg-cyan-950/20' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              3. Databases &amp; Storage
            </button>
          </div>
        )}

        {/* Body Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* STEP 1: Repository & Presets */}
          {step === 1 && !isDeploying && (
            <div className="space-y-6">
              {/* Presets */}
              <div>
                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider block mb-2 font-mono">
                  Quick-Start Starter Blueprints:
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => applyPreset('fastmcp')}
                    className="p-3 text-left rounded-xl border border-purple-800/60 bg-purple-950/20 hover:bg-purple-950/40 transition group"
                  >
                    <div className="flex items-center gap-2 text-purple-300 font-semibold text-xs">
                      <Terminal className="w-4 h-4" />
                      <span>FastMCP Server</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      SSE Protocol, Claude Desktop &amp; Cursor support, NVIDIA L4 GPU.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPreset('vllm')}
                    className="p-3 text-left rounded-xl border border-emerald-800/60 bg-emerald-950/20 hover:bg-emerald-950/40 transition group"
                  >
                    <div className="flex items-center gap-2 text-emerald-300 font-semibold text-xs">
                      <Flame className="w-4 h-4" />
                      <span>vLLM AI Engine</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      High-throughput LLM serving, NVIDIA H100 80GB SXM5 + NVMe cache.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPreset('plugin')}
                    className="p-3 text-left rounded-xl border border-cyan-800/60 bg-cyan-950/20 hover:bg-cyan-950/40 transition group"
                  >
                    <div className="flex items-center gap-2 text-cyan-300 font-semibold text-xs">
                      <Sparkles className="w-4 h-4" />
                      <span>AI Plugin / Action</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      ChatGPT Actions, OpenAPI 3.1 &amp; .well-known/ai-plugin.json.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPreset('free-hf')}
                    className="p-3 text-left rounded-xl border border-amber-800/60 bg-amber-950/20 hover:bg-amber-950/40 transition group"
                  >
                    <div className="flex items-center gap-2 text-amber-300 font-semibold text-xs">
                      <Zap className="w-4 h-4" />
                      <span>HF Free 16GB MCP</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      100% Free Hugging Face Space, 16GB RAM + ZeroGPU T4 quota.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyPreset('free-render')}
                    className="p-3 text-left rounded-xl border border-blue-800/60 bg-blue-950/20 hover:bg-blue-950/40 transition group"
                  >
                    <div className="flex items-center gap-2 text-blue-300 font-semibold text-xs">
                      <Server className="w-4 h-4" />
                      <span>Render Free Service</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Render.com free tier, 512MB RAM + Free PostgreSQL &amp; Redis.
                    </p>
                  </button>
                </div>
              </div>

              {/* Service Type Selection */}
              <div>
                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider block mb-2 font-mono">
                  Hosting Protocol &amp; Service Type
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { id: 'mcp', label: 'MCP Server', desc: 'Model Context Protocol (SSE/stdio) for Claude & Cursor tools' },
                    { id: 'api', label: 'API Provider', desc: 'REST / GraphQL / vLLM OpenAI-compatible endpoint' },
                    { id: 'plugin', label: 'AI Plugin', desc: 'ChatGPT Actions & OpenAPI 3.1 schema endpoint' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setServiceType(t.id as ServiceType)}
                      className={`p-3 rounded-xl border text-left transition ${
                        serviceType === t.id
                          ? 'border-cyan-500 bg-cyan-950/30 text-white'
                          : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700'
                      }`}
                    >
                      <div className="text-xs font-bold text-zinc-200">{t.label}</div>
                      <div className="text-[11px] text-zinc-400 mt-1">{t.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* GitHub Details */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Service Name (Subdomain)
                  </label>
                  <div className="flex items-center">
                    <input
                      type="text"
                      value={serviceName}
                      onChange={(e) => setServiceName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-l-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                    />
                    <span className="bg-zinc-800 border-y border-r border-zinc-700 px-3 py-2 text-xs text-zinc-400 font-mono rounded-r-lg">
                      .nexushost.dev
                    </span>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-300 block mb-1.5">
                    GitHub Repository URL
                  </label>
                  <div className="relative">
                    <Github className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/org/repo"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Branch to Track &amp; Auto-Deploy
                  </label>
                  <div className="relative">
                    <GitBranch className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Custom Domain (Optional)
                  </label>
                  <div className="relative">
                    <Globe className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={customDomain}
                      onChange={(e) => setCustomDomain(e.target.value)}
                      placeholder="api.yourdomain.com"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: Hardware Tier & GPU Acceleration */}
          {step === 2 && !isDeploying && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider block font-mono">
                    Select Server &amp; GPU Tier (Optimized for AI Workloads)
                  </label>
                  <span className="text-[11px] text-cyan-400 font-mono">
                    Includes Pre-warmed CUDA 12.4 &amp; FlashAttention-2
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {Object.values(HARDWARE_SPECS).map((rawSpec) => {
                    const spec = specFor(rawSpec.id);
                    const isGpu = spec.category === 'gpu';
                    const isSelected = hardwareTier === spec.id;
                    const isFree = spec.priceHourly === 0;
                    const isMeasured = !!liveSpecs?.[spec.id] && (spec.id === 'free-blitz' || spec.id === 'local-node');

                    return (
                      <button
                        key={spec.id}
                        type="button"
                        onClick={() => setHardwareTier(spec.id)}
                        className={`p-3.5 rounded-xl border text-left transition flex flex-col justify-between ${
                          isSelected
                            ? 'border-cyan-400 bg-cyan-950/30 ring-1 ring-cyan-400 shadow-md'
                            : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                        } ${isFree ? 'ring-1 ring-emerald-800/50' : ''}`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-zinc-100 flex items-center gap-1.5 min-w-0">
                              {isGpu ? (
                                <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
                              ) : (
                                <Server className="w-4 h-4 text-zinc-400 shrink-0" />
                              )}
                              <span className="truncate">{spec.name}</span>
                              {isFree && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/70 text-emerald-400 border border-emerald-800/60 shrink-0">
                                  FREE
                                </span>
                              )}
                            </span>
                            <span className={`text-xs font-mono font-bold shrink-0 ${isFree ? 'text-emerald-400' : 'text-cyan-300'}`}>
                              {isFree ? '$0' : `$${spec.priceHourly}`}/hr
                            </span>
                          </div>

                          <p className="text-[11px] text-zinc-400 font-mono mt-1 flex items-center gap-1.5 flex-wrap">
                            {isMeasured && (
                              <span className="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-950/70 text-cyan-300 border border-cyan-800/60">
                                <Activity className="w-2.5 h-2.5" />
                                measured live
                              </span>
                            )}
                            {spec.description}
                          </p>
                        </div>

                        <div className="mt-3 pt-2 border-t border-zinc-800/80 text-[10px] text-zinc-400 flex items-center justify-between">
                          <span className="truncate">Best for: {spec.recommendedFor}</span>
                          {isSelected && <Check className="w-3.5 h-3.5 text-cyan-400 ml-2 shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Scaling Settings */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-bold text-zinc-200">Scale-to-Zero on Idle</h4>
                    <p className="text-[11px] text-zinc-400">
                      Automatically suspend idle GPU nodes to reduce hosting costs. Wakes up in ~800ms upon incoming request.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={scaleToZero}
                    onChange={(e) => setScaleToZero(e.target.checked)}
                    className="w-4 h-4 accent-cyan-500 rounded cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3 pt-2 text-xs font-mono">
                  <div>
                    <label className="text-zinc-400 block mb-1 text-[11px]">Min Instances</label>
                    <input
                      type="number"
                      min={0}
                      max={4}
                      value={minInstances}
                      onChange={(e) => setMinInstances(parseInt(e.target.value) || 0)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-zinc-200"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 block mb-1 text-[11px]">Max Instances</label>
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={maxInstances}
                      onChange={(e) => setMaxInstances(parseInt(e.target.value) || 1)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-zinc-200"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 block mb-1 text-[11px]">Idle Timeout (sec)</label>
                    <input
                      type="number"
                      min={60}
                      max={3600}
                      value={scaleToZeroDelay}
                      onChange={(e) => setScaleToZeroDelay(parseInt(e.target.value) || 300)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-zinc-200"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Databases & Storage */}
          {step === 3 && !isDeploying && (
            <div className="space-y-5">
              {/* 1-Click PostgreSQL with pgvector */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-purple-950/60 text-purple-400 border border-purple-800/60">
                      <Database className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-zinc-200">
                        PostgreSQL with pgvector for AI Embeddings
                      </h4>
                      <p className="text-[11px] text-zinc-400">
                        Automatically injects POSTGRES_URL &amp; DATABASE_URL environment variables.
                      </p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={attachPostgres}
                    onChange={(e) => setAttachPostgres(e.target.checked)}
                    className="w-4 h-4 accent-purple-500 rounded cursor-pointer"
                  />
                </div>

                {attachPostgres && (
                  <div className="pt-2 pl-10">
                    <label className="text-[11px] text-zinc-400 block mb-1 font-mono">
                      Select PostgreSQL Cluster:
                    </label>
                    <select
                      value={selectedPostgresId}
                      onChange={(e) => setSelectedPostgresId(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-purple-500"
                    >
                      {postgresDbs.map((db) => (
                        <option key={db.id} value={db.id}>
                          {db.name} ({db.version}) &bull; {db.usedStorageGb}/{db.storageGb}GB
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* 1-Click Redis Provisioning */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-rose-950/60 text-rose-400 border border-rose-800/60">
                      <Zap className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-zinc-200">
                        Redis Cache &amp; PubSub Queue
                      </h4>
                      <p className="text-[11px] text-zinc-400">
                        In-memory session cache, rate-limiting, and async task message queue.
                      </p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={attachRedis}
                    onChange={(e) => setAttachRedis(e.target.checked)}
                    className="w-4 h-4 accent-rose-500 rounded cursor-pointer"
                  />
                </div>

                {attachRedis && (
                  <div className="pt-2 pl-10">
                    <label className="text-[11px] text-zinc-400 block mb-1 font-mono">
                      Select Redis Cluster:
                    </label>
                    <select
                      value={selectedRedisId}
                      onChange={(e) => setSelectedRedisId(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-rose-500"
                    >
                      {redisDbs.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} &bull; {r.usedMemoryMb}/{r.memoryLimitMb}MB ({r.evictionPolicy})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Persistent NVMe Volume Mount */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-cyan-950/60 text-cyan-400 border border-cyan-800/60">
                      <HardDrive className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-zinc-200">
                        Persistent NVMe SSD Volume Mount (Model Weights &amp; State)
                      </h4>
                      <p className="text-[11px] text-zinc-400">
                        Preserves HuggingFace model cache across restarts so you never re-download weights.
                      </p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={attachVolume}
                    onChange={(e) => setAttachVolume(e.target.checked)}
                    className="w-4 h-4 accent-cyan-500 rounded cursor-pointer"
                  />
                </div>

                {attachVolume && (
                  <div className="pt-2 pl-10">
                    <label className="text-[11px] text-zinc-400 block mb-1 font-mono">
                      Mount Path inside Container:
                    </label>
                    <input
                      type="text"
                      value={volumeMountPath}
                      onChange={(e) => setVolumeMountPath(e.target.value)}
                      placeholder="/root/.cache/huggingface or /data"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                )}
              </div>

              {/* S3 Bucket Integration */}
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-emerald-950/60 text-emerald-400 border border-emerald-800/60">
                      <Globe className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-zinc-200">
                        Custom S3 Bucket or Free Built-in Object Storage
                      </h4>
                      <p className="text-[11px] text-zinc-400">
                        AWS S3, Cloudflare R2 (zero egress fees), or Built-in Render-compatible storage.
                      </p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={attachS3}
                    onChange={(e) => setAttachS3(e.target.checked)}
                    className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
                  />
                </div>

                {attachS3 && (
                  <div className="pt-2 pl-10">
                    <label className="text-[11px] text-zinc-400 block mb-1 font-mono">
                      Target S3 Bucket:
                    </label>
                    <select
                      value={selectedS3Id}
                      onChange={(e) => setSelectedS3Id(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-emerald-500"
                    >
                      {s3Buckets.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.provider}) &bull; {b.bucketName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 4: Live Build & Deploy Terminal (streams REAL control-plane logs) */}
          {(isDeploying || deployFailed) && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Provisioning high-config node &amp; building container...</span>
                </div>
                <span className="text-xs font-mono text-zinc-400">{buildProgress}%</span>
              </div>

              {/* Progress bar */}
              <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300"
                  style={{ width: `${buildProgress}%` }}
                />
              </div>

              {/* Terminal Logs Window */}
              <div className="p-4 rounded-xl bg-black border border-zinc-800 font-mono text-xs text-zinc-300 h-64 overflow-y-auto space-y-1.5 shadow-inner">
                {buildLogs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`leading-relaxed ${
                      log.includes('SUCCESS')
                        ? 'text-emerald-400 font-bold'
                        : log.includes('CUDA')
                        ? 'text-cyan-300'
                        : 'text-zinc-400'
                    }`}
                  >
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        {!isDeploying && (
          <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4 bg-zinc-900/50">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition"
              >
                Back
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-3">
              {step < 3 ? (
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition"
                >
                  <span>Continue</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartDeployment}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 via-indigo-600 to-emerald-500 hover:from-cyan-400 hover:via-indigo-500 hover:to-emerald-400 text-white text-xs font-bold shadow-lg shadow-cyan-950/60 transition"
                >
                  <Cpu className="w-4 h-4" />
                  <span>Launch Deployment</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
