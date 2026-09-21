import path from 'node:path';

const HEAD_TTL_MS = 60_000;
// A request for segment n this soon after n-1 is one player moving
// forward, so the old head is replaced instead of counted twice.
const SAME_PLAYER_MS = 15_000;
const LOOKAHEAD_SEGMENTS = 8;

export type SegmentNamer = (n: number) => string;

/**
 * Counts who is waiting for which segment and how far each player has got.
 * Remux work is ordered from this.
 */
export class Playheads {
  private readonly demand = new Map<string, number>();
  private readonly heads = new Map<string, Map<number, number>>();
  private sweptAt = 0;
  private readonly now: () => number;
  private readonly onIdle: (dir: string) => void;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(
    options: {
      now?: () => number;
      onIdle?: (dir: string) => void;
      autoExpire?: boolean;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onIdle = options.onIdle ?? (() => {});
    if (options.autoExpire) {
      this.timer = setInterval(
        () => this.expire(this.now() - HEAD_TTL_MS),
        HEAD_TTL_MS,
      );
      this.timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  want(key: string): void {
    this.demand.set(key, (this.demand.get(key) ?? 0) + 1);
  }

  // True when the last waiter left, so the caller can stop the work.
  release(key: string): boolean {
    const remaining = (this.demand.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.demand.set(key, remaining);
      return false;
    }
    this.demand.delete(key);
    return true;
  }

  waiting(key: string): boolean {
    return this.demand.has(key);
  }

  mark(dir: string, n: number): void {
    let heads = this.heads.get(dir);
    if (!heads) {
      heads = new Map();
      this.heads.set(dir, heads);
    }
    const now = this.now();
    const previous = heads.get(n - 1);
    if (previous !== undefined && now - previous <= SAME_PLAYER_MS) {
      heads.delete(n - 1);
    }
    heads.set(n, now);

    if (now - this.sweptAt > HEAD_TTL_MS) {
      this.sweptAt = now;
      this.expire(now - HEAD_TTL_MS);
    }
  }

  private expire(cutoff: number): void {
    const empty: string[] = [];
    for (const [dir, heads] of this.heads) {
      for (const [n, seen] of heads) {
        if (seen < cutoff) {
          heads.delete(n);
        }
      }
      if (heads.size === 0) {
        empty.push(dir);
      }
    }
    for (const dir of empty) {
      this.heads.delete(dir);
      this.onIdle(dir);
    }
  }

  live(dir: string): number[] {
    const heads = this.heads.get(dir);
    if (!heads) {
      return [];
    }
    const cutoff = this.now() - HEAD_TTL_MS;
    for (const [n, seen] of heads) {
      if (seen < cutoff) {
        heads.delete(n);
      }
    }
    if (heads.size === 0) {
      this.heads.delete(dir);
      return [];
    }
    return [...heads.keys()];
  }

  // Rank is the unbroken run of earlier segments players are already waiting
  // on, so a stalled player outranks a lone request.
  urgency(dir: string, name: SegmentNamer, n: number): number {
    const prefix = keyPrefix(dir);
    let rank = 0;
    while (
      rank < LOOKAHEAD_SEGMENTS &&
      n - rank - 1 >= 0 &&
      this.demand.has(prefix + name(n - rank - 1))
    ) {
      rank++;
    }
    return rank;
  }

  isAhead(dir: string, n: number, depth: number): boolean {
    return this.live(dir).some((head) => head < n && n <= head + depth);
  }

  // The prefetch window is the next depth segments after every live playhead
  // plus the segment just asked for.
  window(
    dir: string,
    name: SegmentNamer,
    n: number,
    depth: number,
    lastSegment: number,
  ): Set<string> {
    const prefix = keyPrefix(dir);
    const keep = new Set<string>();
    for (const head of [...this.live(dir), n]) {
      for (let k = head; k <= Math.min(lastSegment, head + depth); k++) {
        keep.add(prefix + name(k));
      }
    }
    return keep;
  }
}

export function keyPrefix(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}
