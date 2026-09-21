import type { Torrent } from 'webtorrent';

import { logger } from '../logger.js';
import type { PeerBans } from './peer-bans.js';
import {
  addressOf,
  asSwarmTorrent,
  type SwarmTorrent,
  type SwarmWire,
} from './swarm-internals.js';

// A piece usually comes from several peers, so a shared piece needs two
// strikes inside the window. A sole sender is banned on the first.
const STRIKES = 2;
const STRIKE_TTL_MS = 30 * 60_000;
// Bounds the senders map: pieces in flight, oldest entry dropped first.
const TRACKED_PIECES = 512;

// webtorrent reports a hash failure only as a warning string.
const FAILED_PIECE = /Piece (\d+) failed verification/;

export interface CorruptPeersOptions {
  enabled: boolean;
  banMs: number;
}

export interface CorruptStats {
  failures: number;
  banned: number;
}

interface TorrentState {
  torrent: SwarmTorrent;
  infoHash: string;
  senders: Map<number, Map<SwarmWire, number>>;
  strikes: Map<string, { count: number; at: number }>;
  stats: CorruptStats;
  detach: () => void;
}

/**
 * Blames and bans peers whose blocks make a piece fail its hash check.
 */
export class CorruptPeers {
  private readonly states = new Map<string, TorrentState>();

  constructor(
    private readonly bans: PeerBans,
    private readonly options: CorruptPeersOptions,
  ) {}

  attach(torrent: Torrent, infoHash: string): void {
    if (!this.options.enabled || this.states.has(infoHash)) {
      return;
    }
    const state: TorrentState = {
      torrent: asSwarmTorrent(torrent),
      infoHash,
      senders: new Map(),
      strikes: new Map(),
      stats: { failures: 0, banned: 0 },
      detach: () => {},
    };

    const onWire = (wire: unknown) => {
      const sender = wire as SwarmWire;
      (wire as { on(event: string, cb: (index: number) => void): void }).on(
        'piece',
        (index: number) => this.record(state, index, sender),
      );
    };
    const onVerified = (index: number) => state.senders.delete(index);
    const onWarning = (err: Error | string) => {
      const piece = FAILED_PIECE.exec(
        typeof err === 'string' ? err : err.message,
      );
      if (piece) {
        this.blame(state, Number(piece[1]));
      }
    };

    torrent.on('wire', onWire);
    torrent.on('verified', onVerified);
    torrent.on('warning', onWarning);
    state.detach = () => {
      torrent.removeListener('wire', onWire);
      torrent.removeListener('verified', onVerified);
      torrent.removeListener('warning', onWarning);
    };

    this.states.set(infoHash, state);
    torrent.once('close', () => this.detach(infoHash));
  }

  detach(infoHash: string): void {
    const state = this.states.get(infoHash);
    if (!state) {
      return;
    }
    state.detach();
    this.states.delete(infoHash);
  }

  stats(infoHash: string): CorruptStats | undefined {
    return this.states.get(infoHash)?.stats;
  }

  private record(state: TorrentState, index: number, wire: SwarmWire): void {
    let senders = state.senders.get(index);
    if (!senders) {
      senders = new Map();
      state.senders.set(index, senders);
      if (state.senders.size > TRACKED_PIECES) {
        state.senders.delete(state.senders.keys().next().value!);
      }
    }
    senders.set(wire, (senders.get(wire) ?? 0) + 1);
  }

  private blame(state: TorrentState, index: number): void {
    const senders = state.senders.get(index);
    state.senders.delete(index);
    state.stats.failures++;
    if (!senders?.size) {
      logger.warn('A piece failed verification, with nobody to blame for it', {
        infoHash: state.infoHash,
        piece: index,
      });
      return;
    }

    // The peer that sent the most blocks of the piece is the likeliest source
    // of the bad ones.
    const [wire, blocks] = [...senders].sort((a, b) => b[1] - a[1])[0]!;
    const sole = senders.size === 1;
    const address = addressOf(wire);
    if (!address) {
      return;
    }
    const now = Date.now();
    const previous = state.strikes.get(address);
    const strikes =
      previous && now - previous.at < STRIKE_TTL_MS ? previous.count + 1 : 1;
    state.strikes.set(address, { count: strikes, at: now });
    logger.warn('A piece failed verification', {
      infoHash: state.infoHash,
      piece: index,
      blamed: address,
      blocks,
      of: [...senders.values()].reduce((sum, count) => sum + count, 0),
      strikes,
    });
    if (!sole && strikes < STRIKES) {
      return;
    }

    state.strikes.delete(address);
    state.stats.banned++;
    this.bans.block(
      state.infoHash,
      address,
      this.options.banMs,
      'sent data that failed verification',
      true,
    );
    logger.warn('Banning a peer that sent bad data', {
      infoHash: state.infoHash,
      peer: address,
      piece: index,
      sole,
    });
    if (!wire.destroyed) {
      wire.destroy();
    }
  }
}
