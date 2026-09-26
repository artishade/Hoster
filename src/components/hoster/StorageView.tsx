'use client';

import React, { useState } from 'react';
import { PersistentVolume, S3BucketConfig } from '@/lib/hoster/types';
import { 
  HardDrive, 
  Globe, 
  Plus, 
  FileText, 
  Download, 
  Trash2, 
  Upload, 
  Check, 
  Copy, 
  Server, 
  ShieldCheck, 
  Sliders, 
  Folder,
  Layers,
  Activity,
  ArrowRight
} from 'lucide-react';

interface StorageViewProps {
  volumes: PersistentVolume[];
  s3Buckets: S3BucketConfig[];
  onCreateVolume: (vol: PersistentVolume) => void;
  onAddS3Bucket: (bucket: S3BucketConfig) => void;
  onVolumeAction?: (id: string, body: Record<string, unknown>) => Promise<void>;
  onDeleteVolume?: (id: string) => Promise<void>;
  onBucketAction?: (id: string, body: Record<string, unknown>) => Promise<void>;
  onDeleteBucket?: (id: string) => Promise<void>;
}

export default function StorageView({
  volumes,
  s3Buckets,
  onCreateVolume,
  onAddS3Bucket,
  onVolumeAction,
  onDeleteVolume,
  onBucketAction,
  onDeleteBucket,
}: StorageViewProps) {
  const [activeTab, setActiveTab] = useState<'volumes' | 's3' | 'builtin'>('volumes');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // New Volume Modal
  const [isVolModalOpen, setIsVolModalOpen] = useState(false);
  const [newVolName, setNewVolName] = useState('model-checkpoints-nvme');
  const [newVolMount, setNewVolMount] = useState('/root/.cache/huggingface');
  const [newVolSize, setNewVolSize] = useState(150);

  // New S3 Modal
  const [isS3ModalOpen, setIsS3ModalOpen] = useState(false);
  const [s3Provider, setS3Provider] = useState<'aws-s3' | 'cloudflare-r2' | 'minio'>('cloudflare-r2');
  const [s3BucketName, setS3BucketName] = useState('my-ai-weights-vault');
  const [s3Region, setS3Region] = useState('auto (weur)');
  const [s3Endpoint, setS3Endpoint] = useState('https://<account_id>.r2.cloudflarestorage.com');
  const [s3KeyId, setS3KeyId] = useState('r2_pub_key_9981');
  const [s3Secret, setS3Secret] = useState('sec_r2_token_xxxx');

  // Simulated Files in Built-in Free Storage
  const [storedFiles, setStoredFiles] = useState([
    { name: 'deepseek-r1-distill-q4.gguf', sizeMb: 4210, uploadedAt: '2 days ago', type: 'model/weights' },
    { name: 'enterprise-rag-chunks.parquet', sizeMb: 850, uploadedAt: '1 day ago', type: 'application/octet-stream' },
    { name: 'fastmcp-tool-manifest.json', sizeMb: 0.12, uploadedAt: '3 hours ago', type: 'application/json' },
    { name: 'vector-indexes-snapshot.tar.zst', sizeMb: 1240, uploadedAt: '5 hours ago', type: 'archive/zstd' },
  ]);

  const [isUploading, setIsUploading] = useState(false);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreateVolume = () => {
    const newVol: PersistentVolume = {
      id: `vol-${Date.now()}`,
      name: newVolName,
      mountPath: newVolMount,
      sizeGb: newVolSize,
      usedGb: 0,
      type: 'nvme-ssd',
      createdAt: 'Just now',
    };
    onCreateVolume(newVol);
    setIsVolModalOpen(false);
  };

  const handleAddS3 = () => {
    const newBucket: S3BucketConfig = {
      id: `s3-${Date.now()}`,
      name: `${s3BucketName} (${s3Provider})`,
      provider: s3Provider,
      bucketName: s3BucketName,
      region: s3Region,
      endpointUrl: s3Endpoint,
      accessKeyId: s3KeyId,
      isPublic: false,
      totalObjects: 12,
      totalSizeMb: 1540,
      status: 'connected',
    };
    onAddS3Bucket(newBucket);
    setIsS3ModalOpen(false);
  };

  const handleSimulateUpload = () => {
    setIsUploading(true);
    setTimeout(() => {
      setStoredFiles((prev) => [
        {
          name: `custom-embedding-dataset-${Math.floor(Math.random() * 900 + 100)}.jsonl`,
          sizeMb: 145,
          uploadedAt: 'Just now',
          type: 'application/jsonl',
        },
        ...prev,
      ]);
      setIsUploading(false);
    }, 1000);
  };

  // ── Volume actions (PATCH /api/volumes/[id]) ────────────────────────────
  const handleExtendVolume = async (vol: PersistentVolume) => {
    if (!onVolumeAction) return;
    setBusyId(vol.id);
    try {
      await onVolumeAction(vol.id, { sizeGb: vol.sizeGb + 10 });
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteVolume = async (vol: PersistentVolume) => {
    if (!onDeleteVolume) return;
    if (!window.confirm(`Delete volume "${vol.name}"? All data on it will be lost.`)) return;
    setBusyId(vol.id);
    try {
      await onDeleteVolume(vol.id);
    } finally {
      setBusyId(null);
    }
  };

  // ── Bucket actions (PATCH /api/buckets/[id]) ────────────────────────────
  const handleTestBucket = async (bucket: S3BucketConfig) => {
    if (!onBucketAction) return;
    setBusyId(bucket.id);
    try {
      await onBucketAction(bucket.id, { action: 'test_connection' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteBucket = async (bucket: S3BucketConfig) => {
    if (!onDeleteBucket) return;
    if (!window.confirm(`Remove bucket connection "${bucket.name}"?`)) return;
    setBusyId(bucket.id);
    try {
      await onDeleteBucket(bucket.id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div>
          <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-cyan-400" />
            <span>Storage &amp; Persistent Volume Fabric</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Free built-in object storage, custom S3 buckets (AWS S3 &amp; Cloudflare R2), and High-IOPS NVMe volume mounts
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsVolModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create NVMe Volume</span>
          </button>

          <button
            onClick={() => setIsS3ModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Custom S3 Bucket</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-800 text-xs font-medium">
        <button
          onClick={() => setActiveTab('volumes')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'volumes'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <HardDrive className="w-4 h-4 text-cyan-400" />
          <span>Persistent NVMe Volumes ({volumes.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('s3')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 's3'
              ? 'border-emerald-400 text-emerald-300 bg-emerald-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Globe className="w-4 h-4 text-emerald-400" />
          <span>Custom S3 &amp; Cloudflare R2 Buckets ({s3Buckets.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('builtin')}
          className={`flex items-center gap-2 px-4 py-2.5 border-b-2 transition ${
            activeTab === 'builtin'
              ? 'border-indigo-400 text-indigo-300 bg-indigo-950/20'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Layers className="w-4 h-4 text-indigo-400" />
          <span>Free Built-in Storage (50GB Free Tier)</span>
        </button>
      </div>

      {/* TAB 1: PERSISTENT VOLUMES */}
      {activeTab === 'volumes' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-cyan-950/20 border border-cyan-800/40 text-xs text-zinc-300 flex items-start gap-3">
            <HardDrive className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-cyan-300">Why NVMe Persistent Volumes?</span>
              <p className="text-zinc-400 text-[11px] mt-0.5">
                AI model weights (such as DeepSeek, Llama, Whisper) are several gigabytes in size. By mounting an NVMe volume to <code className="text-zinc-200">/root/.cache/huggingface</code> or <code className="text-zinc-200">/models</code>, your servers retain checkpoints during auto-scaling and never waste bandwidth re-downloading model weights.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {volumes.map((vol) => (
              <div
                key={vol.id}
                className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 hover:border-zinc-700 transition space-y-3"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-bold text-zinc-100">{vol.name}</h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 uppercase font-semibold">
                        {vol.type}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                        {vol.sizeGb} GB Total
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs font-mono text-zinc-400 mt-1.5">
                      <span className="text-cyan-400">Mount Path: {vol.mountPath}</span>
                      <span>&bull;</span>
                      <span>Used: {vol.usedGb} GB ({Math.round((vol.usedGb / vol.sizeGb) * 100)}%)</span>
                      <span>&bull;</span>
                      <span>Attached to: {vol.attachedToServiceId || 'Standby (available)'}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyToClipboard(vol.mountPath, vol.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition"
                    >
                      {copiedId === vol.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                      <span>Copy Path</span>
                    </button>

                    {onVolumeAction && (
                      <button
                        onClick={() => handleExtendVolume(vol)}
                        disabled={busyId === vol.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition disabled:opacity-50"
                      >
                        <Plus className={`w-3.5 h-3.5 text-cyan-400 ${busyId === vol.id ? 'animate-pulse' : ''}`} />
                        <span>{busyId === vol.id ? 'Extending…' : 'Extend +10GB'}</span>
                      </button>
                    )}

                    {onDeleteVolume && (
                      <button
                        onClick={() => handleDeleteVolume(vol)}
                        disabled={busyId === vol.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-900/50 text-xs font-mono transition disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress usage bar */}
                <div className="w-full bg-zinc-950 h-2 rounded-full overflow-hidden border border-zinc-800">
                  <div
                    className="bg-cyan-400 h-full rounded-full transition-all"
                    style={{ width: `${(vol.usedGb / vol.sizeGb) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 2: S3 & CLOUDFLARE R2 */}
      {activeTab === 's3' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            {s3Buckets.map((bucket) => (
              <div
                key={bucket.id}
                className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 hover:border-zinc-700 transition space-y-3"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-bold text-zinc-100">{bucket.name}</h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 uppercase font-semibold">
                        {bucket.provider}
                      </span>
                      <span className={`flex items-center gap-1 text-[11px] font-mono ${bucket.status === 'connected' ? 'text-emerald-400' : 'text-red-400'}`}>
                        <ShieldCheck className="w-3 h-3" />
                        {bucket.status === 'connected' ? 'Connected' : 'Error — unreachable'}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs font-mono text-zinc-400 mt-1.5">
                      <span>Bucket: {bucket.bucketName}</span>
                      <span>&bull;</span>
                      <span>Region: {bucket.region}</span>
                      <span>&bull;</span>
                      <span>Objects: {bucket.totalObjects.toLocaleString()}</span>
                      <span>&bull;</span>
                      <span>Size: {(bucket.totalSizeMb / 1024).toFixed(1)} GB</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyToClipboard(bucket.bucketName, bucket.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition"
                    >
                      {copiedId === bucket.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                      <span>Copy Bucket Name</span>
                    </button>

                    {onBucketAction && (
                      <button
                        onClick={() => handleTestBucket(bucket)}
                        disabled={busyId === bucket.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition disabled:opacity-50"
                      >
                        <Activity className={`w-3.5 h-3.5 text-cyan-400 ${busyId === bucket.id ? 'animate-pulse' : ''}`} />
                        <span>{busyId === bucket.id ? 'Testing…' : 'Test Connection'}</span>
                      </button>
                    )}

                    {onDeleteBucket && (
                      <button
                        onClick={() => handleDeleteBucket(bucket)}
                        disabled={busyId === bucket.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-900/50 text-xs font-mono transition disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {bucket.endpointUrl && (
                  <div className="p-2.5 bg-black rounded-lg border border-zinc-800 font-mono text-xs text-emerald-300 truncate">
                    Endpoint: {bucket.endpointUrl}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: BUILT-IN FREE STORAGE */}
      {activeTab === 'builtin' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-400" />
                <span>NexusHost Free Object Storage (Render / Fly Native)</span>
              </h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                50 GB fast SSD edge-replicated object storage with zero egress fees included with every workspace.
              </p>
            </div>

            <button
              onClick={handleSimulateUpload}
              disabled={isUploading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{isUploading ? 'Uploading...' : 'Upload File'}</span>
            </button>
          </div>

          {/* Files List */}
          <div className="border border-zinc-800 rounded-2xl overflow-hidden bg-zinc-900/40">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800">
                <tr>
                  <th className="py-3 px-4">Filename</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4">Size</th>
                  <th className="py-3 px-4">Uploaded</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {storedFiles.map((file, i) => (
                  <tr key={i} className="hover:bg-zinc-800/40">
                    <td className="py-3 px-4 text-zinc-200 font-medium flex items-center gap-2">
                      <FileText className="w-4 h-4 text-cyan-400" />
                      <span>{file.name}</span>
                    </td>
                    <td className="py-3 px-4 text-zinc-400">{file.type}</td>
                    <td className="py-3 px-4 text-cyan-300 font-bold">{file.sizeMb} MB</td>
                    <td className="py-3 px-4 text-zinc-500">{file.uploadedAt}</td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => copyToClipboard(`https://storage.nexushost.dev/download/${file.name}`, `file-${i}`)}
                        className="text-xs text-indigo-400 hover:text-indigo-300 font-sans font-medium"
                      >
                        {copiedId === `file-${i}` ? 'Link Copied!' : 'Get Link'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Volume Modal */}
      {isVolModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-zinc-800 p-6 space-y-4">
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-cyan-400" />
              <span>Create Persistent NVMe SSD Volume</span>
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Volume Name</label>
                <input
                  type="text"
                  value={newVolName}
                  onChange={(e) => setNewVolName(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Mount Path in Container</label>
                <input
                  type="text"
                  value={newVolMount}
                  onChange={(e) => setNewVolMount(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Size (GB)</label>
                <input
                  type="number"
                  min={20}
                  max={2000}
                  value={newVolSize}
                  onChange={(e) => setNewVolSize(parseInt(e.target.value) || 50)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setIsVolModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateVolume}
                className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
              >
                Create Volume
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add S3 Bucket Modal */}
      {isS3ModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-zinc-800 p-6 space-y-4">
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <Globe className="w-5 h-5 text-emerald-400" />
              <span>Connect S3 / Cloudflare R2 Bucket</span>
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Storage Provider</label>
                <select
                  value={s3Provider}
                  onChange={(e) => setS3Provider(e.target.value as 'aws-s3' | 'cloudflare-r2' | 'minio')}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                >
                  <option value="cloudflare-r2">Cloudflare R2 (Zero Egress Fees for AI Weights)</option>
                  <option value="aws-s3">Amazon AWS S3</option>
                  <option value="minio">MinIO Object Store</option>
                </select>
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Bucket Name</label>
                <input
                  type="text"
                  value={s3BucketName}
                  onChange={(e) => setS3BucketName(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Endpoint URL (For R2 / MinIO)</label>
                <input
                  type="text"
                  value={s3Endpoint}
                  onChange={(e) => setS3Endpoint(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Access Key ID</label>
                <input
                  type="text"
                  value={s3KeyId}
                  onChange={(e) => setS3KeyId(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>

              <div>
                <label className="text-zinc-300 block mb-1 font-medium">Secret Access Key</label>
                <input
                  type="password"
                  value={s3Secret}
                  onChange={(e) => setS3Secret(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setIsS3ModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleAddS3}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
              >
                Verify &amp; Attach
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
