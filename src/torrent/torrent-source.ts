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
    if (end <= start) return Readable.from([]);

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

    const watchdog = new StallWatchdog(this.options.stallMs, () => this.stalled(start, end));
    watchdog.once('close', unpin);
    // Ties the two together: destroying or failing either one tears down the other.
    pipeline(source, watchdog).catch(() => {
      // The error is already emitted on the returned stream.
    });
    return watchdog;
  }

  private stalled(start: number, end: number): Error {
    const seconds = Math.round(this.options.stallMs / 1000);
    logger.warn('Torrent read stalled', {
      infoHash: this.torrent.infoHash,
      range: `${start}-${end}`,
      peers: this.torrent.numPeers,
      chokedBy: this.torrent.wires.filter((wire) => wire.peerChoking).length,
      downloadSpeed: Math.round(this.torrent.downloadSpeed),
    });
    return new HttpError(504, `No torrent data received for ${seconds}s`);
  }
}

/**
 * Passes data through, failing the stream if nothing arrives for a while. A
 * peer can go quiet without dropping the connection, and a piece nobody has
 * never arrives; either way a job shouldn't stay open forever.
 */
class StallWatchdog extends Transform {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly stallMs: number,
    private readonly onStall: () => Error,
  ) {
    super();
    this.restart();
    this.once('close', () => clearTimeout(this.timer));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.restart();
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    clearTimeout(this.timer);
    callback();
  }

  private restart(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.destroy(this.onStall()), this.stallMs);
  }
}
