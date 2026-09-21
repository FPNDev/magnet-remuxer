import type { Torrent } from 'webtorrent';

import { logger } from '../logger.js';
import {
  asSwarmTorrent,
  BLOCK_LENGTH,
  type BlockRequest,
  headPieces,
  type SwarmTorrent,
  type SwarmWire,
  wiresOf,
} from './swarm-internals.js';

const TICK_MS = 200;
// Only the piece a selection is stopped at is worth hedging. Further ahead
// the duplicate bytes buy nothing.
const HEAD_DEPTH = 1;
// Every hedge downloads a block twice, so they are capped per torrent.
const MAX_IN_FLIGHT = 32;
// A piece this close to complete is hedged without waiting for a deadline.
// Its last blocks are what keeps it from being verified.
const ENDGAME_BYTES = BLOCK_LENGTH * 4;

export interface TailHedgeOptions {
  enabled: boolean;
  deadlineMs: number;
}

export interface HedgeStats {
  issued: number;
  endgame: number;
  won: number;
  late: number;
  wastedBytes: number;
}

interface Hedge {
  helper: SwarmWire;
  piece: number;
  offset: number;
  length: number;
  startedAt: number;
  settled: boolean;
}

interface Watched {
  since: number;
  owner: SwarmWire;
  ownerBytes: number;
  tried: Set<SwarmWire>;
  hedge?: Hedge | undefined;
}

interface TorrentState {
  torrent: SwarmTorrent;
  timer: NodeJS.Timeout;
  blocks: Map<string, Watched>;
  inFlight: number;
  stats: HedgeStats;
}

const blockKey = (piece: number, offset: number) => `${piece}:${offset}`;

/**
 * Re-requests the block a reader is stopped on from a second peer, so one
 * slow peer cannot hold up the head of the file.
 */
export class TailHedge {
  private readonly states = new Map<string, TorrentState>();
  private warnedInternals = false;

  constructor(private readonly options: TailHedgeOptions) {}

  attach(torrent: Torrent): void {
    if (!this.options.enabled || this.states.has(torrent.infoHash)) {
      return;
    }
    const swarm = asSwarmTorrent(torrent);
    const timer = setInterval(() => this.sweep(swarm), TICK_MS);
    timer.unref();
    this.states.set(torrent.infoHash, {
      torrent: swarm,
      timer,
      blocks: new Map(),
      inFlight: 0,
      stats: { issued: 0, endgame: 0, won: 0, late: 0, wastedBytes: 0 },
    });
    torrent.once('close', () => this.detach(torrent.infoHash));
  }

  detach(infoHash: string): void {
    const state = this.states.get(infoHash);
    if (!state) {
      return;
    }
    clearInterval(state.timer);
    for (const watched of state.blocks.values()) {
      this.drop(state, watched);
    }
    this.states.delete(infoHash);
  }

  stats(infoHash: string): HedgeStats | undefined {
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
    const outstanding = this.tailRequests(torrent);

    for (const [key, watched] of state.blocks) {
      if (!outstanding.has(key)) {
        state.blocks.delete(key);
        this.drop(state, watched);
      }
    }

    for (const [key, { request, owner }] of outstanding) {
      const watched = state.blocks.get(key);
      if (!watched || watched.owner !== owner) {
        if (watched) {
          this.drop(state, watched);
        }
        state.blocks.set(key, {
          since: now,
          owner,
          ownerBytes: owner.downloaded,
          tried: new Set(),
        });
        continue;
      }

      if (watched.hedge) {
        // The helper is no faster than the owner. Give up on this hedge rather
        // than stack another on the same block.
        if (now - watched.hedge.startedAt >= this.options.deadlineMs * 3) {
          this.drop(state, watched);
        }
        continue;
      }
      if (state.inFlight >= MAX_IN_FLIGHT) {
        break;
      }
      const endgame = this.endgame(state, request.piece);
      if (endgame || this.overdue(watched, request, now)) {
        this.hedge(state, watched, request);
        if (endgame) {
          state.stats.endgame++;
        }
      }
    }
  }

  // A peer still delivering other blocks is working and gets the full wait.
  // One that has sent nothing since the request is hedged sooner.
  private overdue(
    watched: Watched,
    request: BlockRequest,
    now: number,
  ): boolean {
    const waited = now - watched.since;
    const { deadlineMs } = this.options;
    if (waited >= deadlineMs * 4) {
      return true;
    }
    if (waited < deadlineMs / 2) {
      return false;
    }
    const sent = watched.owner.downloaded - watched.ownerBytes;
    if (sent === 0) {
      return waited >= deadlineMs;
    }
    return watched.owner.requests[0] === request && sent >= BLOCK_LENGTH;
  }

