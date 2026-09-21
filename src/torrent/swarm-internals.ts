import type { Torrent, TorrentPiece } from 'webtorrent';

// The 16 KiB block every peer will serve. Clients refuse larger requests.
export const BLOCK_LENGTH = 1 << 14;

export interface BlockRequest {
  piece: number;
  offset: number;
  length: number;
  callback(err: Error | null, chunk?: Uint8Array): void;
}

// These shapes mirror webtorrent internals that have no public API.
// Anything underscored is private to it and moves between releases.
export interface SwarmWire {
  destroyed: boolean;
  type: string;
  peerChoking: boolean;
  downloaded: number;
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
  peerPieces?: { get(index: number): boolean } | undefined;
  requests: BlockRequest[];
  downloadSpeed(): number;
  request(
    index: number,
    offset: number,
    length: number,
    callback: (err: Error | null, chunk?: Uint8Array) => void,
  ): void;
  cancel(index: number, offset: number, length: number): void;
  unchoke(): void;
  hasFast: boolean;
  bitfield(advertised: Uint8Array | { buffer: Uint8Array }): void;
  have(index: number): void;
  haveAll(): void;
  haveNone(): void;
  destroy(): void;
  _pull?: (
    requests: BlockRequest[],
    piece: number,
    offset: number,
    length: number,
  ) => BlockRequest | null;
  _callback?: (
    request: BlockRequest | null,
    err: Error | null,
    chunk: Uint8Array | null,
  ) => void;
}

export interface SwarmPiece extends TorrentPiece {
  get(index: number): Uint8Array | null;
}

export interface Selection {
  from: number;
  to: number;
  offset: number;
}

export interface SwarmPeer {
  id: string;
  addr?: string | undefined;
  type: string;
  wire: SwarmWire | null;
}

export interface SwarmTorrent extends Torrent {
  destroyed: boolean;
  bitfield: { get(index: number): boolean };
  pieces: (SwarmPiece | null)[];
  _selections: { readonly length: number; get(index: number): Selection };
  _peers: Map<string, SwarmPeer>;
  _numQueued: number;
  _numConns: number;
  client: { maxConns: number };
  _addPeer(peer: unknown, type?: string, source?: string): unknown;
}

export const asSwarmTorrent = (torrent: Torrent): SwarmTorrent =>
  torrent as unknown as SwarmTorrent;

export const wiresOf = (torrent: SwarmTorrent): SwarmWire[] =>
  torrent.wires as unknown as SwarmWire[];

export const addressOf = (wire: SwarmWire): string | undefined =>
  wire.remoteAddress && wire.remotePort
    ? `${wire.remoteAddress}:${wire.remotePort}`
    : undefined;

// The pieces at the front of each selection that are still missing.
// selection.offset is how far webtorrent has already advanced in it.
export function headPieces(torrent: SwarmTorrent, depth: number): Set<number> {
  const heads = new Set<number>();
  const selections = torrent._selections;
  for (let i = 0; i < selections.length; i++) {
    const selection = selections.get(i);
    if (!selection) {
      continue;
    }
    const head = selection.from + selection.offset;
    for (
      let piece = head;
      piece < head + depth && piece <= selection.to;
      piece++
    ) {
      if (!torrent.bitfield.get(piece)) {
        heads.add(piece);
      }
    }
  }
  return heads;
}

// True when the peer holds a missing piece near the front of a selection.
// That is the only reason to keep the connection.
export function hasWantedPieces(
  torrent: SwarmTorrent,
  wire: SwarmWire,
  window: number,
): boolean {
  const selections = torrent._selections;
  for (let i = 0; i < selections.length; i++) {
    const selection = selections.get(i);
    if (!selection) {
      continue;
    }
    const head = selection.from + selection.offset;
    const end = Math.min(selection.to, head + window - 1);
    for (let piece = head; piece <= end; piece++) {
      if (!torrent.bitfield.get(piece) && wire.peerPieces?.get(piece)) {
        return true;
      }
    }
  }
  return false;
}
