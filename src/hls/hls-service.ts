import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { MetadataCache } from '../cache/metadata-cache.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError, RequestAbandonedError } from '../errors.js';
import { logger } from '../logger.js';
import { isInfoHash, parseInfoHash } from '../torrent/magnet.js';
import type { PieceCache } from '../torrent/piece-store.js';
import type {
  TorrentInfo,
  TorrentManager,
} from '../torrent/torrent-manager.js';
import { untilAborted, withTimeout } from '../util/async.js';
import { exists, readJson } from '../util/fs.js';
import { SingleFlight, type FlightResponse } from '../util/single-flight.js';
import { Priority, type TaskQueue } from '../util/task-queue.js';
import type { Asset } from './asset.js';
import { AssetRegistry, MATROSKA_FILE } from './asset-registry.js';
import { renditionPath, segmentFileName } from './playlists.js';
import type { Remuxer } from './remux.js';
import { WarmQueue } from './warm-queue.js';

export interface HlsServiceOptions {
  layout: CacheLayout;
  torrents: TorrentManager;
  pieces: PieceCache;
  segments: SegmentCache;
  metadata: MetadataCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  segmentDuration: number;
  keepWarm: boolean;
  warmSegments: number;
  warmConcurrency: number;
  requestTimeoutMs: number;
  readStallMs: number;
}

export interface ServedFile {
  path: string;
  contentType: string;
  cacheControl: string;
}

const SEGMENT_NAME = /^(\d+)\.(m4s|vtt)$/;

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
// A rendered segment never changes, so it caches for a day. Playlists are
// rewritten whenever the media index is rebuilt.
const PLAYLIST_CACHE = 'public, max-age=60';
const MEDIA_CACHE = 'public, max-age=86400';

/**
 * Entry points behind the HLS routes: master playlist, warm, file list,
 * and resolving one media path to a file on disk.
 */
export class HlsService {
  private readonly registry: AssetRegistry;
  private readonly warming: WarmQueue;
  private readonly flights = new SingleFlight();

  constructor(private readonly options: HlsServiceOptions) {
    this.registry = new AssetRegistry({
      layout: options.layout,
      torrents: options.torrents,
      pieces: options.pieces,
      segments: options.segments,
      remuxer: options.remuxer,
      queue: options.queue,
      segmentDuration: options.segmentDuration,
      readStallMs: options.readStallMs,
      warmSegments: options.warmSegments,
    });
    this.warming = new WarmQueue({
      concurrency: options.warmConcurrency,
      warm: (infoHash, fileIndex) => this.warmUp(infoHash, fileIndex),
    });
  }

  async master(
    magnet: string,
    fileParam: string | undefined,
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    const { layout, torrents, metadata } = this.options;
    const infoHash = parseInfoHash(magnet);
    await torrents.remember(infoHash, magnet);
    metadata.touch(infoHash);

    const fileIndex =
      fileParam === undefined
        ? await this.registry.defaultFileIndex(infoHash)
        : parseNumber(fileParam, 400, 'file');
    const file = layout.masterFile(infoHash, fileIndex);

    if (!(await exists(file))) {
      const indexKey = AssetRegistry.indexKey(infoHash, fileIndex);
      await this.orTimeout(
        this.awaited(indexKey, () =>
          this.flights.run(indexKey, signal, () => {
            return this.publish(
              infoHash,
              fileIndex,
              Priority.Foreground,
              signal,
            );
          }),
        ),
        `the playlists for ${infoHash}/${fileIndex}`,
      );
    }
    this.startEagerly(infoHash, fileIndex);

    return { path: file, contentType: PLAYLIST_TYPE, cacheControl: 'no-cache' };
  }

  async warm(magnet: string, fileParam?: string) {
    const infoHash = parseInfoHash(magnet);
    await this.options.torrents.remember(infoHash, magnet);
    this.options.metadata.touch(infoHash);
    const fileIndex =
      fileParam === undefined ? undefined : parseNumber(fileParam, 400, 'file');

    const ready = await this.isWarm(infoHash, fileIndex);
    const queued = ready ? false : this.warming.request(infoHash, fileIndex);
    const warming = queued || this.warming.knows(infoHash, fileIndex);
    return {
      infoHash,
      ready,
      queued,
      warming,
      pending: this.warming.pending,
      full: !ready && !warming && this.warming.full,
    };
  }

