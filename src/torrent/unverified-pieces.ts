import type { Torrent } from 'webtorrent';

import { FAILED_PIECE } from './corrupt-peers.js';
import { asSwarmTorrent, type SwarmTorrent } from './swarm-internals.js';

type PieceCallback = (piece: number) => void;

type TorrentState = {
  torrent: SwarmTorrent;
  pieces: Map<number, Set<PieceCallback>>;
  detach: () => void;
};

export class UnverifiedPieces {
  private readonly states = new Map<string, TorrentState>();

  attach(torrent: Torrent, infoHash: string): void {
    if (this.states.has(infoHash)) {
      return;
    }
    const state: TorrentState = {
      torrent: asSwarmTorrent(torrent),
      pieces: new Map(),
      detach: () => {},
    };

    const onVerified = (index: number) => {
      this.settle(state, index);
    };
    const onWarning = (err: Error | string) => {
      const failed = FAILED_PIECE.exec(
        typeof err === 'string' ? err : err.message,
      );
      if (!failed) {
        return;
      }
      const piece = Number(failed[1]);
      const callbacks = state.pieces.get(piece);
      if (!callbacks) {
        return;
      }
      this.settle(state, piece);
      for (const callback of callbacks) {
        callback(piece);
      }
    };
    const onClose = () => {
      this.detach(infoHash);
    };

    torrent.on('verified', onVerified);
    torrent.on('warning', onWarning);
    torrent.once('close', onClose);
    state.detach = () => {
      torrent.removeListener('verified', onVerified);
      torrent.removeListener('warning', onWarning);
      torrent.removeListener('close', onClose);
    };

    this.states.set(infoHash, state);
  }

  detach(infoHash: string): void {
    const state = this.states.get(infoHash);
    if (!state) {
      return;
    }
    state.detach();
    this.states.delete(infoHash);
    for (const [piece, callbacks] of state.pieces) {
      for (const callback of callbacks) {
        callback(piece);
      }
    }
  }

  add(infoHash: string, piece: number, callback: PieceCallback): void {
    const state = this.states.get(infoHash);
    if (!state) {
      callback(piece);
      return;
    }
    let callbacks = state.pieces.get(piece);
    if (!callbacks) {
      callbacks = new Set();
      state.pieces.set(piece, callbacks);
      try {
        state.torrent._select(piece, piece, 1, null, true);
      } catch {}
    }
    callbacks.add(callback);
  }

  remove(infoHash: string, piece: number, callback: PieceCallback): void {
    this.states.get(infoHash)?.pieces.get(piece)?.delete(callback);
  }

  private settle(state: TorrentState, piece: number): void {
    if (!state.pieces.delete(piece)) {
      return;
    }
    try {
      state.torrent._deselect(piece, piece, true);
    } catch {}
  }
}
