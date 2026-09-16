// The job queue: priority, the background cap, preemption and cancellation.
import {
  CancelledError,
  Priority,
  TaskQueue,
} from '../dist/util/task-queue.js';
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
      .run({ key, priority, group: 't' }, async () => {
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
    .run(
      { key: 'bg', priority: Priority.Background, group: 't' },
      async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        aborted = true;
        throw signal.reason;
      },
    )
    .catch((err) => err);

  await wait(20);
  const foreground = await within(
    queue.run(
      { key: 'fg', priority: Priority.Foreground, group: 't' },
      async ({ waitedMs }) => waitedMs,
    ),
    5000,
    'preempted foreground task',
  ).catch((err) => err);

  check(aborted, 'a waiting player preempts running prefetch');
  check(
    typeof foreground === 'number',
    'the player runs once the slot is freed',
    String(foreground),
  );
  check(
    (await background) instanceof CancelledError,
    'the preempted task rejects with CancelledError',
  );
}

// Seeking away drops prefetches that are still queued.
{
  const queue = new TaskQueue(1);
  const blocker = queue.run(
    { key: 'block', priority: Priority.Foreground, group: 't' },
    () => wait(100),
  );
  const dropped = queue
    .run(
      { key: 'drop', priority: Priority.Background, group: 't' },
      async () => 'ran',
    )
    .catch((err) => err);

  queue.cancelBackground((key) => key === 'drop');
  check(
    (await within(dropped, 2000, 'cancelled task')) instanceof CancelledError,
    'queued prefetch is cancelled after a seek',
  );
  await blocker;
}

// One torrent never gets more than its share of the pool, however many players
// ask at once: peers deliver a fixed number of bytes per second, so reads that
// compete only make each other slower.
{
  const queue = new TaskQueue(8, 2); // 8 slots, at most 2 per torrent
  const started = [];
  const finish = [];
  const hold = (key, group) =>
    queue
      .run({ key, priority: Priority.Foreground, group }, async () => {
        started.push(key);
        await new Promise((resolve) => finish.push(resolve));
      })
      .catch(() => {});

  for (let i = 1; i <= 4; i++) {
    hold(`a${i}`, 'torrentA');
  }
  for (let i = 1; i <= 4; i++) {
    hold(`b${i}`, 'torrentB');
  }
  await wait(20);

  check(
    started.join(',') === 'a1,a2,b1,b2',
    'one torrent takes only its share, and another still runs',
    started.join(',') || '(none started)',
  );

  finish.shift()();
  await wait(20);
  check(
    started.includes('a3') && !started.includes('a4'),
    'a freed slot goes to the next read of the same torrent',
    started.join(','),
  );
  finish.forEach((resolve) => resolve());
}

// Prefetch for a position the player has left keeps hold of the torrent, so a
// waiting player has to be able to take its slot back.
{
  const queue = new TaskQueue(8, 1);
  let aborted = false;
  const prefetch = queue
    .run(
      { key: 'old', priority: Priority.Background, group: 'torrentA' },
      async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        aborted = true;
        throw signal.reason;
      },
    )
    .catch((err) => err);

  await wait(20);
  const seek = await within(
    queue.run(
      { key: 'seek', priority: Priority.Foreground, group: 'torrentA' },
      async ({ waitedMs }) => waitedMs,
    ),
    5000,
    'foreground task behind a full group',
  ).catch((err) => err);

  check(
    aborted,
    'a player preempts prefetch holding its torrent, with the pool half empty',
  );
  check(
    typeof seek === 'number',
    'the player runs once that slot is freed',
    String(seek),
  );
  check(
    (await prefetch) instanceof CancelledError,
    'the preempted prefetch rejects with CancelledError',
  );
}

process.exit(failureCount() ? 1 : 0);
