'use client';

import React from 'react';
import {
  Server,
  Database,
  HardDrive,
  Globe,
  Terminal,
  Sparkles,
  Cpu,
  Layers,
  Boxes,
  Settings,
  Network,
  Radio,
} from 'lucide-react';

export interface SidebarNavProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  serviceCounts: {
    total: number;
    api: number;
    mcp: number;
    plugin: number;
  };
  dbCounts: {
    postgres: number;
    redis: number;
  };
  storageCount?: number;
  connectedProviders?: number;
  hostStats?: {
    cpuPercent?: number;
    ramPercent?: number;
    ramTotalGb?: number;
    gpuDetected?: boolean;
    gpuModel?: string;
  } | null;
  /** Called after a nav item is picked (used by the mobile panel to auto-close). */
  onNavigated?: () => void;
}

/**
 * Shared control-plane navigation content.
 * Rendered inside the desktop <aside> (Sidebar) and the mobile Sheet
 * (MobileSidePanel) so every view — including Dashboard Settings —
 * is reachable on any screen size.
 */
export default function SidebarNav({
  currentTab,
  onSelectTab,
  serviceCounts,
  dbCounts,
  storageCount,
  connectedProviders,
  hostStats,
  onNavigated,
}: SidebarNavProps) {
  const navItems = [
    {
      id: 'providers',
      label: 'Nodes & Free Providers',
      icon: Layers,
      badge: 'Live Pool',
      badgeKind: 'text' as const,
    },
    {
      id: 'services',
      label: 'Services & Hosting',
      icon: Server,
      badge: serviceCounts.total.toString(),
      badgeKind: 'count' as const,
    },
    {
      id: 'databases',
      label: 'Databases & Cache',
      icon: Database,
      badge: `${dbCounts.postgres + dbCounts.redis}`,
      badgeKind: 'count' as const,
    },
    {
      id: 'storage',
      label: 'Storage & Volumes',
      icon: HardDrive,
      badge: String(storageCount ?? 0),
      badgeKind: 'count' as const,
    },
    {
      id: 'domains',
      label: 'Custom Domains',
      icon: Globe,
      badge: 'SSL',
      badgeKind: 'text' as const,
    },
    {
      id: 'edge',
      label: 'Edge Network',
      icon: Network,
      badge: 'PoP',
      badgeKind: 'text' as const,
    },
    {
      id: 'activity',
      label: 'Activity & Events',
      icon: Radio,
      badge: 'LIVE',
      badgeKind: 'live' as const,
    },
    {
      id: 'mcp-inspector',
      label: 'MCP & Plugin Studio',
      icon: Terminal,
      badge: 'JSON-RPC',
      badgeKind: 'text' as const,
    },
    {
      id: 'advisor',
      label: 'AI Hardware Sizer',
      icon: Sparkles,
      badge: 'AI',
      badgeKind: 'text' as const,
    },
    {
      id: 'settings',
      label: 'Dashboard Settings',
      icon: Settings,
      badge: '',
      badgeKind: 'text' as const,
    },
  ];

  const handleSelect = (tab: string) => {
    onSelectTab(tab);
    onNavigated?.();
  };

  return (
    <div className="flex flex-col justify-between h-full">
      <div className="space-y-6">
        <div>
          <span className="text-[10px] font-mono tracking-wider uppercase text-zinc-500 font-semibold px-2">
            Cloud Resources
          </span>
          <nav className="mt-2 space-y-1" aria-label="Control plane sections">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-full flex items-center justify-between px-3 py-2.5 md:py-2 rounded-lg text-left text-xs font-medium transition ${
                    isActive
                      ? 'bg-zinc-800/90 text-zinc-100 border border-zinc-700/80 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-400' : 'text-zinc-500'}`} />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 border ${
                        item.badgeKind === 'live'
                          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60 flex items-center gap-1'
                          : item.badgeKind === 'count'
                          ? 'nx-metric-value font-semibold '
                          : ''
                      } ${
                        item.badgeKind === 'live'
                          ? ''
                          : isActive
                          ? 'bg-cyan-950 text-cyan-300 border-cyan-800/60'
                          : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                      }`}
                    >
                      {item.badgeKind === 'live' && (
                        <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" aria-hidden />
                      )}
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Live Cluster Health Box — REAL values from the control plane */}
        <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-zinc-300 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              Host Telemetry
            </span>
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          </div>

          <div className="space-y-1 text-[11px] text-zinc-400">
            <div className="flex justify-between">
              <span>Host CPU:</span>
              <span className="font-mono text-zinc-200">{hostStats?.cpuPercent !== undefined ? `${hostStats.cpuPercent}%` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Host RAM:</span>
              <span className="font-mono text-zinc-200">
                {hostStats?.ramPercent !== undefined ? `${hostStats.ramPercent}% of ${hostStats.ramTotalGb ?? '?'} GB` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>GPU:</span>
              <span className="font-mono text-zinc-200">
                {hostStats?.gpuDetected ? (hostStats.gpuModel ?? 'Detected') : 'None detected'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Providers online:</span>
              <span className="font-mono text-emerald-400">{connectedProviders ?? 0} connected</span>
            </div>
            <div className="flex justify-between">
              <span>pgvector:</span>
              <span className="font-mono text-cyan-400">Ready</span>
            </div>
          </div>
        </div>

        {/* Quick Protocol Quick-links */}
        <div className="p-3 rounded-xl bg-gradient-to-b from-indigo-950/20 to-zinc-900/40 border border-indigo-950/60 text-xs">
          <div className="flex items-center gap-2 text-indigo-300 font-medium mb-1">
            <Boxes className="w-3.5 h-3.5 text-indigo-400" />
            <span>Supported Protocols</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 pt-1 text-[11px] text-zinc-400 font-mono">
            <span className="bg-zinc-900/80 px-2 py-0.5 rounded border border-zinc-800/60 text-center">FastMCP</span>
            <span className="bg-zinc-900/80 px-2 py-0.5 rounded border border-zinc-800/60 text-center">OpenAPI 3.1</span>
            <span className="bg-zinc-900/80 px-2 py-0.5 rounded border border-zinc-800/60 text-center">vLLM OpenAI</span>
            <span className="bg-zinc-900/80 px-2 py-0.5 rounded border border-zinc-800/60 text-center">SSE Transport</span>
          </div>
        </div>
      </div>

      <div className="pt-4 mt-6 border-t border-zinc-800/80 text-[11px] text-zinc-500 space-y-1 font-mono">
        <div className="flex items-center justify-between">
          <span>Control plane:</span>
          <span className="text-emerald-400">local (1ms)</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Version:</span>
          <span>v3.0.0-real</span>
        </div>
      </div>
    </div>
  );
}
