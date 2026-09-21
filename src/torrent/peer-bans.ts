import type { CacheLayout } from '../cache/cache-layout.js';
import { errorMessage, logger } from '../logger.js';
import { readJson, writeFileAtomic } from '../util/fs.js';
import type { SwarmTorrent } from './swarm-internals.js';

const SAVE_DELAY_MS = 2000;

interface Ban {
  until: number;
  reason: string;
  keep: boolean;
}

interface TorrentBans {
  bans: Map<string, Ban>;
  saveTimer: NodeJS.Timeout | undefined;
  restore: () => void;
}

/**
 * Per-torrent address bans. A ban marked keep is written to disk and
 * outlives the process; the rest last as long as the torrent is attached.
 */
export class PeerBans {
  private readonly torrents = new Map<string, TorrentBans>();

  constructor(private readonly layout: CacheLayout) {}

  async saved(infoHash: string): Promise<Record<string, number>> {
    const saved = await readJson<Record<string, number>>(
      this.layout.bannedFile(infoHash),
    ).catch(() => undefined);
    return saved ?? {};
  }

  attach(
    torrent: SwarmTorrent,
    infoHash: string,
    saved: Record<string, number> = {},
  ): void {
    if (this.torrents.has(infoHash)) {
      return;
    }
    const state: TorrentBans = {
      bans: new Map(),
      saveTimer: undefined,
      restore: () => {},
    };
    const now = Date.now();
    for (const [address, until] of Object.entries(saved)) {
      if (until > now) {
        state.bans.set(address, {
          until,
          reason: 'banned in an earlier run',
          keep: true,
        });
      }
    }
    this.torrents.set(infoHash, state);
    state.restore = this.refuse(torrent, state);
  }

  async detach(infoHash: string): Promise<void> {
    const state = this.torrents.get(infoHash);
    if (!state) {
      return;
    }
    clearTimeout(state.saveTimer);
    state.restore();
    this.torrents.delete(infoHash);
    await this.save(infoHash, state);
  }

  block(
    infoHash: string,
    address: string,
    ms: number,
    reason: string,
    keep = false,
  ): void {
    const state = this.torrents.get(infoHash);
    if (!state) {
      return;
    }
    const until = Date.now() + ms;
    const existing = state.bans.get(address);
    state.bans.set(address, {
      // A ban never shortens.
      until: Math.max(until, existing?.until ?? 0),
      reason,
      keep: keep || (existing?.keep ?? false),
    });
    // Only bans worth surviving a restart are written, and the write is
    // debounced because they arrive in bursts.
    if (keep) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        void this.save(infoHash, state);
      }, SAVE_DELAY_MS);
      state.saveTimer.unref();
    }
  }

  // Expiry is lazy. This is the only sweep, so nothing counts a ban that has
  // run out.
  count(infoHash: string): number {
    const state = this.torrents.get(infoHash);
    if (!state) {
      return 0;
    }
    const now = Date.now();
    let live = 0;
    for (const [address, ban] of state.bans) {
      if (ban.until > now) {
        live++;
      } else if (!ban.keep) {
        state.bans.delete(address);
      }
    }
    return live;
  }

  // webtorrent has no ban list, so peer intake is wrapped on the instance.
  // Deleting the override restores the prototype method.
  private refuse(torrent: SwarmTorrent, state: TorrentBans): () => void {
    const original = torrent._addPeer.bind(torrent);
    torrent._addPeer = (peer: unknown, type?: string, source?: string) => {
      if (typeof peer === 'string') {
        const ban = state.bans.get(peer);
        if (ban && ban.until > Date.now()) {
          return null;
        }
        if (ban && !ban.keep) {
          state.bans.delete(peer);
        }
      }
      return original(peer, type, source);
    };
    return () => {
      delete (torrent as Partial<SwarmTorrent>)._addPeer;
    };
  }

  private async save(infoHash: string, state: TorrentBans): Promise<void> {
    const now = Date.now();
    const keeping = Object.fromEntries(
      [...state.bans]
        .filter(([, ban]) => ban.keep && ban.until > now)
        .map(([address, ban]) => [address, ban.until]),
    );
    if (!Object.keys(keeping).length) {
      return;
    }
    await writeFileAtomic(
      this.layout.bannedFile(infoHash),
      JSON.stringify(keeping),
    ).catch((err: unknown) => {
      logger.warn('Could not save banned peers', {
        infoHash,
        error: errorMessage(err),
      });
    });
  }
}
