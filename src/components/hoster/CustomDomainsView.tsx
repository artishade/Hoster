'use client';

import React, { useState } from 'react';
import { CustomDomain, Service } from '@/lib/hoster/types';
import { 
  Globe, 
  ShieldCheck, 
  Plus, 
  Copy, 
  Check, 
  X,
  ExternalLink, 
  RefreshCw, 
  ArrowRight,
  Trash2,
  Server,
  AlertCircle
} from 'lucide-react';

interface CustomDomainsViewProps {
  domains: CustomDomain[];
  services: Service[];
  onAddDomain: (domain: CustomDomain) => void;
  onRecheckDomain?: (id: string) => Promise<void>;
  onDeleteDomain?: (id: string) => Promise<void>;
}

export default function CustomDomainsView({
  domains,
  services,
  onAddDomain,
  onRecheckDomain,
  onDeleteDomain,
}: CustomDomainsViewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [targetServiceId, setTargetServiceId] = useState(services[0]?.id || '');
  const [isVerifying, setIsVerifying] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreate = () => {
    if (!newDomain.trim()) return;
    const srv = services.find((s) => s.id === targetServiceId);
    const newEntry: CustomDomain = {
      id: `dom-${Date.now()}`,
      serviceId: targetServiceId,
      serviceName: srv?.name || 'custom-service',
      domain: newDomain.trim().toLowerCase(),
      cnameTarget: 'cname.nexushost.dev',
      sslStatus: 'active',
      dnsConfigured: true,
      createdAt: 'Just now',
    };
    onAddDomain(newEntry);
    setIsModalOpen(false);
    setNewDomain('');
  };

  const handleRecheck = async (dom: CustomDomain) => {
    if (!onRecheckDomain) return;
    setIsVerifying(dom.id);
    try {
      await onRecheckDomain(dom.id);
    } finally {
      setIsVerifying(null);
    }
  };

  const handleDelete = async (dom: CustomDomain) => {
    if (!onDeleteDomain) return;
    if (!window.confirm(`Remove domain "${dom.domain}"? TLS certificate and routing will be released.`)) return;
    await onDeleteDomain(dom.id);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div>
          <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
            <Globe className="w-5 h-5 text-cyan-400" />
            <span>Custom Domain Management &amp; Global CDN</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Automated Let&apos;s Encrypt TLS/SSL certificates, Anycast Edge routing, and DDoS mitigation for all endpoints
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-sm transition"
        >
          <Plus className="w-4 h-4" />
          <span>Add Custom Domain</span>
        </button>
      </div>

      {/* DNS Configuration Guide Box */}
      <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-2">
        <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
          <span>DNS Configuration Instructions</span>
        </h3>
        <p className="text-xs text-zinc-400">
          In your DNS provider (Cloudflare, Namecheap, Route53, GoDaddy), create a <code className="text-cyan-300 font-mono">CNAME</code> record pointing to the target below:
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1 text-xs font-mono">
          <div className="px-3 py-1.5 rounded-lg bg-black border border-zinc-800 text-zinc-300">
            Type: <span className="text-cyan-400 font-bold">CNAME</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-black border border-zinc-800 text-zinc-300">
            Target: <span className="text-emerald-400 font-bold">cname.nexushost.dev</span>
          </div>
          <button
            onClick={() => copyToClipboard('cname.nexushost.dev', 'cname-target')}
            className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300"
          >
            {copiedId === 'cname-target' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>Copy Target</span>
          </button>
        </div>
      </div>

      {/* Domains List */}
      <div className="grid grid-cols-1 gap-4">
        {domains.map((dom) => (
          <div
            key={dom.id}
            className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 hover:border-zinc-700 transition flex flex-col md:flex-row md:items-center justify-between gap-4"
          >
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-base font-bold font-mono text-zinc-100">{dom.domain}</span>
                <span
                  className={`flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded font-medium border ${
                    dom.sslStatus === 'active'
                      ? 'bg-emerald-950/70 text-emerald-400 border-emerald-800/60'
                      : dom.sslStatus === 'pending'
                      ? 'bg-amber-950/70 text-amber-400 border-amber-800/60'
                      : 'bg-red-950/70 text-red-400 border-red-800/60'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  {dom.sslStatus === 'active'
                    ? "SSL Let's Encrypt Active"
                    : dom.sslStatus === 'pending'
                    ? 'SSL Pending — issuing'
                    : 'SSL Failed'}
                </span>
                <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  {dom.dnsConfigured ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      DNS Configured
                    </>
                  ) : (
                    <>
                      <X className="w-3 h-3 text-red-400" />
                      DNS Not Detected
                    </>
                  )}
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  HTTP/2 + TLS 1.3
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs font-mono text-zinc-400">
                <span className="flex items-center gap-1 text-zinc-300">
                  <Server className="w-3.5 h-3.5 text-cyan-400" />
                  Routes to: <strong className="text-cyan-300">{dom.serviceName}</strong>
                </span>
                <span>&bull;</span>
                <span className="text-zinc-500">Added: {dom.createdAt}</span>
              </div>

              {dom.sslStatus === 'failed' && (
                <p className="flex items-center gap-1.5 text-[11px] font-mono text-amber-400">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Add a CNAME record &rarr; <span className="text-cyan-300">{dom.cnameTarget}</span>, then Recheck DNS
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {onRecheckDomain && (
                <button
                  onClick={() => handleRecheck(dom)}
                  disabled={isVerifying === dom.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isVerifying === dom.id ? 'animate-spin text-cyan-400' : ''}`} />
                  <span>{isVerifying === dom.id ? 'Checking DNS...' : 'Recheck DNS'}</span>
                </button>
              )}

              {onDeleteDomain && (
                <button
                  onClick={() => handleDelete(dom)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-900/50 text-xs font-mono transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete</span>
                </button>
              )}

              <a
                href={`https://${dom.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-lg bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/60 transition"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        ))}
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-zinc-800 p-6 space-y-4">
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <Globe className="w-5 h-5 text-cyan-400" />
              <span>Link Production Custom Domain</span>
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Domain Name</label>
                <input
                  type="text"
                  placeholder="e.g. mcp.mycompany.ai or api.mydomain.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Target Service</label>
                <select
                  value={targetServiceId}
                  onChange={(e) => setTargetServiceId(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                >
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.type.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
              >
                Add Domain
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
