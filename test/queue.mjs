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

// Scrubbing abandons requests faster than they can run. Whatever they left in
// the queue has to go, or the segment the player actually stops on ends up
// behind a queue it will never reach the front of.
{
  const queue = new TaskQueue(8, 1);
  const blocker = queue.run(
    { key: 'busy', priority: Priority.Foreground, group: 't' },
    () => wait(150),
  );

  const scrubbed = [];
  for (let i = 0; i < 20; i++) {
    scrubbed.push(
      queue
        .run(
          { key: `scrub-${i}`, priority: Priority.Foreground, group: 't' },
          async () => 'ran',
        )
        .catch((err) => err),
    );
  }
  await wait(20);
  check(queue.stats.queued === 20, 'a scrub fills the queue', String(queue.stats.queued));

  for (let i = 0; i < 20; i++) {
    queue.abandon(`scrub-${i}`);
  }
  check(
    queue.stats.queued === 0,
    'abandoning empties it again',
    String(queue.stats.queued),
  );
  check(
    (await within(Promise.all(scrubbed), 2000, 'abandoned tasks')).every(
      (result) => result instanceof CancelledError,
    ),
    'every abandoned request rejects rather than hanging',
  );

  const landed = await within(
    queue.run(
      { key: 'landed', priority: Priority.Foreground, group: 't' },
      async ({ waitedMs }) => waitedMs,
    ),
    2000,
    'the segment the player stopped on',
  );
  check(
    landed < 1000,
    'the segment the player stopped on runs next, not last',
    `waited ${landed}ms`,
  );
  await blocker;
}

// A running job nobody waits for stops: on a torrent it would go on dividing the
// swarm's bandwidth with every read that is wanted, slot or no slot.
{
  const queue = new TaskQueue(8, 2);
  const running = queue
    .run(
      { key: 'gone', priority: Priority.Foreground, group: 't' },
      async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
          setTimeout(resolve, 2000);
        });
        if (signal.aborted) {
          throw signal.reason;
        }
        return 'ran to completion';
      },
    )
    .catch((err) => err);

  await wait(20);
  queue.abandon('gone');
  const result = await within(running, 500, 'abandoned running job');
  check(
    result instanceof CancelledError,
    'abandoning a running job stops it, even with slots to spare',
    String(result),
  );
}

// Unless the work still has a purpose - a segment some other playhead is heading
// for. Then it carries on as background work, unless someone needs the slot.
{
  const queue = new TaskQueue(8, 1);
  let finished = false;
  const running = queue
    .run(
      { key: 'left', priority: Priority.Foreground, group: 't' },
      async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
          setTimeout(resolve, 100);
        });
        if (signal.aborted) {
          throw signal.reason;
        }
        finished = true;
        return 'done';
      },
    )
    .catch((err) => err);

  await wait(20);
  queue.abandon('left', true);
  check(
    queue.stats.running === 1 && queue.stats.runningBackground === 1,
    'a running job outlives its request as background work',
    JSON.stringify(queue.stats),
  );
  check(
    (await within(running, 2000, 'demoted job')) === 'done' && finished,
    'and finishes if nothing else wants the slot',
  );
}

// ...but yields it the moment someone does.
{
  const queue = new TaskQueue(8, 1);
  const running = queue
    .run(
      { key: 'left', priority: Priority.Foreground, group: 't' },
      async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        throw signal.reason;
      },
    )
    .catch((err) => err);

  await wait(20);
  queue.abandon('left', true);
  const waited = await within(
    queue.run(
      { key: 'next', priority: Priority.Foreground, group: 't' },
      async ({ waitedMs }) => waitedMs,
    ),
    5000,
    'the next player behind an abandoned job',
  );
  check(
    typeof waited === 'number',
    'an abandoned job gives up its slot to a waiting player',
    `waited ${waited}ms`,
  );
  check(
    (await running) instanceof CancelledError,
    'and is preempted like the background work it became',
  );
}

// A player that comes back to a segment it abandoned takes the job back with it.
{
  const queue = new TaskQueue(8, 1);
  const running = queue
    .run(
      { key: 'again', priority: Priority.Foreground, group: 't' },
      async ({ signal }) => {
        await wait(80);
        return signal.aborted ? 'aborted' : 'done';
      },
    )
    .catch((err) => err);

  await wait(20);
  queue.abandon('again', true);
  queue.promote('again');
  check(
    queue.stats.runningBackground === 0,
    'promoting an abandoned job makes it foreground again',
    JSON.stringify(queue.stats),
  );

  const rival = queue
    .run(
      { key: 'rival', priority: Priority.Foreground, group: 't' },
      async () => 'ran',
    )
    .catch((err) => err);
  check(
    (await within(running, 2000, 'reclaimed job')) === 'done',
    'so a rival player no longer preempts it',
  );
  await rival;
}

// Players' requests go by how far ahead of their playhead they are: one viewer's
// look-ahead must not keep another from the segment it needs next.
{
  const queue = new TaskQueue(8, 1);
  const order = [];
  let release;
  const blocker = queue.run(
    { key: 'busy', priority: Priority.Foreground, group: 't' },
    () => new Promise((resolve) => (release = resolve)),
  );
  const ask = (key, rank) =>
    queue.run({ key, priority: Priority.Foreground, group: 't', rank }, async () => {
      order.push(key);
    });

  const asked = [ask('a+3', 2), ask('a+2', 1), ask('a+1', 0), ask('b', 0)];
  await wait(20);
  release();
  await blocker;
  await Promise.all(asked);
  check(
    order.join(',') === 'a+1,b,a+2,a+3',
    'every player gets its next segment before anyone gets look-ahead',
    order.join(','),
  );
}

