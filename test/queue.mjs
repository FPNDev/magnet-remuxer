// The job queue: priority, the background cap, preemption and cancellation.
import { CancelledError, Priority, TaskQueue } from '../dist/util/task-queue.js';
import { check, failureCount, section } from './lib.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms, label) =>
  Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error(`${label} did not settle within ${ms}ms`);
    }),
  ]);

section('job queue');

// Background work never fills every slot, and foreground work goes first.
{
  const queue = new TaskQueue(3); // a third of 3 slots may hold background work
  const started = [];
  const finish = [];
  const hold = (key, priority) =>
    queue
      .run(key, priority, async () => {
        started.push(key);
        await new Promise((resolve) => finish.push(resolve));
      })
      .catch(() => {});

  hold('bg1', Priority.Background);
  hold('bg2', Priority.Background);
  hold('bg3', Priority.Background);
  await wait(20);
  check(
    started.join(',') === 'bg1',
    'only a third of the slots take background work',
    started.join(',') || '(none started)',
  );

  hold('fg1', Priority.Foreground);
  hold('fg2', Priority.Foreground);
  await wait(20);
  check(
    started.includes('fg1') && started.includes('fg2'),
    'players start while prefetching waits',
    started.join(','),
  );
  finish.forEach((resolve) => resolve());
}

// A waiting player aborts running prefetch instead of queueing behind it.
{
  const queue = new TaskQueue(1);
  let aborted = false;
  const background = queue
    .run('bg', Priority.Background, async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
      aborted = true;
      throw signal.reason;
    })
    .catch((err) => err);

  await wait(20);
  const foreground = await within(
    queue.run('fg', Priority.Foreground, async ({ waitedMs }) => waitedMs),
    5000,
    'preempted foreground task',
  ).catch((err) => err);

  check(aborted, 'a waiting player preempts running prefetch');
  check(typeof foreground === 'number', 'the player runs once the slot is freed', String(foreground));
  check(
    (await background) instanceof CancelledError,
    'the preempted task rejects with CancelledError',
  );
}

// Seeking away drops prefetches that are still queued.
{
  const queue = new TaskQueue(1);
  const blocker = queue.run('block', Priority.Foreground, () => wait(100));
  const dropped = queue
    .run('drop', Priority.Background, async () => 'ran')
    .catch((err) => err);

  queue.cancelBackground((key) => key === 'drop');
  check(
    (await within(dropped, 2000, 'cancelled task')) instanceof CancelledError,
    'queued prefetch is cancelled after a seek',
  );
  await blocker;
}

process.exit(failureCount() ? 1 : 0);
