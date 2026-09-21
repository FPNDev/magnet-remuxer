import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoreOptions, Torrent } from 'webtorrent';

import { errorMessage, logger } from '../logger.js';
import { touchFile } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';

type Callback<T = void> = (err: Error | null, value?: T) => void;

interface GetOptions {
  offset?: number;
  length?: number;
}

interface DontHaveWire {
  lt_donthave?: { donthave(index: number): void };
}

interface TorrentInternals extends Torrent {
  destroyed: boolean;
  wires: (Torrent['wires'][number] & DontHaveWire)[];
  _markUnverified(index: number): void;
}

export interface AdoptableTorrent extends Torrent {
  lastPieceLength: number;
  _hashes: string[];
  _markVerified(index: number): void;
}

export interface AdoptionResult {
  kept: number;
  dropped: number;
  hashedBytes: number;
}

const pieceKey = (infoHash: string, index: number) => `${infoHash}:${index}`;
const PIECE_FILE = /^(\d+)\.piece$/;
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Pieces live one per file under <directory>/<infoHash>/<index>.piece,
 * under a single LRU budget. A pinned piece is never evicted.
 */
export class PieceCache {
  private readonly stores = new Map<string, SlidingPieceStore>();
  private readonly pins = new Map<string, number>();
  private readonly pieces: SizeLru<string>;
  private readonly inventory = new Map<
    string,
    Map<number, { bytes: number; mtimeMs: number }>
  >();
  private readonly trusted = new Set<string>();

  readonly createStore: (
    chunkLength: number,
    opts: StoreOptions,
  ) => SlidingPieceStore;

  constructor(
    readonly directory: string,
    budgetBytes: number,
  ) {
    this.pieces = new SizeLru(budgetBytes);

    // oxlint-disable-next-line no-this-alias
    const cache = this;
    // webtorrent calls the store factory as a constructor, so it cannot be an
    // arrow function bound to the cache.
    this.createStore = function createStore(
      chunkLength: number,
      opts: StoreOptions,
    ) {
      const store = new SlidingPieceStore(
        cache,
        chunkLength,
        opts.torrent as TorrentInternals,
      );
      cache.stores.set(store.infoHash, store);
      return store;
    };
  }

  get usedBytes(): number {
    return this.pieces.size;
  }

