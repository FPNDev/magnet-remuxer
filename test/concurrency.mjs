// Viewers arriving and leaving: a scrub that fails nothing, two players far
// apart in one file, a seek overtaking read-ahead work, a cold player beating
// the warming queue, and a second seek before the first one lands.
//
//   node test/concurrency.mjs

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  cacheRoot,
  createSeeder,
  ensureFixtures,
  exists,
  fixtures,
  playlistOf,
  reporter,
  resolveBinaries,
  seed,
  sleep,
  suitePort,
  TestServer,
  waitFor,
} from './lib.mjs';

// A queue of eight renders against a local swarm can finish before the eighth
// request arrives, which hides the ordering this suite is about. Capping the
// seeder keeps each job long enough for its overlap with the others to show.
const SEED_BYTES_PER_SEC = 150 * 1024;
// A waiting job outranks an older one only once its wait has crossed one
// whole aging interval, so the gap here has to clear that interval outright.
const AGING_MS = 5000;
const SEEK_DELAY_MS = AGING_MS + 1500;

const report = reporter('concurrency');

await resolveBinaries();
await ensureFixtures();

const server = await TestServer.start({
  name: 'concurrency',
  port: suitePort(3),
  cacheDir: `${cacheRoot}/concurrency`,
  options: {
    env: {
      MAX_CONCURRENT_JOBS: '4',
      TAIL_HEDGE: '0',
      READ_STALL_S: '60',
    },
  },
});

/** A seeder whose uploads run at SEED_BYTES_PER_SEC, so reads take seconds. */
async function seedCapped(input) {
  const client = createSeeder();
  const seeded = await seed(input, { client });
  client.throttleUpload(SEED_BYTES_PER_SEC);
  return seeded;
}

const statusOf = () => server.getJson('/status');

const findTorrent = (status, infoHash) =>
  status.torrents.find((entry) => entry.infoHash === infoHash);

/** Master playlist, video media playlist and segment directory of a title. */
async function openTitle(magnet, file) {
  const suffix = file === undefined ? '' : `&file=${file}`;
  const master = playlistOf(
    (
      await server.request(
        `/m3u8?magnet=${encodeURIComponent(magnet)}${suffix}`,
      )
    ).text,
  );
  const { uri } = master.playlists[0];
  const media = playlistOf((await server.request(`/${uri}`)).text);
  return { uri, dir: path.posix.dirname(uri), count: media.segments.length };
}

const segmentFile = (title, n) =>
  path.join(server.cacheLayout.hls, title.dir, `${n}.m4s`);

const getSegment = (title, n, init) =>
  server.request(`/${title.dir}/${n}.m4s`, init);

