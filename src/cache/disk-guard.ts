import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, logger } from '../logger.js';
import { TEMP_SUFFIX } from '../util/fs.js';
import { isSegmentFile, type CacheLayout } from './cache-layout.js';
import type { MetadataCache } from './metadata-cache.js';
import type { SegmentCache } from './segment-cache.js';

// A temp file younger than this may belong to a write still in flight.
const STALE_TEMP_MS = 60 * 60_000;
// Evict in steps so the oldest store is re-picked as the order shifts.
const EVICT_CHUNK = 64 * 1024 * 1024;
// Bounded parallelism: a full cache is tens of thousands of files and one
// event loop also serves playback.
const STAT_BATCH = 64;

export interface PieceBudget {
  oldestUsedAt(): number | undefined;
  evictOldest(bytes: number): Promise<number>;
}

export interface DiskGuardOptions {
  layout: CacheLayout;
  pieces: PieceBudget;
  segments: SegmentCache;
  metadata: MetadataCache;
  totalBytes: number;
  intervalMs: number;
  inUse: () => Set<string>;
}

export interface CacheUsage {
  pieces: number;
  segments: number;
  metadata: number;
  total: number;
  limit: number;
  titles: number;
  freed: { pieces: number; segments: number; metadata: number };
  sweptAt: number;
}

interface Title {
  metadataBytes: number;
  writtenAt: number;
}

/**
 * Sweeps the cache directory on a timer: measures what is on disk, feeds the
 * result back to the three budgets, then evicts oldest first until the total
 * fits. Disk is the record, so a file deleted outside the process is noticed.
 */
export class DiskGuard {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private usage: CacheUsage;

  constructor(private readonly options: DiskGuardOptions) {
    this.usage = {
      pieces: 0,
      segments: 0,
      metadata: 0,
      total: 0,
      limit: options.totalBytes,
      titles: 0,
      freed: { pieces: 0, segments: 0, metadata: 0 },
      sweptAt: 0,
    };
  }

  get lastUsage(): CacheUsage {
    return this.usage;
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<CacheUsage> {
    // Sweeps never overlap: a slow one would evict against stale sizes.
    if (this.sweeping) {
      return this.usage;
    }
    this.sweeping = true;
    try {
      const { layout, metadata, totalBytes } = this.options;
      const titles = new Map<string, Title>();
      const onDisk = {
        pieces: await this.measure(layout.piecesDir, titles, false),
        torrents: await this.measure(layout.torrentsDir, titles, true),
        hls: await this.measure(layout.hlsDir, titles, true),
      };
      for (const [infoHash, title] of [...titles].sort(
        ([, a], [, b]) => a.writtenAt - b.writtenAt,
      )) {
        metadata.note(infoHash, title.metadataBytes, title.writtenAt);
      }
      metadata.keepOnly(new Set(titles.keys()));

      const segmentBytes = onDisk.hls.segments;
      const measured =
        onDisk.pieces.total + onDisk.torrents.total + onDisk.hls.total;

      const busy = this.options.inUse();
      // A title with a live torrent keeps its metadata, however old it is.
      const pinned = (infoHash: string) => busy.has(infoHash);
      const freed = { pieces: 0, segments: 0, metadata: 0 };
      freed.metadata += await metadata.trimToBudget(pinned);

      const over = measured - freed.metadata - totalBytes;
      if (over > 0) {
        Object.assign(freed, await this.evict(over, pinned, freed));
      }

      this.usage = {
        pieces: onDisk.pieces.total - freed.pieces,
        segments: segmentBytes - freed.segments,
        metadata: metadata.usedBytes,
        total: measured - freed.pieces - freed.segments - freed.metadata,
        limit: totalBytes,
        titles: titles.size,
        freed,
        sweptAt: Date.now(),
      };
      logger.debug('Cache swept', { ...this.usage, ...freed });
      return this.usage;
    } catch (err: unknown) {
      logger.warn('Could not sweep the cache', { error: errorMessage(err) });
      return this.usage;
    } finally {
      this.sweeping = false;
    }
  }

  // Takes from whichever store holds the globally oldest entry, so one busy
  // store cannot push another out.
  private async evict(
    over: number,
    pinned: (infoHash: string) => boolean,
    freed: { pieces: number; segments: number; metadata: number },
  ): Promise<{ pieces: number; segments: number; metadata: number }> {
    const { pieces, segments, metadata } = this.options;
    const result = { ...freed };
    let remaining = over;

    while (remaining > 0) {
      const candidates = [
        {
          name: 'pieces' as const,
          usedAt: pieces.oldestUsedAt(),
          take: (bytes: number) => pieces.evictOldest(bytes),
        },
        {
          name: 'segments' as const,
          usedAt: segments.oldestUsedAt(),
          take: (bytes: number) => segments.evictOldest(bytes),
        },
        {
          name: 'metadata' as const,
          usedAt: metadata.oldestUsedAt(pinned),
          take: (bytes: number) => metadata.evictOldest(bytes, pinned),
        },
      ]
        .filter((candidate) => candidate.usedAt !== undefined)
        .sort((a, b) => a.usedAt! - b.usedAt!);

      const oldest = candidates[0];
      if (!oldest) {
        logger.warn('Cache is over its total with nothing left to evict', {
          overMiB: Math.round(remaining / 2 ** 20),
        });
        break;
      }
      const took = await oldest.take(Math.min(remaining, EVICT_CHUNK));
      if (took <= 0) {
        break;
      }
      result[oldest.name] += took;
      remaining -= took;
    }

    logger.info('Cache was over its total; took back the oldest of it', {
      overMiB: Math.round(over / 2 ** 20),
      piecesMiB: Math.round((result.pieces - freed.pieces) / 2 ** 20),
      segmentsMiB: Math.round((result.segments - freed.segments) / 2 ** 20),
      metadataMiB: Math.round((result.metadata - freed.metadata) / 2 ** 20),
    });
    return result;
  }

  private async measure(
    root: string,
    titles: Map<string, Title>,
    byTitle: boolean,
  ): Promise<{ total: number; segments: number }> {
    let total = 0;
    let segments = 0;
    const entries = (
      await readdir(root, {
        recursive: true,
        withFileTypes: true,
      }).catch(() => [])
    ).filter((entry) => entry.isFile());

    for (let i = 0; i < entries.length; i += STAT_BATCH) {
      const batch = entries.slice(i, i + STAT_BATCH);
      const measured = await Promise.all(
        batch.map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          const info = await stat(file).catch(() => undefined);
          return { name: entry.name, file, info };
        }),
      );

      for (const { name, file, info } of measured) {
        if (!info) {
          continue;
        }
        if (
          name.endsWith(TEMP_SUFFIX) &&
          Date.now() - info.mtimeMs > STALE_TEMP_MS
        ) {
          await rm(file, { force: true }).catch(() => {});
          continue;
        }
        total += info.size;
        if (isSegmentFile(name)) {
          segments += info.size;
          continue;
        }
        if (!byTitle) {
          continue;
        }

        const infoHash = path.relative(root, file).split(path.sep)[0];
        if (!infoHash) {
          continue;
        }
        const title = titles.get(infoHash) ?? {
          metadataBytes: 0,
          writtenAt: 0,
        };
        title.metadataBytes += info.size;
        // A title is as recent as its newest file.
        title.writtenAt = Math.max(title.writtenAt, info.mtimeMs);
        titles.set(infoHash, title);
      }
    }
    return { total, segments };
  }
}
