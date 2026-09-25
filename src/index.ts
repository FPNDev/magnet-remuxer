// First import: it fills process.env before config.ts reads it.
import './env.js';

import { mkdir } from 'node:fs/promises';
import { CacheLayout } from './cache/cache-layout.js';
import { DiskGuard } from './cache/disk-guard.js';
import { InterleavingNotes } from './cache/interleaving-notes.js';
import { MetadataCache } from './cache/metadata-cache.js';
import { SegmentCache } from './cache/segment-cache.js';
import { config } from './config.js';
import { FfmpegSupervisor } from './hls/ffmpeg.js';
import { HlsService } from './hls/hls-service.js';
import { Remuxer } from './hls/remux.js';
import { createApp } from './http/app.js';
import { errorMessage, logger } from './logger.js';
import { guardPeerHandshakes } from './torrent/peer-guard.js';
import { PieceCache } from './torrent/piece-store.js';
import { TorrentManager } from './torrent/torrent-manager.js';
import { TaskQueue } from './util/task-queue.js';

async function main(): Promise<void> {
  // Probe ffmpeg now so a bad FFMPEG_PATH fails at startup, not on the first
  // segment a player asks for.
  await new FfmpegSupervisor(config.ffmpegPath)
    .run({ args: ['-version'] })
    .catch((err: unknown) => {
      throw new Error(
        `ffmpeg is not usable at "${config.ffmpegPath}" (set FFMPEG_PATH): ${errorMessage(err)}`,
      );
    });

  const layout = new CacheLayout(config.cacheDir);
  for (const dir of [layout.piecesDir, layout.torrentsDir, layout.hlsDir]) {
    await mkdir(dir, { recursive: true });
  }

  // Patches a webtorrent prototype, so it has to run before the first torrent.
  await guardPeerHandshakes();

  const pieces = new PieceCache(layout.piecesDir, config.pieceCacheBytes);
  await pieces.load();
  const segments = new SegmentCache(layout.hlsDir, config.segmentCacheBytes);
  await segments.load();
  const metadata = new MetadataCache(layout, config.metadataCacheBytes);

  const torrents = new TorrentManager({
    layout,
    pieces,
    metadataTimeoutMs: config.metadataTimeoutMs,
    idleMs: config.torrentIdleMs,
    maxPeers: config.maxPeers,
    hedge: { enabled: config.tailHedge, deadlineMs: config.tailHedgeMs },
    churn: { enabled: config.peerChurn, graceMs: config.peerChurnGraceMs },
    corrupt: { enabled: config.banCorruptPeers, banMs: config.peerBanMs },
  });
  const queue = new TaskQueue(
    config.maxConcurrentJobs,
    config.keepWarmS
      ? Math.max(config.segmentDuration + 1, config.keepWarmS)
      : 0,
  );
  const remuxer = new Remuxer({
    ffmpegPath: config.ffmpegPath,
    timeoutMs: config.jobTimeoutMs,
    notes: new InterleavingNotes(layout),
  });
  await remuxer.restoreNotes();
  const hls = new HlsService({
    layout,
    torrents,
    pieces,
    segments,
    metadata,
    queue,
    remuxer,
    segmentDuration: config.segmentDuration,
    keepWarm: !!config.keepWarmS,
    warmSegments: config.warmSegments,
    warmConcurrency: config.warmConcurrency,
    requestTimeoutMs: config.requestTimeoutMs,
    readStallMs: config.readStallMs,
  });

  const budgets =
    config.pieceCacheBytes +
    config.segmentCacheBytes +
    config.metadataCacheBytes;
  // With no ceiling configured the guard polices the sum of the three budgets.
  const cacheTotalBytes = config.cacheTotalBytes || budgets;
  if (budgets > cacheTotalBytes) {
    logger.warn('The cache budgets add up to more than CACHE_TOTAL_MB', {
      budgetsMiB: Math.round(budgets / (1024 * 1024)),
      totalMiB: Math.round(cacheTotalBytes / (1024 * 1024)),
    });
  }
  const guard = new DiskGuard({
    layout,
    pieces,
    segments,
    metadata,
    totalBytes: cacheTotalBytes,
    intervalMs: config.cacheSweepMs,
    inUse: () => torrents.active(),
  });
  guard.start();

  const app = createApp({
    hls,
    status: () => ({
      torrents: torrents.status(),
      jobs: queue.stats,
      pieceCacheBytes: pieces.usedBytes,
      segmentCacheBytes: segments.usedBytes,
      cache: guard.lastUsage,
    }),
  });

  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      throw error;
    }
    logger.info(`Listening on http://${config.host}:${config.port}`, {
      cacheDir: config.cacheDir,
    });
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info('Shutting down', { signal });
    guard.stop();
    server.close();
    remuxer.killAll();
    // Leave if closing torrents hangs. unref so it never holds the loop open.
    setTimeout(() => process.exit(1), 5000).unref();
    void torrents.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    error:
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason),
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.stack ?? errorMessage(err) });
});

main().catch((err: unknown) => {
  logger.error('Startup failed', { error: errorMessage(err) });
  process.exit(1);
});
