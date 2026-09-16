import type { Peer } from 'webtorrent/lib/peer.js';

import { errorMessage, logger } from '../logger.js';

/**
 * Stops a torrent teardown from taking the process down with it.
 *
 * Destroying a torrent sets `torrent.client` to null. A connection that was
 * still shaking hands keeps a reference to that torrent and, when its socket
 * next reports progress, reads `swarm.client.peerId`, which can lead to race condition
 * and a TypeError
 *
 * This prevents it by hanging up such a connection instead of
 * dereferencing a client that is gone.
 */
export async function guardPeerHandshakes(): Promise<void> {
  try {
    const { default: Peer } = await import('webtorrent/lib/peer.js');
    const shakeHands = Peer.prototype.handshake;

    Peer.prototype.handshake = function handshake(this: Peer): void {
      if (!this.swarm || !this.swarm.client || this.swarm.destroyed) {
        this.destroy();
        return;
      }
      shakeHands.call(this);
    };
  } catch (err: unknown) {
    // Only a deep import into WebTorrent can fix this, so a version that moves
    // the module leaves the server running as it did before.
    logger.warn('Could not guard WebTorrent peer handshakes', {
      error: errorMessage(err),
    });
  }
}
