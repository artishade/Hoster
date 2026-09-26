'use client';

import React from 'react';
import { Zap } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import SidebarNav, { type SidebarNavProps } from './SidebarNav';

export interface MobileSidePanelProps extends SidebarNavProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mobile navigation side panel.
 * Slides in from the left and exposes the full control-plane navigation —
 * Dashboard Settings, Databases, Storage, Domains, MCP Studio — plus live
 * host telemetry, all of which are unreachable on small screens without it.
 */
export default function MobileSidePanel({
  open,
  onOpenChange,
  onSelectTab,
  ...navProps
}: MobileSidePanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[86%] max-w-[320px] p-0 bg-[#0b0c12] border-zinc-800/80 flex flex-col"
      >
        <SheetHeader className="px-4 pt-4 pb-3 border-b border-zinc-800/80 space-y-0">
          <SheetTitle className="flex items-center gap-2.5 text-left">
            <span className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-600 via-indigo-600 to-emerald-400 p-[1px]">
              <span className="flex items-center justify-center w-full h-full bg-zinc-950 rounded-[7px]">
                <Zap className="w-4 h-4 text-cyan-400" />
              </span>
            </span>
            <span className="text-sm font-bold tracking-tight bg-gradient-to-r from-zinc-100 to-zinc-400 bg-clip-text text-transparent">
              NexusHost
            </span>
            <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-800/60">
              Menu
            </span>
          </SheetTitle>
          <SheetDescription className="text-[11px] text-zinc-500 text-left">
            Navigate resources, telemetry & settings
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto nx-scroll p-4">
          <SidebarNav
            {...navProps}
            onSelectTab={onSelectTab}
            onNavigated={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