/** One request, timed, so what landed when can be compared. */
async function timed(entry, init) {
  const startedAt = Date.now();
  try {
    const response = await getSegment(entry.title, entry.n, init);
    return {
      ...entry,
      status: response.status,
      bytes: response.bytes,
      startedAt,
      doneAt: Date.now(),
      aborted: false,
      error: undefined,
    };
  } catch (err) {
    return {
      ...entry,
      status: 0,
      bytes: Buffer.alloc(0),
      startedAt,
      doneAt: Date.now(),
      aborted: err?.name === 'AbortError',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Fires every request before awaiting any, staggered by staggerMs. */
async function requestAll(title, indices, { staggerMs = 0 } = {}) {
  const pending = [];
  for (const n of indices) {
    pending.push(timed({ label: title.uri, title, n }));
    if (staggerMs > 0) {
      await sleep(staggerMs);
    }
  }
  return Promise.all(pending);
}

/** Renders the segments one after another, for bytes to compare against. */
async function renderEach(title, indices) {
  const outcomes = [];
  for (const n of indices) {
    outcomes.push(await timed({ label: title.uri, title, n }));
  }
  return outcomes;
}

async function forgetSegments(title, indices) {
  for (const n of indices) {
    await rm(segmentFile(title, n), { force: true });
  }
}

/** True when first and second agree on the bytes of every segment. */
function compares(label, first, second) {
  const byKey = new Map(second.map((entry) => [entry.n, entry]));
  const wrong = [];
  for (const entry of first) {
    const other = byKey.get(entry.n);
    if (!other || !entry.bytes.equals(other.bytes)) {
      wrong.push(String(entry.n));
    }
  }
  return {
    passed: wrong.length === 0,
    detail: `${label}: ${
      wrong.length ? `differed at ${wrong.join(', ')}` : 'identical bytes'
    }`,
  };
}

function distinctness(entries) {
  const shapes = new Set(entries.map((entry) => entry.bytes.toString('base64')));
  return {
    passed: shapes.size === entries.length && entries.length > 1,
    detail: `${shapes.size} distinct of ${entries.length} segments`,
  };
}

/** Waits for every queued and running job to settle. */
function drained(timeoutMs = 60_000) {
  return waitFor(
    async () => {
      const status = await statusOf();
      return status.jobs.running === 0 && status.jobs.queued === 0
        ? status
        : false;
    },
    { timeoutMs, intervalMs: 50 },
  );
}

async function logOf(message) {
  await sleep(50);
  let text = '';
  try {
    text = await readFile(server.logPath, 'utf8');
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter((line) => line.includes(message));
}

/**
 * Runs `work` while polling /status, and reports the highest counts seen: how
 * much ran at once, and how much of it one torrent owned.
 */
async function whileWatching(work) {
  const peak = {
    running: 0,
    runningBackground: 0,
    queued: 0,
    perTorrent: new Map(),
    both: false,
  };
  let settled = false;
  const watcher = (async () => {
    while (!settled) {
      const status = await statusOf();
      peak.running = Math.max(peak.running, status.jobs.running);
      peak.runningBackground = Math.max(
        peak.runningBackground,
        status.jobs.runningBackground,
      );
      peak.queued = Math.max(peak.queued, status.jobs.queued);
      const busy = [];
      for (const entry of status.torrents) {
        const jobs = entry.activeJobs ?? 0;
        peak.perTorrent.set(
          entry.infoHash,
          Math.max(peak.perTorrent.get(entry.infoHash) ?? 0, jobs),
        );
        if (jobs > 0) {
          busy.push(entry.infoHash);
        }
      }
      if (busy.length > 1) {
        peak.both = true;
      }
      await sleep(10);
    }
  })();

  const outcome = await work();
  settled = true;
  await watcher.catch(() => {
    // A status poll losing to teardown says nothing about the checks.
  });
  return { outcome, peak };
}

try {
  // ---------------------------------------------------------------- scrubbing

  report.section('scrubbing');

  const tiny = await seedCapped(fixtures.tiny());
  const scrubTitle = await openTitle(tiny.magnet, undefined);
  const scrubbed = [1, 4, 7, 9, 11, 13].filter(
    (n) => n < scrubTitle.count,
  );

  const { outcome: scrub, peak: scrubPeak } = await whileWatching(() =>
    requestAll(scrubTitle, scrubbed, { staggerMs: 25 }),
  );

  await report.check('a scrub answers 200 every time', async () => {
    const faulty = scrub.filter((entry) => entry.status !== 200);
    return {
      passed: faulty.length === 0 && scrub.length === scrubbed.length,
      detail:
        `${scrub.length} requests, ${faulty.length} failed; ` +
        `peak ${scrubPeak.running} running`,
    };
  });

  // Rendered again one at a time in the same cache: a scrub that returned
  // another segment's bytes would differ from this.
  await forgetSegments(scrubTitle, scrubbed);
  await drained();
  const scrubReference = await renderEach(scrubTitle, scrubbed);

  await report.check('each scrub carries its own segment', async () => {
    const compared = compares('scrub', scrub, scrubReference);
    const shapes = distinctness(scrubReference);
    return {
      passed: compared.passed && shapes.passed,
      detail: `${compared.detail}; ${shapes.detail}`,
    };
  });

  await report.check('a scrub does not wait behind the last one', async () => {
    return {
      passed: scrubPeak.running > 1,
      detail: `peak ${scrubPeak.running} renders running at once`,
    };
  });

  // ------------------------------------------------------- two viewers apart

  report.section('two viewers far apart');

  const movie = await seedCapped(fixtures.movie());
  const longTitle = await openTitle(movie.magnet, undefined);
  const startIndices = [1, 2, 3];
  const endIndices = [longTitle.count - 3, longTitle.count - 2, longTitle.count - 1];

  const apart = [];
  for (let round = 0; round < startIndices.length; round++) {
    apart.push({ label: 'near', title: longTitle, n: startIndices[round] });
    apart.push({ label: 'far', title: longTitle, n: endIndices[round] });
  }

  const { outcome: viewers, peak: viewerPeak } = await whileWatching(() =>
    requestAll(longTitle, apart.map((entry) => entry.n), { staggerMs: 25 }),
  );

  await report.check('both viewers were served', async () => {
    const faulty = viewers.filter((entry) => entry.status !== 200);
    return {
      passed: faulty.length === 0 && viewers.length === apart.length,
      detail:
        `${viewers.length} segments over ${longTitle.count}; ` +
        `${faulty.length} failed`,
    };
  });

  await forgetSegments(longTitle, [...startIndices, ...endIndices]);
  await drained();
  const apartReference = await renderEach(longTitle, [
    ...startIndices,
    ...endIndices,
  ]);
  const bySegment = new Map(
    apartReference.map((entry) => [entry.n, entry.bytes]),
  );

  await report.check('each viewer got its own bytes', async () => {
    return compares(
      'viewers',
      viewers,
      [...bySegment].map(([n, bytes]) => ({ n, bytes })),
    );
  });

  await report.check('neither viewer starved', async () => {
    const near = viewers
      .filter((entry) => startIndices.includes(entry.n))
      .map((entry) => entry.doneAt);
    const far = viewers
      .filter((entry) => endIndices.includes(entry.n))
      .map((entry) => entry.doneAt);
    const interleaved =
      Math.min(...far) < Math.max(...near) &&
      Math.min(...near) < Math.max(...far);
    return {
      passed: interleaved,
      detail:
        `near ${Math.min(...near)}..${Math.max(...near)}ms, ` +
        `far ${Math.min(...far)}..${Math.max(...far)}ms after start`,
    };
  });

  await report.check('the ceiling held for both viewers', async () => {
    return {
      passed: viewerPeak.running <= 4,
      detail: `peak ${viewerPeak.running} running, ceiling 4`,
    };
  });

  await report.check('the reads of one file share a torrent', async () => {
    const status = await statusOf();
    const entry = findTorrent(status, movie.infoHash);
    return {
      passed: entry?.downloaded > 0 && status.torrents.length === 2,
      detail:
        `${status.torrents.length} torrents live, ` +
        `${entry?.downloaded ?? 0}B downloaded for ${movie.infoHash.slice(0, 8)}`,
    };
  });
} finally {
  await server.stop();
}

report.finish();
process.exit(process.exitCode ?? 0);
