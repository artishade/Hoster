'use client';

import React, { useState } from 'react';
import { PostgresDatabase, RedisDatabase } from '@/lib/hoster/types';
import { 
  Database, 
  Zap, 
  Plus, 
  Terminal, 
  Copy, 
  Check, 
  ExternalLink, 
  Play, 
  Activity, 
  ShieldCheck, 
  Layers, 
  Clock, 
  HardDrive,
  RefreshCw,
  Cpu,
  Square,
  Trash2
} from 'lucide-react';

interface DatabasesViewProps {
  postgresDbs: PostgresDatabase[];
  redisDbs: RedisDatabase[];
  onProvisionPostgres: (db: PostgresDatabase) => void;
  onProvisionRedis: (redis: RedisDatabase) => void;
  onDatabaseAction?: (kind: 'postgres' | 'redis', id: string, action: 'start' | 'stop') => Promise<void>;
  onDeleteDatabase?: (kind: 'postgres' | 'redis', id: string) => Promise<void>;
}

/** `data` envelope of POST /api/databases/query (rows are plain objects). */
interface SqlQueryResult {
  success: boolean;
  executionMs?: number;
  rowCount?: number;
  rows?: Record<string, unknown>[];
  error?: string;
  note?: string;
}

/** `data` envelope of POST /api/redis/execute. */
interface RedisExecuteResult {
  success?: boolean;
  output?: string;
  command?: string;
  keys?: number;
}

const SQL_SAMPLES = [
  "SELECT name, sql FROM sqlite_master WHERE type='table'",
  'SELECT COUNT(*) AS services FROM service',
  'SELECT scope, level, message FROM log_entry ORDER BY createdAt DESC LIMIT 10',
  'SELECT id, name, status, region FROM postgresdb',
];

const REDIS_SAMPLES = [
  'PING',
  'INFO',
  'KEYS *',
  'SET health:last ok EX 120',
  'GET health:last',
  'DBSIZE',
  'INCR hits',
];