  async files(magnet: string, signal?: AbortSignal) {
    const { metadata, torrents } = this.options;
    const infoHash = parseInfoHash(magnet);
    await torrents.remember(infoHash, magnet);
    metadata.touch(infoHash);

    const key = `info:${infoHash}`;
    const info = await this.orTimeout(
      this.awaited(key, () =>
        this.flights.run(key, signal, () => torrents.info(infoHash)),
      ),
      `the file list of ${infoHash}`,
    );
    return {
      ...info,
      files: info.files.map((file) => ({
        ...file,
        playable: MATROSKA_FILE.test(file.name),
      })),
    };
  }

  async resolve(
    infoHash: string,
    fileIndexParam: string,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    if (!isInfoHash(infoHash)) {
      throw new HttpError(404, `Malformed info hash "${infoHash}"`);
    }
    const fileIndex = parseNumber(fileIndexParam, 404, 'file index');
    this.options.torrents.touch(infoHash);
    this.options.metadata.touch(infoHash);

    // Every part of the path comes from the client. The shape is checked here
    // and the names are checked against the asset before any file is opened.
    const [kind, ...rest] = parts;
    const [trackParam, name] =
      kind === 'video' && rest.length === 1
        ? [undefined, rest[0]]
        : (kind === 'audio' || kind === 'subtitles') && rest.length === 2
          ? rest
          : [];
    if (!kind || !name) {
      throw new HttpError(404, `Unsupported path "${parts.join('/')}"`);
    }
    const indexKey = AssetRegistry.indexKey(infoHash, fileIndex);
    const asset = await this.awaited(indexKey, () =>
      this.flights.run(indexKey, signal, () =>
        this.registry.get(infoHash, fileIndex),
      ),
    );
    const rendition = asset.rendition(
      kind,
      trackParam === undefined
        ? undefined
        : parseNumber(trackParam, 404, 'track'),
    );
    const file = path.join(asset.dirOf(rendition), name);
    const mediaType = rendition.type === 'audio' ? 'audio/mp4' : 'video/mp4';

    if (name === 'index.m3u8') {
      if (!(await exists(file))) {
        await this.orTimeout(
          asset.writePlaylists(),
          `the playlists for ${infoHash}/${fileIndex}`,
        );
      }
      return {
        path: file,
        contentType: PLAYLIST_TYPE,
        cacheControl: PLAYLIST_CACHE,
      };
    }

    if (name === 'init.mp4' && rendition.type !== 'subtitle') {
      await this.orTimeout(
        asset.ensureInit(rendition, file, Priority.Foreground, signal),
        `the init section of ${renditionPath(rendition)}`,
      );
      return { path: file, contentType: mediaType, cacheControl: MEDIA_CACHE };
    }

    const segment = SEGMENT_NAME.exec(name);
    const n = Number(segment?.[1]);
    // Comparing against the name this rendition would generate rejects a vtt
    // asked of video, a padded number, and anything with extra characters.
    if (!segment || name !== segmentFileName(rendition, n)) {
      throw new HttpError(
        404,
        `Unexpected segment name "${name}" for ${renditionPath(rendition)}`,
      );
    }
    if (n >= asset.segmentCount) {
      throw new HttpError(
        404,
        `Segment ${n} is past the end of ${asset.index.fileName} (${asset.segmentCount} segments)`,
      );
    }

    if (!signal?.aborted) {
      const mainSegment = this.orTimeout(
        asset.ensureSegment(rendition, n, Priority.Foreground, signal),
        `segment ${n} of ${renditionPath(rendition)}`,
      );

      // Keep torrent warm by quietly prefetching next segment
      // Dropped after KEEP_WARM_S unless is promoted (requested)
      if (this.options.keepWarm && n < asset.segmentCount - 1) {
        for (
          let i = n + 1;
          i <= Math.min(n + this.options.warmSegments, asset.segmentCount);
          i++
        ) {
          asset
            .ensureSegment(rendition, i, Priority.Background, undefined, true)
            .catch((err) => {
              if (!(err instanceof RequestAbandonedError)) {
                logger.error('Error while trying to keep warm', {
                  err,
                  rendition,
                  n,
                });
              }
            });
        }
      }

      await mainSegment;
    }

    return {
      path: file,
      contentType:
        rendition.type === 'subtitle' ? 'text/vtt; charset=utf-8' : mediaType,
      cacheControl: MEDIA_CACHE,
    };
  }

