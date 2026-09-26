import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { GpuInfo, LiveSystemMetrics } from './types';

/**
 * REAL host telemetry engine.
 * - CPU usage: delta of /proc counters via os.cpus() (accurate instantaneous %)
 * - RAM: os.totalmem / os.freemem
 * - Disk: fs.statfs on the project mount (real free/used/total)
 * - GPU: nvidia-smi or rocm-smi detection (cached 20s), graceful "none detected"
 * - Network: /proc/net/dev counter deltas (Linux)
 */

const PROJECT_DIR = process.cwd();
const GPU_CACHE_TTL_MS = 20_000;
const NET_DELTA_MIN_MS = 500;

interface CpuSnapshot {
  idle: number;
  total: number;
  at: number;
}

interface NetSnapshot {
  rxBytes: number;
  txBytes: number;
  at: number;
}

const state: {
  lastCpu?: CpuSnapshot;
  lastNet?: NetSnapshot;
  gpu?: { at: number; info: GpuInfo };
} = {};

function readCpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { idle, total, at: Date.now() };
}

// Prime the first snapshot at module load so the first request has a delta.
state.lastCpu = readCpuSnapshot();

function computeCpuUsage(): { percent: number; perCore: number[] } {
  const prev = state.lastCpu;
  const now = readCpuSnapshot();
  state.lastCpu = now;

  if (!prev || now.total <= prev.total) {
    return { percent: 0, perCore: [] };
  }
  const totalDelta = now.total - prev.total;
  const idleDelta = now.idle - prev.idle;
  const percent = Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
  return { percent: +percent.toFixed(1), perCore: [] };
}

async function readDisk(): Promise<LiveSystemMetrics['storage']> {
  try {
    const st = await fs.statfs(PROJECT_DIR);
    const bsize = st.bsize ?? 4096;
    const totalBytes = Number(st.blocks) * bsize;
    const freeBytes = Number(st.bfree) * bsize;
    const usedBytes = totalBytes - freeBytes;
    const totalGb = +(totalBytes / 1024 ** 3).toFixed(1);
    const usedGb = +(usedBytes / 1024 ** 3).toFixed(1);
    const freeGb = +(freeBytes / 1024 ** 3).toFixed(1);
    let fsName = 'unknown';
    try {
      const mounts = await fs.readFile('/proc/mounts', 'utf8');
      const line = mounts
        .split('\n')
        .filter((l) => !l.startsWith('proc') && !l.startsWith('sysfs') && !l.startsWith('devtmpfs') && !l.startsWith('tmpfs'))
        .find((l) => l.split(' ')[1] === PROJECT_DIR || PROJECT_DIR.startsWith(l.split(' ')[1] + '/'));
      if (line) fsName = line.split(' ')[2] || 'unknown';
    } catch {
      // /proc/mounts unavailable (non-Linux) — fine
    }
    return {
      totalGb,
      usedGb,
      freeGb,
      usedPercent: totalGb > 0 ? +((usedBytes / totalBytes) * 100).toFixed(1) : 0,
      mountPath: PROJECT_DIR,
      filesystem: fsName,
    };
  } catch {
    return { totalGb: 0, usedGb: 0, freeGb: 0, usedPercent: 0, mountPath: PROJECT_DIR };
  }
}

function execShort(cmd: string, args: string[], timeoutMs = 2500): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

async function detectNvidia(): Promise<GpuInfo | null> {
  try {
    const out = await execShort(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,driver_version', '--format=csv,noheader,nounits'],
      3000
    );
    const line = out.trim().split('\n')[0];
    if (!line) return null;
    const [model, vramTotal, vramUsed, util, temp, driver] = line.split(',').map((s) => s.trim());
    if (!model) return null;
    let cudaVersion: string | undefined;
    try {
      const v = await execShort('nvidia-smi', [], 2000);
      const m = v.match(/CUDA Version:\s*([\d.]+)/);
      if (m) cudaVersion = m[1];
    } catch {
      // ignore
    }
    return {
      detected: true,
      vendor: 'nvidia',
      model,
      vramTotalMb: +vramTotal || undefined,
      vramUsedMb: +vramUsed || undefined,
      utilPercent: +util || 0,
      tempC: +temp || undefined,
      driverVersion: driver || undefined,
      cudaVersion,
      source: 'nvidia-smi',
    };
  } catch {
    return null;
  }
}

