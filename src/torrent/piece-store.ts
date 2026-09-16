import { mkdirSync } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoreOptions, Torrent } from 'webtorrent';

import { errorMessage, logger } from '../logger.js';
import { SizeLru } from '../util/lru.js';

type Callback<T = void> = (err: Error | null, value?: T) => void;

interface GetOptions {
  offset?: number;
  length?: number;
}

/** The lt_donthave extension (BEP 54) that WebTorrent adds to every wire. */
interface DontHaveWire {
  lt_donthave?: { donthave(index: number): void };
}

/** WebTorrent internals the store needs to hand evicted pieces back. */
interface TorrentInternals extends Torrent {
  destroyed: boolean;
  wires: (Torrent['wires'][number] & DontHaveWire)[];
  _markUnverified(index: number): void;
}

const pieceKey = (infoHash: string, index: number) => `${infoHash}:${index}`;

/**
 * Disk budget for downloaded torrent pieces, shared by every torrent, file and
 * viewer. Deliberately one budget rather than one per file: on a busy title
 * dozens of players read different parts of the same remux, and whichever
 * ranges are hot should stay resident no matter which file they belong to.
 *
 * Evicted pieces are deleted, handed back to WebTorrent and retracted from
 * peers, so they download again if something reads them later.
 */
export class PieceCache {
  private readonly stores = new Map<string, SlidingPieceStore>();
  private readonly pins = new Map<string, number>();
  private readonly pieces: SizeLru<string>;

  /**
   * Value for WebTorrent's `store` torrent option. WebTorrent invokes it with
   * `new`, so it must be a plain function rather than an arrow function.
   */
  readonly createStore: (chunkLength: number, opts: StoreOptions) => SlidingPieceStore;

  constructor(
    readonly directory: string,
    budgetBytes: number,
  ) {
    this.pieces = new SizeLru(budgetBytes);

    const cache = this;
    this.createStore = function createStore(chunkLength: number, opts: StoreOptions) {
      const store = new SlidingPieceStore(cache, chunkLength, opts.torrent as TorrentInternals);
      cache.stores.set(store.infoHash, store);
      return store;
    };
  }

  get usedBytes(): number {
    return this.pieces.size;
  }

  /** Protects pieces [first, last] from eviction until the returned function is called. */
  pin(infoHash: string, first: number, last: number): () => void {
    for (let i = first; i <= last; i++) {
      const key = pieceKey(infoHash, i);
      this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      for (let i = first; i <= last; i++) {
        const key = pieceKey(infoHash, i);
        const count = (this.pins.get(key) ?? 1) - 1;
        if (count > 0) {
          this.pins.set(key, count);
        } else {
          this.pins.delete(key);
        }
      }
      this.trim();
    };
  }

  added(store: SlidingPieceStore, index: number, bytes: number): void {
    this.pieces.set(pieceKey(store.infoHash, index), bytes);
    this.trim();
  }

  touched(store: SlidingPieceStore, index: number): void {
    this.pieces.touch(pieceKey(store.infoHash, index));
  }

  removed(store: SlidingPieceStore, indexes: Iterable<number>): void {
    for (const index of indexes) {
      this.pieces.delete(pieceKey(store.infoHash, index));
    }
    if (this.stores.get(store.infoHash) === store) {
      this.stores.delete(store.infoHash);
    }
  }

  /** Deletes least recently used pieces until the cache is within budget. */
  private trim(): void {
    for (const key of this.pieces.trim((key) => this.pins.has(key))) {
      const separator = key.lastIndexOf(':');
      const store = this.stores.get(key.slice(0, separator));
      store?.evict(Number(key.slice(separator + 1)));
    }
  }
}

/** An abstract-chunk-store that keeps pieces as files under a PieceCache budget. */
export class SlidingPieceStore {
  readonly infoHash: string;
  private readonly directory: string;
  private readonly present = new Map<number, number>();
  private closed = false;

  constructor(
    private readonly cache: PieceCache,
    readonly chunkLength: number,
    private readonly torrent: TorrentInternals,
  ) {
    this.infoHash = torrent.infoHash;
    // Pieces span the whole torrent, so they are keyed by info hash like the
    // rest of the cache rather than by file.
    this.directory = path.join(cache.directory, torrent.infoHash);
    mkdirSync(this.directory, { recursive: true });
  }

  put(index: number, buf: Uint8Array, cb: Callback = () => {}): void {
    if (this.closed) {
      return cb(new Error('Piece store is closed'));
    }

    writeFile(this.piecePath(index), buf).then(
      () => {
        if (this.closed) {
          return cb(new Error('Piece store is closed'));
        }
        this.present.set(index, buf.length);
        this.cache.added(this, index, buf.length);
        cb(null);
      },
      (err: Error) => cb(err),
    );
  }

  get(
    index: number,
    opts: GetOptions | null | undefined | Callback<Buffer>,
    cb?: Callback<Buffer>,
  ): void {
    if (typeof opts === 'function') {
      return this.get(index, null, opts);
    }
    const callback = cb ?? (() => {});

    const size = this.present.get(index);
    if (size === undefined) {
      return callback(new Error(`Piece ${index} is not stored`));
    }

    const offset = opts?.offset ?? 0;
    const length = opts?.length ?? size - offset;
    this.cache.touched(this, index);
    readPiece(this.piecePath(index), offset, length).then(
      (buf) => callback(null, buf),
      (err: Error) => callback(err),
    );
  }

  close(cb: Callback = () => {}): void {
    this.destroy(cb);
  }

  destroy(cb: Callback = () => {}): void {
    if (this.closed) {
      return cb(null);
    }
    this.closed = true;
    this.cache.removed(this, this.present.keys());
    this.present.clear();
    rm(this.directory, { recursive: true, force: true }).then(
      () => cb(null),
      (err: Error) => cb(err),
    );
  }

  /** Drops a piece to free space; WebTorrent will fetch it again if it's read later. */
  evict(index: number): void {
    if (!this.present.delete(index)) {
      return;
    }
    if (!this.torrent.destroyed) {
      this.torrent._markUnverified(index);
      // Retract the piece (BEP 54). Without this, peers keep believing we have
      // every piece we ever downloaded, take us for a seeder, and choke us for
      // good - which stalls re-downloading anything the cache dropped.
      for (const wire of this.torrent.wires) {
        wire.lt_donthave?.donthave(index);
      }
    }
    rm(this.piecePath(index), { force: true }).catch((err: unknown) => {
      logger.warn('Could not delete evicted piece', {
        infoHash: this.infoHash,
        index,
        error: errorMessage(err),
      });
    });
  }

  private piecePath(index: number): string {
    return path.join(this.directory, `${index}.piece`);
  }
}

async function readPiece(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
