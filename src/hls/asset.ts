import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError, RequestAbandonedError } from '../errors.js';
import { errorMessage, logger } from '../logger.js';
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
import { SingleFlight } from '../util/single-flight.js';
import {
  CancelledError,
  Priority,
  type TaskQueue,
} from '../util/task-queue.js';
import { keyPrefix, type Playheads } from './playhead.js';
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
const RENDER_ATTEMPTS = 4;

export interface AssetOptions {
  infoHash: string;
  fileIndex: number;
  index: MediaIndex;
  layout: CacheLayout;
  torrents: TorrentManager;
  pieces: PieceCache;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  playheads: Playheads;
  prefetchSegments: number;
  prefetchAheadBytes: number;
  readStallMs: number;
}

/**
 * One (infoHash, fileIndex) pair: its media index, renditions, cache
 * directories, and the work that fills them.
 */
export class Asset {
  readonly index: MediaIndex;
  readonly renditions: RenditionSet;
  private readonly flights = new SingleFlight();
  private readonly segmentBytes = new Map<string, number>();

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
    return this.flights.run('playlists', async () => {
      for (const rendition of this.all()) {
        const dir = this.dirOf(rendition);
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(
          path.join(dir, 'index.m3u8'),
          mediaPlaylist(this.index, rendition),
        );
      }
      await writeFileAtomic(
        layout.masterFile(infoHash, fileIndex),
        masterPlaylist(this.index, this.renditions, `${infoHash}/${fileIndex}`),
      );
    });
  }

  ensureInit(
    rendition: Rendition,
    file: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { queue, remuxer, infoHash } = this.options;
    return this.awaited(file, signal, () =>
      this.flights.run(file, async () => {
        if (await exists(file)) {
          return;
        }
        await mkdir(path.dirname(file), { recursive: true });
        await queue.run(
          {
            key: file,
            priority: Priority.Foreground,
            group: `${infoHash}:init`,
          },
          ({ signal: running }) =>
            remuxer.writeInit(this.index, rendition, file, running),
        );
      }),
    );
  }

  async ensureSegment(
    rendition: Rendition,
    n: number,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<void> {
    const { queue, segments, torrents, remuxer, pieces, playheads } =
      this.options;
    const file = this.segmentPath(rendition, n);
    const isForeground = priority === Priority.Foreground;
    if (signal?.aborted) {
      throw new RequestAbandonedError(`Nobody is waiting for ${file}`);
    }

    const dir = this.dirOf(rendition);
    const name = (k: number) => segmentFileName(rendition, k);
    // Foreground rank is a function because urgency changes while the job
    // waits, as players advance and other requests arrive.
    const rank = isForeground ? () => playheads.urgency(dir, name, n) : 0;
    // Rank 0 means no earlier segment is still wanted, so a player is blocked
    // on this one right now.
    const neededNow = typeof rank === 'function' && rank() === 0;
    if (isForeground) {
      queue.promote(file, rank);
      playheads.want(file);
    }

    const render = () =>
      this.flights.run(file, async () => {
        if (await exists(file)) {
          segments.touch(file);
          return;
        }
        // Everyone who asked for this segment left while the flight was queued.
        if (isForeground && !playheads.waiting(file)) {
          throw new CancelledError(`Nobody is waiting for ${file}`);
        }

        await queue.run(
          { key: file, priority, group: this.infoHash, rank },
          ({ signal: running, waitedMs }) =>
            torrents.use(this.infoHash, async (torrent) => {
              const torrentFile = torrent.files[this.fileIndex];
              if (!torrentFile) {
                throw new HttpError(
                  404,
                  `Torrent has no file #${this.fileIndex}`,
                );
              }
              if (neededNow && waitedMs > SLOW_QUEUE_WAIT_MS) {
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
                  ...(isForeground ? { priority: ReadPriority.Playing } : {}),
                },
              );
              await mkdir(path.dirname(file), { recursive: true });
              await remuxer.writeSegment(
                { index: this.index, source, rendition, signal: running },
                n,
                file,
              );
              this.noteSize(rendition, await segments.added(file));
              logger.debug('Rendered segment', {
                infoHash: this.infoHash,
                rendition: renditionPath(rendition),
                n,
                background: !isForeground,
                waitedMs,
                ms: Date.now() - started,
              });
            }),
        );
      });

    const attempt = async () => {
      // A foreground render preempted by a higher-ranked job takes a new slot
      // and tries again, rather than failing the player.
      for (let tries = 0; tries < RENDER_ATTEMPTS; tries++) {
        try {
          return await render();
        } catch (err) {
          if (
            signal?.aborted ||
            !isForeground ||
            !(err instanceof CancelledError)
          ) {
            throw err;
          }
        }
      }
      throw new HttpError(
        503,
        `Segment ${n} of ${renditionPath(rendition)} kept losing its slot`,
      );
    };

    try {
      await untilAborted(
        attempt(),
        signal,
        () => new RequestAbandonedError(`Nobody is waiting for ${file}`),
      );
    } finally {
      // Last waiter left: drop the job unless a live playhead still reaches
      // this segment.
      if (isForeground && playheads.release(file) && signal?.aborted) {
        queue.abandon(file, this.isAhead(rendition, n));
      }
    }
  }

  markHead(rendition: Rendition, n: number): void {
    this.options.playheads.mark(this.dirOf(rendition), n);
  }

  // A seek strands background jobs for segments nobody will reach. Only the
  // ones inside a live prefetch window survive.
  dropStalePrefetch(rendition: Rendition, n: number): void {
    const { queue, playheads } = this.options;
    const dir = this.dirOf(rendition);
    const prefix = keyPrefix(dir);
    const keep = playheads.window(
      dir,
      (k) => segmentFileName(rendition, k),
      n,
      this.prefetchDepth(rendition),
      this.segmentCount - 1,
    );
    queue.cancelBackground(
      (key) =>
        key.startsWith(prefix) && !keep.has(key) && !playheads.waiting(key),
    );
  }

  prefetchAfter(rendition: Rendition, n: number): void {
    const last = Math.min(
      this.segmentCount - 1,
      n + this.prefetchDepth(rendition),
    );
    for (let next = n + 1; next <= last; next++) {
      this.prefetchSegment(rendition, next, 1);
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
      this.ensureInit(rendition, init).catch(() => {});
      if (this.segmentCount > 0) {
        this.ensureSegment(rendition, 0, Priority.Background).catch(() => {});
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

  private prefetchSegment(
    rendition: Rendition,
    n: number,
    attempt: number,
  ): void {
    this.ensureSegment(rendition, n, Priority.Background).catch(
      (err: unknown) => {
        if (!(err instanceof CancelledError)) {
          logger.warn('Prefetch failed', {
            infoHash: this.infoHash,
            rendition: renditionPath(rendition),
            n,
            error: errorMessage(err),
          });
          return;
        }
        if (attempt < RENDER_ATTEMPTS && this.isAhead(rendition, n)) {
          this.prefetchSegment(rendition, n, attempt + 1);
        }
      },
    );
  }

  private isAhead(rendition: Rendition, n: number): boolean {
    return this.options.playheads.isAhead(
      this.dirOf(rendition),
      n,
      this.prefetchDepth(rendition),
    );
  }

  // Depth is bounded in bytes, not segments, so a high-bitrate file does not
  // pull the torrent far ahead of the playhead.
  private prefetchDepth(rendition: Rendition): number {
    const bytes = this.segmentBytes.get(renditionPath(rendition));
    const perSegment =
      bytes ?? Math.max(1, this.index.fileLength / this.segmentCount);
    const affordable = Math.floor(this.options.prefetchAheadBytes / perSegment);
    return Math.max(1, Math.min(this.options.prefetchSegments, affordable));
  }

  // Rolling average of rendered segment size. It sizes the prefetch window
  // before the first segment of a rendition exists.
  private noteSize(rendition: Rendition, bytes: number): void {
    const key = renditionPath(rendition);
    const seen = this.segmentBytes.get(key);
    this.segmentBytes.set(
      key,
      seen === undefined ? bytes : Math.round(seen * 0.75 + bytes * 0.25),
    );
  }

  // Counts the caller as a waiter on key, so the queue can rank the work and
  // abandon it once the last waiter is gone.
  private async awaited<T>(
    key: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const { playheads, queue } = this.options;
    if (signal?.aborted) {
      throw new RequestAbandonedError(`Nobody is waiting for ${key}`);
    }
    playheads.want(key);
    try {
      return await untilAborted(
        work(),
        signal,
        () => new RequestAbandonedError(`Nobody is waiting for ${key}`),
      );
    } finally {
      if (playheads.release(key) && signal?.aborted) {
        queue.abandon(key);
      }
    }
  }
}
