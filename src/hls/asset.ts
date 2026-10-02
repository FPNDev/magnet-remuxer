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
import { exists, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import {
  Priority,
  type TaskContext,
  type TaskQueue,
} from '../util/task-queue.js';
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

  drop(reason: Error): void {
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

  async ensureInit(
    rendition: Rendition,
    file: string,
    priority: Priority,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new RequestAbandonedError(`Client is no more waiting for ${file}`);
    }

    if (await exists(file)) {
      return;
    }

    await mkdir(path.dirname(file), { recursive: true });

    const { queue, remuxer } = this.options;

    if (priority === Priority.Foreground) {
      queue.promote(file);
    }

    return this.flights.run(
      file,
      signal,
      async () => {
        await queue.run(
          {
            key: file,
            priority,
          },
          ({ signal: running }) => {
            return remuxer.writeInit(this.index, rendition, file, running);
          },
        );
      },
      () => {
        queue.abandon(file);
      },
    );
  }

  async ensureSegment(
    rendition: Rendition,
    n: number,
    priority: Priority,
    signal: AbortSignal | undefined,
    stopIfNotPromoted = false,
  ): Promise<void> {
    const { queue, segments } = this.options;
    const file = this.segmentPath(rendition, n);

    if (await this.flights.run(`exists:${file}`, signal, () => exists(file))) {
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
      this.flights.run(
        file,
        signal,
        () =>
          queue.run({ key: file, priority, stopIfNotPromoted }, (state) =>
            this.loadRemoteSegment(file, rendition, n, isForeground, state),
          ),
        () => {
          queue.abandon(file);
        },
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

  loadRemoteSegment(
    file: string,
    rendition: Rendition,
    n: number,
    isForeground: boolean,
    { signal, waitedMs, promoted }: TaskContext,
  ) {
    const { torrents, remuxer, pieces, queue, segments } = this.options;

    return torrents.use(this.infoHash, async (torrent) => {
      if (signal.aborted) {
        return;
      }

      const torrentFile = torrent.files[this.fileIndex];
      if (!torrentFile) {
        throw new HttpError(404, `Torrent has no file #${this.fileIndex}`);
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
      const source = new TorrentFileSource(torrent, torrentFile, pieces, {
        stallMs: this.options.readStallMs,
        subpieceReads: this.options.subpieceReads,
        unverified: torrents.unverified,
        ...(isForeground ? { priority: ReadPriority.Playing } : {}),
      });

      void promoted.then(() => {
        source.promote();
      });

      source.onCorrupt((error) => {
        void rm(file, { force: true }).catch(() => {});

        queue.abandon(`exists:${file}`, false, error);
        queue.abandon(file, false, error);
      });

      await mkdir(path.dirname(file), { recursive: true });

      try {
        await remuxer.writeSegment(
          { index: this.index, source, rendition, signal },
          n,
          file,
        );
      } catch (err) {
        source.release();
        throw err;
      }

      await segments.added(file);

      logger.debug('Rendered segment', {
        infoHash: this.infoHash,
        rendition: renditionPath(rendition),
        n,
        background: !isForeground,
        waitedMs,
        ms: Date.now() - started,
      });
    });
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
}