  private endgame(state: TorrentState, piece: number): boolean {
    const held = state.torrent.pieces[piece];
    return !!held && held.missing > 0 && held.missing <= ENDGAME_BYTES;
  }

  private tailRequests(
    torrent: SwarmTorrent,
  ): Map<string, { request: BlockRequest; owner: SwarmWire }> {
    const found = new Map<
      string,
      { request: BlockRequest; owner: SwarmWire }
    >();
    const heads = headPieces(torrent, HEAD_DEPTH);
    if (!heads.size) {
      return found;
    }
    for (const wire of wiresOf(torrent)) {
      if (wire.destroyed) {
        continue;
      }
      for (const request of wire.requests) {
        if (heads.has(request.piece) && request.length <= BLOCK_LENGTH) {
          found.set(blockKey(request.piece, request.offset), {
            request,
            owner: wire,
          });
        }
      }
    }
    return found;
  }

  private hedge(
    state: TorrentState,
    watched: Watched,
    request: BlockRequest,
  ): void {
    const { piece, offset, length } = request;
    const owner = watched.owner;
    // Handing a block to the owning wire needs these internals. Without them
    // the block would arrive with no request to satisfy.
    if (!owner._pull || !owner._callback) {
      if (!this.warnedInternals) {
        this.warnedInternals = true;
        logger.warn(
          'Tail hedging is off: this bittorrent-protocol cannot hand a request over',
        );
      }
      return;
    }
    const helper = this.pickHelper(state.torrent, piece, watched);
    if (!helper) {
      return;
    }

    watched.tried.add(helper);
    const hedge: Hedge = {
      helper,
      piece,
      offset,
      length,
      startedAt: Date.now(),
      settled: false,
    };
    watched.hedge = hedge;
    state.inFlight++;
    state.stats.issued++;
    logger.debug('Hedging the block a reader is stopped at', {
      infoHash: state.torrent.infoHash,
      piece,
      offset,
      waitedMs: Date.now() - watched.since,
      to: helper.remoteAddress,
    });

    helper.request(piece, offset, length, (err, chunk) => {
      if (hedge.settled) {
        return;
      }
      hedge.settled = true;
      state.inFlight--;
      if (watched.hedge === hedge) {
        watched.hedge = undefined;
      }
      if (err || !chunk) {
        return;
      }
      this.deliver(state, watched, hedge, chunk);
    });
  }

  private pickHelper(
    torrent: SwarmTorrent,
    piece: number,
    watched: Watched,
  ): SwarmWire | undefined {
    let best: SwarmWire | undefined;
    let bestScore = -1;
    for (const wire of wiresOf(torrent)) {
      if (
        wire === watched.owner ||
        wire.destroyed ||
        wire.peerChoking ||
        watched.tried.has(wire) ||
        !wire.peerPieces?.get(piece)
      ) {
        continue;
      }
      const score =
        (wire.downloadSpeed() + BLOCK_LENGTH) / (wire.requests.length + 1);
      if (score > bestScore) {
        best = wire;
        bestScore = score;
      }
    }
    return best;
  }

  // The chunk goes through the owner's own request callback, so webtorrent
  // stores and verifies it as if that peer had answered.
  private deliver(
    state: TorrentState,
    watched: Watched,
    hedge: Hedge,
    chunk: Uint8Array,
  ): void {
    const { piece, offset, length } = hedge;
    const owner = watched.owner;
    const held = state.torrent.pieces[piece];
    const waste = () => {
      state.stats.late++;
      state.stats.wastedBytes += chunk.length;
    };

    // The owner answered while the hedge was in flight.
    if (!held || held.missing === 0 || held.get((offset / BLOCK_LENGTH) | 0)) {
      waste();
      return;
    }
    const pending = owner.destroyed
      ? null
      : (owner._pull?.(owner.requests, piece, offset, length) ?? null);
    if (!pending) {
      waste();
      return;
    }

    owner.cancel(piece, offset, length);
    owner._callback?.(pending, null, chunk);
    state.stats.won++;
    logger.debug('A hedged block arrived first', {
      infoHash: state.torrent.infoHash,
      piece,
      offset,
      ms: Date.now() - hedge.startedAt,
    });
  }

  // Cancel asks the helper to stop, but it may still answer. The settled
  // flag keeps that late chunk from being counted twice.
  private drop(state: TorrentState, watched: Watched): void {
    const hedge = watched.hedge;
    if (!hedge || hedge.settled) {
      return;
    }
    watched.hedge = undefined;
    if (!hedge.helper.destroyed) {
      hedge.helper.cancel(hedge.piece, hedge.offset, hedge.length);
    }
    if (!hedge.settled) {
      hedge.settled = true;
      state.inFlight--;
    }
  }
}
