import './env.js';

import { mkdir, rm } from 'node:fs/promises';
import { CacheLayout } from './cache/cache-layout.js';
import { SegmentCache } from './cache/segment-cache.js';
import { config } from './config.js';
import { killAllFfmpeg, runFfmpeg } from './hls/ffmpeg.js';
import { HlsService } from './hls/hls-service.js';
import { Remuxer } from './hls/remux.js';
import { createApp } from './http/app.js';
import { errorMessage, logger } from './logger.js';
import { guardPeerHandshakes } from './torrent/peer-guard.js';
import { PieceCache } from './torrent/piece-store.js';
import { TorrentManager } from './torrent/torrent-manager.js';
import { TaskQueue } from './util/task-queue.js';

async function main(): Promise<void> {
  await runFfmpeg(config.ffmpegPath, { args: ['-version'] }).catch(
    (err: unknown) => {
      throw new Error(
        `ffmpeg is not usable at "${config.ffmpegPath}" (set FFMPEG_PATH): ${errorMessage(err)}`,
      );
    },
  );

  const layout = new CacheLayout(config.cacheDir);
  // Which pieces are stored is only known in memory, so old ones can't be reused.
  await rm(layout.piecesDir, { recursive: true, force: true });
  for (const dir of [layout.piecesDir, layout.torrentsDir, layout.hlsDir]) {
    await mkdir(dir, { recursive: true });
  }

  await guardPeerHandshakes();

  const pieces = new PieceCache(layout.piecesDir, config.pieceCacheBytes);
  const segments = new SegmentCache(layout.hlsDir, config.segmentCacheBytes);
  await segments.load();

  const torrents = new TorrentManager({
    layout,
    pieces,
    metadataTimeoutMs: config.metadataTimeoutMs,
    idleMs: config.torrentIdleMs,
  });
  const queue = new TaskQueue(
    config.maxConcurrentJobs,
    config.maxJobsPerTorrent,
  );
  const hls = new HlsService({
    layout,
    torrents,
    pieces,
    segments,
    queue,
    remuxer: new Remuxer({
      ffmpegPath: config.ffmpegPath,
      timeoutMs: config.jobTimeoutMs,
    }),
    segmentDuration: config.segmentDuration,
    prefetchSegments: config.prefetchSegments,
    prefetchAheadBytes: config.prefetchAheadBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    readStallMs: config.readStallMs,
  });

  const app = createApp({
    hls,
    status: () => ({
      torrents: torrents.status(),
      jobs: queue.stats,
      pieceCacheBytes: pieces.usedBytes,
      segmentCacheBytes: segments.usedBytes,
    }),
  });

  const server = app.listen(config.port, (error?: Error) => {
    if (error) {
      throw error;
    }
    logger.info(`Listening on http://localhost:${config.port}`, {
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
    server.close();
    killAllFfmpeg();
    setTimeout(() => process.exit(1), 5000).unref();
    void torrents.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// WebTorrent runs async work internally; one failing torrent shouldn't take down every stream.
process.on('unhandledRejection', (reason) => {
  console.log(reason);
  logger.error('Unhandled rejection', { error: errorMessage(reason) });
});

// Prevents dropping every viewer over one bad connection.
// These are logged with their stack and the server carries on.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.stack ?? errorMessage(err) });
});

main().catch((err: unknown) => {
  logger.error('Startup failed', { error: errorMessage(err) });
  process.exit(1);
});
