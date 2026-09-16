import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { HttpError } from '../errors.js';
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
import { exists, readJson, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import { CancelledError, Priority, type TaskQueue } from '../util/task-queue.js';
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

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const PLAYLIST_CACHE = 'public, max-age=60';
const MEDIA_CACHE = 'public, max-age=86400';

/** Turns torrent files into HLS playlists and segments, caching everything on disk. */
export class HlsService {
  private readonly indexes = new Map<string, MediaIndex>();
  private readonly flights = new SingleFlight();

  constructor(private readonly options: HlsServiceOptions) {}

  /** Path of the master playlist for a magnet link, generating it on first use. */
  async master(magnet: string, fileParam: string | undefined): Promise<ServedFile> {
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
    if (!(await exists(file))) await this.writePlaylists(infoHash, fileIndex);

    return { path: file, contentType: PLAYLIST_TYPE, cacheControl: 'no-cache' };
  }

  /** The torrent's files, flagging the ones that can be streamed. */
  async files(magnet: string) {
    const infoHash = parseInfoHash(magnet);
    await this.options.torrents.remember(infoHash, magnet);
    const info = await this.options.torrents.info(infoHash);
    return {
      ...info,
      files: info.files.map((file) => ({ ...file, playable: MATROSKA_FILE.test(file.name) })),
    };
  }

  /**
   * Resolves a path under /<infoHash>/<fileIndex>/ (e.g. "video/12.m4s") to a
   * file on disk, rendering it first if needed.
   */
  async resolve(infoHash: string, fileIndexParam: string, parts: string[]): Promise<ServedFile> {
    if (!isInfoHash(infoHash)) throw notFound(`Malformed info hash "${infoHash}"`);
    const fileIndex = parseNumber(fileIndexParam, 404, 'file index');
    this.options.torrents.touch(infoHash);

    const [kind, ...rest] = parts;
    const [trackParam, name] =
      kind === 'video' && rest.length === 1
        ? [undefined, rest[0]]
        : (kind === 'audio' || kind === 'subtitles') && rest.length === 2
          ? rest
          : [];
    if (!kind || !name) throw notFound(`Unsupported path "${parts.join('/')}"`);

    const index = await this.getIndex(infoHash, fileIndex);
    const rendition = findRendition(index, kind, trackParam);
    const dir = this.options.layout.mediaFile(infoHash, fileIndex, renditionPath(rendition));
    const file = path.join(dir, name);
    const mediaType = rendition.type === 'audio' ? 'audio/mp4' : 'video/mp4';

    if (name === 'index.m3u8') {
      if (!(await exists(file))) await this.writePlaylists(infoHash, fileIndex);
      return { path: file, contentType: PLAYLIST_TYPE, cacheControl: PLAYLIST_CACHE };
    }

    if (name === 'init.mp4' && rendition.type !== 'subtitle') {
      await this.ensureInit(index, rendition, file);
      return { path: file, contentType: mediaType, cacheControl: MEDIA_CACHE };
    }

    const segment = SEGMENT_NAME.exec(name);
    const n = Number(segment?.[1]);
    if (!segment || name !== segmentFileName(rendition, n)) {
      throw notFound(`Unexpected segment name "${name}" for ${renditionPath(rendition)}`);
    }
    if (n >= segmentCount(index)) {
      throw notFound(`Segment ${n} is past the end of ${index.fileName} (${segmentCount(index)} segments)`);
    }

    await this.ensureSegment(infoHash, fileIndex, index, rendition, n, Priority.Foreground);
    this.prefetch(infoHash, fileIndex, index, rendition, n);
    return {
      path: file,
      contentType: rendition.type === 'subtitle' ? 'text/vtt; charset=utf-8' : mediaType,
      cacheControl: MEDIA_CACHE,
    };
  }

  private async defaultFileIndex(infoHash: string): Promise<number> {
    const info = await this.options.torrents.info(infoHash);
    const candidates = info.files.filter((file) => MATROSKA_FILE.test(file.name));
    const largest = candidates.sort((a, b) => b.length - a.length)[0];
    if (!largest) throw new HttpError(404, 'Torrent contains no MKV or WebM files');
    return largest.index;
  }

  private getIndex(infoHash: string, fileIndex: number): Promise<MediaIndex> {
    const key = `${infoHash}/${fileIndex}`;
    const cached = this.indexes.get(key);
    if (cached) return Promise.resolve(cached);

    return this.flights.run(`index:${key}`, async () => {
      const { layout, segmentDuration } = this.options;
      const indexFile = layout.indexFile(infoHash, fileIndex);

      let index = await readJson<MediaIndex>(indexFile);
      if (index?.version !== MEDIA_INDEX_VERSION || index.targetDuration !== segmentDuration) {
        // Segment numbering depends on these, so anything rendered before is stale.
        await rm(layout.mediaDir(infoHash, fileIndex), { recursive: true, force: true });
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
      if (!file) throw new HttpError(404, `Torrent has no file #${fileIndex}`);
      if (!MATROSKA_FILE.test(file.name)) {
        throw new HttpError(422, `${file.name} is not an MKV or WebM file`);
      }

      const started = Date.now();
      const source = new TorrentFileSource(torrent, file, this.options.pieces, {
        stallMs: this.options.readStallMs,
      });
      const index = await buildMediaIndex(source, file.name, this.options.segmentDuration);
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

      for (const rendition of [renditions.video, ...renditions.audio, ...renditions.subtitles]) {
        const dir = layout.mediaFile(infoHash, fileIndex, renditionPath(rendition));
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(path.join(dir, 'index.m3u8'), mediaPlaylist(index, rendition));
      }
      await writeFileAtomic(
        layout.masterFile(infoHash, fileIndex),
        masterPlaylist(index, renditions, `${infoHash}/${fileIndex}`),
      );
    });
  }

  private ensureInit(index: MediaIndex, rendition: Rendition, file: string): Promise<void> {
    return this.flights.run(file, async () => {
      if (await exists(file)) return;
      await mkdir(path.dirname(file), { recursive: true });
      await this.options.queue.run(file, Priority.Foreground, () =>
        this.options.remuxer.writeInit(index, rendition, file),
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
  ): Promise<void> {
    const { layout, queue, segments, torrents, remuxer, pieces } = this.options;
    const file = layout.mediaFile(
      infoHash,
      fileIndex,
      `${renditionPath(rendition)}/${segmentFileName(rendition, n)}`,
    );

    if (priority === Priority.Foreground) queue.promote(file);
    await this.flights.run(file, async () => {
      if (await exists(file)) {
        segments.touch(file);
        return;
      }

      await queue.run(file, priority, () =>
        torrents.use(infoHash, async (torrent) => {
          const torrentFile = torrent.files[fileIndex];
          if (!torrentFile) throw new HttpError(404, `Torrent has no file #${fileIndex}`);

          const started = Date.now();
          const source = new TorrentFileSource(torrent, torrentFile, pieces, {
            stallMs: this.options.readStallMs,
          });
          await mkdir(path.dirname(file), { recursive: true });
          await remuxer.writeSegment({ index, source, rendition }, n, file);
          await segments.added(file);
          logger.debug('Rendered segment', {
            infoHash,
            rendition: renditionPath(rendition),
            n,
            background: priority === Priority.Background,
            ms: Date.now() - started,
          });
        }),
      );
    });
  }

  /** Renders the next few segments ahead of `n` in the background. */
  private prefetch(
    infoHash: string,
    fileIndex: number,
    index: MediaIndex,
    rendition: Rendition,
    n: number,
  ): void {
    const { layout, queue, prefetchSegments } = this.options;
    const dir = layout.mediaFile(infoHash, fileIndex, renditionPath(rendition)) + path.sep;
    const last = Math.min(segmentCount(index) - 1, n + prefetchSegments);

    const wanted = new Set<string>();
    for (let next = n + 1; next <= last; next++) {
      wanted.add(dir + segmentFileName(rendition, next));
    }
    // After a seek, queued prefetches around the old position are pointless.
    queue.cancelBackground((key) => key.startsWith(dir) && !wanted.has(key));

    for (let next = n + 1; next <= last; next++) {
      this.ensureSegment(infoHash, fileIndex, index, rendition, next, Priority.Background).catch(
        (err: unknown) => {
          if (err instanceof CancelledError) return;
          logger.warn('Prefetch failed', {
            infoHash,
            rendition: renditionPath(rendition),
            n: next,
            error: errorMessage(err),
          });
        },
      );
    }
  }
}

function findRendition(index: MediaIndex, kind: string, trackParam: string | undefined): Rendition {
  const renditions = getRenditions(index);
  const track = trackParam === undefined ? undefined : parseNumber(trackParam, 404, 'track');
  const rendition =
    kind === 'video'
      ? renditions.video
      : kind === 'audio'
        ? renditions.audio.find((audio) => audio.track.number === track)
        : renditions.subtitles.find((subtitle) => subtitle.track.number === track);
  if (!rendition) throw notFound(`${index.fileName} has no ${kind} rendition for track ${track}`);
  return rendition;
}

function parseNumber(value: string, status: number, what: string): number {
  if (!/^\d+$/.test(value)) throw new HttpError(status, `Invalid ${what} "${value}"`);
  return Number(value);
}

/** The message matters: these all reach the client as a bare 404 otherwise. */
function notFound(detail: string): HttpError {
  return new HttpError(404, detail);
}
