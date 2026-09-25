// TaskQueue alone: background slots capped, a foreground arrival preempting a
// background runner, and cancellation on a seek. No fixture, no ffmpeg, no
// HTTP - the queue is driven directly and asserted on ordering and counts.
//
//   node test/queue.mjs

import {
  CancelledError,
  Priority,
  TaskQueue,
} from '../dist/util/task-queue.js';
import { reporter, sleep, waitFor } from './lib.mjs';

const report = reporter('queue');

/** Promise plus the resolve/reject that settles it, so a task can be held open. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Waits for a queued entry to actually run. */
const started = (entry) =>
  waitFor(() => entry.startedAt !== undefined, { timeoutMs: 5000 });

/**
 * Starts a task that parks until either the gate opens or it is aborted, and
 * records what it saw.
 */
function park(queue, spec, gate, order = []) {
  const entry = {
    key: spec.key,
    background: spec.priority === Priority.Background,
  };
  entry.promise = queue
    .run(spec, async (context) => {
      entry.startedAt = Date.now();
      entry.waitedMs = context.waitedMs;
      order.push(spec.key);
      await new Promise((resolve) => {
        const done = () => {
          context.signal.removeEventListener('abort', done);
          resolve();
        };
        gate.promise.then(done);
        context.signal.addEventListener('abort', done);
      });
      entry.aborted = context.signal.aborted;
      return spec.key;
    })
    .catch((err) => {
      entry.error = err;
      throw err;
    });
  return entry;
}

report.section('background slots are capped');

await report.check(
  'background never holds more than a third of the slots',
  async () => {
    const queue = new TaskQueue(6, 0);
    const gate = deferred();
    const running = [];
    for (let index = 0; index < 8; index++) {
      running.push(
        park(queue, { key: `bg${index}`, priority: Priority.Background }, gate),
      );
    }
    let peak = 0;
    for (let sample = 0; sample < 12; sample++) {
      peak = Math.max(peak, queue.stats.runningBackground);
      await sleep(10);
    }
    gate.resolve();
    await Promise.allSettled(running.map((entry) => entry.promise));
    return { passed: peak === 2, detail: `peak background ${peak}, cap 2` };
  },
);

await report.check('the cap is one slot even on a one-slot queue', async () => {
  const queue = new TaskQueue(1, 0);
  const gate = deferred();
  const entry = park(
    queue,
    { key: 'warm', priority: Priority.Background },
    gate,
  );
  await started(entry);
  const whileRunning = queue.stats.runningBackground;
  gate.resolve();
  await entry.promise;
  return {
    passed: whileRunning === 1,
    detail: `running background ${whileRunning}`,
  };
});

await report.check('foreground work still uses every idle slot', async () => {
  const queue = new TaskQueue(4, 0);
  const gate = deferred();
  const entries = [];
  for (let index = 0; index < 4; index++) {
    entries.push(
      park(queue, { key: `fg${index}`, priority: Priority.Foreground }, gate),
    );
  }
  await sleep(60);
  const snapshot = queue.stats;
  gate.resolve();
  await Promise.allSettled(entries.map((entry) => entry.promise));
  return {
    passed: snapshot.running === 4,
    detail: `running ${snapshot.running} of 4 slots`,
  };
});

report.section('a player preempts');

await report.check(
  'a foreground arrival aborts a background runner',
  async () => {
    const queue = new TaskQueue(3, 0);
    const gate = deferred();
    // Two foreground tasks take two slots, background takes the third: the
    // queue is now full of work and anything new has to barge in.
    const held = [
      park(queue, { key: 'viewer-a', priority: Priority.Foreground }, gate),
      park(queue, { key: 'viewer-b', priority: Priority.Foreground }, gate),
      park(queue, { key: 'warm', priority: Priority.Background }, gate),
    ];
    await sleep(60);

    const player = park(
      queue,
      { key: 'seek', priority: Priority.Foreground },
      gate,
    );
    await started(player);

    const warm = held[2];
    const outcome = {
      warmAborted: warm.aborted === true,
      started: player.startedAt !== undefined,
    };
    gate.resolve();
    await Promise.allSettled([...held, player].map((entry) => entry.promise));
    return {
      passed: outcome.warmAborted && outcome.started,
      detail: `warm job aborted ${outcome.warmAborted}, seek started ${outcome.started}`,
    };
  },
);

await report.check(
  'preemption stops at one runner per waiting task',
  async () => {
    const queue = new TaskQueue(2, 0);
    const gate = deferred();
    const background = [
      park(queue, { key: 'warm-1', priority: Priority.Background }, gate),
      park(queue, { key: 'warm-2', priority: Priority.Background }, gate),
    ];
    await started(background[0]);
    // Two foreground arrivals, one runner: only one may be aborted.
    const arrivals = [
      park(queue, { key: 'seek-1', priority: Priority.Foreground }, gate),
      park(queue, { key: 'seek-2', priority: Priority.Foreground }, gate),
    ];
    await sleep(80);
    const abortedCount = [...background, ...arrivals].filter(
      (entry) => entry.aborted === true,
    ).length;
    gate.resolve();
    await Promise.allSettled(
      [...background, ...arrivals].map((entry) => entry.promise),
    );
    return {
      passed: abortedCount <= 1,
      detail: `${abortedCount} runners aborted`,
    };
  },
);

report.section('cancellation on a seek');