  private async publish(
    infoHash: string,
    fileIndex: number,
    priority: Priority = Priority.Foreground,
    signal?: AbortSignal,
  ): Promise<Asset> {
    const asset = await this.registry.get(
      infoHash,
      fileIndex,
      priority,
      signal,
    );
    await asset.writePlaylists();

    return asset;
  }

  private startEagerly(infoHash: string, fileIndex: number): void {
    this.registry
      .get(infoHash, fileIndex)
      .then((asset) => asset.eagerStart())
      .catch(() => {});
  }

  private async isWarm(
    infoHash: string,
    fileIndex: number | undefined,
  ): Promise<boolean> {
    const { layout } = this.options;
    if (fileIndex !== undefined) {
      return exists(layout.masterFile(infoHash, fileIndex));
    }
    const info = await readJson<TorrentInfo>(layout.infoFile(infoHash));
    const largest = info?.files
      .filter((file) => MATROSKA_FILE.test(file.name))
      .sort((a, b) => b.length - a.length)[0];
    return largest ? exists(layout.masterFile(infoHash, largest.index)) : false;
  }

  // Renders the opening of the default tracks so a later play starts without
  // waiting for indexing and remux.
  private async warmUp(
    infoHash: string,
    fileParam: number | undefined,
  ): Promise<void> {
    const started = Date.now();
    this.options.torrents.warm(infoHash);
    const fileIndex =
      fileParam ?? (await this.registry.defaultFileIndex(infoHash));
    const asset = await this.publish(infoHash, fileIndex, Priority.Background);

    const tracks = asset.openingTracks();
    for (const rendition of tracks) {
      await asset.ensureInit(
        rendition,
        path.join(asset.dirOf(rendition), 'init.mp4'),
        Priority.Background,
        undefined,
      );
    }
    const last = Math.min(this.options.warmSegments, asset.segmentCount);
    for (let n = 0; n < last; n++) {
      for (const rendition of tracks) {
        await asset
          .ensureSegment(rendition, n, Priority.Background, undefined)
          .catch(() => {});
      }
    }
    logger.info('Warmed a title', {
      infoHash,
      fileIndex,
      name: asset.index.fileName,
      segments: last,
      ms: Date.now() - started,
    });
  }

  // Counts the request as a waiter on key, so the queue can drop the work
  // when the client leaves.
  private async awaited<T>(
    key: string,
    work: () => FlightResponse<T>,
  ): Promise<T> {
    return await untilAborted(
      work,
      () => new RequestAbandonedError(`User stopped waiting for ${key}`),
      () => this.options.queue.abandon(key),
    );
  }

  // Bounds how long a client is held. The work behind it keeps running for
  // whoever asks next.
  private orTimeout<T>(work: Promise<T>, what: string): Promise<T> {
    return withTimeout(work, this.options.requestTimeoutMs, () => {
      const seconds = Math.round(this.options.requestTimeoutMs / 1000);
      logger.warn('Gave up waiting', {
        what,
        seconds,
        jobs: this.options.queue.stats,
      });
      return new HttpError(
        504,
        `Timed out after ${seconds}s producing ${what}`,
      );
    });
  }
}

function parseNumber(value: string, status: number, what: string): number {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(status, `Invalid ${what} "${value}"`);
  }
  return Number(value);
}
