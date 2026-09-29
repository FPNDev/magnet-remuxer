import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError, RequestAbandonedError } from '../errors.js';
import { logger } from '../logger.js';
import {
  getRenditions,
  type Rendition,
  type RenditionSet,
} from '../media/codecs.js';
import { segmentCount, type MediaIndex } from '../media/media-index.js';
import type { PieceCache } from '../torrent/piece-store.js';
import type { TorrentManager } from '../torrent/torrent-manager.js';
import { ReadPriority, TorrentFileSource } from '../torrent/torrent-source.js';
import { untilAborted } from '../util/async.js';
import { exists, writeFileAtomic } from '../util/fs.js';
import { SingleFlight, type FlightResponse } from '../util/single-flight.js';
import { Priority, type TaskQueue } from '../util/task-queue.js';
import {
  masterPlaylist,
  mediaPlaylist,
  renditionPath,
  segmentFileName,
} from './playlists.js';
import type { Remuxer } from './remux.js';

// Past this, a player is waiting on job slots rather than on download
// speed. It is logged, never enforced.
const SLOW_QUEUE_WAIT_MS = 5000;

export type AssetOptions = {
  infoHash: string;
  fileIndex: number;
  index: MediaIndex;
  layout: CacheLayout;
  torrents: TorrentManager;
  pieces: PieceCache;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  readStallMs: number;
  subpieceReads: boolean;
  warmSegments: number;
};

/**
 * One (infoHash, fileIndex) pair: its media index, renditions, cache
 * directories, and the work that fills them.
 */
export class Asset {
  readonly index: MediaIndex;
  readonly renditions: RenditionSet;
  private readonly flights = new SingleFlight();
  private readonly stopped = new AbortController();

  constructor(private readonly options: AssetOptions) {
    this.index = options.index;
    this.renditions = getRenditions(options.index);
  }

  get infoHash(): string {
    return this.options.infoHash;
  }

  get fileIndex(): number {
    return this.options.fileIndex;
  }

  get segmentCount(): number {
    return segmentCount(this.index);
  }

  get dropped(): AbortSignal {
    return this.stopped.signal;
  }

  drop(reason: Error): void {
    this.stopped.abort(reason);
    for (const key of this.flights.keys()) {
      this.options.queue.abandon(key, false, reason);
    }
  }

  dirOf(rendition: Rendition): string {
    return this.options.layout.mediaFile(
      this.options.infoHash,
      this.options.fileIndex,
      renditionPath(rendition),
    );
  }

  segmentPath(rendition: Rendition, n: number): string {
    return path.join(this.dirOf(rendition), segmentFileName(rendition, n));
  }

  rendition(kind: string, track: number | undefined): Rendition {
    const found =
      kind === 'video'
        ? this.renditions.video
        : kind === 'audio'
          ? this.renditions.audio.find((audio) => audio.track.number === track)
          : this.renditions.subtitles.find(
              (subtitle) => subtitle.track.number === track,
            );
    if (!found) {
      throw new HttpError(
        404,
        `${this.index.fileName} has no ${kind} rendition for track ${track}`,
      );
    }
    return found;
  }

  writePlaylists(): Promise<void> {
    const { layout, infoHash, fileIndex } = this.options;
    return this.flights.run('playlists', undefined, async () => {
      for (const rendition of this.all()) {
        this.stopped.signal.throwIfAborted();
        const dir = this.dirOf(rendition);
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(
          path.join(dir, 'index.m3u8'),
          mediaPlaylist(this.index, rendition),
        );
      }
      this.stopped.signal.throwIfAborted();
      await writeFileAtomic(
        layout.masterFile(infoHash, fileIndex),
        masterPlaylist(this.index, this.renditions, `${infoHash}/${fileIndex}`),
      );
    }).promise;
  }

