import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, logger } from '../logger.js';
import { TEMP_SUFFIX } from '../util/fs.js';
import { SizeLru } from '../util/lru.js';

const SEGMENT_FILE = /^\d+\.(m4s|vtt)$/;

/**
 * Keeps rendered media segments under a disk budget, deleting the least
 * recently served ones. Playlists, indexes and init segments are tiny and are
 * never evicted.
 */
export class SegmentCache {
  private readonly lru: SizeLru<string>;

  constructor(
    private readonly root: string,
    budgetBytes: number,
  ) {
    this.lru = new SizeLru(budgetBytes);
  }

  get usedBytes(): number {
    return this.lru.size;
  }

  /** Registers segments left by a previous run and removes abandoned temp files. */
  async load(): Promise<void> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    const segments: { file: string; bytes: number; mtimeMs: number }[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const file = path.join(entry.parentPath, entry.name);
      if (entry.name.endsWith(TEMP_SUFFIX)) {
        await rm(file, { force: true });
      } else if (SEGMENT_FILE.test(entry.name)) {
        const { size, mtimeMs } = await stat(file);
        segments.push({ file, bytes: size, mtimeMs });
      }
    }

    segments.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { file, bytes } of segments) {
      this.lru.set(file, bytes);
    }
    await this.trim();
    logger.info('Segment cache loaded', { segments: segments.length, bytes: this.lru.size });
  }

  async added(file: string): Promise<void> {
    const { size } = await stat(file);
    this.lru.set(file, size);
    await this.trim();
  }

  touch(file: string): void {
    this.lru.touch(file);
  }

  private async trim(): Promise<void> {
    for (const file of this.lru.trim()) {
      await rm(file, { force: true }).catch((err: unknown) => {
        logger.warn('Could not delete evicted segment', { file, error: errorMessage(err) });
      });
    }
  }
}