  async load(): Promise<void> {
    const dirs = await readdir(this.directory, { withFileTypes: true }).catch(
      () => [],
    );
    let found = 0;
    const all: { key: string; bytes: number; mtimeMs: number }[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const held = await this.scan(dir.name);
      for (const [index, file] of held) {
        all.push({ key: pieceKey(dir.name, index), ...file });
        found++;
      }
    }

    all.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { key, bytes, mtimeMs } of all) {
      this.pieces.set(key, bytes, mtimeMs);
    }
    this.trim();
    logger.info('Piece cache loaded', {
      pieces: found,
      bytes: this.pieces.size,
    });
  }

  async prepare(infoHash: string): Promise<void> {
    await mkdir(path.join(this.directory, infoHash), { recursive: true });
    await this.scan(infoHash);
  }

  // A piece found on disk is hashed once before the torrent is told it has
  // it. The file may be a truncated write or the tail of an older layout.
  async adoptInto(torrent: AdoptableTorrent): Promise<AdoptionResult> {
    const { infoHash } = torrent;
    const store = this.stores.get(infoHash);
    const adopted = store?.adopted() ?? [];
    const result: AdoptionResult = { kept: 0, dropped: 0, hashedBytes: 0 };
    if (!store || !adopted.length) {
      return result;
    }

    for (const index of adopted) {
      if (!this.trusted.has(pieceKey(infoHash, index))) {
        const expected = torrent._hashes[index];
        const size = store.sizeOf(index) ?? 0;
        const actual =
          expected === undefined
            ? undefined
            : await hashFile(this.piecePath(infoHash, index)).catch(
                () => undefined,
              );
        if (actual === undefined || actual !== expected) {
          this.discard(infoHash, index);
          result.dropped++;
          continue;
        }
        result.hashedBytes += size;
        this.trusted.add(pieceKey(infoHash, index));
      }
      torrent._markVerified(index);
      result.kept++;
    }
    return result;
  }

  isTrusted(infoHash: string, index: number): boolean {
    return this.trusted.has(pieceKey(infoHash, index));
  }

  discard(infoHash: string, index: number): void {
    const key = pieceKey(infoHash, index);
    this.pieces.delete(key);
    void this.drop([key]);
  }

  piecePath(infoHash: string, index: number): string {
    return path.join(this.directory, infoHash, `${index}.piece`);
  }

  /**
   * Keeps a piece range out of eviction until the returned function runs.
   * Releasing trims the cache, so every pin must be released.
   */
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
    this.pieces.set(key, bytes);
    this.trusted.add(key);
    this.trim();
  }

  // Adopted pieces keep their file mtime as last use, so a restart does not
  // make stale pieces look freshly read.
  adopted(
    store: SlidingPieceStore,
    index: number,
    bytes: number,
    writtenAt: number,
  ): void {
    const key = pieceKey(store.infoHash, index);
    if (this.pieces.has(key)) {
      this.pieces.resize(key, bytes);
    } else {
      this.pieces.set(key, bytes, writtenAt);
    }
  }

  detached(store: SlidingPieceStore): void {
    if (this.stores.get(store.infoHash) === store) {
      this.stores.delete(store.infoHash);
    }
  }

  touched(store: SlidingPieceStore, index: number): void {
    this.pieces.touch(pieceKey(store.infoHash, index));
    touchFile(this.piecePath(store.infoHash, index));
  }

  removed(store: SlidingPieceStore, indexes: Iterable<number>): void {
    for (const index of indexes) {
      const key = pieceKey(store.infoHash, index);
      this.pieces.delete(key);
      this.trusted.delete(key);
    }
    this.inventory.delete(store.infoHash);
    if (this.stores.get(store.infoHash) === store) {
      this.stores.delete(store.infoHash);
    }
  }

  held(infoHash: string): Map<number, { bytes: number; mtimeMs: number }> {
    return this.inventory.get(infoHash) ?? new Map();
  }

  oldestUsedAt(): number | undefined {
    return this.pieces.oldest((key) => this.pins.has(key))?.usedAt;
  }

  async evictOldest(bytes: number): Promise<number> {
    const before = this.pieces.size;
    await this.drop(
      this.pieces.trimTo(Math.max(0, before - bytes), (key) =>
        this.pins.has(key),
      ),
    );
    return before - this.pieces.size;
  }

  private async scan(
    infoHash: string,
  ): Promise<Map<number, { bytes: number; mtimeMs: number }>> {
    const held = new Map<number, { bytes: number; mtimeMs: number }>();
    const dir = path.join(this.directory, infoHash);
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      const index = PIECE_FILE.exec(name)?.[1];
      if (index === undefined) {
        continue;
      }
      const info = await stat(path.join(dir, name)).catch(() => undefined);
      if (info) {
        held.set(Number(index), { bytes: info.size, mtimeMs: info.mtimeMs });
      }
    }
    this.inventory.set(infoHash, held);
    return held;
  }

  private trim(): void {
    void this.drop(this.pieces.trim((key) => this.pins.has(key)));
  }

  // A live store evicts through the torrent so it stops advertising the
  // piece. With no store the file is deleted directly.
  private async drop(keys: string[]): Promise<void> {
    const deletions: Promise<void>[] = [];
    for (const key of keys) {
      const separator = key.lastIndexOf(':');
      const infoHash = key.slice(0, separator);
      const index = Number(key.slice(separator + 1));
      this.trusted.delete(key);
      this.inventory.get(infoHash)?.delete(index);
      const store = this.stores.get(infoHash);
      deletions.push(
        store
          ? store.evict(index)
          : rm(this.piecePath(infoHash, index), { force: true }).catch(
              (err: unknown) => {
                logger.warn('Could not delete evicted piece', {
                  infoHash,
                  index,
                  error: errorMessage(err),
                });
              },
            ),
      );
    }
    await Promise.all(deletions);
  }
}

