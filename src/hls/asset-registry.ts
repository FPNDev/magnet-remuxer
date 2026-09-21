import { mkdir, rm } from 'node:fs/promises';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError } from '../errors.js';
import { logger } from '../logger.js';
import {
  buildMediaIndex,
  MEDIA_INDEX_VERSION,
  segmentCount,
  type MediaIndex,
} from '../media/media-index.js';
import type { PieceCache } from '../torrent/piece-store.js';
import type { TorrentManager } from '../torrent/torrent-manager.js';
import { ReadPriority, TorrentFileSource } from '../torrent/torrent-source.js';
import { readJson, writeFileAtomic } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';
import { SingleFlight } from '../util/single-flight.js';
import { CRITICAL_RANK, Priority, type TaskQueue } from '../util/task-queue.js';
import { Asset } from './asset.js';
import type { Playheads } from './playhead.js';
import type { Remuxer } from './remux.js';

export const MATROSKA_FILE = /\.(mkv|mk3d|webm)$/i;
// An asset rebuilds from its on-disk index cheaply, so the live set is
// capped by count rather than by size.
const MEMORY_ASSETS = 64;

export interface AssetRegistryOptions {
  layout: CacheLayout;
  torrents: TorrentManager;
  pieces: PieceCache;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  playheads: Playheads;
  segmentDuration: number;
  prefetchSegments: number;
  prefetchAheadBytes: number;
  readStallMs: number;
}

export class AssetRegistry {
  private readonly assets = new Map<string, Asset>();
  private readonly order: SizeLru<string>;
  private readonly flights = new SingleFlight();

  constructor(private readonly options: AssetRegistryOptions) {
    this.order = new SizeLru(MEMORY_ASSETS);
  }

  static indexKey(infoHash: string, fileIndex: number): string {
    return `index:${infoHash}/${fileIndex}`;
  }

  async get(
    infoHash: string,
    fileIndex: number,
    priority: Priority = Priority.Foreground,
  ): Promise<Asset> {
    const key = `${infoHash}/${fileIndex}`;
    const cached = this.assets.get(key);
    if (cached) {
      this.order.touch(key);
      return cached;
    }
    // A player arriving behind a background index job lifts that job instead
    // of queueing a second read of the same file.
    if (priority === Priority.Foreground) {
      this.options.queue.promote(
        AssetRegistry.indexKey(infoHash, fileIndex),
        CRITICAL_RANK,
      );
    }
    return this.flights.run(
      AssetRegistry.indexKey(infoHash, fileIndex),
      async () => {
        const existing = this.assets.get(key);
        if (existing) {
          return existing;
        }
        const asset = this.build(
          infoHash,
          fileIndex,
          await this.indexOf(infoHash, fileIndex, priority),
        );
        this.remember(key, asset);
        return asset;
      },
    );
  }

  // The largest Matroska file is the feature; samples and extras are smaller.
  async defaultFileIndex(infoHash: string): Promise<number> {
    const info = await this.options.torrents.info(infoHash);
    const firstFile = info.files.filter((file) =>
      MATROSKA_FILE.test(file.name),
    )[0];
    if (!firstFile) {
      throw new HttpError(404, 'Torrent contains no MKV or WebM files');
    }
    return firstFile.index;
  }

  private build(infoHash: string, fileIndex: number, index: MediaIndex): Asset {
    const {
      layout,
      torrents,
      pieces,
      segments,
      remuxer,
      queue,
      playheads,
      prefetchSegments,
      prefetchAheadBytes,
      readStallMs,
    } = this.options;
    return new Asset({
      infoHash,
      fileIndex,
      index,
      layout,
      torrents,
      pieces,
      segments,
      remuxer,
      queue,
      playheads,
      prefetchSegments,
      prefetchAheadBytes,
      readStallMs,
    });
  }

  private remember(key: string, asset: Asset): void {
    this.assets.set(key, asset);
    this.order.set(key, 1);
    for (const evicted of this.order.trim()) {
      this.assets.delete(evicted);
    }
  }

  private async indexOf(
    infoHash: string,
    fileIndex: number,
    priority: Priority,
  ): Promise<MediaIndex> {
    const { layout, segmentDuration, segments } = this.options;
    const indexFile = layout.indexFile(infoHash, fileIndex);

    const saved = await readJson<MediaIndex>(indexFile);
    if (
      // A saved index is only usable under the same format version and segment
      // duration. Segments rendered against a stale one go with it.
      saved?.version === MEDIA_INDEX_VERSION &&
      saved.targetDuration === segmentDuration
    ) {
      return saved;
    }

    const mediaDir = layout.mediaDir(infoHash, fileIndex);
    await rm(mediaDir, { recursive: true, force: true });
    segments.forgetUnder(mediaDir);

    const index = await this.readIndex(infoHash, fileIndex, priority);
    await mkdir(mediaDir, { recursive: true });
    await writeFileAtomic(indexFile, JSON.stringify(index));
    return index;
  }

  private readIndex(
    infoHash: string,
    fileIndex: number,
    priority: Priority,
  ): Promise<MediaIndex> {
    const { queue, torrents, pieces, segmentDuration, readStallMs } =
      this.options;
    return queue.run(
      {
        key: AssetRegistry.indexKey(infoHash, fileIndex),
        priority,
        rank: CRITICAL_RANK,
        // Indexing takes its own group so the per-torrent limit on segment jobs
        // cannot starve it.
        group: `${infoHash}:index`,
      },
      ({ signal }) =>
        torrents.use(infoHash, async (torrent) => {
          const file = torrent.files[fileIndex];
          if (!file) {
            throw new HttpError(404, `Torrent has no file #${fileIndex}`);
          }
          if (!MATROSKA_FILE.test(file.name)) {
            throw new HttpError(422, `${file.name} is not an MKV or WebM file`);
          }

          const started = Date.now();
          const source = new TorrentFileSource(torrent, file, pieces, {
            stallMs: readStallMs,
            priority: ReadPriority.Index,
            signal,
          });
          const index = await buildMediaIndex(
            source,
            file.name,
            segmentDuration,
          );
          logger.info('Indexed media file', {
            infoHash,
            file: file.name,
            duration: Math.round(index.duration),
            segments: segmentCount(index),
            tracks: index.tracks.length,
            ms: Date.now() - started,
          });
          return index;
        }),
    );
  }
}
