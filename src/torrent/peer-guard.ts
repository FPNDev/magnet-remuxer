import type { Peer } from 'webtorrent/lib/peer.js';

import { errorMessage, logger } from '../logger.js';

/**
 * webtorrent can run Peer#handshake after its swarm is gone, which throws on
 * the missing client and takes the process down. Drop such peers instead.
 * Patches a shared prototype: call once, before any torrent is added.
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
    // Reaching into webtorrent's internals is version-fragile. Losing the patch
    // costs stability, not correctness, so a failure is not fatal.
    logger.warn('Could not guard WebTorrent peer handshakes', {
      error: errorMessage(err),
    });
  }
}
