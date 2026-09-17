import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError, RequestAbandonedError } from '../errors.js';
import { errorMessage, logger } from '../logger.js';
import { getRenditions, type Rendition } from '../media/codecs.js';
import {
  buildMediaIndex,
  MEDIA_INDEX_VERSION,
  segmentCount,
  type MediaIndex,
} from '../media/media-index.js';
import { isInfoHash, parseInfoHash } from '../torrent/magnet.js';
import type { PieceCache } from '../torrent/piece-store.js';
import type { TorrentManager } from '../torrent/torrent-manager.js';
import { TorrentFileSource } from '../torrent/torrent-source.js';
import { untilAborted, withTimeout } from '../util/async.js';
import { exists, readJson, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import {
  CancelledError,
  Priority,
  type TaskQueue,
} from '../util/task-queue.js';
import {
  masterPlaylist,
  mediaPlaylist,
  renditionPath,
  segmentFileName,
} from './playlists.js';
import type { Remuxer } from './remux.js';

export interface HlsServiceOptions {
  layout: CacheLayout;
  torrents: TorrentManager;
  pieces: PieceCache;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  segmentDuration: number;
  prefetchSegments: number;
  prefetchAheadBytes: number;
  requestTimeoutMs: number;
  readStallMs: number;
}

export interface ServedFile {
  path: string;
  contentType: string;
  cacheControl: string;
}

const MATROSKA_FILE = /\.(mkv|mk3d|webm)$/i;
const SEGMENT_NAME = /^(\d+)\.(m4s|vtt)$/;
const MEMORY_INDEX_LIMIT = 64;
/** A player waiting this long for a job slot is worth a line in the log. */
const SLOW_QUEUE_WAIT_MS = 5000;
/**
 * How long a playhead counts as live after its last segment. Long enough to
 * cover a pause or a slow render, short enough that a viewer who left stops
 * protecting prefetch nobody will watch.
 */
const HEAD_TTL_MS = 60_000;
/**
 * How often one prefetch may be preempted and queued again. Each attempt only
 * starts once no player is waiting, so this bounds wasted renders, not delay.
 */
const PREFETCH_ATTEMPTS = 3;
/** Longest run of look-ahead a rank counts; players ask for a few at a time. */
const LOOKAHEAD_SEGMENTS = 8;

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const PLAYLIST_CACHE = 'public, max-age=60';
const MEDIA_CACHE = 'public, max-age=86400';

/** Turns torrent files into HLS playlists and segments, caching everything on disk. */
export class HlsService {
  private readonly indexes = new Map<string, MediaIndex>();
  private readonly flights = new SingleFlight();
  /**
   * Segments players are waiting for, and how many are waiting. Refcounted
   * rather than flagged: two viewers who happen to want the same segment share
   * one job, and it only becomes abandonable when the last of them leaves.
   */
  private readonly wanted = new Map<string, number>();
  /**
   * Where players are reading, per rendition directory: segment number to when
   * it was last served. There is no session id anywhere in this server, and
   * this is why it does not need one - a playhead is simply somewhere a
   * segment was recently handed out, whoever asked for it.
   */
  private readonly heads = new Map<string, Map<number, number>>();
  /** When every rendition's heads were last checked for expiry. */
  private headsSweptAt = 0;

  constructor(private readonly options: HlsServiceOptions) {}

  /** Path of the master playlist for a magnet link, generating it on first use. */
  async master(
    magnet: string,
    fileParam: string | undefined,
  ): Promise<ServedFile> {
    const { layout, torrents } = this.options;
    const infoHash = parseInfoHash(magnet);
    await torrents.remember(infoHash, magnet);

    const fileIndex =
      fileParam === undefined
        ? await this.defaultFileIndex(infoHash)
        : parseNumber(fileParam, 400, 'file');
    const file = layout.masterFile(infoHash, fileIndex);

    // Connect to peers early: the player will ask for segments right away.
    torrents.warm(infoHash);
    if (!(await exists(file))) {
      await this.orTimeout(
        this.writePlaylists(infoHash, fileIndex),
        `the playlists for ${infoHash}/${fileIndex}`,
      );
    }

    return { path: file, contentType: PLAYLIST_TYPE, cacheControl: 'no-cache' };
  }

  /** The torrent's files, flagging the ones that can be streamed. */
  async files(magnet: string) {
    const infoHash = parseInfoHash(magnet);
    await this.options.torrents.remember(infoHash, magnet);
    const info = await this.options.torrents.info(infoHash);
    return {
      ...info,
      files: info.files.map((file) => ({
        ...file,
        playable: MATROSKA_FILE.test(file.name),
      })),
    };
  }

  /**
   * Resolves a path under /<infoHash>/<fileIndex>/ (e.g. "video/12.m4s") to a
   * file on disk, rendering it first if needed.
   */
  async resolve(
    infoHash: string,
    fileIndexParam: string,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile> {
    if (!isInfoHash(infoHash)) {
      throw notFound(`Malformed info hash "${infoHash}"`);
    }
    const fileIndex = parseNumber(fileIndexParam, 404, 'file index');
    this.options.torrents.touch(infoHash);

    const [kind, ...rest] = parts;
    const [trackParam, name] =
      kind === 'video' && rest.length === 1
        ? [undefined, rest[0]]
        : (kind === 'audio' || kind === 'subtitles') && rest.length === 2
          ? rest
          : [];
    if (!kind || !name) {
      throw notFound(`Unsupported path "${parts.join('/')}"`);
    }

    const index = await this.getIndex(infoHash, fileIndex);
    const rendition = findRendition(index, kind, trackParam);
    const dir = this.options.layout.mediaFile(
      infoHash,
      fileIndex,
      renditionPath(rendition),
    );
    const file = path.join(dir, name);
    const mediaType = rendition.type === 'audio' ? 'audio/mp4' : 'video/mp4';

    if (name === 'index.m3u8') {
      if (!(await exists(file))) {
        await this.orTimeout(
          this.writePlaylists(infoHash, fileIndex),
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
        this.ensureInit(infoHash, index, rendition, file),
        `the init section of ${renditionPath(rendition)}`,
      );
      return { path: file, contentType: mediaType, cacheControl: MEDIA_CACHE };
    }

    const segment = SEGMENT_NAME.exec(name);
    const n = Number(segment?.[1]);
    if (!segment || name !== segmentFileName(rendition, n)) {
      throw notFound(
        `Unexpected segment name "${name}" for ${renditionPath(rendition)}`,
      );
    }
    if (n >= segmentCount(index)) {
      throw notFound(
        `Segment ${n} is past the end of ${index.fileName} (${segmentCount(index)} segments)`,
      );
    }

    // Before the wait, not after: a player that has moved on must not queue up
    // behind prefetch for where it used to be. Doing this only once the segment
    // arrived would make it unreachable in exactly the case it is needed.
    this.dropStalePrefetch(infoHash, fileIndex, index, rendition, n);
    await this.orTimeout(
      this.ensureSegment(
        infoHash,
        fileIndex,
        index,
        rendition,
        n,
        Priority.Foreground,
        signal,
      ),
      `segment ${n} of ${renditionPath(rendition)}`,
    );
    this.markHead(dir, n);
    this.prefetch(infoHash, fileIndex, index, rendition, n);
    return {
      path: file,
      contentType:
        rendition.type === 'subtitle' ? 'text/vtt; charset=utf-8' : mediaType,
      cacheControl: MEDIA_CACHE,
    };
  }

  private async defaultFileIndex(infoHash: string): Promise<number> {
    const info = await this.options.torrents.info(infoHash);
    const candidates = info.files.filter((file) =>
      MATROSKA_FILE.test(file.name),
    );
    const largest = candidates.sort((a, b) => b.length - a.length)[0];
    if (!largest) {
      throw new HttpError(404, 'Torrent contains no MKV or WebM files');
    }
    return largest.index;
  }

  /** Fails a request that has waited too long, rather than leaving it hanging. */
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

  private async getIndex(
    infoHash: string,
    fileIndex: number,
  ): Promise<MediaIndex> {
    const key = `${infoHash}/${fileIndex}`;
    const cached = this.indexes.get(key);
    return cached ?? (await this.buildOrLoadIndex(infoHash, fileIndex, key));
  }

  private buildOrLoadIndex(
    infoHash: string,
    fileIndex: number,
    key: string,
  ): Promise<MediaIndex> {
    return this.flights.run(`index:${key}`, async () => {
      const { layout, segmentDuration } = this.options;
      const indexFile = layout.indexFile(infoHash, fileIndex);

      let index = await readJson<MediaIndex>(indexFile);
      if (
        index?.version !== MEDIA_INDEX_VERSION ||
        index.targetDuration !== segmentDuration
      ) {
        // Segment numbering depends on these, so anything rendered before is stale.
        await rm(layout.mediaDir(infoHash, fileIndex), {
          recursive: true,
          force: true,
        });
        index = await this.buildIndex(infoHash, fileIndex);
        await mkdir(layout.mediaDir(infoHash, fileIndex), { recursive: true });
        await writeFileAtomic(indexFile, JSON.stringify(index));
      }

      this.indexes.set(key, index);
      if (this.indexes.size > MEMORY_INDEX_LIMIT) {
        this.indexes.delete(this.indexes.keys().next().value!);
      }
      return index;
    });
  }

  private buildIndex(infoHash: string, fileIndex: number): Promise<MediaIndex> {
    return this.options.torrents.use(infoHash, async (torrent) => {
      const file = torrent.files[fileIndex];
      if (!file) {
        throw new HttpError(404, `Torrent has no file #${fileIndex}`);
      }
      if (!MATROSKA_FILE.test(file.name)) {
        throw new HttpError(422, `${file.name} is not an MKV or WebM file`);
      }

      const started = Date.now();
      const source = new TorrentFileSource(torrent, file, this.options.pieces, {
        stallMs: this.options.readStallMs,
      });
      const index = await buildMediaIndex(
        source,
        file.name,
        this.options.segmentDuration,
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
    });
  }

  /** Writes all media playlists, then the master playlist, which marks completion. */
  private writePlaylists(infoHash: string, fileIndex: number): Promise<void> {
    return this.flights.run(`playlists:${infoHash}/${fileIndex}`, async () => {
      const { layout } = this.options;
      const index = await this.getIndex(infoHash, fileIndex);
      const renditions = getRenditions(index);

      for (const rendition of [
        renditions.video,
        ...renditions.audio,
        ...renditions.subtitles,
      ]) {
        const dir = layout.mediaFile(
          infoHash,
          fileIndex,
          renditionPath(rendition),
        );
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(
          path.join(dir, 'index.m3u8'),
          mediaPlaylist(index, rendition),
        );
      }
      await writeFileAtomic(
        layout.masterFile(infoHash, fileIndex),
        masterPlaylist(index, renditions, `${infoHash}/${fileIndex}`),
      );
    });
  }

  private ensureInit(
    infoHash: string,
    index: MediaIndex,
    rendition: Rendition,
    file: string,
  ): Promise<void> {
    return this.flights.run(file, async () => {
      if (await exists(file)) {
        return;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await this.options.queue.run(
        // An init section is built from the index or from silence and never
        // reads the torrent, so it does not take one of the torrent's read
        // slots - on a first play it is requested alongside segment 0, and
        // would otherwise hold that segment up.
        { key: file, priority: Priority.Foreground, group: `${infoHash}:init` },
        ({ signal }) =>
          this.options.remuxer.writeInit(index, rendition, file, signal),
      );
    });
  }

  private async ensureSegment(
    infoHash: string,
    fileIndex: number,
    index: MediaIndex,
    rendition: Rendition,
    n: number,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<void> {
    const { layout, queue, segments, torrents, remuxer, pieces } = this.options;
    const file = layout.mediaFile(
      infoHash,
      fileIndex,
      `${renditionPath(rendition)}/${segmentFileName(rendition, n)}`,
    );

    const isForeground = priority === Priority.Foreground;
    if (signal?.aborted) {
      throw new RequestAbandonedError(`Nobody is waiting for ${file}`);
    }
    // Asked again whenever the queue picks what runs next: requests for one
    // landing can arrive out of order over separate connections, and a segment
    // becomes the one a player needs next as the one before it completes.
    const rank = isForeground
      ? () => this.urgency(infoHash, fileIndex, rendition, n)
      : 0;
    // Whether this was the segment a player needed when it asked, rather than
    // look-ahead - the only kind worth a warning when it has to wait.
    const neededNow = typeof rank === 'function' && rank() === 0;
    if (isForeground) {
      queue.promote(file, rank);
      this.wanted.set(file, (this.wanted.get(file) ?? 0) + 1);
    }

    const render = () =>
      this.flights.run(file, async () => {
        if (await exists(file)) {
          segments.touch(file);
          return;
        }
        // Checking the disk takes a moment, and a player seeking quickly can
        // give up within it: abandoning then finds nothing queued to remove.
        // Queueing now would leave a job nobody waits for, which nothing can
        // take the slot back from.
        if (isForeground && !this.wanted.has(file)) {
          throw new CancelledError(`Nobody is waiting for ${file}`);
        }

        await queue.run(
          { key: file, priority, group: infoHash, rank },
          ({ signal, waitedMs }) =>
            torrents.use(infoHash, async (torrent) => {
              const torrentFile = torrent.files[fileIndex];
              if (!torrentFile) {
                throw new HttpError(404, `Torrent has no file #${fileIndex}`);
              }
              // Look-ahead is meant to wait; only a segment a player cannot
              // play without is worth a warning.
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
                },
              );
              await mkdir(path.dirname(file), { recursive: true });
              await remuxer.writeSegment(
                { index, source, rendition, signal },
                n,
                file,
              );
              await segments.added(file);
              logger.debug('Rendered segment', {
                infoHash,
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
      for (;;) {
        try {
          return await render();
        } catch (err) {
          // Preempted: prefetch this player joined, or look-ahead that gave
          // its slot to a segment another track's first frame needed. The
          // segment is still wanted, so it goes back in the queue - unless
          // this player is the one that left.
          if (
            signal?.aborted ||
            !isForeground ||
            !(err instanceof CancelledError)
          ) {
            throw err;
          }
        }
      }
    };

    try {
      // The render carries on until the queue is told otherwise below; this
      // only stops *waiting* on it, which is what lets the finally run at all.
      await untilAborted(
        attempt(),
        signal,
        () => new RequestAbandonedError(`Nobody is waiting for ${file}`),
      );
    } finally {
      if (isForeground) {
        const waiting = (this.wanted.get(file) ?? 1) - 1;
        if (waiting > 0) {
          this.wanted.set(file, waiting);
        } else {
          this.wanted.delete(file);
          // The last player waiting for this has gone. Queued, it would keep
          // its place in a queue two jobs wide for as long as the torrent
          // lives, which is how a scrub used to bury the segment wanted next;
          // running, it would go on splitting the swarm with the reads that are
          // wanted. It carries on only if some playhead is heading its way.
          if (signal?.aborted) {
            queue.abandon(
              file,
              this.isAhead(infoHash, fileIndex, index, rendition, n),
            );
          }
        }
      }
    }
  }

  /** How many segments to read ahead, bounded by bytes rather than count. */
  private prefetchDepth(index: MediaIndex): number {
    const affordable = Math.floor(
      this.options.prefetchAheadBytes / bytesPerSegment(index),
    );
    return Math.max(1, Math.min(this.options.prefetchSegments, affordable));
  }

  /** The rendition's directory, which is also its key in `heads`. */
  private renditionDir(
    infoHash: string,
    fileIndex: number,
    rendition: Rendition,
  ): string {
    return this.options.layout.mediaFile(
      infoHash,
      fileIndex,
      renditionPath(rendition),
    );
  }

  /** Records that a player is reading at `n`, and that it has left `n - 1`. */
  private markHead(dir: string, n: number): void {
    let heads = this.heads.get(dir);
    if (!heads) {
      heads = new Map();
      this.heads.set(dir, heads);
    }
    // Playing forwards moves a head rather than adding one, so the set stays
    // the size of the audience instead of growing with the running time.
    heads.delete(n - 1);
    const now = Date.now();
    heads.set(n, now);

    // Renditions nobody asks for again would otherwise keep their last heads
    // for the life of the process.
    if (now - this.headsSweptAt > HEAD_TTL_MS) {
      this.headsSweptAt = now;
      for (const other of this.heads.keys()) {
        this.liveHeads(other);
      }
    }
  }

  /**
   * How urgent a player's request for `n` is, lower first: how many requests
   * for the segments directly before it, in the same rendition, are still
   * waiting - an unbroken run, `n - 1`, `n - 2` and so on.
   *
   * Players ask for a segment and the next few in one go - on load, after every
   * seek, and as they play - one track after another. So the segment a frame
   * needs is 0 in every track and its look-ahead counts up behind it: video and
   * audio for a seek take the slots, and the next video segment does not slip
   * in between them. The run has to be unbroken: a waiting request a few
   * segments back may be someone else's, and says nothing about this one.
   * Positions already served say nothing either; ranking off those made the
   * segment after a short seek look like look-ahead.
   *
   * Two viewers each get their next segment before either gets the one after,
   * without the server knowing they are two.
   */
  private urgency(
    infoHash: string,
    fileIndex: number,
    rendition: Rendition,
    n: number,
  ): number {
    const prefix = this.renditionDir(infoHash, fileIndex, rendition) + path.sep;
    let rank = 0;
    while (
      rank < LOOKAHEAD_SEGMENTS &&
      n - rank - 1 >= 0 &&
      this.wanted.has(prefix + segmentFileName(rendition, n - rank - 1))
    ) {
      rank++;
    }
    return rank;
  }

  /** Playheads still worth prefetching for, dropping any that have gone quiet. */
  private liveHeads(dir: string): number[] {
    const heads = this.heads.get(dir);
    if (!heads) {
      return [];
    }
    const cutoff = Date.now() - HEAD_TTL_MS;
    for (const [n, seen] of heads) {
      if (seen < cutoff) {
        heads.delete(n);
      }
    }
    if (heads.size === 0) {
      this.heads.delete(dir);
    }
    return [...heads.keys()];
  }

  /**
   * Drops queued prefetch that no player is heading for. What survives is the
   * union of every live playhead's window plus the caller's own: one viewer
   * asking for segment 4 says nothing about the viewer reading segment 900, and
   * cancelling by rendition alone would throw that viewer's prefetch away.
   */
  private dropStalePrefetch(
    infoHash: string,
    fileIndex: number,
    index: MediaIndex,
    rendition: Rendition,
    n: number,
  ): void {
    const dir = this.renditionDir(infoHash, fileIndex, rendition);
    const prefix = dir + path.sep;
    const depth = this.prefetchDepth(index);
    const last = segmentCount(index) - 1;

    const keep = new Set<string>();
    for (const head of [...this.liveHeads(dir), n]) {
      for (let k = head; k <= Math.min(last, head + depth); k++) {
        keep.add(prefix + segmentFileName(rendition, k));
      }
    }
    this.options.queue.cancelBackground(
      (key) =>
        key.startsWith(prefix) && !keep.has(key) && !this.wanted.has(key),
    );
  }

  /** Renders the next few segments ahead of `n` in the background. */
  private prefetch(
    infoHash: string,
    fileIndex: number,
    index: MediaIndex,
    rendition: Rendition,
    n: number,
  ): void {
    const last = Math.min(
      segmentCount(index) - 1,
      n + this.prefetchDepth(index),
    );

    for (let next = n + 1; next <= last; next++) {
      this.prefetchSegment(infoHash, fileIndex, index, rendition, next, 1);
    }
  }

  private prefetchSegment(
    infoHash: string,
    fileIndex: number,
    index: MediaIndex,
    rendition: Rendition,
    n: number,
    attempt: number,
  ): void {
    this.ensureSegment(
      infoHash,
      fileIndex,
      index,
      rendition,
      n,
      Priority.Background,
    ).catch((err: unknown) => {
      if (!(err instanceof CancelledError)) {
        logger.warn('Prefetch failed', {
          infoHash,
          rendition: renditionPath(rendition),
          n,
          error: errorMessage(err),
        });
        return;
      }
      // Cancelled for one of two reasons. Swept, because no playhead is heading
      // this way - then it stays gone. Or preempted by some player's request,
      // quite possibly another viewer's, while a playhead still is - then it
      // goes back in the queue.
      if (
        attempt < PREFETCH_ATTEMPTS &&
        this.isAhead(infoHash, fileIndex, index, rendition, n)
      ) {
        this.prefetchSegment(infoHash, fileIndex, index, rendition, n, attempt + 1);
      }
    });
  }

  /** Whether segment `n` is inside some live playhead's prefetch window. */
  private isAhead(
    infoHash: string,
    fileIndex: number,
    index: MediaIndex,
    rendition: Rendition,
    n: number,
  ): boolean {
    const depth = this.prefetchDepth(index);
    const dir = this.renditionDir(infoHash, fileIndex, rendition);
    return this.liveHeads(dir).some((head) => head < n && n <= head + depth);
  }
}

function findRendition(
  index: MediaIndex,
  kind: string,
  trackParam: string | undefined,
): Rendition {
  const renditions = getRenditions(index);
  const track =
    trackParam === undefined
      ? undefined
      : parseNumber(trackParam, 404, 'track');
  const rendition =
    kind === 'video'
      ? renditions.video
      : kind === 'audio'
        ? renditions.audio.find((audio) => audio.track.number === track)
        : renditions.subtitles.find(
            (subtitle) => subtitle.track.number === track,
          );
  if (!rendition) {
    throw notFound(
      `${index.fileName} has no ${kind} rendition for track ${track}`,
    );
  }
  return rendition;
}

/** Average bytes read per segment, which is what a prefetch really costs. */
function bytesPerSegment(index: MediaIndex): number {
  return Math.max(1, index.fileLength / segmentCount(index));
}

function parseNumber(value: string, status: number, what: string): number {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(status, `Invalid ${what} "${value}"`);
  }
  return Number(value);
}

/** The message matters: these all reach the client as a bare 404 otherwise. */
function notFound(detail: string): HttpError {
  return new HttpError(404, detail);
}
