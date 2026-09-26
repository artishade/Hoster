'use client';

import React, { useState } from 'react';
import { 
  Sparkles, 
  X, 
  Cpu, 
  HardDrive, 
  Database, 
  DollarSign, 
  Code, 
  RefreshCw, 
  Check, 
  Copy, 
  Layers,
  MapPin,
  AlertCircle,
  ArrowRight
} from 'lucide-react';
import { HARDWARE_SPECS } from '@/lib/hoster/hardware-specs';

interface AiAdvisorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyRecommendation?: (tier: string) => void;
}

/** Shape of the `data` envelope returned by POST /api/advisor. */
interface AdvisorRecommendation {
  summary: string;
  recommendedTier: string;
  recommendedRegion?: string;
  rationale: string[];
  explanation?: string;
  volumeRecommendation?: string;
  databaseRecommendation?: string;
  dockerfileSnippet?: string;
  scaleToZeroAdvice?: string;
  estimatedMonthlyCostUsd?: number;
}

export default function AiArchitectureAdvisorModal({
  isOpen,
  onClose,
  onApplyRecommendation,
}: AiAdvisorModalProps) {
  const [workload, setWorkload] = useState(
    'Host a DeepSeek-R1-Distill-Llama-70B model with FastMCP for Claude Desktop, using vLLM inference and an enterprise knowledge base with pgvector.'
  );
  const [serviceType, setServiceType] = useState('mcp');
  const [traffic, setTraffic] = useState('Medium production (~1,000 req/min, 20 concurrent MCP streams)');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AdvisorRecommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  if (!isOpen) return null;

  const handleAnalyze = async () => {
    setIsLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workloadDescription: workload,
          serviceType,
          targetTraffic: traffic,
        }),
      });

      const json: { data?: AdvisorRecommendation; error?: string } = await res.json();
      if (!res.ok || json?.error) {
        setError(json?.error || `Advisor request failed (HTTP ${res.status})`);
      } else if (json.data) {
        setResult(json.data);
      } else {
        setError('The advisor returned an empty recommendation. Try rephrasing your workload.');
      }
    } catch (err) {
      setError((err as Error).message || 'Advisor request failed — check your connection and retry.');
    } finally {
      setIsLoading(false);
    }
  };

  const copySnippet = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const recSpec = result ? HARDWARE_SPECS[result.recommendedTier] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl rounded-2xl bg-zinc-950 border border-zinc-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4 bg-gradient-to-r from-indigo-950/40 to-zinc-900/40">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-950/80 border border-indigo-700/60 text-indigo-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100">
                AI Infrastructure &amp; GPU Sizing Advisor
              </h2>
              <p className="text-xs text-zinc-400">
                Calculate precise VRAM, compute requirements, and storage architecture for your AI workload
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Workload Input */}
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-zinc-300 block mb-1 font-mono uppercase">
                Describe Your AI Workload / Models:
              </label>
              <textarea
                rows={3}
                value={workload}
                onChange={(e) => setWorkload(e.target.value)}
                placeholder="e.g. Qwen 2.5 32B model, FastMCP tool execution, 20 tools, pgvector embeddings..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 font-sans"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="text-zinc-400 block mb-1 font-mono">Service Type</label>
                <select
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-200 font-mono"
                >
                  <option value="mcp">MCP Server (Model Context Protocol)</option>
                  <option value="api">API Provider (vLLM / REST / WS)</option>
                  <option value="plugin">AI Plugin / ChatGPT Action</option>
                </select>
              </div>

              <div>
                <label className="text-zinc-400 block mb-1 font-mono">Target Traffic Load</label>
                <input
                  type="text"
                  value={traffic}
                  onChange={(e) => setTraffic(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-200 font-mono"
                />
              </div>
            </div>

            <button
              onClick={handleAnalyze}
              disabled={isLoading}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition disabled:opacity-50 shadow-md shadow-indigo-950/50"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Calculating GPU VRAM &amp; Server Architecture...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Calculate Optimal Server Tier &amp; Config</span>
                </>
              )}
            </button>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-rose-300 block">Advisor request failed</span>
                  <p className="text-[11px] font-mono text-rose-200/80 break-all">{error}</p>
                </div>
              </div>
              <button
                onClick={handleAnalyze}
                disabled={isLoading}
                className="flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                <span>Retry</span>
              </button>
            </div>
          )}

          {/* Results Output */}
          {result && (
            <div className="space-y-4 pt-4 border-t border-zinc-800 animate-in fade-in duration-200">
              {/* Recommendation Banner */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-indigo-950/40 via-cyan-950/30 to-emerald-950/30 border border-indigo-700/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-indigo-400 uppercase font-semibold">
                    Recommended Server Tier:
                  </span>
                  <div className="flex items-center gap-3">
                    {typeof result.estimatedMonthlyCostUsd === 'number' && (
                      <span className="text-xs font-mono font-bold text-emerald-300 flex items-center gap-1">
                        <DollarSign className="w-3 h-3" />
                        ~${Math.abs(Math.round(result.estimatedMonthlyCostUsd)).toLocaleString()}/mo
                      </span>
                    )}
                    {recSpec && (
                      <span className="text-xs font-mono font-bold text-cyan-300">
                        ${recSpec.priceHourly}/hr
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-lg font-bold text-zinc-100">
                  <Cpu className="w-5 h-5 text-emerald-400" />
                  <span>{recSpec?.name || result.recommendedTier}</span>
                </div>

                {result.recommendedRegion && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900/80 border border-zinc-700 text-zinc-300">
                    <MapPin className="w-3 h-3 text-cyan-400" />
                    Region: {result.recommendedRegion}
                  </span>
                )}

                <p className="text-xs text-zinc-200 leading-relaxed font-sans">
                  {result.summary}
                </p>

                {result.explanation && (
                  <p className="text-xs text-zinc-400 leading-relaxed font-sans border-t border-zinc-800/60 pt-2">
                    {result.explanation}
                  </p>
                )}
              </div>

              {/* Rationale bullets */}
              {result.rationale.length > 0 && (
                <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2">
                  <span className="text-[11px] font-mono text-zinc-400 uppercase font-semibold flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-indigo-400" />
                    Sizing Rationale
                  </span>
                  <ul className="space-y-1.5">
                    {result.rationale.map((reason, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-zinc-300">
                        <ArrowRight className="w-3 h-3 text-cyan-400 shrink-0 mt-0.5" />
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Storage & DB Advice */}
              {(result.volumeRecommendation || result.databaseRecommendation) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {result.volumeRecommendation && (
                    <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-1">
                      <div className="flex items-center gap-1.5 text-cyan-400 font-semibold font-mono text-[11px]">
                        <HardDrive className="w-3.5 h-3.5" />
                        <span>Persistent Volume Mount</span>
                      </div>
                      <p className="text-zinc-400 text-[11px]">
                        {result.volumeRecommendation}
                      </p>
                    </div>
                  )}

                  {result.databaseRecommendation && (
                    <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-1">
                      <div className="flex items-center gap-1.5 text-purple-400 font-semibold font-mono text-[11px]">
                        <Database className="w-3.5 h-3.5" />
                        <span>Databases &amp; Caching</span>
                      </div>
                      <p className="text-zinc-400 text-[11px]">
                        {result.databaseRecommendation}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Scale-to-zero advice */}
              {result.scaleToZeroAdvice && (
                <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-semibold font-mono text-[11px]">
                    <Layers className="w-3.5 h-3.5" />
                    <span>Scaling &amp; Scale-to-Zero Strategy</span>
                  </div>
                  <p className="text-zinc-400 text-[11px]">
                    {result.scaleToZeroAdvice}
                  </p>
                </div>
              )}

              {/* Dockerfile snippet */}
              {result.dockerfileSnippet && (
                <div className="p-4 rounded-xl bg-black border border-zinc-800 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400 font-mono flex items-center gap-1.5">
                      <Code className="w-3.5 h-3.5 text-indigo-400" />
                      Optimized Dockerfile / Runtime
                    </span>
                    <button
                      onClick={() => copySnippet(result.dockerfileSnippet ?? '')}
                      className="flex items-center gap-1 text-[11px] font-mono text-cyan-400 hover:text-cyan-300"
                    >
                      {copiedCode ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="p-2.5 bg-zinc-950 rounded-lg text-xs font-mono text-emerald-300 overflow-x-auto">
                    {result.dockerfileSnippet}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
