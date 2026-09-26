'use client';

import React, { useState } from 'react';
import { Service, McpTool } from '@/lib/hoster/types';
import { 
  Terminal, 
  Play, 
  RefreshCw, 
  Copy, 
  Check, 
  Code, 
  ExternalLink, 
  Server, 
  Layers, 
  Sparkles, 
  ShieldCheck,
  FileJson
} from 'lucide-react';

interface McpInspectorViewProps {
  services: Service[];
  initialService?: Service;
}

/** Shape of the `data` envelope returned by POST /api/mcp/execute. */
interface McpExecuteData {
  ok?: boolean;
  result?: unknown;
  executionMs?: number;
  logs?: string[];
  error?: string;
}

export default function McpInspectorView({
  services,
  initialService,
}: McpInspectorViewProps) {
  const mcpServices = services.filter((s) => s.type === 'mcp' || s.mcpDetails);
  const [selectedServiceId, setSelectedServiceId] = useState<string>(
    initialService?.id || mcpServices[0]?.id || services[0]?.id || ''
  );

  const activeService = services.find((s) => s.id === selectedServiceId);
  const tools = activeService?.mcpDetails?.tools || [];

  const [activeTab, setActiveTab] = useState<'tools' | 'resources' | 'prompts' | 'raw-rpc' | 'plugin-manifest'>('tools');
  const [selectedToolIndex, setSelectedToolIndex] = useState(0);
  const [inputArguments, setInputArguments] = useState('{\n  "query": "vector indexing in PostgreSQL",\n  "limit": 3\n}');
  const [rpcResponse, setRpcResponse] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleToolSelect = (idx: number) => {
    setSelectedToolIndex(idx);
    const tool = tools[idx];
    if (tool && tool.exampleInput) {
      setInputArguments(JSON.stringify(tool.exampleInput, null, 2));
    } else {
      setInputArguments('{}');
    }
  };

  const handleExecute = async () => {
    setIsExecuting(true);
    setRpcResponse(null);

    const tool = tools[selectedToolIndex];
    let parsedArgs: unknown = {};
    try {
      parsedArgs = JSON.parse(inputArguments);
    } catch {
      parsedArgs = { input: inputArguments };
    }

    const rpcId = Math.floor(Math.random() * 100000);

    try {
      const res = await fetch('/api/mcp/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: activeService?.id,
          toolName: tool?.name || 'system_diagnostics',
          toolDescription: tool?.description,
          inputSchema: tool?.inputSchema,
          input: parsedArgs,
        }),
      });

      const json: { data?: McpExecuteData; error?: string } = await res.json();
      const data = json?.data;

      if (data?.ok) {
        setRpcResponse(
          JSON.stringify(
            {
              jsonrpc: '2.0',
              id: rpcId,
              result: {
                content: [
                  {
                    type: 'text',
                    text:
                      typeof data.result === 'string'
                        ? data.result
                        : JSON.stringify(data.result, null, 2),
                  },
                ],
                isError: !data.ok,
                metadata: {
                  executionMs: data.executionMs,
                  runtimeLogs: data.logs,
                },
              },
            },
            null,
            2
          )
        );
      } else {
        setRpcResponse(
          JSON.stringify(
            {
              jsonrpc: '2.0',
              id: rpcId,
              error: { message: data?.error || json?.error || 'Execution failed' },
            },
            null,
            2
          )
        );
      }
    } catch (err) {
      setRpcResponse(
        JSON.stringify(
          { jsonrpc: '2.0', id: rpcId, error: { message: (err as Error).message || 'Execution failed' } },
          null,
          2
        )
      );
    } finally {
      setIsExecuting(false);
    }
  };

  // Claude Desktop config
  const claudeDesktopConfig = {
    mcpServers: {
      [activeService?.name || 'mcp-server']: {
        url: activeService
          ? `${typeof window !== 'undefined' ? window.location.origin : ''}/api/ingress/${activeService.name}/sse`
          : 'https://mcp.nexushost.dev/sse',
        transport: 'sse',
        headers: {
          Authorization: 'Bearer <NEXUS_API_KEY>',
        },
      },
    },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div>
          <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
            <Terminal className="w-5 h-5 text-purple-400" />
            <span>MCP (Model Context Protocol) &amp; Plugin Studio</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Interactive JSON-RPC 2.0 debugging suite for Claude Desktop, Cursor IDE, and OpenAPI Action tools
          </p>
        </div>

        {/* Server Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-mono">Target Host:</span>
          <select
            value={selectedServiceId}
            onChange={(e) => {
              setSelectedServiceId(e.target.value);
              setSelectedToolIndex(0);
              setRpcResponse(null);
            }}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-purple-500"
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.type.toUpperCase()})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-800 text-xs font-medium">
        <button
          onClick={() => setActiveTab('tools')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'tools'
              ? 'border-purple-400 text-purple-300 bg-purple-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Code className="w-4 h-4 text-purple-400" />
          <span>Registered Tools ({tools.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('resources')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'resources'
              ? 'border-purple-400 text-purple-300 bg-purple-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Layers className="w-4 h-4 text-cyan-400" />
          <span>Resources ({activeService?.mcpDetails?.resources.length || 0})</span>
        </button>

        <button
          onClick={() => setActiveTab('prompts')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'prompts'
              ? 'border-purple-400 text-purple-300 bg-purple-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <span>Prompts ({activeService?.mcpDetails?.prompts.length || 0})</span>
        </button>

        <button
          onClick={() => setActiveTab('plugin-manifest')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'plugin-manifest'
              ? 'border-purple-400 text-purple-300 bg-purple-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <FileJson className="w-4 h-4 text-rose-400" />
          <span>OpenAPI &amp; Plugin Manifest</span>
        </button>
      </div>

      {/* TAB 1: TOOLS EXECUTION */}
      {activeTab === 'tools' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Tool list sidebar */}
          <div className="lg:col-span-4 space-y-2">
            <span className="text-[11px] font-mono uppercase text-zinc-500 font-bold block mb-2">
              Available MCP Tools:
            </span>

            {tools.map((t, idx) => (
              <button
                key={t.name}
                onClick={() => handleToolSelect(idx)}
                className={`w-full text-left p-3 rounded-xl border transition ${
                  selectedToolIndex === idx
                    ? 'border-purple-500 bg-purple-950/30 text-white shadow-sm'
                    : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <div className="font-mono text-xs font-bold text-zinc-200">{t.name}</div>
                <div className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{t.description}</div>
              </button>
            ))}
          </div>

          {/* Tool execution runner */}
          <div className="lg:col-span-8 p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
            {tools[selectedToolIndex] ? (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-zinc-100 font-mono">
                      {tools[selectedToolIndex].name}
                    </h3>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {tools[selectedToolIndex].description}
                    </p>
                  </div>

                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                    tools/call
                  </span>
                </div>

                {/* Input Arguments */}
                <div>
                  <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                    Input Parameters (JSON payload conforming to schema):
                  </label>
                  <textarea
                    rows={6}
                    value={inputArguments}
                    onChange={(e) => setInputArguments(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono text-xs text-cyan-300 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <button
                    onClick={() => {
                      const example = tools[selectedToolIndex].exampleInput;
                      if (example) setInputArguments(JSON.stringify(example, null, 2));
                    }}
                    className="text-xs text-zinc-400 hover:text-zinc-200 underline"
                  >
                    Reset to Default Example
                  </button>

                  <button
                    onClick={handleExecute}
                    disabled={isExecuting}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold transition disabled:opacity-50"
                  >
                    {isExecuting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-white" />}
                    <span>Invoke MCP Tool</span>
                  </button>
                </div>

                {/* Results window */}
                {rpcResponse && (
                  <div className="space-y-1.5 pt-3 border-t border-zinc-800">
                    <span className="text-[11px] font-mono text-emerald-400 font-bold">
                      JSON-RPC 2.0 Response:
                    </span>
                    <pre className="p-4 bg-black rounded-xl border border-zinc-800 font-mono text-xs text-emerald-300 overflow-x-auto max-h-64 shadow-inner">
                      {rpcResponse}
                    </pre>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 text-zinc-500 text-xs">
                No tools available on this service.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: RESOURCES */}
      {activeTab === 'resources' && (
        <div className="space-y-4">
          {activeService?.mcpDetails?.resources && activeService.mcpDetails.resources.length > 0 ? (
            activeService.mcpDetails.resources.map((res) => (
              <div
                key={res.uri}
                className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 flex items-center justify-between"
              >
                <div>
                  <h4 className="text-sm font-bold font-mono text-zinc-100">{res.name}</h4>
                  <p className="text-xs font-mono text-cyan-400 mt-1">{res.uri}</p>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  {res.mimeType || 'text/plain'}
                </span>
              </div>
            ))
          ) : (
            <div className="text-center py-12 text-zinc-500 text-xs">
              No MCP resources exposed by this service.
            </div>
          )}
        </div>
      )}

      {/* TAB 3: PROMPTS */}
      {activeTab === 'prompts' && (
        <div className="space-y-4">
          {activeService?.mcpDetails?.prompts && activeService.mcpDetails.prompts.length > 0 ? (
            activeService.mcpDetails.prompts.map((p) => (
              <div
                key={p.name}
                className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 flex items-center justify-between"
              >
                <div>
                  <h4 className="text-sm font-bold font-mono text-zinc-100">{p.name}</h4>
                  <p className="text-xs text-zinc-400 mt-1">{p.description}</p>
                </div>
                <button
                  onClick={() => alert(`Prompt template '${p.name}' loaded into prompt builder`)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                >
                  Use Template
                </button>
              </div>
            ))
          ) : (
            <div className="text-center py-12 text-zinc-500 text-xs">
              No MCP prompts defined on this service.
            </div>
          )}
        </div>
      )}

      {/* TAB 4: PLUGIN MANIFEST */}
      {activeTab === 'plugin-manifest' && (
        <div className="space-y-4">
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-zinc-200 font-mono">
                /.well-known/ai-plugin.json Manifest
              </h3>
              <button
                onClick={() =>
                  copyToClipboard(
                    JSON.stringify(
                      {
                        schema_version: 'v1',
                        name_for_human: activeService?.name || 'Nexus Plugin',
                        name_for_model: (activeService?.name || 'nexus').replace(/-/g, '_'),
                        description_for_human: activeService?.description,
                        description_for_model: `Plugin for ${activeService?.description}. Use it to query real-time data.`,
                        auth: { type: 'none' },
                        api: { type: 'openapi', url: `${activeService?.url}/openapi.json` },
                      },
                      null,
                      2
                    ),
                    'manifest'
                  )
                }
                className="flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 font-mono"
              >
                {copiedId === 'manifest' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>Copy Manifest</span>
              </button>
            </div>

            <pre className="p-4 bg-black rounded-xl border border-zinc-800 font-mono text-xs text-zinc-300 overflow-x-auto">
              {JSON.stringify(
                {
                  schema_version: 'v1',
                  name_for_human: activeService?.name || 'Nexus Plugin',
                  name_for_model: (activeService?.name || 'nexus').replace(/-/g, '_'),
                  description_for_human: activeService?.description,
                  description_for_model: `Plugin for ${activeService?.description}. Use it to query real-time data.`,
                  auth: { type: 'none' },
                  api: { type: 'openapi', url: `${activeService?.url}/openapi.json` },
                },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
