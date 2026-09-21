import { rmSync } from 'node:fs';
import { mkdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../dist/cache/cache-layout.js';
import { parseInfoHash } from '../dist/torrent/magnet.js';
import {
  check,
  failureCount,
  fixturesDir,
  get,
  seedFixture,
  section,
  startServer,
  workDir,
} from './lib.mjs';

// Small pieces and a throttled seeder keep warming slow enough to watch it
// while it is still running.
const PIECE_LENGTH = 512 * 1024;
const SEED_RATE = 512 * 1024;
const WARM_BUDGET_MS = 90_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = path.join(fixturesDir, 'movie.mkv');
const { client, magnet } = await seedFixture(fixture, {
  pieceLength: PIECE_LENGTH,
  uploadLimit: SEED_RATE,
});

async function server(name, port) {
  const cacheDir = path.join(workDir, name);
  rmSync(cacheDir, { recursive: true, force: true, maxRetries: 20 });
  await mkdir(cacheDir, { recursive: true });
  return startServer({
    name,
    port,
    cacheDir,
    env: { WARM_SEGMENTS: '2', PREFETCH_SEGMENTS: '2' },
  });
}

async function play(base) {
  const masterUrl = `${base}/m3u8?magnet=${encodeURIComponent(magnet)}`;
  const master = await get(masterUrl, false);
  if (master.status !== 200) {
    throw new Error(`master -> ${master.status}`);
  }
  const videoUri = new URL(master.body.trim().split('\n').at(-1), masterUrl)
    .href;
  const video = await get(videoUri, false);
  const first = video.body
    .trim()
    .split('\n')
    .find((line) => line && !line.startsWith('#'));
  const segment = await get(new URL(first, videoUri).href);
  if (segment.status !== 200) {
    throw new Error(`segment -> ${segment.status}`);
  }
  return { master: master.ms, frame: video.ms + segment.ms };
}

section('a title nobody has warmed');
const cold = await server('warm-cold', 3931);
let coldTimes;
try {
  coldTimes = await play(cold.base);
} finally {
  await cold.stop();
}
check(
  coldTimes.master > 0,
  'pays for its own index before it can play',
  `master ${coldTimes.master}ms, first frame ${coldTimes.frame}ms`,
);

section('a title warmed beforehand');
const warm = await server('warm-warm', 3932);
let warmTimes;
let asked;
let again;
let ready = false;
let waited = 0;
try {
  const url = `${warm.base}/warm?magnet=${encodeURIComponent(magnet)}`;
  asked = JSON.parse((await get(url, false)).body);
  again = JSON.parse((await get(url, false)).body);

  const started = Date.now();
  while (Date.now() - started < WARM_BUDGET_MS) {
    const status = JSON.parse((await get(url, false)).body);
    if (status.ready) {
      ready = true;
      break;
    }
    await wait(500);
  }
  waited = Date.now() - started;
  warmTimes = await play(warm.base);
} finally {
  await warm.stop();
}

check(
  asked?.queued === true && asked?.ready === false,
  'is accepted at once rather than made to wait for its own index',
  JSON.stringify(asked),
);
check(
  again?.queued === false,
  'and asking again while it is warming queues nothing new',
  JSON.stringify(again),
);
check(
  ready,
  'it reports itself ready when the playlists are there',
  `${waited}ms`,
);
check(
  warmTimes.master < 1000,
  'the player that arrives afterwards gets its playlists from the disk',
  `${warmTimes.master}ms against ${coldTimes.master}ms cold`,
);
check(
  warmTimes.frame < coldTimes.frame,
  'and its first frame without waiting for the swarm',
  `${warmTimes.frame}ms against ${coldTimes.frame}ms cold`,
);

section('the file list of a warmed title, after a restart');
const listDir = path.join(workDir, 'warm-warm');
const magnetFile = new CacheLayout(listDir).magnetFile(parseInfoHash(magnet));
// Backdate the magnet file so any fresher mtime can only come from the
// request below.
const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
await utimes(magnetFile, stale, stale);

const restarted = await startServer({
  name: 'warm-restarted',
  port: 3933,
  cacheDir: listDir,
});
let list;
let markedAt;
try {
  list = await get(
    `${restarted.base}/files?magnet=${encodeURIComponent(magnet)}`,
    false,
  );
  markedAt = await settledMtime(magnetFile, stale.getTime());
} finally {
  await restarted.stop();
}

const listed = list.status === 200 ? JSON.parse(list.body) : null;
check(
  listed?.files?.length > 0 && list.ms < 1000,
  'comes off the disk rather than out of the swarm',
  `${listed?.files?.length} files in ${list.ms}ms`,
);
check(
  listed?.files?.some((file) => file.playable),
  'and still says which of them can be played',
  JSON.stringify(listed?.files?.map((file) => file.playable)),
);
check(
  list.cacheControl?.includes('max-age'),
  'a list an info hash pins is one a client may keep',
  String(list.cacheControl),
);
check(
  markedAt > stale.getTime(),
  'and asking for it counts as a use, so browsing does not let a title expire',
  markedAt > stale.getTime()
    ? `marked ${Math.round((Date.now() - markedAt) / 1000)}s ago`
    : 'left at its old modification time',
);

client.destroy();
process.exit(failureCount() ? 1 : 0);

// The mtime is touched after the response is sent, so poll for it instead
// of reading once.
async function settledMtime(file, before) {
  const deadline = Date.now() + 2000;
  let { mtimeMs } = await stat(file);
  while (mtimeMs <= before && Date.now() < deadline) {
    await wait(50);
    ({ mtimeMs } = await stat(file));
  }
  return mtimeMs;
}
