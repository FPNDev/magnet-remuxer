/**
 * WebTorrent ships no types for its internal modules. Only the parts this
 * server reaches into are declared here.
 */
declare module 'webtorrent/lib/peer.js' {
  export interface PeerSwarm {
    destroyed?: boolean;
    /** Null once the torrent has been destroyed. */
    client: unknown;
  }

  /** One connection to a peer. */
  export interface Peer {
    swarm: PeerSwarm | null;
    destroyed: boolean;
    handshake(): void;
    destroy(err?: Error): void;
  }

  const Peer: { prototype: Peer };
  export default Peer;
}
