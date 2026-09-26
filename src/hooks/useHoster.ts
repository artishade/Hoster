'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Service,
  PostgresDatabase,
  RedisDatabase,
  PersistentVolume,
  S3BucketConfig,
  CustomDomain,
  LogEntry,
  LiveSystemMetrics,
  HostHistoryPoint,
  SettingsViewProvider,
  CustomServerNode,
  ProviderActionResult,
  NewProviderPayload,
} from '@/lib/hoster/types';
import type { DeployPayload as ModalDeployPayload } from '@/components/hoster/DeployModal';

export type DeployPayload = ModalDeployPayload;

/** Typed fetch wrapper for the NexusHost control-plane API ({ data } / { error }). */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
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

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Shared resilience options for control-plane queries.
 *
 * On serverless hosts (Vercel, Netlify…) every API request can hit a cold
 * start: the first call is slow and may time out. Retrying a couple of times
 * with back-end, keeping already-fetched data visible (no blanking on
 * refetch) and skipping window-focus refetch storms keeps the dashboard calm
 * instead of flashing "Connecting…" every few seconds.
 */
const QUERY_OPTS = {
  retry: 2,
  retryDelay: (attempt: number) => Math.min(1200 * 2 ** attempt, 5000),
  refetchOnWindowFocus: false,
  staleTime: 2000,
} as const;

export function useServices() {
  return useQuery({
    queryKey: ['services'],
    queryFn: () => api<Service[]>('/api/services'),
    refetchInterval: 3500,
    ...QUERY_OPTS,
  });
}

export function useService(id: string | null) {
  return useQuery({
    queryKey: ['services', id],
    queryFn: () => api<Service>(`/api/services/${id}`),
    enabled: !!id,
    refetchInterval: 2500,
    ...QUERY_OPTS,
  });
}

export function useDatabases() {
  return useQuery({
    queryKey: ['databases'],
    queryFn: () => api<{ postgres: PostgresDatabase[]; redis: RedisDatabase[] }>('/api/databases'),
    refetchInterval: 5000,
    ...QUERY_OPTS,
  });
}

export function useVolumes() {
  return useQuery({
    queryKey: ['volumes'],
    queryFn: () => api<PersistentVolume[]>('/api/volumes'),
    refetchInterval: 8000,
    ...QUERY_OPTS,
  });
}

export function useBuckets() {
  return useQuery({
    queryKey: ['buckets'],
    queryFn: () => api<S3BucketConfig[]>('/api/buckets'),
    refetchInterval: 8000,
    ...QUERY_OPTS,
  });
}

export function useDomains() {
  return useQuery({
    queryKey: ['domains'],
    queryFn: () => api<CustomDomain[]>('/api/domains'),
    refetchInterval: 8000,
    ...QUERY_OPTS,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ providers: SettingsViewProvider[]; nodes: CustomServerNode[] }>('/api/providers'),
    refetchInterval: 6000,
    ...QUERY_OPTS,
  });
}

export function useHostMetrics() {
  return useQuery({
    queryKey: ['system', 'metrics'],
    queryFn: () => api<LiveSystemMetrics>('/api/system/metrics'),
    refetchInterval: 2500,
    ...QUERY_OPTS,
  });
}

export function useHostHistory(points = 80) {
  return useQuery({
    queryKey: ['system', 'history', points],
    queryFn: () => api<HostHistoryPoint[]>(`/api/system/history?points=${points}`),
    refetchInterval: 15000,
    ...QUERY_OPTS,
  });
}

export function useLogs(filter: { scope?: string; serviceId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.scope) params.set('scope', filter.scope);
  if (filter.serviceId) params.set('serviceId', filter.serviceId);
  params.set('limit', String(filter.limit ?? 80));
  return useQuery({
    queryKey: ['logs', filter.scope ?? '', filter.serviceId ?? '', filter.limit ?? 80],
    queryFn: () => api<LogEntry[]>(`/api/logs?${params.toString()}`),
    refetchInterval: 5000,
    ...QUERY_OPTS,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useDeployService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: DeployPayload | ModalDeployPayload) =>
      api<{ ok: true }>('/api/services', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services'] }),
  });
}

/** Deploy returning the created service id (used by the deploy terminal). */
export function useDeployServiceWithId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: DeployPayload | ModalDeployPayload) => {
      const res = await fetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) return { success: false as const, error: json?.error ?? `HTTP ${res.status}` };
      return { success: true as const, serviceId: json?.data?.id as string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services'] }),
  });
}