/** Live status dot + label shared by Postgres/Redis instance cards. */
function DbStatusPill({ status, onlineLabel }: { status: string; onlineLabel: string }) {
  const cls =
    status === 'available'
      ? 'text-emerald-400'
      : status === 'stopped'
      ? 'text-zinc-500'
      : 'text-amber-400';
  const dot =
    status === 'available'
      ? 'bg-emerald-400 animate-pulse'
      : status === 'stopped'
      ? 'bg-zinc-600'
      : 'bg-amber-400 animate-pulse';
  const label =
    status === 'available'
      ? onlineLabel
      : status === 'stopped'
      ? 'Stopped'
      : status === 'provisioning'
      ? 'Provisioning…'
      : status === 'maintenance'
      ? 'Maintenance'
      : status;
  return (
    <span className={`flex items-center gap-1 text-[11px] font-mono ${cls}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export default function DatabasesView({
  postgresDbs,
  redisDbs,
  onProvisionPostgres,
  onProvisionRedis,
  onDatabaseAction,
  onDeleteDatabase,
}: DatabasesViewProps) {
  const [activeTab, setActiveTab] = useState<'postgres' | 'redis'>('postgres');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dbActionBusyId, setDbActionBusyId] = useState<string | null>(null);

  // New Postgres Modal State
  const [isPgModalOpen, setIsPgModalOpen] = useState(false);
  const [newPgName, setNewPgName] = useState('enterprise-vector-db');
  const [pgvectorChecked, setPgvectorChecked] = useState(true);
  const [pgStorageGb, setPgStorageGb] = useState(100);

  // New Redis Modal State
  const [isRedisModalOpen, setIsRedisModalOpen] = useState(false);
  const [newRedisName, setNewRedisName] = useState('production-cache-cluster');
  const [redisMemoryMb, setRedisMemoryMb] = useState(4096);
  const [redisEviction, setRedisEviction] = useState<'allkeys-lru' | 'volatile-lru' | 'noeviction'>('allkeys-lru');

  // Interactive SQL Studio (real console against the selected instance)
  const [sqlQuery, setSqlQuery] = useState("SELECT name, sql FROM sqlite_master WHERE type='table'");
  const [sqlDbId, setSqlDbId] = useState('');
  const [sqlResults, setSqlResults] = useState<SqlQueryResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [isExecutingSql, setIsExecutingSql] = useState(false);

  // Interactive Redis CLI (real in-memory store behind the selected instance)
  const [redisCommand, setRedisCommand] = useState('PING');
  const [redisDbId, setRedisDbId] = useState('');
  const [redisOutput, setRedisOutput] = useState<string[]>([]);
  const [isRunningRedis, setIsRunningRedis] = useState(false);

  // Instances eligible for the live consoles (status available only)
  const availablePgDbs = postgresDbs.filter((d) => d.status === 'available');
  const selectedSqlDb =
    availablePgDbs.find((d) => d.id === sqlDbId) ?? availablePgDbs[0] ?? null;
  const availableRedisDbs = redisDbs.filter((r) => r.status === 'available');
  const selectedRedisDb =
    availableRedisDbs.find((r) => r.id === redisDbId) ?? availableRedisDbs[0] ?? null;

  // Real Database TCP Connection Diagnostics
  const [isTestConnModalOpen, setIsTestConnModalOpen] = useState(false);
  const [testConnString, setTestConnString] = useState('postgres://postgres:secret@dpg-xxxx.render.com:5432/production');
  const [testConnType, setTestConnType] = useState<'postgres' | 'redis'>('postgres');
  const [isTestingConn, setIsTestingConn] = useState(false);
  const [testConnResult, setTestConnResult] = useState<{ success?: boolean; message?: string; error?: string; latencyMs?: number } | null>(null);

  const runTestConnection = async () => {
    setIsTestingConn(true);
    setTestConnResult(null);
    try {
      const res = await fetch('/api/databases/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: testConnType,
          connectionString: testConnString.trim(),
        }),
      });
      const json: { success?: boolean; message?: string; error?: string; latencyMs?: number } = await res.json();
      setTestConnResult(json);
    } catch (err) {
      setTestConnResult({ success: false, error: (err as Error).message });
    } finally {
      setIsTestingConn(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreatePostgres = () => {
    const newDb: PostgresDatabase = {
      id: `db-pg-${Date.now()}`,
      name: newPgName,
      version: pgvectorChecked ? 'PostgreSQL 16.4 + pgvector 0.7.4' : 'PostgreSQL 16.4',
      region: 'us-east-va (N. Virginia)',
      status: 'available',
      storageGb: pgStorageGb,
      usedStorageGb: 1.2,
      pgvectorEnabled: pgvectorChecked,
      connectionString: `postgresql://nexus_admin:sec_${Math.random().toString(36).substring(2, 8)}@${newPgName}.nexushost.internal:5432/main`,
      pooledConnectionString: `postgresql://nexus_admin:sec_pool@${newPgName}-pooler.nexushost.internal:6543/main?pgbouncer=true`,
      activeConnections: 0,
      maxConnections: 200,
      totalQueries: 0,
      queriesLastMin: 0,
      storageUsedMb: 0,
      createdAt: 'Just now',
      attachedServiceIds: [],
    };
    onProvisionPostgres(newDb);
    setIsPgModalOpen(false);
  };

  const handleCreateRedis = () => {
    const newR: RedisDatabase = {
      id: `db-red-${Date.now()}`,
      name: newRedisName,
      version: 'Redis 7.2-alpine',
      region: 'us-east-va (N. Virginia)',
      status: 'available',
      memoryLimitMb: redisMemoryMb,
      usedMemoryMb: 64,
      evictionPolicy: redisEviction,
      connectionString: `redis://default:red_token_${Math.random().toString(36).substring(2, 8)}@${newRedisName}.nexushost.internal:6379`,
      keyspaceSize: 0,
      hitRatePercent: 0,
      opsPerSec: 0,
      totalOps: 0,
      createdAt: 'Just now',
      attachedServiceIds: [],
    };
    onProvisionRedis(newR);
    setIsRedisModalOpen(false);
  };

  // ── Lifecycle actions (start/stop/delete) on instance cards ─────────────
  const handleDatabaseLifecycle = async (kind: 'postgres' | 'redis', id: string, action: 'start' | 'stop') => {
    if (!onDatabaseAction) return;
    setDbActionBusyId(id);
    try {
      await onDatabaseAction(kind, id, action);
    } finally {
      setDbActionBusyId(null);
    }
  };

  const handleDatabaseDelete = async (kind: 'postgres' | 'redis', id: string) => {
    if (!onDeleteDatabase) return;
    if (!window.confirm('Delete this database? All stored data will be reclaimed immediately.')) return;
    setDbActionBusyId(id);
    try {
      await onDeleteDatabase(kind, id);
    } finally {
      setDbActionBusyId(null);
    }
  };

  // ── Real SQL console against /api/databases/query ───────────────────────
  const handleExecuteSql = async () => {
    if (!selectedSqlDb || !sqlQuery.trim() || isExecutingSql) return;
    setIsExecutingSql(true);
    setSqlResults(null);
    setSqlError(null);
    try {
      const res = await fetch('/api/databases/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseId: selectedSqlDb.id, sql: sqlQuery.trim() }),
      });
      const json: { data?: SqlQueryResult; error?: string } = await res.json();
      if (!res.ok || json?.error) {
        setSqlError(json?.error || `Query failed (HTTP ${res.status})`);
      } else if (json.data && !json.data.success) {
        setSqlError(json.data.error || 'The statement could not be executed.');
      } else if (json.data) {
        setSqlResults(json.data);
      } else {
        setSqlError('Empty response from the query engine.');
      }
    } catch (err) {
      setSqlError((err as Error).message || 'Network error while executing the query.');
    } finally {
      setIsExecutingSql(false);
    }
  };

  const formatSqlCell = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  // ── Real Redis console against /api/redis/execute ───────────────────────
  const handleRunRedisCommand = async () => {
    const cmd = redisCommand.trim();
    if (!cmd || !selectedRedisDb || isRunningRedis) return;
    setIsRunningRedis(true);
    setRedisOutput((prev) => [...prev, `> ${cmd}`]);
    setRedisCommand('');
    try {
      const res = await fetch('/api/redis/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseId: selectedRedisDb.id, command: cmd }),
      });
      const json: { data?: RedisExecuteResult; error?: string } = await res.json();
      const output =
        json?.data?.output ?? json?.error ?? `(error) command failed (HTTP ${res.status})`;
      setRedisOutput((prev) => [...prev, ...output.split('\n')]);
    } catch (err) {
      setRedisOutput((prev) => [...prev, `(error) ${(err as Error).message}`]);
    } finally {
      setIsRunningRedis(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div>
          <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
            <Database className="w-5 h-5 text-purple-400" />
            <span>Databases &amp; In-Memory Caching</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            1-Click Provisioning for PostgreSQL (with pgvector for AI Embeddings) and Redis In-Memory Broker
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsTestConnModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-semibold shadow-sm transition"
            title="Test real TCP handshake to any PostgreSQL or Redis server"
          >
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>Test Live Connection</span>
          </button>

          <button
            onClick={() => setIsPgModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New PostgreSQL</span>
          </button>

          <button
            onClick={() => setIsRedisModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Redis</span>
          </button>
        </div>
      </div>

      {/* Database Category Switcher */}
      <div className="flex items-center gap-2 border-b border-zinc-800 text-xs font-medium">
        <button
          onClick={() => setActiveTab('postgres')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'postgres'
              ? 'border-purple-400 text-purple-300 bg-purple-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Database className="w-4 h-4 text-purple-400" />
          <span>PostgreSQL ({postgresDbs.length})</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
            pgvector Ready
          </span>
        </button>

        <button
          onClick={() => setActiveTab('redis')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'redis'
              ? 'border-rose-400 text-rose-300 bg-rose-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Zap className="w-4 h-4 text-rose-400" />
          <span>Redis Cache &amp; PubSub ({redisDbs.length})</span>
        </button>
      </div>

      {/* POSTGRESQL VIEW */}
      {activeTab === 'postgres' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4">
            {postgresDbs.map((db) => (
              <div
                key={db.id}
                className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 hover:border-zinc-700 transition space-y-4"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-bold text-zinc-100">{db.name}</h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                        {db.version}
                      </span>
                      {db.pgvectorEnabled && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-semibold">
                          pgvector Enabled
                        </span>
                      )}
                      <DbStatusPill status={db.status} onlineLabel="Available" />
                    </div>

                    <div className="flex items-center gap-4 text-xs font-mono text-zinc-400 mt-1.5">
                      <span>Region: {db.region}</span>
                      <span>&bull;</span>
                      <span>Storage: {db.usedStorageGb} / {db.storageGb} GB NVMe</span>
                      <span>&bull;</span>
                      <span>Queries: {db.totalQueries} total ({db.queriesLastMin}/min live)</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyToClipboard(db.connectionString, db.id + '-uri')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition"
                    >
                      {copiedId === db.id + '-uri' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                      <span>Copy URI</span>
                    </button>

                    <button
                      onClick={() => copyToClipboard(db.pooledConnectionString, db.id + '-pool')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-950/60 hover:bg-purple-900/60 text-purple-300 border border-purple-800/60 text-xs font-mono transition"
                    >
                      {copiedId === db.id + '-pool' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-purple-400" />}
                      <span>PgBouncer Pooler URI</span>
                    </button>

                    {onDatabaseAction && (db.status === 'available' || db.status === 'stopped') && (
                      <button
                        onClick={() => handleDatabaseLifecycle('postgres', db.id, db.status === 'available' ? 'stop' : 'start')}
                        disabled={dbActionBusyId === db.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition disabled:opacity-50"
                      >
                        {dbActionBusyId === db.id ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : db.status === 'available' ? (
                          <Square className="w-3 h-3 fill-zinc-400 text-zinc-400" />
                        ) : (
                          <Play className="w-3 h-3 fill-emerald-400 text-emerald-400" />
                        )}
                        <span>{db.status === 'available' ? 'Stop' : 'Start'}</span>
                      </button>
                    )}

                    {onDeleteDatabase && (
                      <button
                        onClick={() => handleDatabaseDelete('postgres', db.id)}
                        disabled={dbActionBusyId === db.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-900/50 text-xs font-mono transition disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Connection Details snippet */}
                <div className="p-3 bg-black rounded-xl border border-zinc-800/80 font-mono text-xs text-zinc-300 flex items-center justify-between">
                  <span className="text-purple-300 truncate">{db.connectionString}</span>
                  <span className="text-[10px] text-zinc-500 uppercase ml-2 shrink-0">Direct 5432</span>
                </div>
              </div>
            ))}
          </div>

          {/* Interactive SQL Query Studio (live against the selected instance) */}
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-purple-400" />
                  <span>Interactive SQL Query Studio (Live)</span>
                </h3>
                <p className="text-[11px] text-zinc-400">
                  Read-only console executing for real against the selected instance. Results include true latency and row counts.
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={selectedSqlDb?.id ?? ''}
                  onChange={(e) => setSqlDbId(e.target.value)}
                  disabled={availablePgDbs.length === 0}
                  className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-purple-500 disabled:opacity-50"
                >
                  {availablePgDbs.length === 0 ? (
                    <option value="">No instance available</option>
                  ) : (
                    availablePgDbs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))
                  )}
                </select>

                <button
                  onClick={handleExecuteSql}
                  disabled={isExecutingSql || !selectedSqlDb}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition disabled:opacity-50"
                >
                  {isExecutingSql ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-white" />}
                  <span>Execute Query</span>
                </button>
              </div>
            </div>

            {/* Sample queries */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase text-zinc-500">Samples:</span>
              {SQL_SAMPLES.map((q) => (
                <button
                  key={q}
                  onClick={() => setSqlQuery(q)}
                  className="px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-[10px] font-mono text-zinc-300 transition"
                >
                  {q}
                </button>
              ))}
            </div>

            <textarea
              rows={4}
              value={sqlQuery}
              onChange={(e) => setSqlQuery(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono text-xs text-purple-200 focus:outline-none focus:border-purple-500"
            />

            {sqlError && (
              <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-xs font-mono text-rose-300">
                &#10005; {sqlError}
              </div>
            )}

            {sqlResults && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-zinc-400">
                  <span className="text-emerald-400">&#10003; {sqlResults.rowCount ?? 0} rows</span>
                  <span>{sqlResults.executionMs ?? 0}ms</span>
                  {selectedSqlDb && <span>on {selectedSqlDb.name}</span>}
                  {sqlResults.note && <span className="text-zinc-600">— {sqlResults.note}</span>}
                </div>

                {sqlResults.rows && sqlResults.rows.length > 0 ? (
                  <div className="border border-zinc-800 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                    <table className="w-full text-left text-xs font-mono">
                      <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800">
                        <tr>
                          {Object.keys(sqlResults.rows[0]).map((col) => (
                            <th key={col} className="py-2.5 px-4 whitespace-nowrap">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/60 bg-zinc-900/40">
                        {sqlResults.rows.map((row, i) => (
                          <tr key={i} className="hover:bg-zinc-800/40">
                            {Object.keys(sqlResults.rows![0]).map((col) => (
                              <td key={col} className="py-2.5 px-4 text-zinc-300 max-w-[280px] truncate">
                                {formatSqlCell(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-500 text-center">
                    Statement executed — 0 rows returned.
                  </div>
                )}
              </div>
            )}

            {!sqlResults && !sqlError && !isExecutingSql && (
              <p className="text-[11px] font-mono text-zinc-600">Run a query to see live output from the selected instance.</p>
            )}
          </div>
        </div>
      )}

      {/* REDIS VIEW */}
      {activeTab === 'redis' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4">
            {redisDbs.map((r) => (
              <div
                key={r.id}
                className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 hover:border-zinc-700 transition space-y-4"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-bold text-zinc-100">{r.name}</h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800">
                        {r.version}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                        {r.evictionPolicy}
                      </span>
                      <DbStatusPill status={r.status} onlineLabel="Online" />
                    </div>

                    <div className="flex items-center gap-4 text-xs font-mono text-zinc-400 mt-1.5">
                      <span>Memory: {r.usedMemoryMb} / {r.memoryLimitMb} MB (measured)</span>
                      <span>&bull;</span>
                      <span>Keys: {r.keyspaceSize}</span>
                      <span>&bull;</span>
                      <span>Hit Rate: {r.hitRatePercent}%</span>
                      <span>&bull;</span>
                      <span>Throughput: {r.opsPerSec} ops/sec</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyToClipboard(r.connectionString, r.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition"
                    >
                      {copiedId === r.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                      <span>Copy Redis URI</span>
                    </button>

                    {onDatabaseAction && (r.status === 'available' || r.status === 'stopped') && (
                      <button
                        onClick={() => handleDatabaseLifecycle('redis', r.id, r.status === 'available' ? 'stop' : 'start')}
                        disabled={dbActionBusyId === r.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition disabled:opacity-50"
                      >
                        {dbActionBusyId === r.id ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : r.status === 'available' ? (
                          <Square className="w-3 h-3 fill-zinc-400 text-zinc-400" />
                        ) : (
                          <Play className="w-3 h-3 fill-emerald-400 text-emerald-400" />
                        )}
                        <span>{r.status === 'available' ? 'Stop' : 'Start'}</span>
                      </button>
                    )}

                    {onDeleteDatabase && (
                      <button
                        onClick={() => handleDatabaseDelete('redis', r.id)}
                        disabled={dbActionBusyId === r.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-900/50 text-xs font-mono transition disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="p-3 bg-black rounded-xl border border-zinc-800/80 font-mono text-xs text-rose-300 truncate">
                  {r.connectionString}
                </div>
              </div>
            ))}
          </div>

          {/* Interactive Redis CLI Console (live in-memory store) */}
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-rose-400" />
                  <span>Interactive Redis Command Terminal (Live)</span>
                </h3>
                <p className="text-[11px] text-zinc-400">
                  Commands execute against the real in-memory store backing the selected instance — keys persist between calls.
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-mono uppercase text-zinc-500">Instance:</span>
                <select
                  value={selectedRedisDb?.id ?? ''}
                  onChange={(e) => setRedisDbId(e.target.value)}
                  disabled={availableRedisDbs.length === 0}
                  className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-rose-500 disabled:opacity-50"
                >
                  {availableRedisDbs.length === 0 ? (
                    <option value="">No instance available</option>
                  ) : (
                    availableRedisDbs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {/* Sample commands */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase text-zinc-500">Samples:</span>
              {REDIS_SAMPLES.map((c) => (
                <button
                  key={c}
                  onClick={() => setRedisCommand(c)}
                  className="px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-[10px] font-mono text-zinc-300 transition"
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="p-4 rounded-xl bg-black border border-zinc-800 font-mono text-xs text-zinc-300 h-56 overflow-y-auto space-y-1">
              {redisOutput.length === 0 ? (
                <div className="text-zinc-600">Run a command to see live output</div>
              ) : (
                redisOutput.map((out, idx) => (
                  <div
                    key={idx}
                    className={
                      out.startsWith('>')
                        ? 'text-rose-400 font-bold'
                        : out.startsWith('(error)')
                        ? 'text-red-400'
                        : 'text-zinc-300'
                    }
                  >
                    {out}
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={redisCommand}
                onChange={(e) => setRedisCommand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleRunRedisCommand()}
                placeholder="Enter command: SET user:token abc, GET key..."
                disabled={!selectedRedisDb}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-rose-500 disabled:opacity-50"
              />
              <button
                onClick={() => void handleRunRedisCommand()}
                disabled={isRunningRedis || !selectedRedisDb}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold disabled:opacity-50"
              >
                {isRunningRedis ? 'Running…' : 'Send Command'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 1-Click PostgreSQL Modal */}
      {isPgModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-zinc-800 p-6 space-y-4">
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <Database className="w-5 h-5 text-purple-400" />
              <span>Provision PostgreSQL Database</span>
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Cluster Name</label>
                <input
                  type="text"
                  value={newPgName}
                  onChange={(e) => setNewPgName(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">NVMe Storage (GB)</label>
                <input
                  type="number"
                  value={pgStorageGb}
                  onChange={(e) => setPgStorageGb(parseInt(e.target.value) || 20)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div className="p-3 rounded-lg bg-purple-950/30 border border-purple-800/60 flex items-center justify-between">
                <div>
                  <span className="font-bold text-purple-300 block">Enable pgvector Extension</span>
                  <span className="text-[11px] text-zinc-400">Pre-installs vector indexes for AI embeddings.</span>
                </div>
                <input
                  type="checkbox"
                  checked={pgvectorChecked}
                  onChange={(e) => setPgvectorChecked(e.target.checked)}
                  className="accent-purple-500 w-4 h-4 cursor-pointer"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setIsPgModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePostgres}
                className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold"
              >
                1-Click Provision
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 1-Click Redis Modal */}
      {isRedisModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-zinc-800 p-6 space-y-4">
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <Zap className="w-5 h-5 text-rose-400" />
              <span>Provision Redis Cache Cluster</span>
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Cluster Name</label>
                <input
                  type="text"
                  value={newRedisName}
                  onChange={(e) => setNewRedisName(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">In-Memory Limit (MB)</label>
                <input
                  type="number"
                  value={redisMemoryMb}
                  onChange={(e) => setRedisMemoryMb(parseInt(e.target.value) || 1024)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Eviction Policy</label>
                <select
                  value={redisEviction}
                  onChange={(e) => setRedisEviction(e.target.value as RedisDatabase['evictionPolicy'])}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                >
                  <option value="allkeys-lru">allkeys-lru (Standard cache eviction)</option>
                  <option value="volatile-lru">volatile-lru (Evict only keys with TTL)</option>
                  <option value="noeviction">noeviction (Return error on OOM)</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setIsRedisModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateRedis}
                className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold"
              >
                1-Click Provision
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live TCP Handshake Tester Modal */}
      {isTestConnModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-zinc-950 border border-zinc-800 p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                  <Activity className="w-5 h-5 text-cyan-400" />
                  <span>Real Database TCP Connection Tester</span>
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Executes a real server-side TCP socket probe to verify reachability and latency to any host.
                </p>
              </div>
              <button
                onClick={() => setIsTestConnModalOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 text-lg"
              >
                &times;
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTestConnType('postgres')}
                  className={`flex-1 py-1.5 rounded-lg border text-xs font-semibold transition ${
                    testConnType === 'postgres'
                      ? 'border-purple-500 bg-purple-950/40 text-purple-200'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                  }`}
                >
                  PostgreSQL (5432)
                </button>
                <button
                  type="button"
                  onClick={() => setTestConnType('redis')}
                  className={`flex-1 py-1.5 rounded-lg border text-xs font-semibold transition ${
                    testConnType === 'redis'
                      ? 'border-rose-500 bg-rose-950/40 text-rose-200'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                  }`}
                >
                  Redis (6379)
                </button>
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Connection URL / URI</label>
                <input
                  type="text"
                  value={testConnString}
                  onChange={(e) => setTestConnString(e.target.value)}
                  placeholder={
                    testConnType === 'postgres'
                      ? 'postgres://user:pass@ep-cool-fog.neon.tech:5432/neondb'
                      : 'redis://default:token@fly-cache.internal:6379'
                  }
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>

              {testConnResult && (
                <div
                  className={`p-3 rounded-xl text-xs space-y-1 ${
                    testConnResult.success
                      ? 'bg-emerald-950/60 border border-emerald-800 text-emerald-300'
                      : 'bg-rose-950/60 border border-rose-800 text-rose-300'
                  }`}
                >
                  <div className="font-bold flex items-center justify-between">
                    <span>{testConnResult.success ? '✓ Connection Verified' : '✕ Connection Failed'}</span>
                    {testConnResult.latencyMs && (
                      <span className="font-mono text-xs">{testConnResult.latencyMs}ms</span>
                    )}
                  </div>
                  <p className="text-[11px] font-mono opacity-90">
                    {testConnResult.message || testConnResult.error}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setIsTestConnModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs"
              >
                Close
              </button>
              <button
                onClick={runTestConnection}
                disabled={isTestingConn || !testConnString.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-500 text-zinc-950 hover:bg-cyan-400 text-xs font-bold disabled:opacity-50 transition"
              >
                {isTestingConn ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Testing TCP Socket...</span>
                  </>
                ) : (
                  <>
                    <Activity className="w-3.5 h-3.5" />
                    <span>Run TCP Probe</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
