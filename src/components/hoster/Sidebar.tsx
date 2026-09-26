'use client';

import React from 'react';
import SidebarNav, { type SidebarNavProps } from './SidebarNav';

export type SidebarProps = SidebarNavProps;

/** Desktop sidebar (≥ md). On smaller screens the MobileSidePanel Sheet is used instead. */
export default function Sidebar(props: SidebarProps) {
  return (
    <aside className="w-64 border-r border-zinc-800/80 bg-zinc-950/60 p-4 shrink-0 hidden md:flex md:flex-col">
      <SidebarNav {...props} />
    </aside>
  );
}