async function detectAmd(): Promise<GpuInfo | null> {
  try {
    const out = await execShort('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--showuse', '--showtemp', '--json'], 3000);
    const json = JSON.parse(out);
    const firstKey = Object.keys(json)[0];
    const gpu = json[firstKey];
    if (!gpu) return null;
    return {
      detected: true,
      vendor: 'amd',
      model: gpu['Card series'] || gpu['Product Name'] || 'AMD GPU',
      vramTotalMb: gpu['VRAM Total Memory (B)'] ? Math.round(+gpu['VRAM Total Memory (B)'] / 1024 / 1024) : undefined,
      vramUsedMb: gpu['VRAM Total Used Memory (B)'] ? Math.round(+gpu['VRAM Total Used Memory (B)'] / 1024 / 1024) : undefined,
      utilPercent: gpu['GPU use (%)'] ? +gpu['GPU use (%)'] : undefined,
      tempC: gpu['Temperature (Sensor memory) (C)'] ? +gpu['Temperature (Sensor memory) (C)'] : undefined,
      source: 'rocm-smi',
    };
  } catch {
    return null;
  }
}

export async function getGpuInfo(force = false): Promise<GpuInfo> {
  const cached = state.gpu;
  if (!force && cached && Date.now() - cached.at < GPU_CACHE_TTL_MS) return cached.info;

  let info = (await detectNvidia()) || (await detectAmd());
  if (!info) {
    info = {
      detected: false,
      note: 'No discrete GPU detected on this host (nvidia-smi / rocm-smi not found). CPU + RAM + Storage telemetry is live.',
    };
  }
  state.gpu = { at: Date.now(), info };
  return info;
}

function readNetwork(): { net: LiveSystemMetrics['network'] } | null {
  if (os.platform() !== 'linux') return null;
  try {
    const data = fsSync.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of data.split('\n').slice(2)) {
      const [ifName, rest] = line.split(':');
      if (!ifName || !rest) continue;
      const name = ifName.trim();
      if (name === 'lo' || name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth')) continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] || 0;
      tx += cols[8] || 0;
    }
    const now = Date.now();
    const snapshot: NetSnapshot = { rxBytes: rx, txBytes: tx, at: now };
    const prev = state.lastNet;
    state.lastNet = snapshot;
    if (!prev || now - prev.at < NET_DELTA_MIN_MS) {
      return { net: undefined };
    }
    const sec = (now - prev.at) / 1000;
    return {
      net: {
        rxKbPerSec: +((rx - prev.rxBytes) / 1024 / sec).toFixed(1),
        txKbPerSec: +((tx - prev.txBytes) / 1024 / sec).toFixed(1),
        totalRxMb: +(rx / 1024 / 1024).toFixed(1),
        totalTxMb: +(tx / 1024 / 1024).toFixed(1),
      },
    };
  } catch {
    return null;
  }
}

export async function getHostMetrics(): Promise<LiveSystemMetrics> {
  const cpus = os.cpus();
  const cpu = computeCpuUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = process.memoryUsage();
  const loadAvg = os.loadavg();
  const [storage, gpu] = await Promise.all([readDisk(), getGpuInfo()]);
  const netResult = readNetwork();

  return {
    timestamp: new Date().toISOString(),
    os: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      nodeVersion: process.version,
    },
    cpu: {
      model: cpus[0]?.model?.trim() || 'Generic Virtual CPU',
      cores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      usagePercent: cpu.percent,
      loadAvg: [+loadAvg[0].toFixed(2), +loadAvg[1].toFixed(2), +loadAvg[2].toFixed(2)] as [number, number, number],
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: +((usedMem / totalMem) * 100).toFixed(1),
      totalGb: +(totalMem / 1024 ** 3).toFixed(2),
      usedGb: +(usedMem / 1024 ** 3).toFixed(2),
      processHeapUsedMb: +(memUsage.heapUsed / 1024 / 1024).toFixed(1),
      processRssMb: +(memUsage.rss / 1024 / 1024).toFixed(1),
    },
    storage,
    gpu,
    network: netResult?.net,
  };
}
