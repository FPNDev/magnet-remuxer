import os from 'node:os';
import path from 'node:path';

const env = process.env;
const MiB = 1024 * 1024;

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

export const config = {
  port: number('PORT', 3000),
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  cacheDir: path.resolve(env.CACHE_DIR || path.join(os.tmpdir(), 'magnet-cache')),

  /**
   * Disk budget for all cached torrent pieces, shared by every torrent.
   */
  pieceCacheBytes: number('PIECE_CACHE_MB', 8192) * MiB,
  /** Disk budget for rendered HLS segments. */
  segmentCacheBytes: number('SEGMENT_CACHE_MB', 15360) * MiB,

  /** Target HLS segment length in seconds; real segments follow keyframes. */
  segmentDuration: number('SEGMENT_DURATION', 6),
  /** Segments rendered ahead of the one a player just requested. */
  prefetchSegments: number('PREFETCH_SEGMENTS', 3),
  /**
   * Cap on how much a file may prefetch, in bytes read. Segments of a 4K remux
   * are tens of MB, so prefetching by count alone would flood the swarm.
   */
  prefetchAheadBytes: number('PREFETCH_AHEAD_MB', 96) * MiB,
  /** A request waiting longer than this for its segment fails instead of hanging. */
  requestTimeoutMs: number('REQUEST_TIMEOUT_S', 120) * 1000,
  maxConcurrentJobs: number('MAX_CONCURRENT_JOBS', Math.max(16, os.availableParallelism())),
  jobTimeoutMs: number('JOB_TIMEOUT_S', 180) * 1000,
  /** A torrent read that receives nothing for this long fails instead of hanging. */
  readStallMs: number('READ_STALL_S', 45) * 1000,

  metadataTimeoutMs: number('METADATA_TIMEOUT_S', 90) * 1000,
  /** Torrents unused for this long are removed from the client. */
  torrentIdleMs: number('TORRENT_IDLE_S', 600) * 1000,
} as const;
