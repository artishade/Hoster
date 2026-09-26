'use client';

/**
 * QuickExecPanel — REAL one-shot command execution in the deployment workspace.
 *
 * Complements the interactive PTY: type a single command, get captured
 * stdout/stderr + exit code + duration. Runs through
 * POST /api/services/[id]/exec which spawns `bash -lc <cmd>` inside
 * deployments/<name>/repo with hard guardrails (timeout, output caps).
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Play, Loader2, ChevronRight, History, CircleAlert, Clock } from 'lucide-react';
import type { Service } from '@/lib/hoster/types';

export interface ExecResultRow {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  at: string;
}

const SUGGESTED = [
  'git log --oneline -5',
  'cat package.json | head -20',
  'du -sh .',
  'ls -la',
  'echo $PORT',
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let json: { data?: T; error?: string };
  try {
    json = await res.json();
  } catch {
    throw new Error(`Control plane returned HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);
  return json.data as T;
}

export default function QuickExecPanel({ service }: { service: Service }) {
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecResultRow | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const hasWorkspace =
    service.runtime?.mode === 'git-deploy' || (!!service.repoUrl && service.runtime?.mode !== 'builtin-runner');

  const historyQ = useQuery({
    queryKey: ['exec-history', service.id],
    queryFn: () => api<ExecResultRow[]>(`/api/services/${service.id}/exec`),
    refetchInterval: 15_000,
    enabled: !!hasWorkspace,
  });

  const runExec = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    try {
      const res = await api<ExecResultRow>(`/api/services/${service.id}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command: cmd }),
      });
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ['exec-history', service.id] });
      if (res.timedOut) toast.warning('exec timed out', { description: `${cmd.slice(0, 60)} — killed at the timeout` });
      else if (res.exitCode !== 0) toast.error(`exit ${res.exitCode}`, { description: cmd.slice(0, 60) });
      else toast.success(`exit 0 · ${res.durationMs}ms`, { description: cmd.slice(0, 60) });
    } catch (e) {
      toast.error('exec failed', { description: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }, [command, running, service.id, queryClient]);

  useEffect(() => {
    setResult(null);
    setCommand('');
  }, [service.id]);

  if (!hasWorkspace) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-center gap-2 text-zinc-400">
          <CircleAlert className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold">No workspace for one-shot exec</span>
        </div>
        <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
          Exec runs inside the deployment workspace — deploy a git repository to unlock it. Builtin runners execute
          in-process and have no workspace directory.
        </p>
      </div>
    );
  }

  const history = historyQ.data ?? [];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/80 bg-zinc-950/60">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-sm font-semibold text-zinc-100">One-shot exec</span>
          <span className="text-[10px] font-mono text-zinc-500 hidden sm:inline truncate">
            bash -lc · deployments/{service.name}/repo · timeout 30s
          </span>
        </div>
        {history.length > 0 && (
          <span className="text-[10px] font-mono text-zinc-500 shrink-0 flex items-center gap-1">
            <History className="w-3 h-3" />
            {history.length} recent
          </span>
        )}
      </div>

      {/* command input */}
      <div className="p-4 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cyan-400/90 font-mono text-xs select-none">$</span>
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runExec();
                }
              }}
              placeholder="run a single command in the workspace…"
              spellCheck={false}
              maxLength={2000}
              className="w-full bg-zinc-950/70 border border-zinc-800 rounded-lg pl-7 pr-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-cyan-700/70 focus:ring-1 focus:ring-cyan-800/40 transition"
              aria-label="Command to execute in the service workspace"
            />
          </div>
          <button
            onClick={() => void runExec()}
            disabled={running || !command.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Running…' : 'Run'}
          </button>
        </div>

        {/* suggested commands */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-600 mr-1">try</span>
          {SUGGESTED.map((s) => (
            <button
              key={s}
              onClick={() => {
                setCommand(s);
                inputRef.current?.focus();
              }}
              disabled={running}
              className="text-[10px] font-mono px-2 py-1 rounded-md border border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-cyan-800/60 hover:text-cyan-300 transition disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>

        {/* latest result */}
        {(result || running) && (
          <div className="rounded-lg border border-zinc-800 bg-[#0b0e14] overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-800/80 bg-zinc-950/70">
              <span className="text-[10px] font-mono text-zinc-500 truncate">
                {result ? result.command : command}
              </span>
              {result && (
                <span
                  className={`flex items-center gap-2 text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                    result.timedOut
                      ? 'text-amber-300 border-amber-800/60 bg-amber-950/30'
                      : result.exitCode === 0
                      ? 'text-emerald-300 border-emerald-800/60 bg-emerald-950/30'
                      : 'text-red-300 border-red-800/60 bg-red-950/30'
                  }`}
                >
                  {result.timedOut ? 'timeout' : `exit ${result.exitCode}`}
                  <span className="text-zinc-600">·</span>
                  <Clock className="w-3 h-3" />
                  {result.durationMs}ms
                </span>
              )}
            </div>
            <pre
              className="px-3 py-2.5 text-[11px] font-mono leading-relaxed text-zinc-300 max-h-72 overflow-auto custom-scrollbar whitespace-pre-wrap break-all"
              aria-label="Command output"
            >
              {running ? '…' : result ? (result.stdout || result.stderr || '(no output)') : ''}
            </pre>
            {result?.truncated && (
              <div className="px-3 py-1.5 border-t border-zinc-800/80 text-[10px] font-mono text-amber-400/80">
                output truncated at 128 KB
              </div>
            )}
          </div>
        )}

        {/* recent history */}
        {history.length > 0 && (
          <div className="pt-2">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-600 mb-1.5 mt-2">
              <History className="w-3 h-3" /> recent execs (this server instance)
            </div>
            <div className="max-h-48 overflow-y-auto custom-scrollbar rounded-lg border border-zinc-800/70 divide-y divide-zinc-800/60">
              {history.map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    setCommand(h.command);
                    setResult(h);
                    inputRef.current?.focus();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-900/70 transition"
                  title={`${h.command} — click to reload into the input`}
                >
                  <span className="font-mono text-cyan-400/70 text-[10px] shrink-0">$</span>
                  <span className="text-[11px] font-mono text-zinc-400 truncate flex-1">{h.command}</span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                      h.timedOut
                        ? 'text-amber-300 border-amber-900/60 bg-amber-950/20'
                        : h.exitCode === 0
                        ? 'text-emerald-300 border-emerald-900/60 bg-emerald-950/20'
                        : 'text-red-300 border-red-900/60 bg-red-950/20'
                    }`}
                  >
                    {h.timedOut ? 'timeout' : h.exitCode}
                  </span>
                  <span className="text-[10px] font-mono text-zinc-600 shrink-0">{h.durationMs}ms</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] text-zinc-600 font-mono">
          real spawn (bash -lc) · output capped 128 KB · one concurrent exec per service · recorded in the activity feed
        </p>
      </div>
    </div>
  );
}
