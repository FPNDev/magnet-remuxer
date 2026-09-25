import type { Torrent } from 'webtorrent';

import { logger } from '../logger.js';
import type { PeerBans } from './peer-bans.js';
import {
  addressOf,
  asSwarmTorrent,
  hasWantedPieces,
  type SwarmPeer,
  type SwarmTorrent,
  type SwarmWire,
  wiresOf,
} from './swarm-internals.js';

const TICK_MS = 1000;
// Dropping is rate limited. Churning a whole swarm at once costs more
// throughput than the dead connections do.
const MAX_PER_TICK = 1;
// A wire that has not sent its bitfield yet looks like it holds nothing.
const BITFIELD_SETTLE_MS = 1500;
// A dropped peer is banned for this long, so the tracker or DHT does not
// hand the same address straight back.
const BAN_MS = 10 * 60_000;
// Only pieces near the read head count. A peer holding the tail of the
// file cannot help a player.
const WANTED_WINDOW = 256;
// How many connections an address may spend without serving a byte before
// it is treated as a freeloader rather than a slow starter.
const FRUITLESS_LIMIT = 10;
// Connection counts older than this are stale. A peer that comes back
// slower than this is reconnecting, not hammering.
const RECONNECT_WINDOW_MS = 60_000;
// The first freeload ban. It doubles with every further offence and stops
// at BAN_MS, so a mistake costs a minute and a repeat offender ten.
const FREELOAD_BAN_MS = 60_000;

export interface PeerChurnOptions {
  enabled: boolean;
  graceMs: number;
}

export interface ChurnStats {
  dropped: number;
  reasons: Record<string, number>;
}

interface Seen {
  since: number;
  bytes: number;
  // Start of the stretch in which the peer sent nothing. Set on first
  // sight and again whenever bytes arrive, so it measures how long this
  // wire has been silent.
  quietSince: number;
  asked: boolean;
}

// What one address has done across every wire it has held, so a peer that
// reconnects is judged on its history instead of from scratch.
interface Address {
  fruitless: number;
  served: number;
  offenses: number;
  lastSeen: number;
}

interface Candidate {
  wire: SwarmWire;
  weight: number;
  reason: string;
  quietSince: number;
}

interface TorrentState {
  torrent: SwarmTorrent;
  timer: NodeJS.Timeout;
  seen: Map<SwarmWire, Seen>;
  addresses: Map<string, Address>;
  stats: ChurnStats;
  restore: () => void;
}

/**
 * Drops peers that hold nothing being read or that have gone quiet, so
 * their connection slots return to the swarm.
 */
export class PeerChurn {
  private readonly states = new Map<string, TorrentState>();

  constructor(
    private readonly bans: PeerBans,
    private readonly options: PeerChurnOptions,
  ) {}

  attach(torrent: Torrent): void {
    if (!this.options.enabled || this.states.has(torrent.infoHash)) {
      return;
    }
    const swarm = asSwarmTorrent(torrent);
    const timer = setInterval(() => this.sweep(swarm), TICK_MS);
    timer.unref();
    const state: TorrentState = {
      torrent: swarm,
      timer,
      seen: new Map(),
      addresses: new Map(),
      stats: { dropped: 0, reasons: {} },
      restore: () => {},
    };
    const onWire = (wire: unknown) => {
      const now = Date.now();
      state.seen.set(wire as SwarmWire, {
        since: now,
        bytes: 0,
        quietSince: now,
        asked: false,
      });
    };
    state.restore = () => torrent.removeListener('wire', onWire);
    torrent.on('wire', onWire);
    this.states.set(torrent.infoHash, state);
    torrent.once('close', () => this.detach(torrent.infoHash));
  }

  detach(infoHash: string): void {
    const state = this.states.get(infoHash);
    if (!state) {
      return;
    }
    clearInterval(state.timer);
    state.restore();
    this.states.delete(infoHash);
  }

  stats(infoHash: string): ChurnStats | undefined {
    return this.states.get(infoHash)?.stats;
  }

  private sweep(torrent: SwarmTorrent): void {
    const state = this.states.get(torrent.infoHash);
    if (!state) {
      return;
    }
    if (torrent.destroyed) {
      this.detach(torrent.infoHash);
      return;
    }

    const now = Date.now();
    const wires = new Set(wiresOf(torrent).filter((wire) => !wire.destroyed));
    for (const wire of state.seen.keys()) {
      if (!wires.has(wire)) {
        this.remember(state, wire, now);
        state.seen.delete(wire);
      }
    }
    for (const [address, record] of state.addresses) {
      if (
        record.offenses === 0 &&
        now - record.lastSeen > RECONNECT_WINDOW_MS
      ) {
        state.addresses.delete(address);
      }
    }
    for (const wire of wires) {
      const seen = state.seen.get(wire);
      if (!seen) {
        state.seen.set(wire, {
          since: now,
          bytes: wire.downloaded,
          quietSince: now,
          asked: wire.requests.length > 0,
        });
        continue;
      }
      if (wire.downloaded !== seen.bytes) {
        seen.bytes = wire.downloaded;
        seen.quietSince = now;
      }
      if (wire.requests.length > 0) {
        seen.asked = true;
      }
    }

    // With nothing selected, or nobody queued for a connection slot, a drop
    // only loses swarm.
    if (!torrent._selections.length || torrent._numQueued <= 0) {
      return;
    }

    const candidates: Candidate[] = [];
    for (const wire of wires) {
      const candidate = this.judge(torrent, state, wire, now);
      if (candidate) {
        candidates.push(candidate);
      }
    }
    if (!candidates.length) {
      return;
    }

    candidates.sort(
      (a, b) => b.weight - a.weight || a.quietSince - b.quietSince,
    );
    // Churn hands slots to better peers; it must never empty the swarm. One
    // connection survives every sweep, however useless every wire looks.
    const limit = Math.min(MAX_PER_TICK, wires.size - 1);
    if (limit <= 0) {
      return;
    }
    const peers = this.peersByWire(torrent);
    for (const candidate of candidates.slice(0, limit)) {
      this.drop(state, candidate, peers.get(candidate.wire));
    }
  }

