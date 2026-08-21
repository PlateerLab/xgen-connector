import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import type { SystemMetrics } from '../core/system-metrics';

interface CpuCounters {
  idle: number;
  total: number;
}

interface NetworkCounters {
  interfaceName: string;
  receivedBytes: number;
  transmittedBytes: number;
}

interface MemoryUsage {
  usedBytes: number;
  totalBytes: number;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function readCpuCounters(): CpuCounters {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuCounters, current: CpuCounters): number {
  const elapsed = current.total - previous.total;
  if (elapsed <= 0) return 0;
  return clampPercent((1 - (current.idle - previous.idle) / elapsed) * 100);
}

function run(command: string, args: string[], timeout = 2_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export function parseDarwinDefaultInterface(output: string): string | null {
  return output.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
}

export function parseDarwinNetworkCounters(
  output: string,
  interfaceName: string,
): NetworkCounters | null {
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== interfaceName || !fields[2]?.startsWith('<Link#')) continue;
    const receivedBytes = Number(fields[6]);
    const transmittedBytes = Number(fields[9]);
    if (Number.isFinite(receivedBytes) && Number.isFinite(transmittedBytes)) {
      return { interfaceName, receivedBytes, transmittedBytes };
    }
  }
  return null;
}

export function parseLinuxDefaultInterface(output: string): string | null {
  for (const line of output.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === '00000000') return fields[0] ?? null;
  }
  return null;
}

export function parseLinuxNetworkCounters(
  output: string,
  interfaceName: string,
): NetworkCounters | null {
  for (const line of output.split('\n')) {
    const [name, values] = line.split(':', 2);
    if (name?.trim() !== interfaceName || !values) continue;
    const fields = values.trim().split(/\s+/);
    const receivedBytes = Number(fields[0]);
    const transmittedBytes = Number(fields[8]);
    if (Number.isFinite(receivedBytes) && Number.isFinite(transmittedBytes)) {
      return { interfaceName, receivedBytes, transmittedBytes };
    }
  }
  return null;
}