await report.check('abandoning a key rejects its queued work', async () => {
  const queue = new TaskQueue(1, 0);
  const gate = deferred();
  const blocker = park(
    queue,
    { key: 'blocker', priority: Priority.Foreground },
    gate,
  );
  await started(blocker);

  const abandoned = [
    park(queue, { key: 'stale', priority: Priority.Foreground }, gate),
    park(queue, { key: 'stale', priority: Priority.Background }, gate),
  ];
  queue.abandon('stale');
  const outcomes = await Promise.allSettled(
    abandoned.map((entry) => entry.promise),
  );
  gate.resolve();
  await blocker.promise;

  const cancelled = outcomes.filter(
    (outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof CancelledError,
  );
  return {
    passed: cancelled.length === 2,
    detail: `${cancelled.length} of 2 queued tasks cancelled`,
  };
});

await report.check('abandon leaves other keys waiting', async () => {
  const queue = new TaskQueue(1, 0);
  const gate = deferred();
  const blocker = park(
    queue,
    { key: 'blocker', priority: Priority.Foreground },
    gate,
  );
  await started(blocker);

  const keeper = park(
    queue,
    { key: 'keeper', priority: Priority.Foreground },
    gate,
  );
  const dropped = park(
    queue,
    { key: 'stale', priority: Priority.Foreground },
    gate,
  );
  queue.abandon('stale');

  const droppedOutcome = await dropped.promise.catch((err) => err);
  const stillQueued = queue.stats.queued;
  gate.resolve();
  await Promise.allSettled([blocker.promise, keeper.promise]);

  return {
    passed: droppedOutcome instanceof CancelledError && stillQueued === 1,
    detail: `dropped ${droppedOutcome?.name}, keeper queued ${stillQueued}`,
  };
});

await report.check('abandon aborts a running task', async () => {
  const queue = new TaskQueue(2, 0);
  const gate = deferred();
  const running = park(
    queue,
    { key: 'stale', priority: Priority.Foreground },
    gate,
  );
  await started(running);
  queue.abandon('stale');
  await waitFor(() => running.aborted === true, { timeoutMs: 5000 });
  gate.resolve();
  await Promise.allSettled([running.promise]);
  return {
    passed: running.aborted === true,
    detail: `aborted ${running.aborted}`,
  };
});

await report.check('promote lifts waiting background work', async () => {
  const queue = new TaskQueue(2, 0);
  const gate = deferred();
  const order = [];
  const blockers = [
    park(
      queue,
      { key: 'blocker-1', priority: Priority.Foreground },
      gate,
      order,
    ),
    park(
      queue,
      { key: 'blocker-2', priority: Priority.Foreground },
      gate,
      order,
    ),
  ];
  await sleep(60);

  const early = park(
    queue,
    { key: 'warm', priority: Priority.Background },
    gate,
    order,
  );
  const player = park(
    queue,
    { key: 'seek', priority: Priority.Background },
    gate,
    order,
  );
  queue.promote('seek');

  // Free one slot: the promoted task must be the one that takes it, even
  // though the other one queued first.
  gate.resolve();
  await started(player);
  await started(early);
  await Promise.allSettled(
    [...blockers, early, player].map((entry) => entry.promise),
  );
  const promoted = order.indexOf('seek');
  const warm = order.indexOf('warm');
  return {
    passed: promoted !== -1 && promoted < warm,
    detail: `start order ${order.join(', ')}`,
  };
});

await report.check(
  'abandon with backgroundOnly drops background only',
  async () => {
    const queue = new TaskQueue(1, 0);
    const gate = deferred();
    const blocker = park(
      queue,
      { key: 'blocker', priority: Priority.Foreground },
      gate,
    );
    await started(blocker);

    const warm = park(
      queue,
      { key: 'warm', priority: Priority.Background },
      gate,
    );
    const foreground = park(
      queue,
      { key: 'player', priority: Priority.Foreground },
      gate,
    );
    queue.abandon('warm', true);

    const warmOutcome = await warm.promise.catch((err) => err);
    const queued = queue.stats.queued;
    gate.resolve();
    await Promise.allSettled([blocker.promise, foreground.promise]);

    return {
      passed: warmOutcome instanceof CancelledError && queued === 1,
      detail: `warm cancelled ${warmOutcome instanceof CancelledError}, ${queued} still queued`,
    };
  },
);

report.section('the queue reports itself');

await report.check('a waiting task sees how long it waited', async () => {
  const queue = new TaskQueue(1, 0);
  const gate = deferred();
  const blocker = park(
    queue,
    { key: 'blocker', priority: Priority.Foreground },
    gate,
  );
  await started(blocker);
  const waiter = park(
    queue,
    { key: 'waiter', priority: Priority.Foreground },
    gate,
  );
  await sleep(120);
  gate.resolve();
  await Promise.allSettled([blocker.promise, waiter.promise]);
  return {
    passed: waiter.waitedMs >= 100,
    detail: `waited ${waiter.waitedMs}ms`,
  };
});

await report.check('stats stay consistent once everything drains', async () => {
  const queue = new TaskQueue(4, 0);
  const gate = deferred();
  const entries = [];
  for (let index = 0; index < 6; index++) {
    entries.push(
      park(
        queue,
        {
          key: `task${index}`,
          priority: index % 2 === 0 ? Priority.Foreground : Priority.Background,
        },
        gate,
      ),
    );
  }
  await sleep(60);
  const during = queue.stats;
  gate.resolve();
  await Promise.allSettled(entries.map((entry) => entry.promise));
  await sleep(120);
  const after = queue.stats;
  return {
    passed:
      during.running === 4 &&
      during.queued === 2 &&
      after.queued === 0 &&
      after.running === 0,
    detail: `during ${JSON.stringify(during)}, after ${JSON.stringify(after)}`,
  };
});

report.finish();
process.exit(process.exitCode ?? 0);
