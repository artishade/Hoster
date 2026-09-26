export type ServiceType = 'api' | 'mcp' | 'plugin';

export type ServiceStatus = 'running' | 'deploying' | 'building' | 'stopped' | 'failed';

export type HardwareTier = 
  | 'local-node'
  | 'free-blitz'
  | 'free-hf-space'
  | 'free-render'
  | 'free-fly'
  | 'free-koyeb'
  | 'custom-vps'
  | 'cpu-nano'
  | 'cpu-standard'
  | 'cpu-highmem'
  | 'gpu-rtx4090'
  | 'gpu-l4'
  | 'gpu-a100-40gb'
  | 'gpu-a100-80gb'
  | 'gpu-h100-80gb';

export type ProviderType = 'local' | 'huggingface' | 'render' | 'fly' | 'runpod' | 'koyeb' | 'custom_agent' | 'custom_probe';

export interface GpuInfo {
  detected: boolean;
  vendor?: 'nvidia' | 'amd';
  model?: string;
  vramTotalMb?: number;
  vramUsedMb?: number;
  utilPercent?: number;
  tempC?: number;
  driverVersion?: string;
  cudaVersion?: string;
  source?: string; // which detector produced it
  note?: string;
}

export interface LiveSystemMetrics {
  timestamp: string;
  os: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
    uptimeSeconds: number;
    nodeVersion: string;
  };
  cpu: {
    model: string;
    cores: number;
    speedMhz: number;
    usagePercent: number;
    loadAvg: [number, number, number];
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    totalGb: number;
    usedGb: number;
    processHeapUsedMb: number;
    processRssMb: number;
  };
  storage: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
    usedPercent: number;
    mountPath: string;
    filesystem?: string;
  };
  gpu: GpuInfo;
  network?: {
    rxKbPerSec: number;
    txKbPerSec: number;
    totalRxMb: number;
    totalTxMb: number;
  };
}

export interface ConnectedProvider {
  id: string;
  name: string;
  type: ProviderType;
  category: 'free_cloud' | 'local_node' | 'custom_server' | 'gpu_cloud';
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  apiKeyOrToken?: string;
  endpointUrl?: string;
  accountEmail?: string;
  accountPlan?: string;
  lastChecked?: string;
  pingLatencyMs?: number;
  capacity: {
    vCpu: number;
    ramGb: number;
    gpuModel?: string;
    vramGb?: number;
    storageGb: number;
  };
  allocated: {
    vCpu: number;
    ramGb: number;
    vramGb?: number;
    servicesCount: number;
  };
  features: string[];
  isBuiltInFree: boolean;
  notes?: string;
}

export interface CustomServerNode {
  id: string;
  name: string;
  ipOrHost: string;
  connectionMethod: 'agent' | 'probe_url' | 'manual';
  status: 'online' | 'offline' | 'warning';
  agentToken?: string;
  healthUrl?: string;
  lastHeartbeat?: string;
  pingMs?: number;
  hardware: {
    vCpu: number;
    ramGb: number;
    gpuModel?: string;
    vramGb?: number;
    storageGb: number;
  };
  liveMetrics?: {
    cpuPercent: number;
    ramPercent: number;
    gpuPercent?: number;
    gpuTempC?: number;
    diskPercent: number;
  };
  tags: string[];
  osInfo?: string;
  notes?: string;
}

export interface HardwareSpec {
  id: HardwareTier;
  name: string;
  category: 'cpu' | 'gpu';
  vCpu: number;
  ramGb: number;
  gpuModel?: string;
  vramGb?: number;
  priceHourly: number;
  description: string;
  recommendedFor: string;
}

export interface PersistentVolume {
  id: string;
  name: string;
  mountPath: string; // e.g. /models or /data
  sizeGb: number;
  usedGb: number;
  type: 'nvme-ssd' | 'gp3-ssd';
  attachedToServiceId?: string;
  createdAt: string;
}

export interface S3BucketConfig {
  id: string;
  name: string;
  provider: 'aws-s3' | 'cloudflare-r2' | 'minio' | 'built-in-storage';
  bucketName: string;
  region: string;
  endpointUrl?: string;
  accessKeyId: string;
  isPublic: boolean;
  totalObjects: number;
  totalSizeMb: number;
  status: 'connected' | 'error';
}

export interface CustomDomain {
  id: string;
  serviceId: string;
  serviceName: string;
  domain: string;
  cnameTarget: string;
  sslStatus: 'active' | 'pending' | 'failed';
  dnsConfigured: boolean;
  createdAt: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  exampleInput?: Record<string, any>;
}