  ensureInit(
    rendition: Rendition,
    file: string,
    priority: Priority,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new RequestAbandonedError(`Client is not more waiting for ${file}`),
      );
    }
    const { queue, remuxer } = this.options;
    if (priority === Priority.Foreground) {
      queue.promote(file);
    }

    return this.awaited(file, () =>
      this.flights.run(file, signal, async () => {
        if (await exists(file)) {
          return;
        }
        await mkdir(path.dirname(file), { recursive: true });
        await queue.run(
          {
            key: file,
            priority,
          },
          ({ signal: running }) => {
            this.stopped.signal.throwIfAborted();
            return remuxer.writeInit(this.index, rendition, file, running);
          },
        );
      }),
    );
  }

  async ensureSegment(
    rendition: Rendition,
    n: number,
    priority: Priority,
    signal: AbortSignal | undefined,
    stopIfNotPromoted = false,
  ): Promise<void> {
    const { queue, segments, torrents, remuxer, pieces } = this.options;
    const file = this.segmentPath(rendition, n);
    if (await exists(file)) {
      segments.touch(file);
      return;
    }
    if (signal?.aborted) {
      throw new RequestAbandonedError(`Client is not more waiting for ${file}`);
    }
    const isForeground = priority === Priority.Foreground;
    if (isForeground) {
      queue.promote(file);
    }

    queue.refreshAbandonTimer(file);
    const render = () =>
      this.awaited(file, () =>
        this.flights.run(file, signal, () =>
          queue.run(
            { key: file, priority, stopIfNotPromoted },
            ({ signal: running, waitedMs, promoted }) =>
              torrents.use(this.infoHash, async (torrent) => {
                this.stopped.signal.throwIfAborted();
                const torrentFile = torrent.files[this.fileIndex];
                if (!torrentFile) {
                  throw new HttpError(
                    404,
                    `Torrent has no file #${this.fileIndex}`,
                  );
                }
                if (waitedMs > SLOW_QUEUE_WAIT_MS) {
                  logger.warn('Player waited for a free job slot', {
                    rendition: renditionPath(rendition),
                    n,
                    waitedMs,
                    jobs: queue.stats,
                  });
                }

                const started = Date.now();
                const source = new TorrentFileSource(
                  torrent,
                  torrentFile,
                  pieces,
                  {
                    stallMs: this.options.readStallMs,
                    subpieceReads: this.options.subpieceReads,
                    unverified: torrents.unverified,
                    ...(isForeground ? { priority: ReadPriority.Playing } : {}),
                  },
                );
                void promoted.then(() => {
                  source.promote();
                });
                source.onCorrupt((error) => {
                  queue.abandon(file, false, error);
                });

                await mkdir(path.dirname(file), { recursive: true });
                try {
                  await remuxer.writeSegment(
                    { index: this.index, source, rendition, signal: running },
                    n,
                    file,
                  );
                } catch (err) {
                  source.release();
                  throw err;
                }
                await segments.added(file);
                source.onCorrupt(() => {
                  void rm(file, { force: true }).catch(() => {});
                });
                logger.debug('Rendered segment', {
                  infoHash: this.infoHash,
                  rendition: renditionPath(rendition),
                  n,
                  background: !isForeground,
                  waitedMs,
                  ms: Date.now() - started,
                });
              }),
          ),
        ),
      );

    try {
      await render();
    } catch (err) {
      if (err instanceof RequestAbandonedError) {
        for (
          let i = n + 1;
          i < Math.min(n + 1 + this.options.warmSegments, this.segmentCount);
          i++
        ) {
          queue.abandon(this.segmentPath(rendition, i), true);
        }
      }
      throw err;
    }
  }

  openingTracks(): Rendition[] {
    const audio =
      this.renditions.audio.find((track) => track.track.isDefault) ??
      this.renditions.audio[0];
    return audio ? [audio, this.renditions.video] : [this.renditions.video];
  }

  eagerStart(): void {
    for (const rendition of this.openingTracks()) {
      const init = path.join(this.dirOf(rendition), 'init.mp4');
      this.ensureInit(rendition, init, Priority.Background, undefined).catch(
        () => {},
      );
      if (this.segmentCount > 0) {
        this.ensureSegment(rendition, 0, Priority.Background, undefined).catch(
          () => {},
        );
      }
    }
  }

  all(): Rendition[] {
    return [
      this.renditions.video,
      ...this.renditions.audio,
      ...this.renditions.subtitles,
    ];
  }

  // Counts the caller as a waiter on key, so the queue can rank the work and
  // abandon it once the last waiter is gone.
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
