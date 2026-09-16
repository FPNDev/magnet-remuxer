import { mkdir, readFile } from 'node:fs/promises';
import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';

import type { CacheLayout } from '../cache/cache-layout.js';
import { HttpError } from '../errors.js';
import { errorMessage, logger } from '../logger.js';
import { exists, readJson, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import { peersOf, trackersOf } from './magnet.js';
import type { PieceCache } from './piece-store.js';

export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
}

export interface TorrentInfo {
  infoHash: string;
  name: string;
  files: TorrentFileInfo[];
}

export interface TorrentManagerOptions {
  layout: CacheLayout;
  pieces: PieceCache;
  metadataTimeoutMs: number;
  idleMs: number;
}

const SWEEP_INTERVAL_MS = 30_000;

/**
 * Owns the WebTorrent client. Torrents are added on demand (from saved
 * metadata when available, so no peer metadata exchange is needed), kept alive
 * while in use, and removed after a period of inactivity.
 */
export class TorrentManager {
  private readonly client = new WebTorrent();
  private readonly flights = new SingleFlight();
  private readonly destroying = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly options: TorrentManagerOptions) {
    this.client.on('error', (err) => {
      logger.error('WebTorrent client error', { error: errorMessage(err) });
    });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Saves a magnet link so the torrent can later be reached by info hash alone. */
  remember(infoHash: string, magnet: string): Promise<void> {
    return this.flights.run(`remember:${infoHash}`, async () => {
      const file = this.options.layout.magnetFile(infoHash);
      if (await exists(file)) return;
      await mkdir(this.options.layout.torrentDir(infoHash), { recursive: true });
      await writeFileAtomic(file, magnet);
    });
  }

  /** The torrent's file list; read from disk when the torrent was seen before. */
  async info(infoHash: string): Promise<TorrentInfo> {
    const saved = await readJson<TorrentInfo>(this.options.layout.infoFile(infoHash));
    if (saved) return saved;
    return this.use(infoHash, async (torrent) => describe(torrent));
  }

  /** Marks a torrent as recently used without holding it. */
  touch(infoHash: string): void {
    if (this.lastUsed.has(infoHash) || this.find(infoHash)) {
      this.lastUsed.set(infoHash, Date.now());
    }
  }

  /** Starts adding a torrent in the background so peers are ready when needed. */
  warm(infoHash: string): void {
    this.lastUsed.set(infoHash, Date.now());
    this.get(infoHash).catch((err: unknown) => {
      logger.warn('Torrent warm-up failed', { infoHash, error: errorMessage(err) });
    });
  }

  /** Runs `task` with a ready torrent that won't be removed while it runs. */
  async use<T>(infoHash: string, task: (torrent: Torrent) => Promise<T>): Promise<T> {
    this.leases.set(infoHash, (this.leases.get(infoHash) ?? 0) + 1);
    this.lastUsed.set(infoHash, Date.now());
    try {
      return await task(await this.get(infoHash));
    } finally {
      const remaining = (this.leases.get(infoHash) ?? 1) - 1;
      if (remaining > 0) this.leases.set(infoHash, remaining);
      else this.leases.delete(infoHash);
      this.lastUsed.set(infoHash, Date.now());
    }
  }

  status() {
    const now = Date.now();
    return this.client.torrents.map((torrent) => ({
      infoHash: torrent.infoHash,
      name: torrent.name,
      ready: torrent.ready,
      peers: torrent.numPeers,
      // Why a torrent isn't downloading is usually one of these.
      chokedBy: torrent.wires.filter((wire) => wire.peerChoking).length,
      interested: (torrent as unknown as { _amInterested?: boolean })._amInterested ?? false,
      wantedRanges:
        (torrent as unknown as { _selections?: { length: number } })._selections?.length ?? 0,
      downloadSpeed: Math.round(torrent.downloadSpeed),
      uploadSpeed: Math.round(torrent.uploadSpeed),
      downloaded: torrent.downloaded,
      activeJobs: this.leases.get(torrent.infoHash) ?? 0,
      idleSeconds: Math.round((now - (this.lastUsed.get(torrent.infoHash) ?? now)) / 1000),
    }));
  }

  close(): Promise<void> {
    clearInterval(this.sweepTimer);
    return new Promise((resolve) => this.client.destroy(() => resolve()));
  }

  private find(infoHash: string): Torrent | undefined {
    return this.client.torrents.find((torrent) => torrent.infoHash === infoHash);
  }

  private async get(infoHash: string): Promise<Torrent> {
    await this.destroying.get(infoHash);
    const existing = this.find(infoHash);
    // A destroyed torrent has no files left, so add it again rather than hand
    // back something a job can't read.
    if (existing?.ready && !isDestroyed(existing)) return existing;
    return this.flights.run(`add:${infoHash}`, () => this.add(infoHash));
  }

  private async add(infoHash: string): Promise<Torrent> {
    const { layout, pieces, metadataTimeoutMs } = this.options;
    const [metadata, magnet] = await Promise.all([
      readFile(layout.torrentFile(infoHash)).catch(() => undefined),
      readFile(layout.magnetFile(infoHash), 'utf8').catch(() => undefined),
    ]);
    if (!metadata && !magnet) {
      throw new HttpError(404, `Unknown torrent ${infoHash}; request it by magnet link first`);
    }

    logger.info('Adding torrent', { infoHash, from: metadata ? 'saved metadata' : 'magnet' });
    const torrent = this.client.add(metadata ?? magnet!, {
      store: pieces.createStore,
      path: pieces.directory,
      // Nothing is downloaded unless a read asks for it.
      deselect: true,
      storeCacheSlots: 0,
      destroyStoreOnDestroy: true,
      announce: magnet ? trackersOf(magnet) : [],
    });
    // Saved metadata carries no peer addresses, so keep the magnet's direct peers.
    const peers = metadata && magnet ? peersOf(magnet) : [];
    if (peers.length) {
      torrent.once('infoHash', () => peers.forEach((peer) => torrent.addPeer(peer)));
    }

    try {
      await waitUntilReady(torrent, metadataTimeoutMs);
    } catch (err) {
      await this.destroy(infoHash, torrent);
      throw err;
    }

    torrent.on('error', (err) => {
      logger.error('Torrent error', { infoHash, error: errorMessage(err) });
    });
    await this.persist(torrent).catch((err: unknown) => {
      logger.warn('Could not save torrent metadata', { infoHash, error: errorMessage(err) });
    });
    logger.info('Torrent ready', { infoHash, name: torrent.name, peers: torrent.numPeers });
    return torrent;
  }

  private async persist(torrent: Torrent): Promise<void> {
    const { layout } = this.options;
    await mkdir(layout.torrentDir(torrent.infoHash), { recursive: true });
    if (!(await exists(layout.torrentFile(torrent.infoHash)))) {
      await writeFileAtomic(layout.torrentFile(torrent.infoHash), torrent.torrentFile);
    }
    if (!(await exists(layout.infoFile(torrent.infoHash)))) {
      await writeFileAtomic(layout.infoFile(torrent.infoHash), JSON.stringify(describe(torrent)));
    }
  }

  private destroy(infoHash: string, torrent: Torrent): Promise<void> {
    const pending = new Promise<void>((resolve) => {
      torrent.destroy({ destroyStore: true }, () => resolve());
    }).finally(() => this.destroying.delete(infoHash));
    this.destroying.set(infoHash, pending);
    return pending;
  }

  private sweep(): void {
    const now = Date.now();
    // Usage records for hashes that never became a torrent (e.g. bad URLs).
    for (const [infoHash, used] of this.lastUsed) {
      if (!this.find(infoHash) && !this.leases.has(infoHash) && now - used >= this.options.idleMs) {
        this.lastUsed.delete(infoHash);
      }
    }

    for (const torrent of this.client.torrents) {
      const { infoHash } = torrent;
      if (!infoHash || !torrent.ready || this.leases.has(infoHash)) continue;
      if (now - (this.lastUsed.get(infoHash) ?? 0) < this.options.idleMs) continue;

      logger.info('Removing idle torrent', { infoHash, name: torrent.name });
      this.lastUsed.delete(infoHash);
      void this.destroy(infoHash, torrent);
    }
  }
}

function isDestroyed(torrent: Torrent): boolean {
  return (torrent as unknown as { destroyed?: boolean }).destroyed === true;
}

function describe(torrent: Torrent): TorrentInfo {
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    files: torrent.files.map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      length: file.length,
    })),
  };
}

function waitUntilReady(torrent: Torrent, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      torrent.removeListener('ready', onReady);
      torrent.removeListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onReady = () => finish();
    const onError = (err: Error | string) =>
      finish(err instanceof Error ? err : new Error(err));
    const timer = setTimeout(
      () => finish(new HttpError(504, 'Timed out waiting for torrent metadata; it may have no peers')),
      timeoutMs,
    );

    torrent.once('ready', onReady);
    torrent.once('error', onError);
  });
}
