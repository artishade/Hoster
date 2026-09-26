'use client';

/**
 * TerminalSessionsPanel — live ops view of the terminal mini-service.
 *
 * Connects to the terminal service (socket.io, ?XTransformPort=3031) WITHOUT
 * attaching a PTY and uses the session-manager protocol: list live PTY
 * sessions (service, pid, age, idle) and kill one by socket id. Everything
 * shown is real state of real bash processes on this host.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalSquare, RefreshCw, Skull, CircleCheck, Timer, Users } from 'lucide-react';

interface SessionRow {
  socketId: string;
  service: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  idleSec: number;
  ageSec: number;
}

interface PoolInfo {
  active: number;
  max: number;
}

function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function TerminalSessionsPanel() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [pool, setPool] = useState<PoolInfo>({ active: 0, max: 6 });
  const [state, setState] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [killed, setKilled] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const socketRef = useRef<{ disconnect: () => void } | null>(null);

  const connect = useCallback(async () => {
    setState('connecting');
    setError(null);
    // Tear down any previous socket (reconnect path) before dialing again.
    const prev = socketRef.current as unknown as { __t?: ReturnType<typeof setInterval>; disconnect: () => void } | null;
    if (prev) {
      if (prev.__t) clearInterval(prev.__t);
      prev.disconnect();
      socketRef.current = null;
    }
    try {
      const { io } = await import('socket.io-client');
      const socket = io('/?XTransformPort=3031', {
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 6000,
      });
      socketRef.current = socket;

      const refresh = () =>
        socket.emit('list-sessions', {}, (r: { ok?: boolean; sessions?: SessionRow[]; pool?: PoolInfo; error?: string }) => {
          if (r?.ok) {
            setSessions(r.sessions ?? []);
            setPool(r.pool ?? { active: 0, max: 6 });
            setState('live');
          } else {
            setState('error');
            setError(r?.error ?? 'list failed');
          }
        });

      socket.on('connect', refresh);
      socket.on('disconnect', () => setState('connecting'));
      socket.on('connect_error', (e: Error) => {
        setState('error');
        setError(e.message);
      });
      // Period refresh while mounted (12s); if the service restarted and the
      // socket dropped (reconnection is off), transparently reconnect.
      const t = setInterval(() => {
        if (socket.connected) refresh();
        else void connect();
      }, 12_000);
      (socket as unknown as { __t?: ReturnType<typeof setInterval> }).__t = t;
    } catch (e) {
      setState('error');
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void connect();
    return () => {
      const s = socketRef.current as unknown as { __t?: ReturnType<typeof setInterval>; disconnect: () => void } | null;
      if (s?.__t) clearInterval(s.__t);
      s?.disconnect();
      socketRef.current = null;
    };
  }, [connect]);

  const kill = async (socketId: string) => {
    setBusy(socketId);
    try {
      const { io } = await import('socket.io-client');
      // one-shot connection for the kill command
      const s = io('/?XTransformPort=3031', { transports: ['websocket', 'polling'], reconnection: false, timeout: 6000 });
      await new Promise<void>((res) => {
        s.on('connect', () => {
          s.emit('kill-session', { socketId }, () => {
            s.disconnect();
            res();
          });
        });
        s.on('connect_error', () => res());
        setTimeout(() => { s.disconnect(); res(); }, 5000);
      });
      setKilled(socketId);
      // Instant local feedback — drop the row now (the 12s poll confirms).
      setSessions((prev) => prev.filter((s) => s.socketId !== socketId));
      setPool((p) => ({ ...p, active: Math.max(0, p.active - 1) }));
      setTimeout(() => setKilled(null), 2200);
      // refresh main listing shortly after
      setTimeout(() => {
        const s = socketRef.current as unknown as { emit: (e: string, p: unknown, cb: (r: unknown) => void) => void } | null;
        s?.emit('list-sessions', {}, () => {});
      }, 400);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/60">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
          <TerminalSquare className="w-4 h-4 text-cyan-400" />
          Workspace Shell Sessions
        </h2>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full border flex items-center gap-1.5 ${
            state === 'live'
              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/60'
              : state === 'connecting'
                ? 'bg-cyan-950/60 text-cyan-300 border-cyan-800/60'
                : 'bg-red-950/60 text-red-400 border-red-800/60'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              state === 'live' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-cyan-400 animate-pulse' : 'bg-red-400'
            }`}
          />
          {state === 'live' ? `${pool.active}/${pool.max} active` : state === 'connecting' ? 'connecting…' : 'unreachable'}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {/* summary */}
        <div className="flex items-center gap-4 text-[11px] font-mono text-zinc-400">
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-zinc-500" />
            {sessions.length} live PTY {sessions.length === 1 ? 'session' : 'sessions'}
          </span>
          <span className="flex items-center gap-1.5">
            <Timer className="w-3.5 h-3.5 text-zinc-500" />
            30-min idle reaper armed
          </span>
          <button
            onClick={() => {
              const s = socketRef.current as unknown as { connected?: boolean } | null;
              if (s?.connected) {
                (socketRef.current as unknown as { emit: (e: string, p: unknown, cb: (r: unknown) => void) => void }).emit('list-sessions', {}, () => {});
              } else {
                void connect();
              }
            }}
            className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition active:scale-95"
            disabled={state !== 'live'}
            title="Refresh session list"
          >
            <RefreshCw className="w-3 h-3" />
            refresh
          </button>
        </div>

        {state === 'error' && error && (
          <p className="text-[11px] font-mono text-red-300 bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2">
            terminal service unreachable: {error}
          </p>
        )}

        {/* sessions */}
        {sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 py-6 text-center">
            <p className="text-xs font-mono text-zinc-500">No active workspace shells</p>
            <p className="text-[10px] text-zinc-600 mt-1">
              open a service → Workspace Shell (PTY) → Attach — live sessions appear here in real time
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li
                key={s.socketId}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
                  killed === s.socketId
                    ? 'border-emerald-800/60 bg-emerald-950/20'
                    : 'border-zinc-800 bg-zinc-950/60'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 nx-status-dot" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-zinc-100 font-mono">{s.service}</span>
                    <span className="text-[10px] font-mono text-zinc-500">pid {s.pid}</span>
                    {killed === s.socketId && (
                      <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                        <CircleCheck className="w-3 h-3" /> killed
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-zinc-600 mt-0.5">
                    age {fmtDur(s.ageSec)} · idle {fmtDur(s.idleSec)}
                    {s.idleSec > 600 && <span className="text-amber-500/80"> · near reaper limit</span>}
                  </div>
                </div>
                <button
                  onClick={() => void kill(s.socketId)}
                  disabled={busy === s.socketId || killed === s.socketId}
                  className="flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1.5 rounded-md border border-red-900/50 bg-red-950/30 hover:bg-red-900/40 text-red-300 transition active:scale-95 disabled:opacity-40 shrink-0"
                  title="Kill this PTY session (bash process + socket)"
                >
                  <Skull className="w-3 h-3" />
                  {busy === s.socketId ? 'killing…' : 'kill'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-[10px] text-zinc-600 font-mono">
          real bash processes (node-pty) — session manager reads live state from the terminal service on port 3031
        </p>
      </div>
    </section>
  );
}
