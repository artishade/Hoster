'use client';

/**
 * ServiceTerminal — a REAL per-service web terminal (PTY).
 *
 * Connects to the terminal mini-service (socket.io, ?XTransformPort=3031),
 * which spawns an actual bash PTY inside the service's deployment workspace
 * (node-pty on the host). Everything typed here is executed for real —
 * ls, git log, ps, curl against the live app on its port, etc.
 *
 * Only git-deploy services have a workspace; builtin runners execute
 * in-process and get an explainer instead.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Service } from '@/lib/hoster/types';
import { Terminal as TerminalIcon, ChevronRight, Unplug, CircleDot, ShieldAlert } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

type AttachAck = { ok: boolean; error?: string; pid?: number; cwd?: string; status?: string };
type ConnState = 'idle' | 'connecting' | 'attached' | 'exited' | 'error';

const QUICK_COMMANDS = [
  { label: 'ls -la', cmd: 'ls -la\r' },
  { label: 'git log -5', cmd: 'git log --oneline -5\r' },
  { label: 'ps aux', cmd: 'ps aux | head -15\r' },
  { label: 'du -sh .', cmd: 'du -sh . && du -sh ./* 2>/dev/null | sort -rh | head -8\r' },
  { label: 'env', cmd: 'env | sort | grep -v -E "PATH|LS_COLORS" | head -20\r' },
];

export default function ServiceTerminal({ service }: { service: Service }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<{ write: (d: string) => void; clear: () => void; focus: () => void } | null>(null);
  const socketRef = useRef<{ emit: (e: string, p?: unknown, cb?: (r: unknown) => void) => void; disconnect: () => void; connected: boolean } | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ pid?: number; cwd?: string } | null>(null);
  const [booting, setBooting] = useState(false);

  // Any git-deploy service (running or failed) may have a workspace on disk —
  // the server validates existence and returns a precise error otherwise.
  // Builtin runners execute in-process and get an explainer instead.
  const hasWorkspace = service.runtime?.mode === 'git-deploy' || (!!service.repoUrl && service.runtime?.mode !== 'builtin-runner');

  const connect = useCallback(async () => {
    if (booting || conn === 'attached' || conn === 'connecting') return;
    setBooting(true);
    setConn('connecting');
    setError(null);
    try {
      const [{ Terminal }, { FitAddon }, { io }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('socket.io-client'),
      ]);

      if (xtermRef.current) {
        xtermRef.current.clear();
      }

      // Connection pattern MUST match the sandbox gateway contract exactly:
      // relative URL + XTransformPort query (Caddy routes by query param),
      // path stays '/' so engine.io is servable through the gateway.
      const socket = io('/?XTransformPort=3031', {
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 8000,
      });
      socketRef.current = socket as unknown as typeof socketRef.current;

      socket.on('connect', () => {
        const mount = mountRef.current;
        const cols = Math.max(10, Math.min(200, Math.floor((mount?.clientWidth ?? 640) / 8.4)));
        const rows = 24;
        socket.emit('attach', { service: service.name, cols, rows }, (ack: AttachAck) => {
          setBooting(false);
          if (ack?.ok) {
            setConn('attached');
            setInfo({ pid: ack.pid, cwd: ack.cwd });
            xtermRef.current?.focus();
          } else {
            setConn('error');
            setError(ack?.error ?? 'attach failed');
            socket.disconnect();
          }
        });
      });

      socket.on('data', (d: string) => xtermRef.current?.write(d));
      socket.on('exit', () => {
        setConn('exited');
        socket.disconnect();
        if (socketRef.current === (socket as unknown)) socketRef.current = null;
      });
      socket.on('connect_error', (e: Error) => {
        setBooting(false);
        setConn('error');
        setError(`terminal service unreachable: ${e.message}`);
      });

      // one-shot: if this is the first mount, create the xterm instance now
      if (!xtermRef.current && mountRef.current) {
        const t = new Terminal({
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
          fontSize: 12.5,
          lineHeight: 1.35,
          cursorBlink: true,
          scrollback: 4000,
          theme: {
            background: '#0b0e14',
            foreground: '#c9d4e3',
            cursor: '#22d3ee',
            selectionBackground: 'rgba(34,211,238,0.22)',
            black: '#1f2430',
            red: '#f87171',
            green: '#34d399',
            yellow: '#fbbf24',
            blue: '#60a5fa',
            magenta: '#c084fc',
            cyan: '#22d3ee',
            white: '#e5eaf2',
            brightBlack: '#5c6478',
            brightGreen: '#6ee7b7',
            brightCyan: '#67e8f9',
          },
        });
        const fit = new FitAddon();
        t.loadAddon(fit);
        t.open(mountRef.current);
        try {
          fit.fit();
        } catch {
          /* container may be hidden */
        }
        t.onData((data) => {
          socketRef.current?.emit('input', data);
        });
        xtermRef.current = t as unknown as typeof xtermRef.current;

        // Keep the PTY grid matched to the container size.
        const ro = new ResizeObserver(() => {
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        });
        ro.observe(mountRef.current);
        (t as unknown as { __ro?: ResizeObserver }).__ro = ro;
      }
    } catch (e) {
      setBooting(false);
      setConn('error');
      setError((e as Error).message);
    }
  }, [booting, conn, service.name]);

  const detach = useCallback(() => {
    socketRef.current?.emit('detach');
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConn('idle');
    setInfo(null);
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      socketRef.current?.emit('detach');
      socketRef.current?.disconnect();
      const t = xtermRef.current as unknown as { dispose?: () => void; __ro?: ResizeObserver } | null;
      t?.__ro?.disconnect();
      t?.dispose?.();
      xtermRef.current = null;
    };
  }, []);

  // Reconnect when the service identity changes.
  useEffect(() => {
    detach();
  }, [service.id]);

  if (!hasWorkspace) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-3">
        <div className="flex items-center gap-2 text-amber-300">
          <ShieldAlert className="w-4 h-4" />
          <span className="text-sm font-semibold">No shell for this service</span>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          {service.runtime?.mode === 'builtin-runner'
            ? 'Builtin runners execute inside the shared control-plane process — there is no isolated deployment workspace to open a shell in. Deploy a git repository to get a live workspace terminal.'
            : 'A deployment workspace appears here once the service has cloned its repository and spawned its process.'}
        </p>
      </div>
    );
  }

  const statusMeta: Record<ConnState, { label: string; cls: string; dot: string }> = {
    idle: { label: 'Not attached', cls: 'text-zinc-400 border-zinc-700 bg-zinc-900', dot: 'bg-zinc-500' },
    connecting: { label: 'Attaching…', cls: 'text-cyan-300 border-cyan-800/60 bg-cyan-950/30', dot: 'bg-cyan-400 animate-pulse' },
    attached: { label: 'LIVE PTY', cls: 'text-emerald-300 border-emerald-800/60 bg-emerald-950/30', dot: 'bg-emerald-400 nx-status-dot' },
    exited: { label: 'Shell exited', cls: 'text-zinc-300 border-zinc-700 bg-zinc-900', dot: 'bg-zinc-400' },
    error: { label: 'Error', cls: 'text-red-300 border-red-800/60 bg-red-950/30', dot: 'bg-red-400' },
  };
  const sm = statusMeta[conn];

  return (
    <div className="space-y-3">
      {/* Terminal window (macOS-style chrome) */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden bg-[#0b0e14] shadow-xl shadow-black/40">
        {/* Title bar */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-zinc-800/80 bg-zinc-950/80">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="w-3 h-3 rounded-full bg-red-500/80" />
              <span className="w-3 h-3 rounded-full bg-amber-400/80" />
              <span className="w-3 h-3 rounded-full bg-emerald-500/80" />
            </div>
            <span className="text-xs font-mono text-zinc-300 truncate">
              {service.name}@nexushost <span className="text-zinc-600">—</span>{' '}
              <span className="text-zinc-500 truncate">
                {info?.cwd ? info.cwd.replace('/home/z/my-project/', '') : `deployments/${service.name}/repo`}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-md border ${sm.cls}`}
              role="status"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} />
              {sm.label}
              {info?.pid && conn === 'attached' && <span className="text-zinc-500 normal-case">· pid {info.pid}</span>}
            </span>
            {conn === 'attached' ? (
              <button
                onClick={detach}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition active:scale-95"
                title="Kill the shell and detach"
              >
                <Unplug className="w-3.5 h-3.5" />
                Detach
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={conn === 'connecting' || booting}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md border border-cyan-800/60 bg-cyan-950/40 hover:bg-cyan-900/40 text-cyan-300 transition active:scale-95 disabled:opacity-50"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                {conn === 'exited' ? 'New shell' : 'Attach shell'}
              </button>
            )}
          </div>
        </div>

        {/* xterm mount point */}
        <div
          ref={mountRef}
          className="h-[460px] px-3 py-2 overflow-hidden [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto custom-scrollbar"
          role="application"
          aria-label={`Interactive terminal for ${service.name}`}
        />

        {/* Status strip / errors */}
        {(conn === 'idle' || conn === 'exited') && (
          <div className="px-4 py-3 border-t border-zinc-800/80 bg-zinc-950/60 flex items-center gap-2 text-xs text-zinc-400">
            <CircleDot className="w-3.5 h-3.5 text-cyan-500/70 shrink-0" />
            Click <b className="text-cyan-300 font-semibold">Attach shell</b> to open a real bash PTY inside this deployment&apos;s workspace. Everything you type executes on the host.
          </div>
        )}
        {conn === 'error' && error && (
          <div className="px-4 py-3 border-t border-red-900/50 bg-red-950/20 flex items-start gap-2 text-xs text-red-300">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Quick commands + usage notes */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mr-1">Quick</span>
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q.label}
            onClick={() => {
              if (conn !== 'attached') return;
              socketRef.current?.emit('input', q.cmd);
              xtermRef.current?.focus();
            }}
            disabled={conn !== 'attached'}
            title={`Run: ${q.label}`}
            className="text-[11px] font-mono px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:border-cyan-800/60 hover:text-cyan-300 hover:bg-cyan-950/30 transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {q.label}
          </button>
        ))}
      </div>

      <p className="text-[10px] text-zinc-500 font-mono flex flex-wrap gap-x-4 gap-y-1">
        <span className="flex items-center gap-1">
          <TerminalIcon className="w-3 h-3" /> real bash PTY (node-pty) · resize-aware · 30-min idle reaper
        </span>
        <span className="text-zinc-600">detaching or leaving this tab kills the shell process</span>
      </p>
    </div>
  );
}
