// Two torrents playing at once, then two files of one torrent at once: a
// viewer's segments always come back as its own bytes, the job ceiling holds
// across titles, and a piece two files share is taken from the swarm once.
//
//   node test/multi.mjs

import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  cacheRoot,
  createSeeder,
  dirFiles,
  ensureFixtures,
  exists,
  fileSize,
  fixtures,
  playlistOf,
  removeDir,
  reporter,
  resolveBinaries,
  seed,
  sleep,
  suitePort,
  TestServer,
  waitFor,
  workDir,
} from './lib.mjs';

const GLOBAL_JOBS = 4;
const JOBS_PER_TORRENT = 2;
// The swarm is local and fast, which would let a queue of eight renders
// finish before the eighth request arrived. Capping the seeder keeps jobs
// long enough for their overlap - and so for the queue's ordering - to be
// observable.
const SEED_BYTES_PER_SEC = 200 * 1024;

const report = reporter('multi');

await resolveBinaries();
await ensureFixtures();

const server = await TestServer.start({
  name: 'multi',
  port: suitePort(2),
  cacheDir: `${cacheRoot}/multi`,
  options: {
    env: {
      MAX_CONCURRENT_JOBS: String(GLOBAL_JOBS),
      TAIL_HEDGE: '0',
      READ_STALL_S: '60',
    },
  },
});

async function seedCapped(fixture) {
  const client = createSeeder();
  const seeded = await seed(fixture, { client });
  client.throttleUpload(SEED_BYTES_PER_SEC);
  return seeded;
}

const first = await seedCapped(fixtures.movie());
const second = await seedCapped(fixtures.sparse());

// Two mkv files under one directory seed as one torrent with two files, which
// is how a multi-file release reaches the server.
const pairDir = path.join(workDir, 'multi-pair');
await removeDir(pairDir);
await mkdir(pairDir, { recursive: true });
await copyFile(fixtures.tiny(), path.join(pairDir, 'episode-one.mkv'));
await copyFile(fixtures.sparse(), path.join(pairDir, 'episode-two.mkv'));
const pair = await seedCapped(pairDir);

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
const pieceFile = (infoHash, index) =>
  path.join(server.cacheLayout.pieces, infoHash, `${index}.piece`);

const getSegment = (title, n, init) =>
  server.request(`/${title.dir}/${n}.m4s`, init);

