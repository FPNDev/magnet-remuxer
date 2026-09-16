export const Priority = { Foreground: 0, Background: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export class CancelledError extends Error {
  override name = 'CancelledError';
}

interface Entry {
  key: string;
  priority: Priority;
  seq: number;
  start: () => void;
  cancel: (reason: Error) => void;
}

/**
 * Runs async tasks with a concurrency limit. Foreground tasks go first, and a
 * share of the slots is kept free of background work so players never wait
 * behind prefetching.
 */
export class TaskQueue {
  private readonly waiting: Entry[] = [];
  private readonly backgroundLimit: number;
  private foreground = 0;
  private background = 0;
  private seq = 0;

  constructor(private readonly concurrency: number) {
    this.backgroundLimit = Math.max(1, Math.floor(concurrency * 0.75));
  }

  get stats() {
    return {
      running: this.foreground + this.background,
      runningBackground: this.background,
      queued: this.waiting.length,
    };
  }

  run<T>(key: string, priority: Priority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        key,
        priority,
        seq: this.seq++,
        cancel: reject,
        start: () => {
          const isBackground = entry.priority === Priority.Background;
          if (isBackground) this.background++;
          else this.foreground++;

          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              if (isBackground) this.background--;
              else this.foreground--;
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
      if (entry.key === key) entry.priority = Priority.Foreground;
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
    while (this.foreground + this.background < this.concurrency) {
      const next = this.pickNext();
      if (!next) return;
      this.waiting.splice(this.waiting.indexOf(next), 1);
      next.start();
    }
  }

  private pickNext(): Entry | undefined {
    const backgroundAllowed = this.background < this.backgroundLimit;
    let best: Entry | undefined;
    for (const entry of this.waiting) {
      if (entry.priority === Priority.Background && !backgroundAllowed) continue;
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