/**
 * webtorrent chunk store over the shared cache. Pieces can disappear under
 * a running torrent, which is told about each one.
 */
export class SlidingPieceStore {
  readonly infoHash: string;
  private readonly directory: string;
  private readonly present = new Map<number, number>();
  private readonly writing = new Set<number>();
  private readonly cancelled = new Set<number>();
  private ensuringDirectory: Promise<unknown> | undefined;
  private closed = false;

  constructor(
    private readonly cache: PieceCache,
    readonly chunkLength: number,
    private readonly torrent: TorrentInternals,
  ) {
    this.infoHash = torrent.infoHash;
    this.directory = path.join(cache.directory, torrent.infoHash);
    this.adopt();
  }

  adopted(): number[] {
    return [...this.present.keys()];
  }

  sizeOf(index: number): number | undefined {
    return this.present.get(index);
  }

  put(index: number, buf: Uint8Array, cb: Callback = () => {}): void {
    if (this.closed) {
      return cb(new Error('Piece store is closed'));
    }

    const file = this.piecePath(index);
    this.writing.add(index);
    this.cancelled.delete(index);
    this.ensureDirectory()
      .then(() => writeFile(file, buf))
      .then(
        () => {
          // Eviction landed while the write was in flight, so the file goes
          // and the piece counts as never stored.
          const stale = this.cancelled.delete(index);
          this.writing.delete(index);
          if (this.closed || stale) {
            void rm(file, { force: true }).catch(() => {});
            return cb(new Error('Piece store is closed'));
          }
          this.present.set(index, buf.length);
          this.cache.added(this, index, buf.length);
          cb(null);
        },
        (err: Error) => {
          this.writing.delete(index);
          this.cancelled.delete(index);
          cb(err);
        },
      );
  }

  get(
    index: number,
    opts: GetOptions | null | undefined | Callback<Buffer>,
    cb?: Callback<Buffer>,
  ): void {
    // The chunk store API allows the callback in place of the options.
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

  // close leaves the files on disk. destroy is the one that deletes them and
  // takes the pieces out of the cache.
  close(cb: Callback = () => {}): void {
    this.closed = true;
    this.cache.detached(this);
    cb(null);
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

  // The torrent is marked unverified and peers are told the piece is gone,
  // or it keeps serving requests for data that is no longer on disk.
  evict(index: number): Promise<void> {
    if (this.writing.has(index)) {
      this.cancelled.add(index);
    }
    if (!this.present.delete(index)) {
      return Promise.resolve();
    }
    if (!this.torrent.destroyed) {
      this.torrent._markUnverified(index);
      for (const wire of this.torrent.wires) {
        wire.lt_donthave?.donthave(index);
      }
    }
    return rm(this.piecePath(index), { force: true }).catch((err: unknown) => {
      logger.warn('Could not delete evicted piece', {
        infoHash: this.infoHash,
        index,
        error: errorMessage(err),
      });
    });
  }

  // A file whose size is not the piece length belongs to another layout or
  // to a partial write, so it is removed rather than trusted.
  private adopt(): void {
    const lastIndex = this.torrent.pieces.length - 1;
    for (const [index, file] of this.cache.held(this.infoHash)) {
      const expected =
        index === lastIndex ? this.torrent.lastPieceLength : this.chunkLength;
      if (file.bytes !== expected) {
        void rm(this.piecePath(index), { force: true }).catch(() => {});
        continue;
      }
      this.present.set(index, file.bytes);
      this.cache.adopted(this, index, file.bytes, file.mtimeMs);
    }
  }

  private ensureDirectory(): Promise<unknown> {
    this.ensuringDirectory ??= mkdir(this.directory, { recursive: true });
    return this.ensuringDirectory;
  }

  private piecePath(index: number): string {
    return path.join(this.directory, `${index}.piece`);
  }
}

async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha1');
  const stream = createReadStream(file, { highWaterMark: HASH_CHUNK_BYTES });
  try {
    for await (const chunk of stream) {
      digest.update(chunk as Uint8Array);
    }
  } finally {
    stream.destroy();
  }
  return digest.digest('hex');
}

async function readPiece(
  file: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
