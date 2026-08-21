import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpuPercentBetween,
  parseDarwinDefaultInterface,
  parseDarwinMemoryUsage,
  parseDarwinNetworkCounters,
  parseGpuPercent,
  parseLinuxDefaultInterface,
  parseLinuxMemoryUsage,
  parseLinuxNetworkCounters,
} from '../src/main/system-metrics';
import { formatNetworkRate } from '../src/renderer/src/views/system-monitor-model';

test('CPU usage is calculated from idle and total counter deltas', () => {
  assert.equal(cpuPercentBetween({ idle: 100, total: 400 }, { idle: 125, total: 500 }), 75);
  assert.equal(cpuPercentBetween({ idle: 100, total: 400 }, { idle: 100, total: 400 }), 0);
});

test('macOS default interface and link byte counters are parsed', () => {
  assert.equal(parseDarwinDefaultInterface('   interface: en0\n'), 'en0');
  const output = [
    'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll',
    'en0 1500 <Link#21> aa:bb:cc 12 0 2048 8 0 1024 0',
    'en0 1500 192.168.0 192.168.0.2 12 - 2048 8 - 1024 -',
  ].join('\n');
  assert.deepEqual(parseDarwinNetworkCounters(output, 'en0'), {
    interfaceName: 'en0',
    receivedBytes: 2048,
    transmittedBytes: 1024,
  });
});

test('Linux default interface and byte counters are parsed', () => {
  const routes = [
    'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
    'eth0 00000000 0100000A 0003 0 0 100 00000000 0 0 0',
  ].join('\n');
  assert.equal(parseLinuxDefaultInterface(routes), 'eth0');
  const stats = '  eth0: 4096 1 0 0 0 0 0 0 2048 1 0 0 0 0 0 0';
  assert.deepEqual(parseLinuxNetworkCounters(stats, 'eth0'), {
    interfaceName: 'eth0',
    receivedBytes: 4096,
    transmittedBytes: 2048,
  });
});

test('GPU utilization and network rate display are normalized', () => {
  assert.equal(parseGpuPercent('"Device Utilization %"=31'), 31);
  assert.equal(parseGpuPercent('"Device Utilization %"=18 "GPU Activity(%)"=42'), 42);
  assert.equal(parseGpuPercent('no supported counter'), null);
  assert.equal(formatNetworkRate(900), '900 B/s');
  assert.equal(formatNetworkRate(1536), '1.5 KB/s');
  assert.equal(formatNetworkRate(2.5 * 1024 ** 2), '2.5 MB/s');
});

test('reclaimable cache is excluded from macOS and Linux RAM usage', () => {
  const darwin = [
    'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
    'Pages active: 100.',
    'Pages wired down: 50.',
    'Pages occupied by compressor: 25.',
    'The system has 1048576 bytes (256 pages with a page size of 4096).',
  ].join('\n');
  assert.deepEqual(parseDarwinMemoryUsage(darwin), {
    usedBytes: 175 * 4096,
    totalBytes: 1048576,
  });
  const linux = 'MemTotal:       1000 kB\nMemAvailable:    400 kB\n';
  assert.deepEqual(parseLinuxMemoryUsage(linux), {
    usedBytes: 600 * 1024,
    totalBytes: 1000 * 1024,
  });
});
