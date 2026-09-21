import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Torrent, TorrentFile } from 'webtorrent';

import { HttpError } from '../errors.js';
import type { ByteSource } from '../io/byte-source.js';
import { logger } from '../logger.js';
import type { PieceCache } from './piece-store.js';

const asError = (reason: unknown): Error | undefined =>
  reason instanceof Error ? reason : undefined;

// webtorrent selection priorities. Indexing outranks playback because it
// is short and nothing can be served until it finishes.
export const ReadPriority = {
  Index: 3,
  Playing: 2,
} as const;
export type ReadPriority = (typeof ReadPriority)[keyof typeof ReadPriority];

export interface TorrentReadOptions {
  stallMs: number;
  priority?: ReadPriority | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * ByteSource over one file of a torrent. A read pins the pieces it covers
 * and raises their selection priority for as long as it runs.
 */
export class TorrentFileSource implements ByteSource {
  readonly length: number;

  constructor(
    private readonly torrent: Torrent,
    private readonly file: TorrentFile,
    private readonly pieces: PieceCache,
    private readonly options: TorrentReadOptions,
  ) {
    this.length = file.length;
  }

  stream(start: number, end: number): Readable {
    if (end <= start) {
      return Readable.from([]);
    }

    const { pieceLength, infoHash } = this.torrent;
    // start and end are file-relative; piece numbers are torrent-relative.
    const first = Math.floor((this.file.offset + start) / pieceLength);
    const last = Math.floor((this.file.offset + end - 1) / pieceLength);
    // Pinned pieces stay out of cache eviction until the stream closes.
    const unpin = this.pieces.pin(infoHash, first, last);

    let source: Readable;
    try {
      source = this.file.createReadStream({ start, end: end - 1 });
    } catch (err) {
      unpin();
      throw err;
    }

    const watchdog = new StallWatchdog({
      stallMs: this.options.stallMs,
      progress: () => this.torrent.downloaded,
      onWait: () => this.waiting(start, end),
      onStall: () => this.stalled(start, end),
    });
    watchdog.once('close', unpin);

    const { priority, signal } = this.options;
    if (priority !== undefined) {
      this.select(first, last, priority);
      // Without the deselect the torrent keeps downloading ahead for a reader
      // that has gone.
      watchdog.once('close', () => this.select(first, last));
    }
    if (signal) {
      const stop = () => watchdog.destroy(asError(signal.reason));
      signal.addEventListener('abort', stop, { once: true });
      watchdog.once('close', () => signal.removeEventListener('abort', stop));
    }

    // The watchdog emits the failure to its own reader. This catch only keeps
    // the rejection from going unhandled.
    pipeline(source, watchdog).catch(() => {});
    return watchdog;
  }

  // webtorrent throws when the torrent is gone or the range is out of
  // bounds. Neither is a reason to fail the read.
  private select(first: number, last: number, priority?: number): void {
    try {
      if (priority === undefined) {
        this.torrent.deselect(first, last);
      } else {
        this.torrent.select(first, last, priority);
      }
    } catch {}
  }

  private waiting(start: number, end: number): void {
    logger.warn('Torrent read is waiting its turn', {
      ...this.describe(start, end),
      seconds: Math.round(this.options.stallMs / 1000),
    });
  }

  private stalled(start: number, end: number): Error {
    const seconds = Math.round(this.options.stallMs / 1000);
    logger.warn('Torrent read stalled', this.describe(start, end));
    return new HttpError(504, `The torrent received no data for ${seconds}s`);
  }

  private describe(start: number, end: number) {
    return {
      infoHash: this.torrent.infoHash,
      range: `${start}-${end}`,
      mib: Math.round((end - start) / 1024 / 1024),
      peers: this.torrent.numPeers,
      chokedBy: this.torrent.wires.filter((wire) => wire.peerChoking).length,
      downloadSpeed: Math.round(this.torrent.downloadSpeed),
    };
  }
}

interface WatchdogOptions {
  stallMs: number;
  progress: () => number;
  onWait: () => void;
  onStall: () => Error;
}

// Progress is measured on the whole torrent, not on this stream. A read
// waiting its turn behind other pieces is slow, not stalled.
class StallWatchdog extends Transform {
  private timer: NodeJS.Timeout | undefined;
  private mark: number;
  private reportedWait = false;

  constructor(private readonly options: WatchdogOptions) {
    super();
    this.mark = options.progress();
    this.restart();
    this.once('close', () => clearTimeout(this.timer));
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.restart();
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    clearTimeout(this.timer);
    callback();
  }

  private restart(): void {
    clearTimeout(this.timer);
    this.mark = this.options.progress();
    this.timer = setTimeout(() => this.check(), this.options.stallMs);
  }

  private check(): void {
    if (this.options.progress() <= this.mark) {
      this.destroy(this.options.onStall());
      return;
    }
    if (!this.reportedWait) {
      this.reportedWait = true;
      this.options.onWait();
    }
    this.restart();
  }
}
