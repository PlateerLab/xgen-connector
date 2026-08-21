/** A point-in-time snapshot of this computer's resource usage. */
export interface SystemMetrics {
  sampledAt: number;
  cpuPercent: number;
  /** null when the operating system does not expose a readable GPU counter. */
  gpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  networkDownloadBytesPerSecond: number;
  networkUploadBytesPerSecond: number;
}
