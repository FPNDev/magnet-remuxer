// webtorrent ships no types for its peer module. Only the members the
// handshake guard patches are declared.
declare module 'webtorrent/lib/peer.js' {
  export type PeerSwarm = {
    destroyed?: boolean;
    client: unknown;
  };

  export type Peer = {
    swarm: PeerSwarm | null;
    destroyed: boolean;
    handshake: (this: Peer) => void;
    destroy(err?: Error): void;
  };

  const Peer: { prototype: Peer };
  export default Peer;
}
