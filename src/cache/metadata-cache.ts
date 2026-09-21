import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, logger } from '../logger.js';
import { touchFile } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';
import { isSegmentFile, type CacheLayout } from './cache-layout.js';

// The magnet file's mtime carries use order across restarts. Bump it at most
// this often: every touch costs a syscall.
const MARK_INTERVAL_MS = 60_000;

/**
 * LRU over everything cached for a title except its segments: torrent
 * metadata, peers, index and playlists. Dropping a title makes the next
 * request fetch metadata again, not the media.
 */
export class MetadataCache {
  private readonly lru: SizeLru<string>;
  private readonly marked = new Map<string, number>();

  constructor(
    private readonly layout: CacheLayout,
    budgetBytes: number,
  ) {
    this.lru = new SizeLru(budgetBytes);
  }

  get usedBytes(): number {
    return this.lru.size;
  }

  note(infoHash: string, bytes: number, writtenAt: number): void {
    // A title that grows keeps its place in the order; only a new one enters at
    // the time it was written.
    if (this.lru.has(infoHash)) {
      this.lru.resize(infoHash, bytes);
    } else {
      this.lru.set(infoHash, bytes, writtenAt);
    }
  }

  touch(infoHash: string): void {
    this.lru.touch(infoHash);
    const now = Date.now();
    if (now - (this.marked.get(infoHash) ?? 0) < MARK_INTERVAL_MS) {
      return;
    }
    this.marked.set(infoHash, now);
    touchFile(this.layout.magnetFile(infoHash));
  }

  keepOnly(present: Set<string>): void {
    for (const infoHash of this.lru.keys()) {
      if (!present.has(infoHash)) {
        this.lru.delete(infoHash);
        this.marked.delete(infoHash);
      }
    }
  }

  oldestUsedAt(isPinned: (infoHash: string) => boolean): number | undefined {
    return this.lru.oldest(isPinned)?.usedAt;
  }

  trimToBudget(isPinned: (infoHash: string) => boolean): Promise<number> {
    const before = this.lru.size;
    return this.remove(this.lru.trim(isPinned), before);
  }

  evictOldest(
    bytes: number,
    isPinned: (infoHash: string) => boolean,
  ): Promise<number> {
    const before = this.lru.size;
    const target = Math.max(0, before - bytes);
    return this.remove(this.lru.trimTo(target, isPinned), before);
  }

  private async remove(infoHashes: string[], before: number): Promise<number> {
    for (const infoHash of infoHashes) {
      await this.deleteMetadata(infoHash);
      logger.info('Dropped the least recently used title', { infoHash });
    }
    return before - this.lru.size;
  }

  // Leaves numbered segments behind for SegmentCache to account for and evict.
  private async deleteMetadata(infoHash: string): Promise<void> {
    const drop = async (file: string): Promise<void> => {
      await rm(file, { force: true, recursive: true }).catch((err: unknown) => {
        logger.warn('Could not delete cached metadata', {
          file,
          error: errorMessage(err),
        });
      });
    };

    await drop(this.layout.torrentDir(infoHash));
    const media = path.join(this.layout.hlsDir, infoHash);
    const entries = await readdir(media, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && !isSegmentFile(entry.name)) {
        await drop(path.join(entry.parentPath, entry.name));
      }
    }
  }
}
