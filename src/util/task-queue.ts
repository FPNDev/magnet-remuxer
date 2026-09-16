export const Priority = { Foreground: 0, Background: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

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
}

interface Entry extends TaskSpec {
  seq: number;
  queuedAt: number;
  start: () => void;
  cancel: (reason: Error) => void;
}

interface RunningTask {
  key: string;
  group: string;
  priority: Priority;
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
        seq: this.seq++,
        queuedAt: Date.now(),
        cancel: reject,
        start: () => {
          const running: RunningTask = {
            key: entry.key,
            group: entry.group,
            priority: entry.priority,
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
   * Moves tasks with `key` to the foreground
   */
  promote(key: string): void {
    for (const entry of this.waiting) {
      if (entry.key === key) {
        entry.priority = Priority.Foreground;
      }
    }
    for (const task of this.running) {
      if (task.key === key) {
        task.priority = Priority.Foreground;
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

  /** Aborts background tasks so waiting foreground work can start. */
  private preempt(): void {
    for (const entry of this.waiting) {
      if (entry.priority !== Priority.Foreground) {
        continue;
      }
      // Either the pool is full or this task's own group is, and only a
      // background task in that group frees the slot it is waiting for.
      const sameGroup = this.groupRunning(entry.group) >= this.groupLimit;
      if (!sameGroup && this.running.size < this.concurrency) {
        continue;
      }

      const victim = this.pickVictim(sameGroup ? entry.group : undefined);
      if (victim) {
        victim.abort.abort(new CancelledError(`Preempted ${victim.key}`));
      }
    }
  }

  private pickVictim(group: string | undefined): RunningTask | undefined {
    for (const task of this.running) {
      if (task.priority !== Priority.Background || task.abort.signal.aborted) {
        continue;
      }
      if (group === undefined || task.group === group) {
        return task;
      }
    }
    return undefined;
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
    let best: Entry | undefined;

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
      if (
        !best ||
        entry.priority < best.priority ||
        (entry.priority === best.priority && entry.seq < best.seq)
      ) {
        best = entry;
      }
    }
    return best;
  }
}