export interface McpResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface VerifyResult {
  success: boolean;
  latencyMs?: number;
  message?: string;
  error?: string;
  account?: Record<string, unknown>;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

export interface EnvVariable {
  key: string;
  value: string;
  isSecret: boolean;
}

/** Live state of the real HTTP runner / deployed process serving a service. */
/** One scale-out worker process (autoscaling) — a REAL app process on its own port. */
export interface RuntimeWorker {
  pid: number;
  port: number;
  startedAt: string;
}

export interface ServiceRuntime {
  pid: number;
  port: number;
  startedAt: string;
  mode: 'builtin-runner' | 'git-deploy';
  healthy: boolean;
  /** Real commit deployed (git-deploy mode). */
  commit?: string;
  /** Workspace dir of the cloned repo (git-deploy mode). */
  repoDir?: string;
  /** Scale-out workers beyond the primary (autoscaling) — real pids on real ports. */
  workers?: RuntimeWorker[];
  /** The exact (post-transform) boot command — replayed verbatim when scaling out. */
  startCmd?: string;
  /** Autoscaler bookkeeping — last decision timestamp (epoch ms). */
  lastScaleAt?: number;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  type: ServiceType; // api, mcp, plugin
  status: ServiceStatus;
  repoUrl: string;
  branch: string;
  commitHash: string;
  commitMessage: string;
  deployedAt: string;
  url: string;
  /** Same-origin ingress that actually serves the service (no DNS needed). */
  ingressPath: string;
  /** Present while the service is running — real listener on the control-plane host. */
  runtime?: ServiceRuntime;
  hardwareTier: HardwareTier;
  region: string;
  instances: {
    min: number;
    max: number;
    current: number;
    scaleToZero: boolean;
    scaleToZeroDelaySec: number;
    /** Webhook→autoscale coordination: scale to max as soon as a webhook-triggered redeploy is running (pre-traffic warm-up). */
    scaleOnDeploy: boolean;
  };
  metrics: {
    cpuPercent: number;
    ramUsedGb: number;
    ramTotalGb: number;
    gpuUtilPercent?: number;
    gpuVramUsedGb?: number;
    gpuVramTotalGb?: number;
    requestsPerMin: number;
    latencyP95Ms: number;
    activeMcpClients?: number;
    bandwidthInMb: number;
    bandwidthOutMb: number;
  };
  buildCommand: string;
  startCommand: string;
  port: number;
  protocol: 'http' | 'sse' | 'stdio-proxy' | 'websocket';
  /** Per-service deploy-webhook secret (HMAC for GitHub push, bearer for generic CI). */
  webhookSecret?: string;
  envVars: EnvVariable[];
  customDomains: string[];
  attachedPostgresId?: string;
  attachedRedisId?: string;
  volumeMounts: {
    volumeId: string;
    mountPath: string;
  }[];
  s3BucketId?: string;
  mcpDetails?: {
    protocolVersion: string;
    tools: McpTool[];
    resources: McpResource[];
    prompts: McpPrompt[];
  };
  pluginDetails?: {
    manifestUrl: string;
    openApiUrl: string;
    authType: 'none' | 'bearer' | 'oauth';
  };
}

export interface PostgresDatabase {
  id: string;
  name: string;
  version: string;
  region: string;
  status: 'available' | 'provisioning' | 'maintenance' | 'stopped';
  storageGb: number;
  usedStorageGb: number;
  pgvectorEnabled: boolean;
  connectionString: string;
  pooledConnectionString: string;
  activeConnections: number;
  maxConnections: number;
  totalQueries: number;
  queriesLastMin: number;
  storageUsedMb: number;
  createdAt: string;
  attachedServiceIds: string[];
}

export interface RedisDatabase {
  id: string;
  name: string;
  version: string;
  region: string;
  status: 'available' | 'provisioning' | 'stopped';
  memoryLimitMb: number;
  usedMemoryMb: number;
  evictionPolicy: 'allkeys-lru' | 'volatile-lru' | 'noeviction';
  connectionString: string;
  keyspaceSize: number;
  hitRatePercent: number;
  opsPerSec: number;
  totalOps: number;
  createdAt: string;
  attachedServiceIds: string[];
}

// ─── Shared action/payload contracts (page ⇄ views) ─────────────────────────

export type SettingsViewProvider = ConnectedProvider & {
  record?: { hasToken: boolean; tokenLast4: string | null; endpointUrl: string | null; slug: string; isBuiltIn: boolean };
};

export interface NewProviderPayload {
  name: string;
  type: string;
  endpointUrl?: string;
  token?: string;
  capacity?: { vCpu?: number; ramGb?: number; gpuModel?: string; vramGb?: number; storageGb?: number };
  tags?: string[];
  notes?: string;
}

export interface ProviderActionResult {
  success: boolean;
  error?: string;
  verify?: VerifyResult;
  agentToken?: string | null;
}

export interface HostHistoryPoint {
  timestamp: string;
  cpuPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  netInMb?: number | null;
  netOutMb?: number | null;
}

/** REAL usage metering report (GET /api/usage). */
export interface UsageReport {
  windowDays: number;
  global: {
    instanceHours: number;
    requests: number;
    egressMb: number;
    equivalentCostUsd: number;
    paidUsd: number;
    liveInstances: number;
    unflushedRequests: number;
  };
  today: {
    day: string;
    equivalentUsd: number;
    hoursElapsed: number;
    runRateUsdPerDay: number;
  };
  projection: {
    hoursPerMonth: number;
    globalCurrentUsd: number;
    globalMaxUsd: number;
    perService: {
      serviceId: string;
      name: string;
      status: string;
      tier: string;
      ratePerHourUsd: number;
      currentInstances: number;
      maxInstances: number;
      autoscaleCapable: boolean;
      projectedCurrentUsd: number;
      projectedMaxUsd: number;
    }[];
  };
  perDay: {
    day: string;
    instanceHours: number;
    requests: number;
    egressMb: number;
    equivalentCostUsd: number;
  }[];
  perService: {
    serviceId: string;
    name: string;
    status: string;
    tier: string;
    instanceHours: number;
    requests: number;
    egressMb: number;
    equivalentCostUsd: number;
    ratePerHourUsd: number;
    firstSeenDay: string | null;
    lastSeenDay: string | null;
  }[];
  rates: { formula: string; note: string };
}

export interface ProvisionDatabasePayload {
  kind: 'postgres' | 'redis';
  name: string;
  region?: string;
  storageGb?: number;
  pgvectorEnabled?: boolean;
  memoryLimitMb?: number;
  evictionPolicy?: string;
}

export interface CreateVolumePayload {
  name: string;
  mountPath: string;
  sizeGb: number;
  type?: string;
}

export interface CreateBucketPayload {
  name: string;
  provider: string;
  bucketName: string;
  region?: string;
  endpointUrl?: string;
  accessKeyId?: string;
  isPublic?: boolean;
}
