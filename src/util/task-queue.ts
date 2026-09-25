import { logger } from '../logger.js';

export const Priority = { Foreground: 0, Background: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

// Waiting improves a task's score by one point per interval, so an old
// task eventually beats a fresher one that scores better.
const SCORE_AGING_MS = 5000;

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
  stopIfNotPromoted?: boolean;
}

interface Entry extends TaskSpec {
  seq: number;
  queuedAt: number;
  start: () => void;
  cancel: (reason: Error) => void;
  abandonTimer?: NodeJS.Timeout;
}

interface RunningTask {
  key: string;
  priority: Priority;
  abort: AbortController;
}

export class TaskQueue {
  private readonly waiting: Entry[] = [];
  private readonly running = new Set<RunningTask>();
  private readonly backgroundLimit: number;
  private seq = 0;

  private needPromotion = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly concurrency: number,
    private readonly mustPromoteInS: number,
  ) {
    // Background work never holds more than a third of the slots, so background jobs
    // cannot starve playback.
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
    spec: TaskSpec,
    task: (context: TaskContext) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        ...spec,
        seq: this.seq++,
        queuedAt: Date.now(),
        // Cancelling a task that has not started rejects the caller's
        // promise; the task function never runs.
        cancel: reject,
        start: () => {
          const running: RunningTask = {
            key: entry.key,
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
      if (entry.priority === Priority.Background) {
        this.abandonNotPromoted(entry.key);
      }
      this.waiting.push(entry);
      this.drain();
    });
  }

  abandonNotPromoted(key: string) {
    if (!this.mustPromoteInS) {
      return;
    }

    this.stopAbandonTimer(key);
    this.needPromotion.set(
      key,
      setTimeout(() => {
        logger.debug(
          `Abandoning ${key} after ${this.mustPromoteInS * 1000} - not promoted`,
        );
        this.abandon(key);
      }, this.mustPromoteInS * 1000),
    );
  }

  refreshAbandonTimer(key: string) {
    this.needPromotion.get(key)?.refresh();
  }

  stopAbandonTimer(key: string) {
    this.needPromotion.get(key)?.close();
    this.needPromotion.delete(key);
  }

  /**
   * Raises every task under key to foreground. A task already in foreground
   * keeps the better of the two scores, so promotion never demotes it.
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
    this.stopAbandonTimer(key);
    this.drain();
  }

  /**
   * Drops queued tasks under key and aborts running ones. keepRunning demotes a
   * runner to background instead, for work whose output is still worth caching.
   */
  abandon(key: string, backgroundOnly = false): void {
    if (
      this.abandonWaiting(key, backgroundOnly) +
      this.abandonRunning(key, backgroundOnly)
    ) {
      this.stopAbandonTimer(key);
      this.drain();
    }
  }

  private abandonWaiting(key: string, backgroundOnly = false) {
    let abandonedTasks = 0;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const entry = this.waiting[i]!;
      if (shouldAbandon(entry, key, backgroundOnly)) {
        ++abandonedTasks;
        this.waiting.splice(i, 1);
        entry.cancel(new CancelledError(`Abandoned ${entry.key}`));
      }
    }
    return abandonedTasks;
  }

  private abandonRunning(key: string, backgroundOnly = false) {
    let abandonedTasks = 0;
    for (const task of this.running) {
      if (
        shouldAbandon(task, key, backgroundOnly) &&
        !task.abort.signal.aborted
      ) {
        ++abandonedTasks;
        task.abort.abort(new CancelledError(`Abandoned ${task.key}`));
      }
    }

    return abandonedTasks;
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
    let stoppingAnywhere = 0;
    for (const task of this.running) {
      if (task.abort.signal.aborted) {
        stoppingAnywhere++;
      }
    }

    for (const entry of this.waiting) {
      if (entry.priority !== Priority.Foreground) {
        continue;
      }
      if (this.running.size < this.concurrency) {
        continue;
      }

      if (stoppingAnywhere > 0) {
        stoppingAnywhere--;
        continue;
      }

      const victim = this.pickVictim();
      if (victim) {
        victim.abort.abort(new CancelledError(`Preempted ${victim.key}`));
      }
    }
  }

  // Background runners go first. Among foreground runners only one that scores
  // worse than the newcomer is taken, so equal scores do not thrash.
  private pickVictim(): RunningTask | undefined {
    for (const task of this.running) {
      if (task.abort.signal.aborted) {
        continue;
      }
      if (task.priority === Priority.Background) {
        return task;
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
    // Order: foreground first, then arrival.
    const backgroundAllowed = this.backgroundRunning() < this.backgroundLimit;
    const now = Date.now();
    const score = (entry: Entry) =>
      Math.floor((now - entry.queuedAt) / SCORE_AGING_MS);
    let best: Entry | undefined;
    let bestScore = 0;

    for (const entry of this.waiting) {
      if (entry.priority === Priority.Background && !backgroundAllowed) {
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

function shouldAbandon(
  task: Entry | RunningTask,
  key: string,
  backgroundOnly: boolean,
) {
  return (
    task.key === key &&
    (!backgroundOnly || task.priority === Priority.Background)
  );
}
