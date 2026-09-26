'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import Navbar, { type ConnectionState } from '@/components/hoster/Navbar';
import Sidebar from '@/components/hoster/Sidebar';
import MobileSidePanel from '@/components/hoster/MobileSidePanel';
import ServicesList from '@/components/hoster/ServicesList';
import ServiceDetailView from '@/components/hoster/ServiceDetailView';
import DatabasesView from '@/components/hoster/DatabasesView';
import StorageView from '@/components/hoster/StorageView';
import CustomDomainsView from '@/components/hoster/CustomDomainsView';
import EdgeNetworkView from '@/components/hoster/EdgeNetworkView';
import ActivityFeedView from '@/components/hoster/ActivityFeedView';
import McpInspectorView from '@/components/hoster/McpInspectorView';
import CloudNodesView from '@/components/hoster/CloudNodesView';
import SettingsView from '@/components/hoster/SettingsView';
import DeployModal from '@/components/hoster/DeployModal';
import AiArchitectureAdvisorModal from '@/components/hoster/AiArchitectureAdvisorModal';

import {
  useServices,
  useDatabases,
  useVolumes,
  useBuckets,
  useDomains,
  useProviders,
  useHostMetrics,
  useHostHistory,
  useDeployServiceWithId,
  useServiceAction,
  useDeleteService,
  useProvisionDatabase,
  useDatabaseAction,
  useDeleteDatabase,
  useCreateVolume,
  useVolumeAction,
  useDeleteVolume,
  useCreateBucket,
  useBucketAction,
  useDeleteBucket,
  useCreateDomain,
  useDomainAction,
  useDeleteDomain,
  useAddProvider,
  useConnectProvider,
  useDisconnectProvider,
  useTestProvider,
  useDeleteProvider,
} from '@/hooks/useHoster';

import type { Service, PostgresDatabase, RedisDatabase, PersistentVolume, S3BucketConfig, CustomDomain } from '@/lib/hoster/types';

