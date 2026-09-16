import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Torrent, TorrentFile } from 'webtorrent';

import { HttpError } from '../errors.js';
import type { ByteSource } from '../io/byte-source.js';
import { logger } from '../logger.js';
import type { PieceCache } from './piece-store.js';

export interface TorrentReadOptions {
  /** Give up on a read that receives no data for this long. */
  stallMs: number;
}

/**
 * Reads a file inside a torrent. WebTorrent prioritises the pieces of each
 * open range, and they stay pinned in the piece cache until the read closes.
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
    const first = Math.floor((this.file.offset + start) / pieceLength);
    const last = Math.floor((this.file.offset + end - 1) / pieceLength);
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
    // Ties the two together: destroying or failing either one tears down the other.
    pipeline(source, watchdog).catch(() => {
      // The error is already emitted on the returned stream.
    });
    return watchdog;
  }

  /** The read has had nothing for a while, but the torrent is still receiving. */
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
  /** Total bytes the torrent has received, to tell a dead swarm from a busy one. */
  progress: () => number;
  onWait: () => void;
  onStall: () => Error;
}

/**
 * Passes data through, failing the stream if the torrent goes quiet. A peer can
 * stop sending without dropping the connection, and a piece nobody has never
 * arrives; either way a job shouldn't stay open forever.
 *
 * Silence on this read alone is not enough to call it stalled. WebTorrent hands
 * a read one whole piece at a time, so while its current piece is in flight the
 * read produces nothing - for a 16 MiB piece shared with other readers, that is
 * can take time. Only a torrent receiving nothing at all has really stopped.
 */
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
    // Bytes are arriving, just not ours yet. The request and job timeouts still
    // bound how long this can go on.
    if (!this.reportedWait) {
      this.reportedWait = true;
      this.options.onWait();
    }
    this.restart();
  }
}
