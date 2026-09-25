import type { Torrent } from 'webtorrent';

import type { CacheLayout } from '../cache/cache-layout.js';
import { errorMessage, logger } from '../logger.js';
import { readJson, writeFileAtomic } from '../util/fs.js';
import { SingleFlight } from '../util/single-flight.js';

const REMEMBERED_PEERS = 30;
// One save per torrent per interval. The claim is released when nothing was
// written, so the next call may try again straight away.
const SAVE_INTERVAL_MS = 60_000;

/**
 * Remembers peers that served data, so a restart can reconnect to them
 * instead of waiting on trackers and the DHT.
 */
export class PeerMemory {
  private readonly savedAt = new Map<string, number>();
  private readonly flights = new SingleFlight();

  constructor(private readonly layout: CacheLayout) {}

  async saved(infoHash: string): Promise<string[]> {
    return (await readJson<string[]>(this.layout.peersFile(infoHash))) ?? [];
  }

  noteUse(torrent: Torrent): void {
    const { infoHash } = torrent;
    if (Date.now() - (this.savedAt.get(infoHash) ?? 0) < SAVE_INTERVAL_MS) {
      return;
    }
    const claimed = Date.now();
    this.savedAt.set(infoHash, claimed);
    const release = () => {
      if (this.savedAt.get(infoHash) === claimed) {
        this.savedAt.delete(infoHash);
      }
    };
    this.save(torrent).then(
      (written) => {
        if (!written) {
          release();
        }
      },
      (err: unknown) => {
        release();
        logger.warn('Could not save peers', {
          infoHash,
          error: errorMessage(err),
        });
      },
    );
  }

  forget(infoHash: string): void {
    this.savedAt.delete(infoHash);
  }

  async flush(torrent: Torrent): Promise<void> {
    await this.save(torrent).catch((err: unknown) => {
      logger.warn('Could not save peers', {
        infoHash: torrent.infoHash,
        error: errorMessage(err),
      });
    });
  }

  private async save(torrent: Torrent): Promise<boolean> {
    const serving = torrent.wires
      // A connection proves nothing. Only peers that sent bytes are worth
      // keeping.
      .filter((wire) => wire.downloaded > 0)
      .map((wire) => {
        const { remoteAddress, remotePort } = wire as unknown as {
          remoteAddress?: string;
          remotePort?: number;
        };
        return remoteAddress && remotePort
          ? `${remoteAddress}:${remotePort}`
          : undefined;
      })
      .filter((peer): peer is string => peer !== undefined)
      .slice(0, REMEMBERED_PEERS);
    if (!serving.length) {
      return false;
    }
    await this.flights.run(torrent.infoHash, undefined, () =>
      writeFileAtomic(
        this.layout.peersFile(torrent.infoHash),
        JSON.stringify(serving),
      ),
    ).promise;
    return true;
  }
}
