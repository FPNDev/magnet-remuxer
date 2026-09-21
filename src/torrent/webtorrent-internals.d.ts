// webtorrent ships no types for its peer module. Only the members the
// handshake guard patches are declared.
declare module 'webtorrent/lib/peer.js' {
  export interface PeerSwarm {
    destroyed?: boolean;
    client: unknown;
  }

  export interface Peer {
    swarm: PeerSwarm | null;
    destroyed: boolean;
    handshake(): void;
    destroy(err?: Error): void;
  }

  const Peer: { prototype: Peer };
  export default Peer;
}
