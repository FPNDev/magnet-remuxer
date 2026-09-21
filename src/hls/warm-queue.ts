import { errorMessage, logger } from '../logger.js';

// Warming is speculative, so the backlog is bounded and further requests
// are refused rather than held.
const MAX_BACKLOG = 256;

export interface WarmRequest {
  infoHash: string;
  fileIndex: number | undefined;
}

export interface WarmQueueOptions {
  concurrency: number;
  warm: (infoHash: string, fileIndex: number | undefined) => Promise<void>;
}

export class WarmQueue {
  private readonly backlog: WarmRequest[] = [];
  private readonly running = new Set<string>();

  constructor(private readonly options: WarmQueueOptions) {}

  get pending(): number {
    return this.backlog.length;
  }

  knows(infoHash: string, fileIndex: number | undefined): boolean {
    const key = warmKey(infoHash, fileIndex);
    return (
      this.running.has(key) ||
      this.backlog.some(
        (entry) => warmKey(entry.infoHash, entry.fileIndex) === key,
      )
    );
  }

  get full(): boolean {
    return this.backlog.length >= MAX_BACKLOG;
  }

  request(infoHash: string, fileIndex: number | undefined): boolean {
    if (this.knows(infoHash, fileIndex)) {
      return false;
    }
    if (this.full) {
      logger.debug('Warm backlog is full; refused a title', { infoHash });
      return false;
    }
    this.backlog.push({ infoHash, fileIndex });
    this.pump();
    return true;
  }

  private pump(): void {
    while (
      this.running.size < this.options.concurrency &&
      this.backlog.length
    ) {
      const next = this.backlog.shift()!;
      const key = warmKey(next.infoHash, next.fileIndex);
      this.running.add(key);
      this.options
        .warm(next.infoHash, next.fileIndex)
        .catch((err: unknown) => {
          // A warm failure costs a cold first play and nothing else.
          logger.warn('Could not warm a title', {
            infoHash: next.infoHash,
            error: errorMessage(err),
          });
        })
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
    }
  }
}

// An undefined fileIndex means the largest file in the torrent.
export function warmKey(
  infoHash: string,
  fileIndex: number | undefined,
): string {
  return `${infoHash}/${fileIndex ?? 'largest'}`;
}