export function parseGpuPercent(output: string): number | null {
  const values: number[] = [];
  const patterns = [
    /"Device Utilization %"\s*=\s*([\d.]+)/g,
    /"GPU Activity\(%\)"\s*=\s*([\d.]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (!values.length) return null;
  return clampPercent(Math.max(...values));
}

function vmStatPages(output: string, label: string): number {
  const match = output.match(new RegExp(`^${label}:\\s*(\\d+)\\.?$`, 'm'));
  return match ? Number(match[1]) : 0;
}

export function parseDarwinMemoryUsage(output: string): MemoryUsage | null {
  const pageSize = Number(output.match(/page size of (\d+) bytes/i)?.[1]);
  const reportedTotal = Number(output.match(/system has (\d+) bytes/i)?.[1]);
  const totalBytes = Number.isFinite(reportedTotal) ? reportedTotal : totalmem();
  if (!Number.isFinite(pageSize)) return null;
  const usedPages =
    vmStatPages(output, 'Pages active') +
    vmStatPages(output, 'Pages wired down') +
    vmStatPages(output, 'Pages occupied by compressor');
  return { usedBytes: Math.min(totalBytes, usedPages * pageSize), totalBytes };
}

export function parseLinuxMemoryUsage(output: string): MemoryUsage | null {
  const totalKib = Number(output.match(/^MemTotal:\s*(\d+)\s+kB$/m)?.[1]);
  const availableKib = Number(output.match(/^MemAvailable:\s*(\d+)\s+kB$/m)?.[1]);
  if (!Number.isFinite(totalKib) || !Number.isFinite(availableKib)) return null;
  return {
    usedBytes: Math.max(0, totalKib - availableKib) * 1024,
    totalBytes: totalKib * 1024,
  };
}

async function darwinNetworkCounters(): Promise<NetworkCounters | null> {
  const route = await run('/sbin/route', ['-n', 'get', 'default']);
  const interfaceName = route ? parseDarwinDefaultInterface(route) : null;
  if (!interfaceName) return null;
  const stats = await run('/usr/sbin/netstat', ['-ibn', '-I', interfaceName]);
  return stats ? parseDarwinNetworkCounters(stats, interfaceName) : null;
}

async function linuxNetworkCounters(): Promise<NetworkCounters | null> {
  try {
    const [routes, stats] = await Promise.all([
      readFile('/proc/net/route', 'utf8'),
      readFile('/proc/net/dev', 'utf8'),
    ]);
    const interfaceName = parseLinuxDefaultInterface(routes);
    return interfaceName ? parseLinuxNetworkCounters(stats, interfaceName) : null;
  } catch {
    return null;
  }
}

async function windowsNetworkCounters(): Promise<NetworkCounters | null> {
  const script = [
    "$r=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop",
    '$r=$r | Sort-Object RouteMetric | Select-Object -First 1',
    '$s=Get-NetAdapterStatistics -Name $r.InterfaceAlias -ErrorAction Stop',
    'Write-Output "$($r.InterfaceIndex),$($s.ReceivedBytes),$($s.SentBytes)"',
  ].join(';');
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const match = output?.trim().match(/^(\d+),(\d+),(\d+)$/);
  if (!match) return null;
  return {
    interfaceName: match[1],
    receivedBytes: Number(match[2]),
    transmittedBytes: Number(match[3]),
  };
}

async function readNetworkCounters(): Promise<NetworkCounters | null> {
  if (process.platform === 'darwin') return darwinNetworkCounters();
  if (process.platform === 'linux') return linuxNetworkCounters();
  if (process.platform === 'win32') return windowsNetworkCounters();
  return null;
}

async function readMemoryUsage(): Promise<MemoryUsage> {
  if (process.platform === 'darwin') {
    const output = await run('/usr/bin/vm_stat', []);
    const parsed = output ? parseDarwinMemoryUsage(output) : null;
    if (parsed) return parsed;
  }
  if (process.platform === 'linux') {
    try {
      const parsed = parseLinuxMemoryUsage(await readFile('/proc/meminfo', 'utf8'));
      if (parsed) return parsed;
    } catch {
      /* Fall through to Node's portable counters. */
    }
  }
  const totalBytes = totalmem();
  return { usedBytes: Math.max(0, totalBytes - freemem()), totalBytes };
}

async function darwinGpuPercent(): Promise<number | null> {
  const output = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-l', '-w', '0']);
  return output ? parseGpuPercent(output) : null;
}

async function linuxGpuPercent(): Promise<number | null> {
  try {
    const entries = await readdir('/sys/class/drm', { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
      if (!/^card\d+$/.test(entry.name)) continue;
      try {
        const value = Number(
          await readFile(`/sys/class/drm/${entry.name}/device/gpu_busy_percent`, 'utf8'),
        );
        if (Number.isFinite(value)) return clampPercent(value);
      } catch {
        /* This driver does not expose gpu_busy_percent. */
      }
    }
  } catch {
    /* DRM is unavailable, so try NVIDIA's user-space counter below. */
  }
  const output = await run('nvidia-smi', [
    '--query-gpu=utilization.gpu',
    '--format=csv,noheader,nounits',
  ]);
  const values = output?.split('\n').map(Number).filter(Number.isFinite);
  return values?.length ? clampPercent(Math.max(...values)) : null;
}

async function windowsGpuPercent(): Promise<number | null> {
  const script = [
    "$v=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples",
    '$v=$v | ForEach-Object {$_.CookedValue}',
    'if ($v) {($v | Measure-Object -Maximum).Maximum}',
  ].join(';');
  const output = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    3_000,
  );
  const value = Number(output?.trim());
  return output?.trim() && Number.isFinite(value) ? clampPercent(value) : null;
}

async function readGpuPercent(): Promise<number | null> {
  if (process.platform === 'darwin') return darwinGpuPercent();
  if (process.platform === 'linux') return linuxGpuPercent();
  if (process.platform === 'win32') return windowsGpuPercent();
  return null;
}

class SystemMetricsSampler {
  private cpu = readCpuCounters();
  private network: NetworkCounters | null = null;
  private networkSampledAt = Date.now();
  private pending: Promise<SystemMetrics> | null = null;

  sample(): Promise<SystemMetrics> {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async collect(): Promise<SystemMetrics> {
    const cpu = readCpuCounters();
    const cpuPercent = cpuPercentBetween(this.cpu, cpu);
    this.cpu = cpu;

    const [network, gpuPercent, memory] = await Promise.all([
      readNetworkCounters(),
      readGpuPercent(),
      readMemoryUsage(),
    ]);
    const sampledAt = Date.now();
    let networkDownloadBytesPerSecond = 0;
    let networkUploadBytesPerSecond = 0;
    if (network && this.network?.interfaceName === network.interfaceName) {
      const elapsedSeconds = Math.max(0.001, (sampledAt - this.networkSampledAt) / 1_000);
      networkDownloadBytesPerSecond = Math.max(
        0,
        (network.receivedBytes - this.network.receivedBytes) / elapsedSeconds,
      );
      networkUploadBytesPerSecond = Math.max(
        0,
        (network.transmittedBytes - this.network.transmittedBytes) / elapsedSeconds,
      );
    }
    this.network = network;
    this.networkSampledAt = sampledAt;

    const memoryTotalBytes = memory.totalBytes;
    const memoryUsedBytes = memory.usedBytes;
    return {
      sampledAt,
      cpuPercent,
      gpuPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent: clampPercent((memoryUsedBytes / Math.max(1, memoryTotalBytes)) * 100),
      networkDownloadBytesPerSecond,
      networkUploadBytesPerSecond,
    };
  }
}

export const systemMetricsSampler = new SystemMetricsSampler();
