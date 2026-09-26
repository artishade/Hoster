'use client';

import React, { useState } from 'react';
import { 
  Service, 
  ServiceType 
} from '@/lib/hoster/types';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';
import { 
  Server, 
  Terminal, 
  Cpu, 
  GitBranch, 
  ExternalLink, 
  Zap, 
  Activity, 
  Database, 
  HardDrive, 
  Search, 
  Filter, 
  Play, 
  Square, 
  RefreshCw,
  Clock,
  Sparkles,
  ArrowUpRight
} from 'lucide-react';

interface ServicesListProps {
  services: Service[];
  onSelectService: (service: Service) => void;
  onDeployNew: () => void;
  onToggleServiceStatus: (serviceId: string) => void;
  onOpenMcpInspector: (service: Service) => void;
}

export default function ServicesList({
  services,
  onSelectService,
  onDeployNew,
  onToggleServiceStatus,
  onOpenMcpInspector,
}: ServicesListProps) {
  const [filterType, setFilterType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredServices = services.filter((srv) => {
    const matchesType = filterType === 'all' || srv.type === filterType;
    const matchesSearch = 
      srv.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      srv.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      srv.repoUrl.toLowerCase().includes(searchQuery.toLowerCase()) ||
      srv.customDomains.some((d) => d.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesType && matchesSearch;
  });

  // Calculate cluster aggregate statistics
  const totalRequestsPerMin = services.reduce((acc, s) => acc + (s.metrics?.requestsPerMin || 0), 0);
  const totalGpuServices = services.filter((s) => HARDWARE_SPECS[s.hardwareTier]?.category === 'gpu').length;
  const runningServices = services.filter((s) => s.status === 'running').length;

  return (
    <div className="space-y-6">
      {/* Platform Hero / Key Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Hosted Deployments</span>
            <Server className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-zinc-100">{services.length}</span>
            <span className="text-xs text-emerald-400 font-medium">({runningServices} active)</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">APIs, MCP &amp; Plugins</p>
        </div>

        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>GPU Accelerated Nodes</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-zinc-100">{totalGpuServices}</span>
            <span className="text-xs text-zinc-400 font-mono">H100 &bull; L4</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">CUDA 12.4 + FlashAttn-2</p>
        </div>

        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Aggregated Ingress</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-zinc-100">{totalRequestsPerMin.toLocaleString()}</span>
            <span className="text-xs text-indigo-300 font-mono">req/min</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Average P95: 18ms</p>
        </div>

        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Storage &amp; Data Fabric</span>
            <Database className="w-4 h-4 text-purple-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-zinc-100">pgvector</span>
            <span className="text-xs text-purple-400 font-mono">+ Redis</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">NVMe SSD + Built-in S3</p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-zinc-900/40 p-2.5 rounded-xl border border-zinc-800/80">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {[
            { id: 'all', label: 'All Services' },
            { id: 'mcp', label: 'MCP Servers' },
            { id: 'api', label: 'API Providers' },
            { id: 'plugin', label: 'AI Plugins & Actions' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilterType(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                filterType === tab.id
                  ? 'bg-zinc-800 text-cyan-300 border border-zinc-700 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 sm:max-w-xs">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by repo, domain, name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Services Grid */}
      {filteredServices.length === 0 ? (
        <div className="p-12 text-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40">
          <Server className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-zinc-300">No matching deployments found</h3>
          <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">
            Try adjusting your search query or launch a new API, MCP, or Plugin server from a GitHub repository.
          </p>
          <button
            onClick={onDeployNew}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold"
          >
            Deploy New Service
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredServices.map((srv) => {
            const spec = HARDWARE_SPECS[srv.hardwareTier] || HARDWARE_SPECS['cpu-standard'];
            const isGpu = spec.category === 'gpu';
            const isMcp = srv.type === 'mcp';
            const isPlugin = srv.type === 'plugin';

            return (
              <div
                key={srv.id}
                className="group relative rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900/80 hover:border-zinc-700/80 transition-all p-5 shadow-sm"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  {/* Service Identity & Metadata */}
                  <div className="space-y-2 flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        onClick={() => onSelectService(srv)}
                        className="text-base font-bold text-zinc-100 hover:text-cyan-400 transition text-left flex items-center gap-2"
                      >
                        <span>{srv.name}</span>
                        <ArrowUpRight className="w-3.5 h-3.5 opacity-40 group-hover:opacity-100 text-cyan-400 transition" />
                      </button>

                      {/* Type Badge */}
                      <span
                        className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold border ${
                          isMcp
                            ? 'bg-purple-950/70 text-purple-300 border-purple-800/60'
                            : isPlugin
                            ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800/60'
                            : 'bg-cyan-950/70 text-cyan-300 border-cyan-800/60'
                        }`}
                      >
                        {srv.type === 'mcp' ? 'MCP Server (SSE)' : srv.type === 'plugin' ? 'AI Plugin / OpenAPI' : 'API Provider'}
                      </span>

                      {/* Hardware Spec Badge */}
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded flex items-center gap-1 border ${
                          isGpu
                            ? 'bg-emerald-950/50 text-emerald-300 border-emerald-700/60 font-semibold'
                            : 'bg-zinc-800/80 text-zinc-300 border-zinc-700/50'
                        }`}
                      >
                        {isGpu ? <Cpu className="w-3 h-3 text-emerald-400" /> : <Server className="w-3 h-3 text-zinc-400" />}
                        <span>{spec.gpuModel || spec.name}</span>
                        <span className="text-zinc-500">(${spec.priceHourly}/hr)</span>
                      </span>

                      {/* Status indicator */}
                      <span className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            srv.status === 'running'
                              ? 'bg-emerald-400 animate-pulse'
                              : srv.status === 'deploying'
                              ? 'bg-amber-400 animate-spin'
                              : 'bg-zinc-600'
                          }`}
                        />
                        <span className="text-zinc-300 capitalize">{srv.status}</span>
                      </span>
                    </div>

                    <p className="text-xs text-zinc-400 line-clamp-1">{srv.description}</p>

                    {/* GitHub repo & deployment details */}
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500 font-mono">
                      <div className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200">
                        <GitBranch className="w-3 h-3 text-zinc-500" />
                        <span>{srv.branch}</span>
                        <span className="text-zinc-600">({srv.commitHash})</span>
                      </div>
                      <span className="text-zinc-700">&bull;</span>
                      <div className="flex items-center gap-1 text-zinc-400">
                        <Clock className="w-3 h-3 text-zinc-500" />
                        <span>Deployed {srv.deployedAt}</span>
                      </div>
                      {srv.customDomains.length > 0 && (
                        <>
                          <span className="text-zinc-700">&bull;</span>
                          <span className="text-cyan-400 font-medium">
                            {srv.customDomains[0]}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Live Metrics Snapshot */}
                  <div className="flex items-center gap-3 bg-zinc-950/70 px-4 py-2.5 rounded-lg border border-zinc-800 text-xs font-mono">
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">CPU / RAM</div>
                      <div className="text-zinc-200 font-medium mt-0.5">
                        {srv.metrics.cpuPercent}% &bull; {srv.metrics.ramUsedGb}GB
                      </div>
                    </div>

                    {isGpu && (
                      <div className="border-l border-zinc-800 pl-3">
                        <div className="text-[10px] text-emerald-500 uppercase">GPU VRAM</div>
                        <div className="text-emerald-400 font-medium mt-0.5">
                          {srv.metrics.gpuVramUsedGb !== undefined ? (
                            <>{srv.metrics.gpuVramUsedGb} / {srv.metrics.gpuVramTotalGb}GB ({srv.metrics.gpuUtilPercent}%)</>
                          ) : (
                            <span className="text-zinc-500" title="No discrete GPU detected on the connected host">no GPU on host</span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="border-l border-zinc-800 pl-3">
                      <div className="text-[10px] text-zinc-500 uppercase">Traffic &bull; P95</div>
                      <div className="text-zinc-200 font-medium mt-0.5">
                        {srv.metrics.requestsPerMin} rpm &bull; {srv.metrics.latencyP95Ms}ms
                      </div>
                    </div>

                    {isMcp && srv.metrics.activeMcpClients !== undefined && (
                      <div className="border-l border-zinc-800 pl-3 hidden sm:block">
                        <div className="text-[10px] text-purple-400 uppercase">MCP Clients</div>
                        <div className="text-purple-300 font-medium mt-0.5">
                          {srv.metrics.activeMcpClients} connected
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {isMcp && (
                      <button
                        onClick={() => onOpenMcpInspector(srv)}
                        className="px-3 py-1.5 rounded-lg bg-purple-950/50 hover:bg-purple-900/60 border border-purple-800/60 text-purple-300 text-xs font-medium flex items-center gap-1.5 transition"
                        title="Open interactive MCP tool inspector"
                      >
                        <Terminal className="w-3.5 h-3.5 text-purple-400" />
                        <span>MCP Studio</span>
                      </button>
                    )}

                    <button
                      onClick={() => onSelectService(srv)}
                      className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white text-xs font-medium transition"
                    >
                      Logs &amp; Config
                    </button>

                    <a
                      href={srv.ingressPath}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition ${srv.status !== 'running' ? 'opacity-40' : ''}`}
                      title={srv.status === 'running' ? 'Open live endpoint — served by this control plane (no DNS needed)' : `Endpoint goes live when deployment finishes (status: ${srv.status})`}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>

                {/* Storage & Addon Badges Footer */}
                <div className="mt-3 pt-3 border-t border-zinc-800/50 flex flex-wrap items-center gap-2 text-[10px] font-mono text-zinc-400">
                  {srv.attachedPostgresId && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-purple-300">
                      <Database className="w-2.5 h-2.5" />
                      PostgreSQL + pgvector
                    </span>
                  )}
                  {srv.attachedRedisId && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-rose-300">
                      <Zap className="w-2.5 h-2.5" />
                      Redis Cache
                    </span>
                  )}
                  {srv.volumeMounts.length > 0 && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-cyan-300">
                      <HardDrive className="w-2.5 h-2.5" />
                      NVMe Mount: {srv.volumeMounts[0].mountPath}
                    </span>
                  )}
                  {srv.s3BucketId && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-emerald-300">
                      <HardDrive className="w-2.5 h-2.5" />
                      S3 Weights Vault
                    </span>
                  )}
                  {srv.instances.scaleToZero && (
                    <span className="px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40 ml-auto">
                      Scale-to-Zero Enabled
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
