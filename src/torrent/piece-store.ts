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
const windowKey = (infoHash: string, fileIndex: number) => `${infoHash}/${fileIndex}`;

/**
 * Disk budget for downloaded torrent pieces.
 *
 * Pieces belong to a torrent, not to a file - one can straddle a file
 * boundary - so they live in a single folder per torrent and are shared. The
 * budget, however, is per file: each file being streamed gets its own sliding
 * window, so watching one episode never evicts another's. A piece counts
 * towards the file it mostly covers, and a ceiling caps the lot.
 *
 * Evicted pieces are dropped from disk, handed back to WebTorrent and retracted
 * from peers, so they are downloaded again if something reads them later.
 */
export class PieceCache {
  private readonly stores = new Map<string, SlidingPieceStore>();
  private readonly pins = new Map<string, number>();
  private readonly windows = new Map<string, SizeLru<string>>();
  private readonly windowOf = new Map<string, string>();
  private readonly windowBudgets = new Map<string, number>();
  private readonly total: SizeLru<string>;

  /**
   * Value for WebTorrent's `store` torrent option. WebTorrent invokes it with
   * `new`, so it must be a plain function rather than an arrow function.
   */
  readonly createStore: (chunkLength: number, opts: StoreOptions) => SlidingPieceStore;

  constructor(
    readonly directory: string,
    private readonly perFileBytes: number,
    totalBytes: number,
  ) {
    this.total = new SizeLru(totalBytes);

    const cache = this;
    this.createStore = function createStore(chunkLength: number, opts: StoreOptions) {
      const store = new SlidingPieceStore(cache, chunkLength, opts.torrent as TorrentInternals);
      cache.stores.set(store.infoHash, store);
      return store;
    };
  }

  get usedBytes(): number {
    return this.total.size;
  }

  /** How many files currently hold cached pieces. */
  get windowCount(): number {
    return this.windows.size;
  }

  /**
   * Raises one file's window so a working set of `bytes` fits. A 4K remux has
   * far bigger segments than the default window, and every rendition of a
   * segment reads the same bytes, so too small a window means re-downloading
   * what was just read. Never shrinks a window, and never takes more than half
   * the total budget.
   */
  reserveWindow(infoHash: string, fileIndex: number, bytes: number): void {
    const key = windowKey(infoHash, fileIndex);
    const budget = Math.max(
      this.perFileBytes,
      Math.min(bytes, Math.floor(this.total.budget / 2)),
    );
    if ((this.windowBudgets.get(key) ?? 0) >= budget) {
      return;
    }

    this.windowBudgets.set(key, budget);
    this.windows.get(key)?.setBudget(budget);
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
    const key = pieceKey(store.infoHash, index);
    const window = windowKey(store.infoHash, store.fileIndexOfPiece(index));

    this.windowOf.set(key, window);
    this.windowFor(window).set(key, bytes);
    this.total.set(key, bytes);
    this.trim();
  }

  touched(store: SlidingPieceStore, index: number): void {
    const key = pieceKey(store.infoHash, index);
    const window = this.windowOf.get(key);
    if (window) {
      this.windows.get(window)?.touch(key);
    }
    this.total.touch(key);
  }

  removed(store: SlidingPieceStore, indexes: Iterable<number>): void {
    for (const index of indexes) {
      this.forget(pieceKey(store.infoHash, index));
    }
    if (this.stores.get(store.infoHash) === store) {
      this.stores.delete(store.infoHash);
    }
  }

  private windowFor(window: string): SizeLru<string> {
    let lru = this.windows.get(window);
    if (!lru) {
      lru = new SizeLru(this.windowBudgets.get(window) ?? this.perFileBytes);
      this.windows.set(window, lru);
    }
    return lru;
  }

  /** Brings every window, and the cache as a whole, back within budget. */
  private trim(): void {
    const isPinned = (key: string) => this.pins.has(key);

    for (const [window, lru] of this.windows) {
      for (const key of lru.trim(isPinned)) {
        this.evict(key);
      }
      if (lru.size === 0) {
        this.windows.delete(window);
      }
    }
    for (const key of this.total.trim(isPinned)) {
      this.evict(key);
    }
  }

  private evict(key: string): void {
    const separator = key.lastIndexOf(':');
    const store = this.stores.get(key.slice(0, separator));
    this.forget(key);
    store?.evict(Number(key.slice(separator + 1)));
  }

  private forget(key: string): void {
    const window = this.windowOf.get(key);
    if (window) {
      const lru = this.windows.get(window);
      lru?.delete(key);
      if (lru?.size === 0) {
        this.windows.delete(window);
      }
    }
    this.windowOf.delete(key);
    this.total.delete(key);
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

  /** The file a piece mostly covers; boundary pieces go to their larger share. */
  fileIndexOfPiece(index: number): number {
    const files = this.torrent.files;
    const start = index * this.chunkLength;
    const end = Math.min(start + this.chunkLength, this.torrent.length);

    // Files are laid out in order, so binary search for the first candidate.
    let low = 0;
    let high = files.length - 1;
    let first = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (files[middle]!.offset <= start) {
        first = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    let best = first;
    let bestOverlap = -1;
    for (let i = first; i < files.length && files[i]!.offset < end; i++) {
      const file = files[i]!;
      const overlap =
        Math.min(end, file.offset + file.length) - Math.max(start, file.offset);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    return best;
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
      for (const wire of this.torrent.wires) wire.lt_donthave?.donthave(index);
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
