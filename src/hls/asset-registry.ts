import { mkdir, rm } from 'node:fs/promises';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError, RequestAbandonedError } from '../errors.js';
import { errorMessage, logger } from '../logger.js';
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
import { SingleFlight, type FlightResponse } from '../util/single-flight.js';
import { Priority, type TaskQueue } from '../util/task-queue.js';
import { Asset } from './asset.js';
import type { Remuxer } from './remux.js';
import { untilAborted } from '../util/async.js';

export const MATROSKA_FILE = /\.(mkv|mk3d|webm)$/iu;
// An asset rebuilds from its on-disk index cheaply, so the live set is
// capped by count rather than by size.
const MEMORY_ASSETS = 64;

type IndexBuild = {
  index: MediaIndex;
  source?: TorrentFileSource | undefined;
};

export type AssetRegistryOptions = {
  layout: CacheLayout;
  torrents: TorrentManager;
  pieces: PieceCache;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  segmentDuration: number;
  readStallMs: number;
  criticalIndexReads: boolean;
  subpieceReads: boolean;
  warmSegments: number;
};

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

  static segmentKey(
    infoHash: string,
    fileIndex: number,
    parts: string[],
  ): string {
    return `segment:${infoHash}/${fileIndex}/${parts.join('/')}`;
  }

  get(
    infoHash: string,
    fileIndex: number,
    priority: Priority = Priority.Foreground,
    signal?: AbortSignal,
  ): Promise<Asset> {
    const key = `${infoHash}/${fileIndex}`;
    const cached = this.assets.get(key);
    if (cached) {
      this.order.touch(key);
      return cached.dropped.aborted
        ? Promise.reject(cached.dropped.reason)
        : Promise.resolve(cached);
    }
    const indexKey = AssetRegistry.indexKey(infoHash, fileIndex);
    if (priority === Priority.Foreground) {
      this.options.queue.promote(indexKey);
    }

    return this.awaited(indexKey, () =>
      this.flights.run(indexKey, signal, async () => {
        const existing = this.assets.get(key);
        if (existing) {
          return existing;
        }
        const { index, source } = await this.indexOf(
          infoHash,
          fileIndex,
          priority,
        );
        const asset = this.build(infoHash, fileIndex, index);
        this.remember(key, asset);
        source?.onCorrupt((error) => {
          asset.drop(error);
          void this.forget(infoHash, fileIndex);
        });
        return asset;
      }),
    );
  }

  // The largest Matroska file is the feature; samples and extras are smaller.
  async defaultFileIndex(infoHash: string): Promise<number> {
    const info = await this.options.torrents.info(infoHash);
    const firstFile = info.files.find((file) => MATROSKA_FILE.test(file.name));
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
      readStallMs,
      warmSegments,
      subpieceReads,
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
      readStallMs,
      warmSegments,
      subpieceReads,
    });
  }

  private remember(key: string, asset: Asset): void {
    this.assets.set(key, asset);
    this.order.set(key, 1);
    for (const evicted of this.order.trim()) {
      this.assets.delete(evicted);
    }
  }

  private async forget(infoHash: string, fileIndex: number): Promise<void> {
    const mediaDir = this.options.layout.mediaDir(infoHash, fileIndex);
    try {
      await rm(mediaDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Could not delete media built from an unverified piece', {
        infoHash,
        fileIndex,
        error: errorMessage(err),
      });
    }
    this.options.segments.forgetUnder(mediaDir);
    const key = `${infoHash}/${fileIndex}`;
    this.assets.delete(key);
    this.order.delete(key);
  }

  private async indexOf(
    infoHash: string,
    fileIndex: number,
    priority: Priority,
  ): Promise<IndexBuild> {
    const { layout, segmentDuration, segments } = this.options;
    const indexFile = layout.indexFile(infoHash, fileIndex);

    const saved = await readJson<MediaIndex>(indexFile);
    if (
      // A saved index is only usable under the same format version and segment
      // duration. Segments rendered against a stale one go with it.
      saved?.version === MEDIA_INDEX_VERSION &&
      saved.targetDuration === segmentDuration
    ) {
      return { index: saved };
    }

    const mediaDir = layout.mediaDir(infoHash, fileIndex);
    await rm(mediaDir, { recursive: true, force: true });
    segments.forgetUnder(mediaDir);

    const { index, source } = await this.readIndex(
      infoHash,
      fileIndex,
      priority,
    );
    await mkdir(mediaDir, { recursive: true });
    await writeFileAtomic(indexFile, JSON.stringify(index));

    return { index, source };
  }

  private readIndex(
    infoHash: string,
    fileIndex: number,
    priority: Priority,
  ): Promise<IndexBuild> {
    const {
      queue,
      torrents,
      pieces,
      segmentDuration,
      readStallMs,
      criticalIndexReads,
      subpieceReads,
    } = this.options;

    return queue.run(
      {
        key: AssetRegistry.indexKey(infoHash, fileIndex),
        priority,
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
            critical: criticalIndexReads,
            subpieceReads,
            unverified: torrents.unverified,
            signal,
          });
          let index: MediaIndex;
          try {
            index = await buildMediaIndex(source, file.name, segmentDuration);
          } catch (err) {
            source.release();
            throw err;
          }

          logger.info('Indexed media file', {
            infoHash,
            file: file.name,
            duration: Math.round(index.duration),
            segments: segmentCount(index),
            tracks: index.tracks.length,
            ms: Date.now() - started,
          });

          return { index, source };
        }),
    );
  }

  private awaited<T>(key: string, work: () => FlightResponse<T>): Promise<T> {
    return untilAborted(
      work,
      () => new RequestAbandonedError(`Nobody is waiting for ${key}`),
      () => {
        this.options.queue.abandon(key);
      },
    );
  }
}