export default function HomePage() {
  // ── Live data from the control plane ──────────────────────────────────────
  const servicesQ = useServices();
  const databasesQ = useDatabases();
  const volumesQ = useVolumes();
  const bucketsQ = useBuckets();
  const domainsQ = useDomains();
  const providersQ = useProviders();
  const hostMetricsQ = useHostMetrics();
  const hostHistoryQ = useHostHistory(90);

  const services = servicesQ.data ?? [];
  const postgresDbs = databasesQ.data?.postgres ?? [];
  const redisDbs = databasesQ.data?.redis ?? [];
  const volumes = volumesQ.data ?? [];
  const s3Buckets = bucketsQ.data ?? [];
  const domains = domainsQ.data ?? [];
  const providers = providersQ.data?.providers ?? [];
  const nodes = providersQ.data?.nodes ?? [];

  // ── Mutations ─────────────────────────────────────────────────────────────
  const deployMutation = useDeployServiceWithId();
  const serviceAction = useServiceAction();
  const deleteService = useDeleteService();
  const provisionDb = useProvisionDatabase();
  const databaseAction = useDatabaseAction();
  const deleteDatabase = useDeleteDatabase();
  const createVolume = useCreateVolume();
  const volumeAction = useVolumeAction();
  const deleteVolume = useDeleteVolume();
  const createBucket = useCreateBucket();
  const bucketAction = useBucketAction();
  const deleteBucket = useDeleteBucket();
  const createDomain = useCreateDomain();
  const domainAction = useDomainAction();
  const deleteDomainM = useDeleteDomain();
  const addProvider = useAddProvider();
  const connectProvider = useConnectProvider();
  const disconnectProvider = useDisconnectProvider();
  const testProvider = useTestProvider();
  const deleteProvider = useDeleteProvider();

  // ── Navigation state ──────────────────────────────────────────────────────
  const [currentTab, setCurrentTab] = useState<string>('services');
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const selectedService = services.find((s) => s.id === selectedServiceId) ?? null;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // ── Modal state ───────────────────────────────────────────────────────────
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false);
  const [isAdvisorModalOpen, setIsAdvisorModalOpen] = useState(false);

  const handleSelectTab = (tab: string) => {
    // "AI Hardware Sizer" is a modal, not a routed view — opening it must
    // not blank the current tab.
    if (tab === 'advisor') {
      setIsAdvisorModalOpen(true);
      return;
    }
    setCurrentTab(tab);
    setSelectedServiceId(null);
  };

  const handleDeployNew = async (payload: Parameters<typeof deployMutation.mutateAsync>[0]) => {
    try {
      return await deployMutation.mutateAsync(payload as never);
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  };

  const handleUpdateService = async (updated: Service) => {
    try {
      await serviceAction.mutateAsync({
        id: updated.id,
        body: {
          envVars: updated.envVars,
          instances: updated.instances,
          buildCommand: updated.buildCommand,
          startCommand: updated.startCommand,
          description: updated.description,
          hardwareTier: updated.hardwareTier,
          customDomains: updated.customDomains,
        },
      });
      toast.success('Service configuration applied');
    } catch (err) {
      toast.error(`Update failed: ${(err as Error).message}`);
    }
  };

  const handleToggleStatus = async (serviceId: string) => {
    const svc = services.find((s) => s.id === serviceId);
    if (!svc) return;
    try {
      if (svc.status === 'running') {
        await serviceAction.mutateAsync({ id: serviceId, body: { action: 'stop' } });
        toast.success(`${svc.name} stopped — compute released`);
      } else if (svc.status === 'stopped') {
        await serviceAction.mutateAsync({ id: serviceId, body: { action: 'start' } });
        toast.success(`${svc.name} redeploying...`);
      } else {
        await serviceAction.mutateAsync({ id: serviceId, body: { action: 'restart' } });
        toast.success(`${svc.name} restarting...`);
      }
    } catch (err) {
      toast.error(`Action failed: ${(err as Error).message}`);
    }
  };

  const handleRestartService = async (serviceId: string) => {
    try {
      await serviceAction.mutateAsync({ id: serviceId, body: { action: 'restart' } });
      toast.success('Restart initiated');
    } catch (err) {
      toast.error(`Restart failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteService = async (serviceId: string) => {
    try {
      await deleteService.mutateAsync(serviceId);
      if (selectedServiceId === serviceId) setSelectedServiceId(null);
      toast.success('Service deleted');
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleProvisionPostgres = async (db: Partial<PostgresDatabase>) => {
    try {
      await provisionDb.mutateAsync({
        kind: 'postgres',
        name: db.name ?? `pg-${Date.now().toString(36)}`,
        region: db.region,
        storageGb: db.storageGb,
        pgvectorEnabled: db.pgvectorEnabled,
      });
      toast.success(`Provisioning PostgreSQL "${db.name}"...`);
    } catch (err) {
      toast.error(`Provision failed: ${(err as Error).message}`);
    }
  };

  const handleProvisionRedis = async (redis: Partial<RedisDatabase>) => {
    try {
      await provisionDb.mutateAsync({
        kind: 'redis',
        name: redis.name ?? `redis-${Date.now().toString(36)}`,
        region: redis.region,
        memoryLimitMb: redis.memoryLimitMb,
        evictionPolicy: redis.evictionPolicy,
      });
      toast.success(`Provisioning Redis "${redis.name}"...`);
    } catch (err) {
      toast.error(`Provision failed: ${(err as Error).message}`);
    }
  };

  const handleDatabaseAction = async (kind: 'postgres' | 'redis', id: string, action: 'start' | 'stop') => {
    try {
      await databaseAction.mutateAsync({ id, kind, action });
      toast.success(action === 'stop' ? 'Instance stopped' : 'Instance started');
    } catch (err) {
      toast.error(`Action failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteDatabase = async (kind: 'postgres' | 'redis', id: string) => {
    try {
      await deleteDatabase.mutateAsync({ id, kind });
      toast.success('Database deleted — storage reclaimed');
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleCreateVolume = async (vol: Partial<PersistentVolume> & { mountPath: string; sizeGb: number }) => {
    try {
      await createVolume.mutateAsync({
        name: vol.name ?? `vol-${Date.now().toString(36)}`,
        mountPath: vol.mountPath,
        sizeGb: vol.sizeGb,
        type: vol.type,
      });
      toast.success(`Provisioning volume "${vol.name}"...`);
    } catch (err) {
      toast.error(`Volume creation failed: ${(err as Error).message}`);
    }
  };

  const handleVolumeAction = async (id: string, body: Record<string, unknown>) => {
    try {
      await volumeAction.mutateAsync({ id, body });
      toast.success('Volume updated');
    } catch (err) {
      toast.error(`Volume update failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteVolume = async (id: string) => {
    try {
      await deleteVolume.mutateAsync(id);
      toast.success('Volume deleted');
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleAddS3Bucket = async (bucket: Partial<S3BucketConfig> & { bucketName: string }) => {
    try {
      await createBucket.mutateAsync({
        name: bucket.name ?? bucket.bucketName,
        provider: bucket.provider ?? 'built-in-storage',
        bucketName: bucket.bucketName,
        region: bucket.region,
        endpointUrl: bucket.endpointUrl,
        accessKeyId: bucket.accessKeyId,
        isPublic: bucket.isPublic,
      });
      toast.success(`Bucket "${bucket.bucketName}" connected`);
    } catch (err) {
      toast.error(`Bucket connection failed: ${(err as Error).message}`);
    }
  };

  const handleBucketAction = async (id: string, body: Record<string, unknown>) => {
    try {
      await bucketAction.mutateAsync({ id, body });
      toast.success('Bucket updated');
    } catch (err) {
      toast.error(`Bucket update failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteBucket = async (id: string) => {
    try {
      await deleteBucket.mutateAsync(id);
      toast.success('Bucket removed');
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleAddDomain = async (domain: Partial<CustomDomain> & { domain: string }) => {
    try {
      await createDomain.mutateAsync({
        serviceId: domain.serviceId ?? services[0]?.id ?? '',
        domain: domain.domain,
      });
      toast.success(`Domain "${domain.domain}" added — DNS verification started`);
    } catch (err) {
      toast.error(`Domain failed: ${(err as Error).message}`);
    }
  };

  const handleRecheckDomain = async (id: string) => {
    try {
      await domainAction.mutateAsync({ id, action: 'recheck_dns' });
      toast.success('DNS re-check queued');
    } catch (err) {
      toast.error(`Re-check failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteDomain = async (id: string) => {
    try {
      await deleteDomainM.mutateAsync(id);
      toast.success('Domain removed');
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  };

  // ── Derived counts ────────────────────────────────────────────────────────
  const serviceCounts = {
    total: services.length,
    api: services.filter((s) => s.type === 'api').length,
    mcp: services.filter((s) => s.type === 'mcp').length,
    plugin: services.filter((s) => s.type === 'plugin').length,
  };
  const dbCounts = { postgres: postgresDbs.length, redis: redisDbs.length };

  const loading = servicesQ.isLoading || providersQ.isLoading;

  // Control-plane link state for the navbar pill + reconnect banner.
  // "reconnecting" = the UI is up but a core API call is failing — typical on
  // serverless hosts (e.g. Vercel) while a function cold-starts.
  const coreErrored = servicesQ.isError || providersQ.isError || hostMetricsQ.isError;
  const connectionState: ConnectionState = loading ? 'connecting' : coreErrored ? 'reconnecting' : 'online';

  const handleRetryConnection = () => {
    void servicesQ.refetch();
    void providersQ.refetch();
    void hostMetricsQ.refetch();
    void databasesQ.refetch();
  };

  const sidebarNavProps = {
    currentTab,
    onSelectTab: handleSelectTab,
    serviceCounts,
    dbCounts,
    storageCount: volumes.length + s3Buckets.length,
    connectedProviders: providers.filter((p) => p.status === 'connected').length,
    hostStats: hostMetricsQ.data
      ? {
          cpuPercent: hostMetricsQ.data.cpu.usagePercent,
          ramPercent: hostMetricsQ.data.memory.usedPercent,
          ramTotalGb: hostMetricsQ.data.memory.totalGb,
          gpuDetected: hostMetricsQ.data.gpu.detected,
          gpuModel: hostMetricsQ.data.gpu.model,
        }
      : null,
  } as const;

  return (
    <div className="h-dvh min-h-[560px] bg-[#090a0f] text-zinc-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200 overflow-hidden">
      {/* Top Global Navigation Bar */}
      <Navbar
        onNewDeploy={() => setIsDeployModalOpen(true)}
        onOpenAdvisor={() => setIsAdvisorModalOpen(true)}
        activeView={currentTab}
        onSelectTab={handleSelectTab}
        onOpenMobileNav={() => setMobileNavOpen(true)}
        connectionState={connectionState}
      />

      {/* Main Container Layout — height-bounded app shell: main scrolls internally,
          sidebar never scrolls behind the sticky header (QA fix) */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Sidebar Navigation (desktop) + Mobile Side Panel (< md) */}
        <Sidebar {...sidebarNavProps} />
        <MobileSidePanel
          open={mobileNavOpen}
          onOpenChange={setMobileNavOpen}
          {...sidebarNavProps}
        />

        {/* Dynamic Content Area */}
        <main className="flex-1 min-w-0 overflow-y-auto custom-scrollbar px-4 lg:px-8 py-6">
          <div className="max-w-7xl mx-auto space-y-6">
            {/* Initial load — skeleton instead of a stuck text line */}
            {loading && (
              <div className="space-y-4" aria-busy="true" aria-live="polite">
                <div className="h-5 w-52 rounded bg-zinc-800/60 animate-pulse" />
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-28 rounded-xl bg-zinc-900/70 border border-zinc-800/60 animate-pulse" />
                  ))}
                </div>
                <p className="sr-only">Connecting to control plane…</p>
              </div>
            )}

            {/* Cold-start / transient API failure banner (e.g. serverless hosts) */}
            {!loading && connectionState === 'reconnecting' && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-xs text-amber-200"
              >
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                  Control plane reconnecting — cold start or transient error. Data will refresh automatically.
                </span>
                <button
                  onClick={handleRetryConnection}
                  className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100 font-medium transition active:scale-95"
                >
                  Retry now
                </button>
              </div>
            )}

            {/* NODES & FREE PROVIDERS VIEW */}
            {currentTab === 'providers' && (
              <CloudNodesView
                providers={providers}
                nodes={nodes}
                hostMetrics={hostMetricsQ.data ?? null}
                hostHistory={hostHistoryQ.data ?? []}
                onAddProvider={async (p) => {
                  const r = await addProvider.mutateAsync(p);
                  return { success: r.success, error: r.error, verify: r.verify, agentToken: r.agentToken ?? null };
                }}
                onConnectProvider={async (id, token, endpointUrl) => {
                  const r = await connectProvider.mutateAsync({ id, token, endpointUrl });
                  return { success: r.success, error: r.error, verify: r.verify };
                }}
                onDisconnectProvider={async (id) => {
                  const r = await disconnectProvider.mutateAsync(id);
                  return { success: r.success, error: r.error };
                }}
                onTestProvider={async (id) => {
                  const r = await testProvider.mutateAsync(id);
                  return { success: r.success, error: r.error, verify: r.verify };
                }}
                onDeleteProvider={async (id) => {
                  const r = await deleteProvider.mutateAsync(id);
                  return { success: r.success, error: r.error };
                }}
              />
            )}

            {/* DASHBOARD SETTINGS VIEW */}
            {currentTab === 'settings' && (
              <SettingsView
                providers={providers}
                nodes={nodes}
                onAddProvider={async (p) => {
                  const r = await addProvider.mutateAsync(p);
                  return { success: r.success, error: r.error, verify: r.verify, agentToken: r.agentToken ?? null };
                }}
                onConnectProvider={async (id, token, endpointUrl) => {
                  const r = await connectProvider.mutateAsync({ id, token, endpointUrl });
                  return { success: r.success, error: r.error, verify: r.verify };
                }}
                onDisconnectProvider={async (id) => {
                  const r = await disconnectProvider.mutateAsync(id);
                  return { success: r.success, error: r.error };
                }}
                onTestProvider={async (id) => {
                  const r = await testProvider.mutateAsync(id);
                  return { success: r.success, error: r.error, verify: r.verify };
                }}
                onDeleteProvider={async (id) => {
                  const r = await deleteProvider.mutateAsync(id);
                  return { success: r.success, error: r.error };
                }}
              />
            )}

            {/* SERVICES VIEW */}
            {currentTab === 'services' && (
              <>
                {selectedService ? (
                  <ServiceDetailView
                    service={selectedService}
                    onBack={() => setSelectedServiceId(null)}
                    onUpdateService={handleUpdateService}
                    postgresDbs={postgresDbs}
                    redisDbs={redisDbs}
                    volumes={volumes}
                    s3Buckets={s3Buckets}
                    onToggleServiceStatus={handleToggleStatus}
                    onRestartService={handleRestartService}
                    onDeleteService={handleDeleteService}
                  />
                ) : (
                  <ServicesList
                    services={services}
                    onSelectService={(s) => setSelectedServiceId(s.id)}
                    onDeployNew={() => setIsDeployModalOpen(true)}
                    onToggleServiceStatus={handleToggleStatus}
                    onOpenMcpInspector={(s) => {
                      setSelectedServiceId(s.id);
                      setCurrentTab('mcp-inspector');
                    }}
                  />
                )}
              </>
            )}

            {/* DATABASES & CACHE VIEW */}
            {currentTab === 'databases' && (
              <DatabasesView
                postgresDbs={postgresDbs}
                redisDbs={redisDbs}
                onProvisionPostgres={handleProvisionPostgres}
                onProvisionRedis={handleProvisionRedis}
                onDatabaseAction={handleDatabaseAction}
                onDeleteDatabase={handleDeleteDatabase}
              />
            )}

            {/* STORAGE & VOLUMES VIEW */}
            {currentTab === 'storage' && (
              <StorageView
                volumes={volumes}
                s3Buckets={s3Buckets}
                onCreateVolume={handleCreateVolume}
                onAddS3Bucket={handleAddS3Bucket}
                onVolumeAction={handleVolumeAction}
                onDeleteVolume={handleDeleteVolume}
                onBucketAction={handleBucketAction}
                onDeleteBucket={handleDeleteBucket}
              />
            )}

            {/* CUSTOM DOMAINS VIEW */}
            {currentTab === 'domains' && (
              <CustomDomainsView
                domains={domains}
                services={services}
                onAddDomain={handleAddDomain}
                onRecheckDomain={handleRecheckDomain}
                onDeleteDomain={handleDeleteDomain}
              />
            )}

            {/* EDGE NETWORK VIEW */}
            {currentTab === 'edge' && <EdgeNetworkView />}

            {/* ACTIVITY & EVENTS FEED VIEW */}
            {currentTab === 'activity' && <ActivityFeedView />}

            {/* MCP & PLUGIN STUDIO VIEW */}
            {currentTab === 'mcp-inspector' && (
              <McpInspectorView
                services={services}
                initialService={selectedService || undefined}
              />
            )}
          </div>
        </main>
      </div>

      {/* GitHub Repository Import & Automated Deploy Modal */}
      <DeployModal
        isOpen={isDeployModalOpen}
        onClose={() => setIsDeployModalOpen(false)}
        onDeploy={handleDeployNew}
        postgresDbs={postgresDbs}
        redisDbs={redisDbs}
        volumes={volumes}
        s3Buckets={s3Buckets}
      />

      {/* AI Architecture & GPU Sizing Advisor Modal */}
      <AiArchitectureAdvisorModal
        isOpen={isAdvisorModalOpen}
        onClose={() => setIsAdvisorModalOpen(false)}
      />
    </div>
  );
}
