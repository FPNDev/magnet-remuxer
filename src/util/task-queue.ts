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

interface Entry {
  key: string;
  priority: Priority;
  seq: number;
  queuedAt: number;
  start: () => void;
  cancel: (reason: Error) => void;
}

interface RunningTask {
  key: string;
  priority: Priority;
  abort: AbortController;
}

/**
 * Runs async tasks with a concurrency limit. Foreground work goes first, only a
 * third of the slots may hold background work, and a waiting foreground task
 * preempts a running background one: prefetching must never make a player wait.
 */
export class TaskQueue {
  private readonly waiting: Entry[] = [];
  private readonly running = new Set<RunningTask>();
  private readonly backgroundLimit: number;
  private seq = 0;

  constructor(private readonly concurrency: number) {
    this.backgroundLimit = Math.max(1, Math.floor(concurrency / 3));
  }

  get stats() {
    return {
      running: this.running.size,
      runningBackground: this.backgroundRunning(),
      queued: this.waiting.length,
    };
  }

  run<T>(
    key: string,
    priority: Priority,
    task: (context: TaskContext) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        key,
        priority,
        seq: this.seq++,
        queuedAt: Date.now(),
        cancel: reject,
        start: () => {
          const running: RunningTask = {
            key,
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

  /** Moves queued tasks with `key` to the foreground. */
  promote(key: string): void {
    for (const entry of this.waiting) {
      if (entry.key === key) {
        entry.priority = Priority.Foreground;
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
    let needed = 0;
    for (const entry of this.waiting) {
      if (entry.priority === Priority.Foreground) {
        needed++;
      }
    }

    for (const task of this.running) {
      if (needed === 0) {
        break;
      }
      if (task.priority === Priority.Background && !task.abort.signal.aborted) {
        task.abort.abort(new CancelledError(`Preempted ${task.key}`));
        needed--;
      }
    }
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
    let best: Entry | undefined;

    for (const entry of this.waiting) {
      if (entry.priority === Priority.Background && !backgroundAllowed) {
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