export function useServiceAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<Service>(`/api/services/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate('services', 'providers'),
  });
}

export function useDeleteService() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/services/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('services', 'providers', 'domains', 'logs'),
  });
}

export function useProvisionDatabase() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (payload: { kind: 'postgres' | 'redis'; name: string; region?: string; storageGb?: number; pgvectorEnabled?: boolean; memoryLimitMb?: number; evictionPolicy?: string }) =>
      api<unknown>('/api/databases', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => invalidate('databases', 'logs'),
  });
}

export function useDatabaseAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind, action }: { id: string; kind: 'postgres' | 'redis'; action: 'start' | 'stop' }) =>
      api<unknown>(`/api/databases/${id}?kind=${kind}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
    onSuccess: () => invalidate('databases', 'logs'),
  });
}

export function useDeleteDatabase() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'postgres' | 'redis' }) =>
      api<{ ok: true }>(`/api/databases/${id}?kind=${kind}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('databases', 'logs', 'services'),
  });
}

export function useCreateVolume() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (payload: { name: string; mountPath: string; sizeGb: number; type?: string }) =>
      api<unknown>('/api/volumes', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => invalidate('volumes', 'logs'),
  });
}

export function useVolumeAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/api/volumes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate('volumes'),
  });
}

export function useDeleteVolume() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/volumes/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('volumes', 'logs'),
  });
}

export function useCreateBucket() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (payload: { name: string; provider: string; bucketName: string; region?: string; endpointUrl?: string; accessKeyId?: string; isPublic?: boolean }) =>
      api<unknown>('/api/buckets', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => invalidate('buckets', 'logs'),
  });
}

export function useBucketAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/api/buckets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate('buckets'),
  });
}

export function useDeleteBucket() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/buckets/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('buckets', 'logs'),
  });
}

export function useCreateDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (payload: { serviceId: string; domain: string }) =>
      api<unknown>('/api/domains', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => invalidate('domains', 'logs'),
  });
}

export function useDomainAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api<unknown>(`/api/domains/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
    onSuccess: () => invalidate('domains'),
  });
}

export function useDeleteDomain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/domains/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('domains', 'logs'),
  });
}

// ─── Provider mutations (Settings + Nodes views) ────────────────────────────

export function useAddProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (payload: NewProviderPayload) => {
      try {
        const data = await api<{ provider: SettingsViewProvider | CustomServerNode; verify?: ProviderActionResult['verify']; agentToken?: string | null }>(
          '/api/providers',
          { method: 'POST', body: JSON.stringify(payload) }
        );
        return { success: true, verify: data.verify, agentToken: data.agentToken ?? null } as ProviderActionResult;
      } catch (err) {
        return { success: false, error: (err as Error).message } as ProviderActionResult;
      }
    },
    onSuccess: () => invalidate('providers', 'logs'),
  });
}

export function useConnectProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, token, endpointUrl }: { id: string; token: string | null; endpointUrl?: string | null }) => {
      try {
        const data = await api<{ provider: unknown; verify: ProviderActionResult['verify'] }>(`/api/providers/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'connect', token, endpointUrl }),
        });
        return { success: !!data.verify?.success, error: data.verify?.error, verify: data.verify } as ProviderActionResult;
      } catch (err) {
        return { success: false, error: (err as Error).message } as ProviderActionResult;
      }
    },
    onSuccess: () => invalidate('providers', 'logs'),
  });
}

export function useDisconnectProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await api<unknown>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'disconnect' }) });
        return { success: true } as ProviderActionResult;
      } catch (err) {
        return { success: false, error: (err as Error).message } as ProviderActionResult;
      }
    },
    onSuccess: () => invalidate('providers', 'logs'),
  });
}

export function useTestProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        const data = await api<{ verify: ProviderActionResult['verify'] }>(`/api/providers/${id}/test`, { method: 'POST' });
        return { success: !!data.verify?.success, error: data.verify?.error, verify: data.verify } as ProviderActionResult;
      } catch (err) {
        return { success: false, error: (err as Error).message } as ProviderActionResult;
      }
    },
    onSuccess: () => invalidate('providers'),
  });
}

export function useDeleteProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await api<{ ok: true }>(`/api/providers/${id}`, { method: 'DELETE' });
        return { success: true } as ProviderActionResult;
      } catch (err) {
        return { success: false, error: (err as Error).message } as ProviderActionResult;
      }
    },
    onSuccess: () => invalidate('providers', 'logs'),
  });
}
