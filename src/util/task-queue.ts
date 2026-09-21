export const Priority = { Foreground: 0, Background: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

// Waiting improves a task's score by one rank point per interval, so an old
// task eventually beats a fresher one that ranks better.
const RANK_AGING_MS = 5000;

// Rank for work a player is blocked on. Below any rank derived from distance
// to the playhead, so it outranks everything computed.
export const CRITICAL_RANK = -1_000_000;

export class CancelledError extends Error {
  override name = 'CancelledError';
}

export interface TaskContext {
  signal: AbortSignal;
  waitedMs: number;
}

/**
 * key groups tasks for promote() and abandon(); group caps how much work one
 * torrent may run at once.
 */
export interface TaskSpec {
  key: string;
  priority: Priority;
  group: string;
  rank?: Rank;
}

/**
 * Lower wins. A function is re-read on every scheduling pass, so a task's rank
 * can follow a moving playhead.
 */
export type Rank = number | (() => number);

const rankOf = (rank: Rank | undefined): (() => number) =>
  typeof rank === 'function' ? rank : () => rank ?? 0;

interface Entry extends Omit<TaskSpec, 'rank'> {
  rank: () => number;
  seq: number;
  queuedAt: number;
  start: () => void;
  cancel: (reason: Error) => void;
}

interface RunningTask {
  key: string;
  group: string;
  priority: Priority;
  rank: () => number;
  abort: AbortController;
}

export class TaskQueue {
  private readonly waiting: Entry[] = [];
  private readonly running = new Set<RunningTask>();
  private readonly backgroundLimit: number;
  private readonly groupLimit: number;
  private seq = 0;

  constructor(
    private readonly concurrency: number,
    groupLimit = concurrency,
  ) {
    // Background work never holds more than a third of the slots, so prefetch
    // cannot starve playback.
    this.backgroundLimit = Math.max(1, Math.floor(concurrency / 3));
    this.groupLimit = Math.max(1, Math.min(groupLimit, concurrency));
  }

  get stats() {
    return {
      running: this.running.size,
      runningBackground: this.backgroundRunning(),
      queued: this.waiting.length,
    };
  }

  run<T>(
    spec: TaskSpec,
    task: (context: TaskContext) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        ...spec,
        rank: rankOf(spec.rank),
        seq: this.seq++,
        queuedAt: Date.now(),
        // Cancelling a task that has not started rejects the caller's
        // promise; the task function never runs.
        cancel: reject,
        start: () => {
          const running: RunningTask = {
            key: entry.key,
            group: entry.group,
            priority: entry.priority,
            rank: entry.rank,
            abort: new AbortController(),
          };
          this.running.add(running);

          Promise.resolve()
            .then(() =>
              task({
                signal: running.abort.signal,
                waitedMs: Date.now() - entry.queuedAt,
              }),
            )
            .then(resolve, reject)
            .finally(() => {
              this.running.delete(running);
              this.drain();
            });
        },
      };
      this.waiting.push(entry);
      this.drain();
    });
  }

  /**
   * Raises every task under key to foreground. A task already in foreground
   * keeps the better of the two ranks, so promotion never demotes it.
   */
  promote(key: string, rank: Rank = 0): void {
    const next = rankOf(rank);
    for (const entry of this.waiting) {
      if (entry.key === key) {
        const previous = entry.rank;
        entry.rank =
          entry.priority === Priority.Foreground
            ? () => Math.min(previous(), next())
            : next;
        entry.priority = Priority.Foreground;
      }
    }
    for (const task of this.running) {
      if (task.key === key) {
        const previous = task.rank;
        task.rank =
          task.priority === Priority.Foreground
            ? () => Math.min(previous(), next())
            : next;
        task.priority = Priority.Foreground;
      }
    }
    this.drain();
  }

  /**
   * Drops queued tasks under key and aborts running ones. keepRunning demotes a
   * runner to background instead, for work whose output is still worth caching.
   */
  abandon(key: string, keepRunning = false): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const entry = this.waiting[i]!;
      if (entry.key === key) {
        this.waiting.splice(i, 1);
        entry.cancel(new CancelledError(`Abandoned ${entry.key}`));
      }
    }
    for (const task of this.running) {
      if (task.key !== key) {
        continue;
      }
      if (keepRunning) {
        task.priority = Priority.Background;
      } else if (!task.abort.signal.aborted) {
        task.abort.abort(new CancelledError(`Abandoned ${task.key}`));
      }
    }
    this.drain();
  }

  cancelBackground(predicate: (key: string) => boolean): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const entry = this.waiting[i]!;
      if (entry.priority === Priority.Background && predicate(entry.key)) {
        this.waiting.splice(i, 1);
        entry.cancel(new CancelledError(`Cancelled ${entry.key}`));
      }
    }
  }

  private drain(): void {
    while (this.running.size < this.concurrency) {
      const next = this.pickNext();
      if (!next) {
        break;
      }
      this.waiting.splice(this.waiting.indexOf(next), 1);
      next.start();
    }
    this.preempt();
  }

  // Slots that are already draining count against waiting demand, so two
  // foreground tasks never abort three runners between them.
  private preempt(): void {
    const stopping = new Map<string, number>();
    let stoppingAnywhere = 0;
    for (const task of this.running) {
      if (task.abort.signal.aborted) {
        stopping.set(task.group, (stopping.get(task.group) ?? 0) + 1);
        stoppingAnywhere++;
      }
    }

    for (const entry of this.waiting) {
      if (entry.priority !== Priority.Foreground) {
        continue;
      }
      const sameGroup = this.groupRunning(entry.group) >= this.groupLimit;
      if (!sameGroup && this.running.size < this.concurrency) {
        continue;
      }

      const freeing = sameGroup
        ? (stopping.get(entry.group) ?? 0)
        : stoppingAnywhere;
      if (freeing > 0) {
        if (sameGroup) {
          stopping.set(entry.group, freeing - 1);
        }
        stoppingAnywhere--;
        continue;
      }

      const victim = this.pickVictim(
        sameGroup ? entry.group : undefined,
        entry.rank(),
      );
      if (victim) {
        victim.abort.abort(new CancelledError(`Preempted ${victim.key}`));
      }
    }
  }

  // Background runners go first. Among foreground runners only one that ranks
  // worse than the newcomer is taken, so equal ranks do not thrash.
  private pickVictim(
    group: string | undefined,
    rank: number,
  ): RunningTask | undefined {
    let lookAhead: RunningTask | undefined;
    let lookAheadRank = rank;
    for (const task of this.running) {
      if (task.abort.signal.aborted) {
        continue;
      }
      if (group !== undefined && task.group !== group) {
        continue;
      }
      if (task.priority === Priority.Background) {
        return task;
      }
      if (group !== undefined) {
        const taskRank = task.rank();
        if (taskRank > lookAheadRank) {
          lookAhead = task;
          lookAheadRank = taskRank;
        }
      }
    }
    return lookAhead;
  }

  private groupRunning(group: string): number {
    let count = 0;
    for (const task of this.running) {
      if (task.group === group) {
        count++;
      }
    }
    return count;
  }

  private backgroundRunning(): number {
    let count = 0;
    for (const task of this.running) {
      if (task.priority === Priority.Background) {
        count++;
      }
    }
    return count;
  }

  private pickNext(): Entry | undefined {
    // Order: foreground first, then lowest aged score, then arrival.
    const backgroundAllowed = this.backgroundRunning() < this.backgroundLimit;
    const groupUse = new Map<string, number>();
    const now = Date.now();
    const score = (entry: Entry) =>
      entry.rank() - (now - entry.queuedAt) / RANK_AGING_MS;
    let best: Entry | undefined;
    let bestScore = 0;

    for (const entry of this.waiting) {
      if (entry.priority === Priority.Background && !backgroundAllowed) {
        continue;
      }
      let used = groupUse.get(entry.group);
      if (used === undefined) {
        used = this.groupRunning(entry.group);
        groupUse.set(entry.group, used);
      }
      if (used >= this.groupLimit) {
        continue;
      }
      const entryScore = score(entry);
      if (
        !best ||
        entry.priority < best.priority ||
        (entry.priority === best.priority &&
          (entryScore < bestScore ||
            (entryScore === bestScore && entry.seq < best.seq)))
      ) {
        best = entry;
        bestScore = entryScore;
      }
    }
    return best;
  }
}
