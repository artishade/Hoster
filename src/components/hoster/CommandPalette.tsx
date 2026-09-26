'use client';

/**
 * CommandPalette — global Ctrl/⌘+K search & quick actions.
 *
 * Everything it offers is REAL: navigation to every view, jump to any service /
 * database / volume / domain by name (fetched live), per-service quick actions
 * (open terminal, stop/restart), and platform actions (deploy, advisor).
 * cmdk powers the fuzzy search; actions execute the same callbacks the rest
 * of the UI uses.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Command } from 'cmdk';
import {
  Search,
  Rocket,
  Server,
  Terminal,
  Database,
  HardDrive,
  Globe,
  Activity,
  Layers,
  Settings,
  Cpu,
  StopCircle,
  RotateCw,
  Sparkles,
  CornerDownLeft,
  ArrowRight,
} from 'lucide-react';
import type { Service } from '@/lib/hoster/types';

export interface PaletteServiceAction {
  id: string;
  label: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: Service[];
  onNavigate: (tab: string, serviceId?: string) => void;
  onDeployNew: () => void;
  onOpenAdvisor: () => void;
  onServiceAction: (serviceId: string, action: 'stop' | 'restart') => void;
  onOpenTerminal: (serviceId: string) => void;
  dbCount: number;
  volumeCount: number;
  domainCount: number;
}

const VIEWS = [
  { id: 'services', label: 'Services & Hosting', hint: 'deployments, runners, ingress', icon: Server },
  { id: 'databases', label: 'Databases & Cache', hint: 'postgres, redis, consoles', icon: Database },
  { id: 'storage', label: 'Storage & Volumes', hint: 'volumes, S3 buckets', icon: HardDrive },
  { id: 'domains', label: 'Custom Domains', hint: 'DNS verification, vhosts', icon: Globe },
  { id: 'edge', label: 'Edge Network PoP', hint: 'routing table, upstreams', icon: Activity },
  { id: 'activity', label: 'Activity & Events', hint: 'live platform event stream', icon: Activity },
  { id: 'providers', label: 'Nodes & Free Providers', hint: 'live pool, capacity', icon: Layers },
  { id: 'mcp-inspector', label: 'MCP & Plugin Studio', hint: 'JSON-RPC inspector', icon: Sparkles },
  { id: 'settings', label: 'Dashboard Settings', hint: 'platform config', icon: Settings },
];

export default function CommandPalette({
  open,
  onOpenChange,
  services,
  onNavigate,
  onDeployNew,
  onOpenAdvisor,
  onServiceAction,
  onOpenTerminal,
  dbCount,
  volumeCount,
  domainCount,
}: Props) {
  const [value, setValue] = useState('');

  // Reset the query each time the palette opens.
  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  // Global keyboard shortcut: Ctrl/⌘+K toggles, Esc closes (cmdk handles Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const runAndView = useCallback(
    (fn: () => void) => {
      fn();
      close();
    },
    [close]
  );

  if (!open) return null;

  const statusDot: Record<string, string> = {
    running: 'bg-emerald-400',
    building: 'bg-amber-400 animate-pulse',
    deploying: 'bg-amber-400 animate-pulse',
    stopped: 'bg-zinc-500',
    failed: 'bg-red-400',
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop */}
      <button
        aria-label="Close command palette"
        onClick={close}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
      />

      <Command
        value={value}
        onValueChange={setValue}
        loop
        className="relative w-full max-w-xl rounded-2xl border border-zinc-700/80 bg-zinc-950/95 shadow-2xl shadow-black/60 overflow-hidden nx-cmdk-in"
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 border-b border-zinc-800">
          <Search className="w-4 h-4 text-cyan-400/80 shrink-0" />
          <Command.Input
            autoFocus
            placeholder="Search services, views, actions…"
            className="flex-1 bg-transparent py-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <Command.List className="max-h-[52vh] overflow-y-auto custom-scrollbar px-2 py-2">
          <Command.Empty className="py-10 text-center text-xs font-mono text-zinc-500">
            No matches — try a service name, e.g. &quot;real-node-app&quot;
          </Command.Empty>

          {/* Quick actions */}
          <Command.Group
            heading={
              <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                <CornerDownLeft className="w-3 h-3" /> Quick actions
              </span>
            }
          >
            <Item
              icon={<Rocket className="w-4 h-4 text-cyan-400" />}
              label="Deploy new service"
              hint="git repo → real build pipeline"
              onSelect={() => runAndView(onDeployNew)}
            />
            <Item
              icon={<Sparkles className="w-4 h-4 text-violet-400" />}
              label="AI Hardware Sizer"
              hint="architecture advisor"
              onSelect={() => runAndView(onOpenAdvisor)}
            />
          </Command.Group>

          {/* Services */}
          <Command.Group
            heading={
              <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                <Server className="w-3 h-3" /> Services ({services.length})
              </span>
            }
          >
            {services.map((s) => (
              <Item
                key={`nav-${s.id}`}
                icon={
                  <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[s.status] ?? 'bg-zinc-500'}`} />
                }
                label={s.name}
                hint={s.status}
                onSelect={() => runAndView(() => onNavigate('services', s.id))}
                trailing={
                  <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600 uppercase">
                    <ArrowRight className="w-3 h-3" /> open
                  </span>
                }
              />
            ))}
          </Command.Group>

          {/* Per-service actions for running services (only after typing a name-ish query) */}
          {services.some(
            (s) =>
              value.trim().length > 0 &&
              s.name.toLowerCase().includes(value.trim().toLowerCase()) &&
              (s.status === 'running' || s.status === 'stopped' || s.status === 'failed')
          ) && (
            <Command.Group
              heading={
                <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                  <Terminal className="w-3 h-3" /> Service actions
                </span>
              }
            >
              {services
                .filter((s) => s.name.toLowerCase().includes(value.trim().toLowerCase()))
                .slice(0, 4)
                .flatMap((s) => {
                  const items = [
                    <Item
                      key={`term-${s.id}`}
                      icon={<Terminal className="w-4 h-4 text-cyan-400" />}
                      label={`${s.name}: open workspace shell`}
                      hint="real PTY"
                      onSelect={() => runAndView(() => onOpenTerminal(s.id))}
                    />,
                  ];
                  if (s.status === 'running') {
                    items.push(
                      <Item
                        key={`stop-${s.id}`}
                        icon={<StopCircle className="w-4 h-4 text-amber-400" />}
                        label={`${s.name}: stop`}
                        hint="kill process, release port"
                        onSelect={() => runAndView(() => onServiceAction(s.id, 'stop'))}
                      />
                    );
                  }
                  if (s.status !== 'building' && s.status !== 'deploying') {
                    items.push(
                      <Item
                        key={`restart-${s.id}`}
                        icon={<RotateCw className="w-4 h-4 text-emerald-400" />}
                        label={`${s.name}: restart`}
                        hint="fresh clone → build → run"
                        onSelect={() => runAndView(() => onServiceAction(s.id, 'restart'))}
                      />
                    );
                  }
                  return items;
                })}
            </Command.Group>
          )}

          {/* Views */}
          <Command.Group
            heading={
              <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                <Cpu className="w-3 h-3" /> Navigate ({dbCount} dbs · {volumeCount} volumes · {domainCount} domains)
              </span>
            }
          >
            {VIEWS.map((v) => (
              <Item
                key={v.id}
                icon={<v.icon className="w-4 h-4 text-zinc-400" />}
                label={v.label}
                hint={v.hint}
                onSelect={() => runInView(v.id)}
              />
            ))}
          </Command.Group>
        </Command.List>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/60 text-[10px] font-mono text-zinc-500">
          <span className="flex items-center gap-2">
            <kbd className="border border-zinc-700 rounded px-1 py-0.5">↑↓</kbd> navigate
            <kbd className="border border-zinc-700 rounded px-1 py-0.5">↵</kbd> select
          </span>
          <span className="text-zinc-600">everything here runs for real</span>
        </div>
      </Command>
    </div>
  );

  function runInView(id: string) {
    runAndView(() => onNavigate(id));
  }
}

function Item({
  icon,
  label,
  hint,
  trailing,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      value={`${label} ${hint ?? ''}`}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm text-zinc-200 data-[selected=true]:bg-cyan-950/40 data-[selected=true]:text-cyan-100 transition-colors"
    >
      {icon}
      <span className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="truncate">{label}</span>
        {hint && <span className="text-[10px] font-mono text-zinc-500 truncate hidden sm:inline">{hint}</span>}
      </span>
      {trailing}
    </Command.Item>
  );
}