  // A wire dies and the same peer dials back, so what it did is kept against
  // its address. The key is ip:port, the address a ban is placed on, so the
  // peer a count condemns is the one blocked, and two peers behind one NAT
  // keep separate records.
  private remember(state: TorrentState, wire: SwarmWire, now: number): void {
    const address = addressOf(wire);
    if (!address) {
      return;
    }
    const record = state.addresses.get(address) ?? {
      fruitless: 0,
      served: 0,
      offenses: 0,
      lastSeen: now,
    };
    state.addresses.set(address, record);
    if (now - record.lastSeen > RECONNECT_WINDOW_MS) {
      record.fruitless = 0;
    }
    record.lastSeen = now;
    const bytes = wire.downloaded + (state.seen.get(wire)?.bytes ?? 0);
    if (bytes > 0) {
      record.served += bytes;
      record.fruitless = 0;
    } else {
      record.fruitless++;
    }
    if (record.served > 0 || record.fruitless < FRUITLESS_LIMIT) {
      return;
    }
    const ms = Math.min(BAN_MS, FREELOAD_BAN_MS * 2 ** record.offenses);
    this.bans.block(
      state.torrent.infoHash,
      address,
      ms,
      'reconnects without serving',
    );
    record.offenses++;
    record.fruitless = 0;
    logger.info('Banning a peer that reconnects without serving', {
      infoHash: state.torrent.infoHash,
      peer: address,
      offences: record.offenses,
      banMs: ms,
    });
  }

  // Weight sets the drop order: peers holding none of the wanted pieces go
  // first, then ones that never sent bytes, then ones that served and quit.
  private judge(
    torrent: SwarmTorrent,
    state: TorrentState,
    wire: SwarmWire,
    now: number,
  ): Candidate | undefined {
    const seen = state.seen.get(wire);
    if (!seen || wire.type === 'webSeed') {
      return undefined;
    }
    const age = now - seen.since;
    const settle = Math.min(this.options.graceMs, BITFIELD_SETTLE_MS);
    if (age < settle) {
      return undefined;
    }
    if (seen.bytes > 0 && now - seen.quietSince < this.options.graceMs) {
      return undefined;
    }

    const { quietSince } = seen;
    if (!hasWantedPieces(torrent, wire, WANTED_WINDOW)) {
      return {
        wire,
        weight: 3,
        reason: 'has none of what is being read',
        quietSince,
      };
    }
    if (age < this.options.graceMs) {
      return undefined;
    }
    if (seen.bytes === 0) {
      // A choking peer cannot serve whether or not it was asked.
      if (wire.peerChoking) {
        return {
          wire,
          weight: 2,
          reason: 'choking us since it connected',
          quietSince,
        };
      }
      if (!seen.asked) {
        return undefined;
      }
      return { wire, weight: 2, reason: 'silent', quietSince };
    }
    return { wire, weight: 1, reason: 'served us and went quiet', quietSince };
  }

  private peersByWire(torrent: SwarmTorrent): Map<SwarmWire, SwarmPeer> {
    const byWire = new Map<SwarmWire, SwarmPeer>();
    for (const peer of torrent._peers.values()) {
      if (peer.wire) {
        byWire.set(peer.wire, peer);
      }
    }
    return byWire;
  }

  private drop(
    state: TorrentState,
    candidate: Candidate,
    peer: SwarmPeer | undefined,
  ): void {
    const { wire, reason } = candidate;
    const address = peer?.addr ?? addressOf(wire);
    if (address) {
      this.bans.block(state.torrent.infoHash, address, BAN_MS, reason);
    }
    logger.debug('Dropping a peer', {
      infoHash: state.torrent.infoHash,
      peer: address,
      reason,
      bytes: wire.downloaded,
    });
    state.stats.dropped++;
    state.stats.reasons[reason] = (state.stats.reasons[reason] ?? 0) + 1;

    // Removing the peer takes the address out of the swarm. Destroying the
    // wire alone leaves it to be dialed again.
    if (peer) {
      state.torrent.removePeer(peer.id);
    } else {
      wire.destroy();
    }
  }
}
