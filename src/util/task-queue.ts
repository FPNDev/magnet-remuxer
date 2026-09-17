export const Priority = { Foreground: 0, Background: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/**
 * How long a queued task waits to be treated as one rank more urgent. Ranks
 * order players by need, and aging keeps that from starving anyone: a request
 * that has waited long enough goes first whatever its rank.
 */
const RANK_AGING_MS = 5000;

export class CancelledError extends Error {
  override name = 'CancelledError';
}

export interface TaskContext {
  /** Aborted when foreground work needs this background task's slot. */
  signal: AbortSignal;
  /** How long the task sat in the queue before starting. */
  waitedMs: number;
}

export interface TaskSpec {
  /** What the task produces; only one task per key runs at a time upstream. */
  key: string;
  priority: Priority;
  group: string;
  /**
   * Order within a priority, lower first: how far ahead of what a player needs
   * right now this task is. A function is asked again each time the queue picks
   * what runs next, so it follows requests that arrive late or finish meanwhile.
   * Defaults to 0.
   */
  rank?: Rank;
}

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

/**
 * Runs async tasks with a concurrency limit. Foreground work goes first, only a
 * third of the slots may hold background work, and a waiting foreground task
 * preempts a running background one: prefetching must never make a player wait.
 * No group may hold more than `groupLimit` slots.
 */
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
   * Moves tasks with `key` to the foreground at `rank`, or to a more urgent rank
   * if they are already there - two players can want the same task for
   * different reasons, and the more pressing one counts.
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
   * Nobody is waiting for `key`: queued, it is dropped; running, it is stopped,
   * since a read nobody wants still splits the torrent's bandwidth. With
   * `keepRunning` a running task is demoted to background work instead.
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

  /** Drops queued (not yet running) background tasks matching `predicate`. */
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

  /**
   * Stops running work so waiting foreground work can start: background work
   * first, then look-ahead that is less urgent than what waits. Tasks start as
   * soon as a slot is free, so a player's look-ahead can take a torrent's slots
   * a few milliseconds before the segment its first frame needs arrives - this
   * is what gives them back.
   */
  private preempt(): void {
    // A task already told to stop still holds its slot until it settles. That
    // slot is spoken for, so no second task is stopped to free it again.
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
      // Either the pool is full or this task's own group is, and only a task in
      // that group frees the slot it is waiting for.
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

  /**
   * Background work anywhere in scope; failing that, within the group, the least
   * urgent foreground task that is less urgent than `rank`. Look-ahead only ever
   * yields to its own torrent: stopping it frees bandwidth, not just a slot.
   */
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
    const backgroundAllowed = this.backgroundRunning() < this.backgroundLimit;
    const groupUse = new Map<string, number>();
    const now = Date.now();
    // Equal ranks come out oldest first, so this is plain FIFO until ranks differ.
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
