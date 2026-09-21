import os from 'node:os';
import path from 'node:path';

const env = process.env;
const MiB = 1024 * 1024;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function number(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function logLevel(name: string, fallback: LogLevel): LogLevel {
  const raw = env[name]?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === raw) ?? fallback;
}

// Read once at import. A malformed number throws here, so a bad value stops
// the process at startup rather than mid-request.
export const config = {
  host: env.HOST || '127.0.0.1',
  port: number('PORT', 3000),
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  logLevel: logLevel('LOG_LEVEL', 'info'),
  cacheDir: path.resolve(
    env.CACHE_DIR || path.join(os.tmpdir(), 'magnet-cache'),
  ),

  pieceCacheBytes: number('PIECE_CACHE_MB', 8192) * MiB,
  segmentCacheBytes: number('SEGMENT_CACHE_MB', 15360) * MiB,
  metadataCacheBytes: number('METADATA_CACHE_MB', 2048) * MiB,
  // 0 means no combined ceiling; the three budgets above then stand alone.
  cacheTotalBytes: number('CACHE_TOTAL_MB', 0) * MiB,
  cacheSweepMs: number('CACHE_SWEEP_MINUTES', 5) * 60_000,

  // Seconds per segment. Also the EXT-X-TARGETDURATION written into playlists,
  // so changing it invalidates playlists already on disk.
  segmentDuration: number('SEGMENT_DURATION', 2),
  prefetchSegments: number('PREFETCH_SEGMENTS', 9),
  warmSegments: number('WARM_SEGMENTS', 2),
  warmConcurrency: Math.max(1, number('WARM_CONCURRENCY', 4)),
  prefetchAheadBytes: number('PREFETCH_AHEAD_MB', 96) * MiB,
  requestTimeoutMs: number('REQUEST_TIMEOUT_S', 120) * 1000,
  maxConcurrentJobs: number(
    'MAX_CONCURRENT_JOBS',
    Math.max(16, os.availableParallelism()),
  ),
  maxJobsPerTorrent: number('MAX_JOBS_PER_TORRENT', 2),
  jobTimeoutMs: number('JOB_TIMEOUT_S', 180) * 1000,
  readStallMs: number('READ_STALL_S', 45) * 1000,

  maxPeers: number('MAX_PEERS', 100),
  tailHedge: flag('TAIL_HEDGE', true),
  tailHedgeMs: number('TAIL_HEDGE_MS', 250),
  peerChurn: flag('PEER_CHURN', true),
  peerChurnGraceMs: number('PEER_CHURN_GRACE_S', 10) * 1000,
  banCorruptPeers: flag('BAN_CORRUPT_PEERS', true),
  peerBanMs: number('PEER_BAN_DAYS', 7) * 24 * 60 * 60 * 1000,

  metadataTimeoutMs: number('METADATA_TIMEOUT_S', 90) * 1000,
  torrentIdleMs: number('TORRENT_IDLE_S', 600) * 1000,
} as const;