/** One request, timed, so ordering between viewers can be compared. */
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
      error: undefined,
    };
  } catch (err) {
    return {
      ...entry,
      status: 0,
      bytes: Buffer.alloc(0),
      startedAt,
      doneAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fires every request before awaiting any, optionally staggering them so the
 * order they reach the server is the order they were issued in.
 */
async function burst(entries, { staggerMs = 0 } = {}) {
  const pending = [];
  for (const entry of entries) {
    pending.push(timed(entry));
    if (staggerMs > 0) {
      await sleep(staggerMs);
    }
  }
  return Promise.all(pending);
}

async function forgetSegments(title, indices) {
  for (const n of indices) {
    await rm(segmentFile(title, n), { force: true });
  }
}

/** Four segments spread over a file, cheap enough to render twice. Segment 0
 *  is skipped: the server starts it on its own once a title is opened. */
function spread(count) {
  return [
    ...new Set([
      0,
      Math.floor(count / 3),
      Math.floor((2 * count) / 3),
      count - 1,
    ]),
  ];
}

/** Piece files and their total size for one title, straight off the disk. */
async function piecesOnDisk(infoHash) {
  const files = await dirFiles(path.join(server.cacheLayout.pieces, infoHash));
  let bytes = 0;
  for (const file of files) {
    bytes += await fileSize(file);
  }
  return { count: files.length, bytes };
}

/** Download counter and cached bytes for the shared torrent, as they stand. */
async function mark() {
  const status = await statusOf();
  return {
    downloaded: findTorrent(status, pair.infoHash)?.downloaded ?? 0,
    stored: (await piecesOnDisk(pair.infoHash)).bytes,
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
  const peak = { running: 0, queued: 0, perTorrent: new Map(), both: false };
  let settled = false;
  const watcher = (async () => {
    while (!settled) {
      const status = await statusOf();
      peak.running = Math.max(peak.running, status.jobs.running);
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

/** The same bytes whatever the order the requests went out in. */
try {
  report.section('two torrents at once');

  const titles = [
    { label: 'first', magnet: first.magnet, infoHash: first.infoHash },
    { label: 'second', magnet: second.magnet, infoHash: second.infoHash },
  ];
  for (const title of titles) {
    title.playlist = await openTitle(title.magnet, undefined);
    title.indices = spread(title.playlist.count);
  }
  report.note(
    `segments per title: ${titles
      .map((title) => `${title.label} ${title.playlist.count}`)
      .join(', ')}`,
  );

  // Interleaved, so the slots handed out in arrival order serve both torrents.
  const wanted = [];
  for (let round = 0; round < 3; round++) {
    for (const title of titles) {
      wanted.push({
        label: title.label,
        title: title.playlist,
        n: title.indices[round + 1],
      });
    }
  }

  const { outcome: answered, peak } = await whileWatching(() =>
    burst(wanted, { staggerMs: 25 }),
  );

  await report.check('every segment of both torrents answers 200', async () => {
    const faulty = answered.filter((entry) => entry.status !== 200);
    return {
      passed: faulty.length === 0 && answered.length === wanted.length,
      detail:
        `${answered.length} of ${wanted.length} answered; ` +
        (faulty.length
          ? faulty
              .map((entry) => `${entry.label}/${entry.n}:${entry.status}`)
              .join(' ')
          : 'no failures'),
    };
  });

  await report.check('the global job ceiling held', async () => {
    return {
      passed: peak.running <= GLOBAL_JOBS,
      detail: `peak ${peak.running} running, ceiling ${GLOBAL_JOBS}`,
    };
  });

  await report.check('the two torrents were served side by side', async () => {
    return {
      passed: peak.both,
      detail:
        `peak ${peak.running} running of ${GLOBAL_JOBS} slots; ` +
        `two torrents busy at once: ${peak.both}`,
    };
  });

  // Rendered one at a time in the same cache, the same segments have to come
  // back with the same bytes: that is what says the parallel pass gave each
  // viewer its own segment rather than a neighbour's.
  for (const title of titles) {
    await forgetSegments(title.playlist, title.indices.slice(1));
  }
  await drained();
  const expected = new Map();
  for (const title of titles) {
    for (const n of title.indices.slice(1)) {
      expected.set(`${title.label}/${n}`, await getSegment(title.playlist, n));
    }
  }

  await report.check('each answer carries its own segment', async () => {
    const wrong = [];
    for (const entry of answered) {
      const reference = expected.get(`${entry.label}/${entry.n}`);
      if (!reference || !entry.bytes.equals(reference.bytes)) {
        wrong.push(`${entry.label}/${entry.n}`);
      }
    }
    const shapes = new Set(
      [...expected.values()].map((response) =>
        response.bytes.toString('base64'),
      ),
    );
    return {
      passed: wrong.length === 0 && shapes.size === expected.size,
      detail:
        `${shapes.size} distinct of ${expected.size} segments; ` +
        `mismatched: ${wrong.join(', ') || 'none'}`,
    };
  });

  report.section('two files of one torrent');

  const listing = await server.getJson(
    `/files?magnet=${encodeURIComponent(pair.magnet)}`,
  );

  await report.check('one torrent holds both files', async () => {
    return {
      passed:
        listing.files.length === 2 &&
        listing.files.every((file) => file.playable),
      detail: listing.files
        .map((file) => `#${file.index} ${file.name} ${file.length}B`)
        .join('; '),
    };
  });

  // Both files are opened first, so their index jobs are done and what is
  // left to watch is the reads themselves.
  const firstFile = await openTitle(pair.magnet, 0);
  const secondFile = await openTitle(pair.magnet, 1);
  // The piece holding file 1's first byte also holds file 0's last ones.
  const sharedPiece = Math.floor(listing.files[0].length / pair.pieceLength);

  await report.check('the two files share a piece', async () => {
    return {
      passed:
        listing.files[0].length % pair.pieceLength !== 0 &&
        sharedPiece < pair.pieceCount,
      detail:
        `piece ${sharedPiece} of ${pair.pieceCount} straddles ` +
        `${listing.files[0].length}B`,
    };
  });

  const before = await mark();
  const [tail, head] = await Promise.all([
    getSegment(firstFile, firstFile.count - 1),
    getSegment(secondFile, 0),
  ]);
  const after = await mark();
  const sharedHeld = await exists(pieceFile(pair.infoHash, sharedPiece));

  await report.check('both files play at once', async () => {
    return {
      passed: tail.status === 200 && head.status === 200,
      detail:
        `file 0 segment ${firstFile.count - 1} ${tail.status}/${tail.bytes.length}B; ` +
        `file 1 segment 0 ${head.status}/${head.bytes.length}B`,
    };
  });

  await forgetSegments(firstFile, [firstFile.count - 1]);
  await forgetSegments(secondFile, [0]);
  await drained();
  const tailAgain = await getSegment(firstFile, firstFile.count - 1);
  const headAgain = await getSegment(secondFile, 0);

  await report.check('each file answers with its own bytes', async () => {
    const identical = tailAgain.bytes.equals(headAgain.bytes);
    const stable =
      tail.bytes.equals(tailAgain.bytes) && head.bytes.equals(headAgain.bytes);
    return {
      passed:
        tail.bytes.length > 0 && head.bytes.length > 0 && !identical && stable,
      detail:
        `${tail.bytes.length}B and ${head.bytes.length}B; ` +
        `identical ${identical}; stable across renders ${stable}`,
    };
  });

  await report.check('the piece both files need was fetched once', async () => {
    const downloaded = after.downloaded - before.downloaded;
    const stored = after.stored - before.stored;
    return {
      passed:
        downloaded > 0 && stored > 0 && downloaded <= stored && sharedHeld,
      detail:
        `${downloaded}B from the swarm against ${stored}B newly cached; ` +
        `shared piece ${sharedPiece} on disk ${sharedHeld}; a second fetch ` +
        `would add ${pair.pieceLength}B`,
    };
  });

  await report.check('both files were indexed and rendered', async () => {
    const indexed = await logOf('Indexed media file');
    const rendered = await logOf('Rendered segment');
    const named = (name) => indexed.some((line) => line.includes(`"${name}"`));
    return {
      passed:
        named(listing.files[0].name) &&
        named(listing.files[1].name) &&
        rendered.length >= 2,
      detail: `${indexed.length} index runs (${listing.files
        .map((file) => file.name)
        .join(', ')}) and ${rendered.length} segment renders`,
    };
  });
} finally {
  await server.stop();
  await first.close();
  await second.close();
  await pair.close();
}

report.finish();
process.exit(process.exitCode ?? 0);