// ...but a rank only buys so much: whatever has waited long enough goes first.
{
  const realNow = Date.now;
  const start = realNow();
  let offset = 0;
  Date.now = () => start + offset;
  try {
    const queue = new TaskQueue(8, 1);
    const order = [];
    let release;
    const blocker = queue.run(
      { key: 'busy', priority: Priority.Foreground, group: 't' },
      () => new Promise((resolve) => (release = resolve)),
    );
    const ask = (key, rank) =>
      queue.run({ key, priority: Priority.Foreground, group: 't', rank }, async () => {
        order.push(key);
      });

    const old = ask('waited', 2);
    offset = 11_000; // two ranks' worth of waiting, and then some
    const fresh = ask('fresh', 0);
    await wait(20); // real time; the queue only sees the stubbed clock
    release();
    await blocker;
    await Promise.all([old, fresh]);
    check(
      order.join(',') === 'waited,fresh',
      'look-ahead that has waited long enough is not starved',
      order.join(','),
    );
  } finally {
    Date.now = realNow;
  }
}

// A task wanted for two reasons takes the more urgent one.
{
  const queue = new TaskQueue(8, 1);
  const order = [];
  let release;
  const blocker = queue.run(
    { key: 'busy', priority: Priority.Foreground, group: 't' },
    () => new Promise((resolve) => (release = resolve)),
  );
  const ask = (key, priority, rank) =>
    queue.run({ key, priority, group: 't', rank }, async () => {
      order.push(key);
    });

  const asked = [
    ask('other', Priority.Foreground, 1),
    ask('shared', Priority.Foreground, 3),
  ];
  queue.promote('shared', 0);
  queue.promote('shared', 2);
  await wait(20);
  release();
  await blocker;
  await Promise.all(asked);
  check(
    order.join(',') === 'shared,other',
    'promoting keeps the most urgent rank anyone asked for',
    order.join(','),
  );
}

// Tasks start as soon as a slot is free, so look-ahead that arrives a moment
// before the segment a first frame needs can take the torrent's slots. The
// needed segment takes one back.
{
  const queue = new TaskQueue(8, 2);
  const stopped = [];
  const hold = (key, rank) =>
    queue
      .run({ key, priority: Priority.Foreground, group: 't', rank }, ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              stopped.push(key);
              reject(signal.reason);
            },
            { once: true },
          );
          setTimeout(resolve, 300);
        }),
      )
      .catch((err) => err);

  const video0 = hold('video0', 0);
  const video1 = hold('video1', 1);
  await wait(20);
  const started = Date.now();
  const audio0 = await within(
    queue.run(
      { key: 'audio0', priority: Priority.Foreground, group: 't', rank: 0 },
      async ({ waitedMs }) => waitedMs,
    ),
    2000,
    'needed segment behind look-ahead',
  );
  check(
    stopped.join(',') === 'video1',
    "a first frame's segment stops running look-ahead, and nothing else",
    stopped.join(',') || 'nothing stopped',
  );
  check(
    Date.now() - started < 200,
    'and starts without waiting for it to finish',
    `waited ${audio0}ms`,
  );
  check((await video1) instanceof CancelledError, 'the look-ahead rejects with CancelledError');
  await video0;
}

// Equally urgent work never preempts: two viewers' first frames both wait their turn.
{
  const queue = new TaskQueue(8, 2);
  let stopped = 0;
  const hold = (key) =>
    queue
      .run({ key, priority: Priority.Foreground, group: 't', rank: 0 }, ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            stopped++;
            reject(signal.reason);
          });
          setTimeout(resolve, 150);
        }),
      )
      .catch((err) => err);

  const running = [hold('a'), hold('b')];
  await wait(20);
  const third = queue.run(
    { key: 'c', priority: Priority.Foreground, group: 't', rank: 0 },
    async () => 'ran',
  );
  await Promise.all(running);
  await third;
  check(stopped === 0, 'equally urgent work is never preempted', `${stopped} stopped`);
}

// One waiting task stops one look-ahead - the least urgent - however often the
// queue is drained before that slot comes free.
{
  const queue = new TaskQueue(8, 2);
  const stopped = [];
  const hold = (key, rank) =>
    queue
      .run({ key, priority: Priority.Foreground, group: 't', rank }, ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            stopped.push(key);
            // Settles a little late, like a read unwinding.
            setTimeout(() => reject(signal.reason), 50);
          });
          setTimeout(resolve, 400);
        }),
      )
      .catch((err) => err);

  const lookAhead = [hold('ahead1', 1), hold('ahead2', 2)];
  await wait(20);
  const needed = queue.run(
    { key: 'needed', priority: Priority.Foreground, group: 't', rank: 0 },
    async () => 'ran',
  );
  // Unrelated activity drains the queue again while the stopped task unwinds.
  for (let i = 0; i < 5; i++) {
    queue.promote('unrelated');
    await wait(5);
  }
  await needed;
  await Promise.all(lookAhead);
  check(
    stopped.join(',') === 'ahead2',
    'one waiting task stops exactly one look-ahead, the least urgent',
    stopped.join(',') || 'nothing stopped',
  );
}

process.exit(failureCount() ? 1 : 0);
