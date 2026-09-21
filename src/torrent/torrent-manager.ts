import { mkdir, readFile } from 'node:fs/promises';
import WebTorrent from 'webtorrent';
import type { Torrent, TorrentOptions } from 'webtorrent';

import type { CacheLayout } from '../cache/cache-layout.js';
import { HttpError } from '../errors.js';
import { errorMessage, logger } from '../logger.js';
import { exists, readJson, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';
import { CorruptPeers, type CorruptPeersOptions } from './corrupt-peers.js';
import { peersOf, trackersOf } from './magnet.js';
import { PeerBans } from './peer-bans.js';
import { PeerChurn, type PeerChurnOptions } from './peer-churn.js';
import { PeerMemory } from './peer-memory.js';
import type { AdoptableTorrent, PieceCache } from './piece-store.js';
import { asSwarmTorrent, type SwarmWire } from './swarm-internals.js';
import { TailHedge, type TailHedgeOptions } from './tail-hedge.js';

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
  maxPeers: number;
  hedge: TailHedgeOptions;
  churn: PeerChurnOptions;
  corrupt: CorruptPeersOptions;
}

const SWEEP_INTERVAL_MS = 30_000;
// Reads, hedging and churn each attach listeners per torrent, well past
// Node's default warning threshold of ten.
const MAX_TORRENT_LISTENERS = 200;

/**
 * Owns the WebTorrent client. Torrents are added on demand, leased while
 * work runs against them, and removed once idle.
 */
export class TorrentManager {
  private readonly client: WebTorrent;
  private readonly flights = new SingleFlight();
  private readonly destroying = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly hedge: TailHedge;
  private readonly churn: PeerChurn;
  private readonly corrupt: CorruptPeers;
  private readonly bans: PeerBans;
  private readonly peers: PeerMemory;

