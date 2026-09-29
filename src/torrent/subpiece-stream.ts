import { Readable } from 'node:stream';

import {
  BLOCK_LENGTH,
  type SwarmPiece,
  type SwarmTorrent,
} from './swarm-internals.js';

type WindowedPiece = SwarmPiece & {
  readerBlocks?: Map<object, number>;
  reservedBlocks?: Uint8Array;
};

function preferBlock(piece: WindowedPiece, reader: object, from: number): void {
  if (!piece.init()) {
    return;
  }
  const waiters = (piece.readerBlocks ??= new Map<object, number>());
  waiters.set(reader, from);
  if (piece.reservedBlocks) {
    return;
  }
  const reserved = new Uint8Array(piece._chunks);
  reserved.fill(1, 0, piece._reservations);
  piece.reservedBlocks = reserved;
  piece.reserve = function reserve(this: SwarmPiece): number {
    if (!this.init()) {
      return -1;
    }
    const cancelled = this._cancellations?.pop();
    if (cancelled !== undefined) {
      return cancelled;
    }
    const n = this._chunks;
    let start = n;
    for (const block of waiters.values()) {
      start = Math.min(start, block);
    }
    if (start >= n) {
      start = 0;
    }
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (!reserved[i]) {
        reserved[i] = 1;
        this._reservations++;
        return i;
      }
    }
    return -1;
  };
}

function nextEvent(
  torrent: SwarmTorrent,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      torrent.removeListener('download', done);
      torrent.removeListener('verified', done);
      torrent.removeListener('close', done);
      signal.removeEventListener('abort', done);
      setImmediate(resolve);
    };
    const timer = setTimeout(done, ms);
    torrent.on('download', done);
    torrent.on('verified', done);
    torrent.on('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

function storeGet(
  torrent: SwarmTorrent,
  index: number,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    torrent.store.get(index, { offset, length }, (err, chunk) => {
      if (err || !chunk) {
        reject(err ?? new Error(`Piece ${index} missing from store`));
        return;
      }
      resolve(chunk);
    });
  });
}

function bufferedRun(piece: SwarmPiece, offset: number, until: number): Buffer {
  const parts: Uint8Array[] = [];
  let pos = offset;
  while (pos < until) {
    const block = Math.floor(pos / BLOCK_LENGTH);
    const data = piece.get(block);
    if (!data) {
      break;
    }
    const from = pos - block * BLOCK_LENGTH;
    const to = Math.min(data.length, until - block * BLOCK_LENGTH);
    parts.push(data.subarray(from, to));
    pos = block * BLOCK_LENGTH + to;
  }
  return Buffer.concat(parts);
}

/**
 * Streams torrent bytes [start, end) as blocks arrive, before their piece
 * passes the hash check, so the data may be unverified.
 */
export function subpieceStream(
  torrent: SwarmTorrent,
  start: number,
  end: number,
  signal: AbortSignal,
  onUnverified: (piece: number) => void,
): Readable {
  const reader = {};
  let waitingOn: WindowedPiece | undefined;
  async function* chunks() {
    let pos = start;
    let marked = -1;
    while (pos < end) {
      const index = Math.floor(pos / torrent.pieceLength);
      if (waitingOn && waitingOn !== torrent.pieces[index]) {
        waitingOn.readerBlocks?.delete(reader);
        waitingOn = undefined;
      }
      const pieceStart = index * torrent.pieceLength;
      const until = Math.min(end, pieceStart + torrent.pieceLength);
      if (torrent.bitfield.get(index)) {
        const chunk = await storeGet(
          torrent,
          index,
          pos - pieceStart,
          until - pos,
        );
        yield chunk;
        pos = until;
        continue;
      }
      const piece = torrent.pieces[index];
      if (piece) {
        const run = bufferedRun(piece, pos - pieceStart, until - pieceStart);
        if (run.length > 0) {
          onUnverified(index);
          yield run;
          pos += run.length;
          continue;
        }
        const block = Math.floor((pos - pieceStart) / BLOCK_LENGTH);
        preferBlock(piece, reader, block);
        waitingOn = piece;
      }
      if (marked !== index) {
        marked = index;
        try {
          torrent.critical(index, index);
        } catch {}
      }
      await nextEvent(torrent, 250, signal);
      if (signal.aborted) {
        return;
      }
      if (torrent.destroyed) {
        throw new Error('Torrent was destroyed during a read');
      }
    }
  }
  async function* guarded() {
    try {
      yield* chunks();
    } finally {
      waitingOn?.readerBlocks?.delete(reader);
    }
  }
  return Readable.from(guarded(), { objectMode: false });
}
