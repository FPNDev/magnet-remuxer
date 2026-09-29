import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Torrent, TorrentFile } from 'webtorrent';

import { HttpError } from '../errors.js';
import type { ByteSource } from '../io/byte-source.js';
import { logger } from '../logger.js';
import type { PieceCache } from './piece-store.js';
import { subpieceStream } from './subpiece-stream.js';
import { asSwarmTorrent, BLOCK_LENGTH } from './swarm-internals.js';
import type { UnverifiedPieces } from './unverified-pieces.js';

const asError = (reason: unknown): Error | undefined =>
  reason instanceof Error ? reason : undefined;

const PREFETCH_HOLD_MS = 60_000;

// webtorrent selection priorities. Indexing outranks playback because it
// is short and nothing can be served until it finishes.
export const ReadPriority = {
  Index: 3,
  Playing: 2,
} as const;
export type ReadPriority = (typeof ReadPriority)[keyof typeof ReadPriority];

export type TorrentReadOptions = {
  stallMs: number;
  subpieceReads: boolean;
  unverified: UnverifiedPieces;
  priority?: ReadPriority | undefined;
  critical?: boolean | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * ByteSource over one file of a torrent. A read pins the pieces it covers
 * and raises their selection priority for as long as it runs.
 */
export class TorrentFileSource implements ByteSource {
  readonly length: number;
  readonly minReadBytes?: number;
  private priority: ReadPriority | undefined;
  private readonly raises = new Set<() => void>();
  private readonly tracked = new Set<number>();
  private readonly live = new Set<StallWatchdog>();
  private corruption: HttpError | undefined;
  private invalidate: ((error: HttpError) => void) | undefined;
  private readonly onBadPiece = (piece: number): void => {
    if (this.corruption) {
      return;
    }
    const error = new HttpError(
      502,
      `Piece ${piece} of the torrent could not be verified`,
    );
    this.corruption = error;
    logger.warn('Dropping work built from an unverified piece', {
      infoHash: this.torrent.infoHash,
      piece,
    });
    for (const watchdog of this.live) {
      watchdog.destroy(error);
    }
    this.invalidate?.(error);
  };

  constructor(
    private readonly torrent: Torrent,
    private readonly file: TorrentFile,
    private readonly pieces: PieceCache,
    private readonly options: TorrentReadOptions,
  ) {
    this.length = file.length;
    this.priority = options.priority;
    if (options.subpieceReads) {
      this.minReadBytes = BLOCK_LENGTH;
    }
  }

  promote(): void {
    if (this.priority !== undefined) {
      return;
    }
    this.priority = ReadPriority.Playing;
    for (const raise of this.raises) {
      raise();
    }
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

    const closed = new AbortController();
    let source: Readable;
    try {
      source = this.options.subpieceReads
        ? subpieceStream(
            asSwarmTorrent(this.torrent),
            this.file.offset + start,
            this.file.offset + end,
            closed.signal,
            (piece) => {
              this.watch(piece);
            },
          )
        : this.file.createReadStream({ start, end: end - 1 });
    } catch (err) {
      unpin();
      throw err;
    }

    const watchdog = new StallWatchdog({
      stallMs: this.options.stallMs,
      progress: () => this.torrent.downloaded,
      onWait: () => {
        this.waiting(start, end);
      },
      onStall: () => this.stalled(start, end),
    });

    const { signal } = this.options;
    if (this.options.subpieceReads) {
      this.select(first, last, 1);
      this.live.add(watchdog);
    }

    let raised = false;
    const raise = () => {
      const { priority } = this;
      if (raised || priority === undefined) {
        return;
      }
      raised = true;
      this.select(first, last, priority);
      if (this.options.critical) {
        try {
          this.torrent.critical(first, last);
        } catch {}
      }
    };
    raise();
    this.raises.add(raise);
    const stop = () => watchdog.destroy(asError(signal?.reason));
    signal?.addEventListener('abort', stop, { once: true });
    // Without the deselect the torrent keeps downloading ahead for a reader
    // that has gone.
    watchdog.once('close', () => {
      unpin();
      if (this.options.subpieceReads) {
        this.select(first, last);
        this.live.delete(watchdog);
        closed.abort();
      }
      this.raises.delete(raise);
      if (raised) {
        this.select(first, last);
      }
      signal?.removeEventListener('abort', stop);
    });

    // The watchdog emits the failure to its own reader. This catch only keeps
    // the rejection from going unhandled.
    pipeline(source, watchdog).catch(() => {});
    return watchdog;
  }

  prefetch(start: number, end: number): void {
    if (!this.options.subpieceReads) {
      return;
    }
    const { pieceLength } = this.torrent;
    const first = Math.floor((this.file.offset + start) / pieceLength);
    const last = Math.floor(
      (this.file.offset + Math.min(end, this.length) - 1) / pieceLength,
    );
    this.select(first, last, ReadPriority.Playing);
    setTimeout(() => {
      this.select(first, last);
    }, PREFETCH_HOLD_MS).unref();
  }

  onCorrupt(invalidate: (error: HttpError) => void): void {
    if (this.corruption) {
      invalidate(this.corruption);
    } else {
      this.invalidate = invalidate;
    }
  }

  release(): void {
    for (const piece of this.tracked) {
      this.options.unverified.remove(
        this.torrent.infoHash,
        piece,
        this.onBadPiece,
      );
    }
    this.tracked.clear();
  }

  private watch(piece: number): void {
    if (this.tracked.has(piece)) {
      return;
    }
    this.tracked.add(piece);
    this.options.unverified.add(this.torrent.infoHash, piece, this.onBadPiece);
  }

  // webtorrent throws when the torrent is gone or the range is out of
  // bounds. Neither is a reason to fail the read.
  private select(first: number, last: number, priority?: number): void {
    const swarm = asSwarmTorrent(this.torrent);
    try {
      if (priority === undefined) {
        swarm._deselect(first, last, true);
      } else {
        swarm._select(first, last, priority, null, true);
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

type WatchdogOptions = {
  stallMs: number;
  progress: () => number;
  onWait: () => void;
  onStall: () => Error;
};

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
    this.once('close', () => {
      clearTimeout(this.timer);
    });
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
    this.timer = setTimeout(() => {
      this.check();
    }, this.options.stallMs);
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