  constructor(private readonly options: TorrentManagerOptions) {
    this.client = new WebTorrent({ maxConns: options.maxPeers });
    this.bans = new PeerBans(options.layout);
    this.peers = new PeerMemory(options.layout);
    this.hedge = new TailHedge(options.hedge);
    this.churn = new PeerChurn(this.bans, options.churn);
    this.corrupt = new CorruptPeers(this.bans, options.corrupt);
    this.client.on('error', (err) => {
      logger.error('WebTorrent client error', { error: errorMessage(err) });
    });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  remember(infoHash: string, magnet: string): Promise<void> {
    return this.flights.run(`remember:${infoHash}`, async () => {
      const file = this.options.layout.magnetFile(infoHash);
      if (await exists(file)) {
        return;
      }
      await mkdir(this.options.layout.torrentDir(infoHash), {
        recursive: true,
      });
      await writeFileAtomic(file, magnet);
    });
  }

  async info(infoHash: string): Promise<TorrentInfo> {
    const saved = await readJson<TorrentInfo>(
      this.options.layout.infoFile(infoHash),
    );
    if (saved) {
      return saved;
    }
    return this.use(infoHash, async (torrent) => describe(torrent));
  }

  // Refreshes a torrent that is already known. It never revives one the
  // sweep has forgotten.
  touch(infoHash: string): void {
    if (this.lastUsed.has(infoHash) || this.find(infoHash)) {
      this.lastUsed.set(infoHash, Date.now());
    }
  }

  warm(infoHash: string): void {
    this.lastUsed.set(infoHash, Date.now());
    this.get(infoHash).catch((err: unknown) => {
      logger.warn('Torrent warm-up failed', {
        infoHash,
        error: errorMessage(err),
      });
    });
  }

  // The lease keeps the torrent out of the idle sweep for as long as the
  // task runs.
  async use<T>(
    infoHash: string,
    task: (torrent: Torrent) => Promise<T>,
  ): Promise<T> {
    this.leases.set(infoHash, (this.leases.get(infoHash) ?? 0) + 1);
    this.lastUsed.set(infoHash, Date.now());
    try {
      const torrent = await this.get(infoHash);
      try {
        return await task(torrent);
      } finally {
        this.peers.noteUse(torrent);
      }
    } finally {
      const remaining = (this.leases.get(infoHash) ?? 1) - 1;
      if (remaining > 0) {
        this.leases.set(infoHash, remaining);
      } else {
        this.leases.delete(infoHash);
      }
      this.lastUsed.set(infoHash, Date.now());
    }
  }

  active(): Set<string> {
    return new Set([
      ...this.leases.keys(),
      ...this.pending.keys(),
      ...this.client.torrents
        .map((torrent) => torrent.infoHash)
        .filter((infoHash) => !!infoHash),
    ]);
  }

  status() {
    const now = Date.now();
    return this.client.torrents.map((torrent) => ({
      infoHash: torrent.infoHash,
      name: torrent.name,
      ready: torrent.ready,
      peers: torrent.numPeers,
      chokedBy: torrent.wires.filter((wire) => wire.peerChoking).length,
      interested:
        (torrent as unknown as { _amInterested?: boolean })._amInterested ??
        false,
      wantedRanges:
        (torrent as unknown as { _selections?: { length: number } })._selections
          ?.length ?? 0,
      downloadSpeed: Math.round(torrent.downloadSpeed),
      uploadSpeed: Math.round(torrent.uploadSpeed),
      downloaded: torrent.downloaded,
      hedges: this.hedge.stats(torrent.infoHash),
      churn: this.churn.stats(torrent.infoHash),
      corrupt: this.corrupt.stats(torrent.infoHash),
      bannedPeers: this.bans.count(torrent.infoHash),
      activeJobs: this.leases.get(torrent.infoHash) ?? 0,
      idleSeconds: Math.round(
        (now - (this.lastUsed.get(torrent.infoHash) ?? now)) / 1000,
      ),
    }));
  }

  // An idle torrent is removed, but its magnet and metadata stay on disk, so
  // the next request can add it back without the DHT.
  sweep(): void {
    const now = Date.now();
    for (const [infoHash, used] of this.lastUsed) {
      if (
        !this.find(infoHash) &&
        !this.busy(infoHash) &&
        now - used >= this.options.idleMs
      ) {
        this.lastUsed.delete(infoHash);
      }
    }

    for (const torrent of this.client.torrents) {
      const { infoHash } = torrent;
      if (!infoHash || !torrent.ready || this.busy(infoHash)) {
        continue;
      }
      if (now - (this.lastUsed.get(infoHash) ?? 0) < this.options.idleMs) {
        continue;
      }

      logger.info('Removing idle torrent', { infoHash, name: torrent.name });
      this.lastUsed.delete(infoHash);
      void this.destroy(infoHash, torrent);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    await Promise.all(
      this.client.torrents
        .filter((torrent) => torrent.infoHash && torrent.ready)
        .map((torrent) => this.peers.flush(torrent)),
    );
    await new Promise<void>((resolve) => this.client.destroy(() => resolve()));
  }

  private busy(infoHash: string): boolean {
    return this.leases.has(infoHash) || this.pending.has(infoHash);
  }

  private find(infoHash: string): Torrent | undefined {
    return this.client.torrents.find(
      (torrent) => torrent.infoHash === infoHash,
    );
  }

  private async get(infoHash: string): Promise<Torrent> {
    this.pending.set(infoHash, (this.pending.get(infoHash) ?? 0) + 1);
    try {
      // A torrent part way through teardown must finish leaving before the same
      // info hash can be added again.
      for (let attempt = 0; attempt < 4; attempt++) {
        const leaving = this.destroying.get(infoHash);
        if (leaving) {
          await leaving;
          continue;
        }
        const existing = this.find(infoHash);
        if (existing?.ready && !isDestroyed(existing)) {
          return existing;
        }
        return await this.flights.run(`add:${infoHash}`, () =>
          this.add(infoHash),
        );
      }
      throw new HttpError(503, `Torrent ${infoHash} is being removed`);
    } finally {
      const remaining = (this.pending.get(infoHash) ?? 1) - 1;
      if (remaining > 0) {
        this.pending.set(infoHash, remaining);
      } else {
        this.pending.delete(infoHash);
      }
    }
  }

  private async add(infoHash: string): Promise<Torrent> {
    const { layout, pieces, metadataTimeoutMs } = this.options;
    const [metadata, magnet, remembered, banned] = await Promise.all([
      readFile(layout.torrentFile(infoHash)).catch(() => undefined),
      readFile(layout.magnetFile(infoHash), 'utf8').catch(() => undefined),
      this.peers.saved(infoHash).catch(() => []),
      this.bans.saved(infoHash),
      // Prepared alongside the reads; it has no result to destructure.
      pieces.prepare(infoHash),
    ]);
    if (!metadata && !magnet) {
      throw new HttpError(
        404,
        `Unknown torrent ${infoHash}; request it by magnet link first`,
      );
    }

    logger.info('Adding torrent', {
      infoHash,
      from: metadata ? 'saved metadata' : 'magnet',
    });
    const torrent = this.client.add(metadata ?? magnet!, {
      store: pieces.createStore as unknown as NonNullable<
        TorrentOptions['store']
      >,
      path: pieces.directory,
      // Nothing downloads until a read selects pieces.
      deselect: true,
      storeCacheSlots: 0,
      // Cached pieces outlive the torrent, and webtorrent's own store cache
      // is off because PieceCache holds the bytes.
      destroyStoreOnDestroy: false,
      announce: magnet ? trackersOf(magnet) : [],
    });
    torrent.setMaxListeners(MAX_TORRENT_LISTENERS);
    // The server reads and never seeds. Every peer is told we hold no piece,
    // by have-none where the fast extension is negotiated and by an empty
    // bitfield otherwise, so nothing we hold is ever worth asking for. A peer
    // that asks anyway stays choked.
    torrent.on('wire', (wire: unknown) => {
      const peer = wire as SwarmWire;
      const bitfield = peer.bitfield.bind(peer);
      peer.bitfield = (advertised) => {
        if (peer.hasFast) {
          peer.haveNone();
          return;
        }
        const view = ArrayBuffer.isView(advertised)
          ? advertised
          : advertised.buffer;
        bitfield(new Uint8Array(view.byteLength));
      };
      peer.haveAll = () => peer.haveNone();
      peer.have = () => {};
      peer.unchoke = () => {};
    });
    torrent.on('error', (err) => {
      logger.error('Torrent error', { infoHash, error: errorMessage(err) });
    });
    this.bans.attach(asSwarmTorrent(torrent), infoHash, banned);
    this.corrupt.attach(torrent, infoHash);
    const peers = [
      ...new Set([
        ...(metadata && magnet ? peersOf(magnet) : []),
        ...remembered,
      ]),
    ];
    if (peers.length) {
      // Peers can only be added once the info hash is known.
      torrent.once('infoHash', () => {
        for (const peer of peers) {
          torrent.addPeer(peer);
        }
      });
    }

    try {
      await waitUntilReady(torrent, metadataTimeoutMs);
    } catch (err) {
      await this.destroy(infoHash, torrent);
      throw err;
    }

    await pieces
      // Pieces left from an earlier run are rehashed and kept, so a
      // restart does not download them again.
      .adoptInto(torrent as unknown as AdoptableTorrent)
      .then((adoption) => {
        if (adoption.kept || adoption.dropped) {
          logger.info('Reused cached pieces', {
            infoHash,
            kept: adoption.kept,
            dropped: adoption.dropped,
            hashedMiB: Math.round(adoption.hashedBytes / 2 ** 20),
          });
        }
      })
      .catch((err: unknown) => {
        logger.warn('Could not reuse cached pieces', {
          infoHash,
          error: errorMessage(err),
        });
      });
    this.hedge.attach(torrent);
    this.churn.attach(torrent);
    await this.persist(torrent).catch((err: unknown) => {
      logger.warn('Could not save torrent metadata', {
        infoHash,
        error: errorMessage(err),
      });
    });
    logger.info('Torrent ready', {
      infoHash,
      name: torrent.name,
      peers: torrent.numPeers,
    });
    return torrent;
  }

  private async persist(torrent: Torrent): Promise<void> {
    const { layout } = this.options;
    await mkdir(layout.torrentDir(torrent.infoHash), { recursive: true });
    if (!(await exists(layout.torrentFile(torrent.infoHash)))) {
      await writeFileAtomic(
        layout.torrentFile(torrent.infoHash),
        torrent.torrentFile,
      );
    }
    if (!(await exists(layout.infoFile(torrent.infoHash)))) {
      await writeFileAtomic(
        layout.infoFile(torrent.infoHash),
        JSON.stringify(describe(torrent)),
      );
    }
  }

  private destroy(infoHash: string, torrent: Torrent): Promise<void> {
    const already = this.destroying.get(infoHash);
    if (already) {
      return already;
    }
    const pending = this.teardown(infoHash, torrent).finally(() =>
      this.destroying.delete(infoHash),
    );
    this.destroying.set(infoHash, pending);
    return pending;
  }

  // Order matters: peers are saved and every policy detached while the wires
  // still exist.
  private async teardown(infoHash: string, torrent: Torrent): Promise<void> {
    await this.peers.flush(torrent);
    this.hedge.detach(infoHash);
    this.churn.detach(infoHash);
    this.corrupt.detach(infoHash);
    await this.bans.detach(infoHash);
    this.peers.forget(infoHash);
    torrent.pause();
    await new Promise<void>((resolve) => {
      torrent.destroy({ destroyStore: false }, () => resolve());
    });
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

// A magnet with no reachable peers never becomes ready, so the wait is
// bounded and reported as 504.
function waitUntilReady(torrent: Torrent, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      torrent.removeListener('ready', onReady);
      torrent.removeListener('error', onError);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const onReady = () => finish();
    const onError = (err: Error | string) =>
      finish(err instanceof Error ? err : new Error(err));
    const timer = setTimeout(
      () =>
        finish(
          new HttpError(
            504,
            'Timed out waiting for torrent metadata; it may have no peers',
          ),
        ),
      timeoutMs,
    );

    torrent.once('ready', onReady);
    torrent.once('error', onError);
  });
}
