'use client';

import React from 'react';
import { 
  Zap, 
  Cpu, 
  Server, 
  Plus, 
  Globe, 
  Sparkles, 
  ShieldCheck, 
  Layers,
  Menu
} from 'lucide-react';

export type ConnectionState = 'connecting' | 'online' | 'reconnecting';

interface NavbarProps {
  onNewDeploy: () => void;
  onOpenAdvisor: () => void;
  activeView: string;
  onSelectTab?: (tab: string) => void;
  /** Opens the mobile navigation side panel (< md). */
  onOpenMobileNav?: () => void;
  /** Live control-plane link state — drives the status pill. */
  connectionState?: ConnectionState;
}

const CONNECTION_META: Record<ConnectionState, { label: string; dot: string; text: string }> = {
  connecting: { label: 'Connecting', dot: 'bg-cyan-400 animate-pulse', text: 'text-cyan-300' },
  online: { label: 'Online', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
};

export default function Navbar({ onNewDeploy, onOpenAdvisor, activeView, onSelectTab, onOpenMobileNav, connectionState = 'online' }: NavbarProps) {
  const conn = CONNECTION_META[connectionState];
  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md px-4 lg:px-8 py-3">
      <div className="flex items-center justify-between gap-4">
        {/* Mobile: side-panel trigger (full nav incl. Settings lives here) */}
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          aria-haspopup="dialog"
          className="md:hidden flex items-center justify-center w-10 h-10 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800 transition active:scale-95"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Logo and Brand */}
        <div className="flex items-center gap-4 min-w-0">
          <button 
            onClick={() => onSelectTab && onSelectTab('services')}
            className="flex items-center gap-2.5 text-left focus:outline-none"
          >
            <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600 via-indigo-600 to-emerald-400 p-[1px] shadow-lg shadow-cyan-950/50">
              <div className="flex items-center justify-center w-full h-full bg-zinc-950 rounded-[11px]">
                <Zap className="w-5 h-5 text-cyan-400 fill-cyan-400/20" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
                  NexusHost
                </span>
                <span className="hidden sm:inline text-[10px] font-mono uppercase tracking-wider whitespace-nowrap px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-800/60">
                  Live Cloud Hub
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 hidden sm:block">
                Real Hardware Telemetry &bull; Free Provider Pooling &bull; Custom VPS Nodes
              </p>
            </div>
          </button>

          {/* Live control-plane status pill */}
          <div
            className="flex md:hidden items-center gap-1.5 px-2 py-1 shrink-0 rounded-md bg-zinc-900/80 border border-zinc-800"
            role="status"
            aria-live="polite"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${conn.dot}`} />
            <span className={`text-[10px] font-mono ${conn.text}`}>{conn.label}</span>
          </div>

          {/* Org & Project Selector */}
          <div className="hidden md:flex items-center gap-2 pl-4 border-l border-zinc-800 text-xs">
            <button
              onClick={() => onSelectTab && onSelectTab('providers')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 font-medium transition"
              title="Open Compute Nodes & Free Cloud Providers"
            >
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span>Capacity Pool</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-1" />
            </button>
          </div>
        </div>

        {/* Global Cluster Status Indicators & Actions */}
        <div className="flex items-center gap-3">
          {/* Active GPU Pool Indicator */}
          <button
            onClick={() => onSelectTab && onSelectTab('providers')}
            className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 text-xs font-mono transition"
            title="Inspect Pooled Hardware & Live Telemetry"
          >
            <Cpu className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span className="text-zinc-400">Capacity Pool:</span>
            <span className="text-emerald-400 font-semibold">Real Host + Free Cloud</span>
          </button>

          {/* Region Status */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 text-xs text-zinc-300 font-mono">
            <Globe className="w-3.5 h-3.5 text-indigo-400" />
            <span>us-east-va (Edge Anycast)</span>
          </div>

          {/* Desktop control-plane status */}
          <div
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 text-xs font-mono"
            role="status"
            aria-live="polite"
            title="Control plane API link state"
          >
            <span className={`w-2 h-2 rounded-full ${conn.dot}`} />
            <span className="text-zinc-400">Plane:</span>
            <span className={conn.text}>{conn.label}</span>
          </div>

          {/* AI Architecture & Sizing Advisor */}
          <button
            onClick={onOpenAdvisor}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-950/80 to-purple-950/80 border border-indigo-700/60 hover:border-indigo-500 text-indigo-200 hover:text-white text-xs font-medium transition shadow-sm"
            title="Ask AI Infrastructure Advisor for model VRAM & server tier recommendation"
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">AI Hardware Sizer</span>
          </button>

          {/* New Service / Deploy CTA */}
          <button
            onClick={onNewDeploy}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 via-indigo-600 to-emerald-500 hover:from-cyan-400 hover:via-indigo-500 hover:to-emerald-400 text-white text-xs font-semibold shadow-md shadow-cyan-950/50 transition transform active:scale-95"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Deploy Service</span>
          </button>
        </div>
      </div>
    </header>
  );
}
