import React, { useEffect, useState } from 'react';
import type { SystemMetrics } from '../../../core/system-metrics';
import { xgen } from '../bridge';
import { formatNetworkRate } from './system-monitor-model';

const POLL_INTERVAL_MS = 1_500;
const GIB = 1024 ** 3;

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

const UsageMetric: React.FC<{
  label: string;
  value: string;
  usage: number | null;
  title: string;
}> = ({ label, value, usage, title }) => (
  <div className="system-metric" title={title}>
    <span className="system-metric-label">{label}</span>
    <span className="system-metric-value">{value}</span>
    <span className="system-meter" aria-hidden>
      <span style={{ width: `${usage ?? 0}%` }} />
    </span>
  </div>
);

export const SystemMonitorFooter: React.FC = () => {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let mounted = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await xgen.system.metrics();
        if (mounted) {
          setMetrics(next);
          setAvailable(true);
        }
      } catch {
        if (mounted) setAvailable(false);
      } finally {
        if (mounted) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  const cpu = metrics ? percent(metrics.cpuPercent) : '—';
  const gpu = metrics ? (metrics.gpuPercent === null ? 'N/A' : percent(metrics.gpuPercent)) : '—';
  const memory = metrics
    ? `${(metrics.memoryUsedBytes / GIB).toFixed(1)} / ${(metrics.memoryTotalBytes / GIB).toFixed(0)} GB`
    : '—';

  return (
    <footer className="system-monitor-footer" aria-label="시스템 리소스 사용량">
      <div className={`system-monitor-state ${available ? '' : 'offline'}`}>
        <span className="system-live-dot" aria-hidden />
        <span>시스템</span>
      </div>
      <UsageMetric
        label="CPU"
        value={cpu}
        usage={metrics?.cpuPercent ?? null}
        title={`CPU 사용량 ${cpu}`}
      />
      <UsageMetric
        label="GPU"
        value={gpu}
        usage={metrics?.gpuPercent ?? null}
        title={`GPU 사용량 ${gpu}`}
      />
      <UsageMetric
        label="RAM"
        value={memory}
        usage={metrics?.memoryPercent ?? null}
        title={
          metrics ? `메모리 사용량 ${memory} (${percent(metrics.memoryPercent)})` : '메모리 사용량'
        }
      />
      <div className="system-metric system-network" title="현재 네트워크 다운로드 및 업로드 속도">
        <span className="system-metric-label">NET</span>
        <span className="system-metric-value network-down">
          ↓ {metrics ? formatNetworkRate(metrics.networkDownloadBytesPerSecond) : '—'}
        </span>
        <span className="system-metric-value network-up">
          ↑ {metrics ? formatNetworkRate(metrics.networkUploadBytesPerSecond) : '—'}
        </span>
      </div>
    </footer>
  );
};
