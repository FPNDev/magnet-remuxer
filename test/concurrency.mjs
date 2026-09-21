import { existsSync, rmSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

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

const fixture = path.join(fixturesDir, 'movie.mkv');
const cacheDir = path.join(workDir, 'concurrency-cache');
const port = Number(process.env.TEST_PORT ?? 3941);

// One job per torrent renders segments one at a time, and the upload limit
// keeps them slow enough for queue order to be observable.
const JOBS_PER_TORRENT = 1;
const PREFETCH = 3;
const SEED_RATE = 1536 * 1024;
const SCRUBBED = 12;
const LANDING = 15;

rmSync(cacheDir, { recursive: true, force: true });
await mkdir(cacheDir, { recursive: true });

const {
  client: seeder,
  torrent: seeded,
  magnet,
} = await seedFixture(fixture, {
  uploadLimit: SEED_RATE,
});
const serverEnv = {
  MAX_JOBS_PER_TORRENT: String(JOBS_PER_TORRENT),
  PREFETCH_SEGMENTS: String(PREFETCH),
  REQUEST_TIMEOUT_S: '30',
  SEGMENT_DURATION: '6',
};
let server = await startServer({
  name: 'concurrency',
  port,
  cacheDir,
  env: serverEnv,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Aborted requests resolve with status 0 instead of rejecting, so a caller
// can await every request it started.
function abortable(url) {
  const controller = new AbortController();
  const started = Date.now();
  const done = fetch(url, { signal: controller.signal }).then(
    async (res) => {
      await res.arrayBuffer();
      return { status: res.status, ms: Date.now() - started };
    },
    () => ({ status: 0, ms: Date.now() - started }),
  );
  done.catch(() => {});
  return { abort: () => controller.abort(), done };
}

const jobs = async () => (await get(`${server.base}/status`, false)).body;

async function idle(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { jobs: stats } = JSON.parse(await jobs());
    if (stats.running === 0 && stats.queued === 0) {
      return stats;
    }
    if (Date.now() > deadline) {
      return stats;
    }
    await wait(100);
  }
}

// Prefetched segments are never asked for over HTTP, so the cache directory
// is the only place they can be observed.
async function rendered(numbers, timeoutMs = 20000) {
  const file = (n) =>
    path.join(cacheDir, 'hls', seeded.infoHash, '0', 'video', `${n}.m4s`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const missing = numbers.filter((n) => !existsSync(file(n)));
    if (!missing.length || Date.now() > deadline) {
      return missing;
    }
    await wait(100);
  }
}

const master = await get(
  `${server.base}/m3u8?magnet=${encodeURIComponent(magnet)}`,
  false,
);
if (master.status !== 200) {
  throw new Error(`master → ${master.status} ${master.body}`);
}
const videoUrl = new URL(
  master.body.trim().split('\n').at(-1),
  `${server.base}/m3u8`,
).href;
const playlist = await get(videoUrl, false);
const segments = playlist.body
  .trim()
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => new URL(line, videoUrl).href);

section(
  `scrubbing - ${segments.length} segments at ${SEED_RATE / 1024} KiB/s, ` +
    `${JOBS_PER_TORRENT} job per torrent`,
);

{
  const scrub = [];
  for (let i = 0; i < SCRUBBED; i++) {
    scrub.push(abortable(segments[i]));
    await wait(15);
  }
  const peak = JSON.parse(await jobs()).jobs.queued;
  check(
    peak > 0,
    'a scrub really does pile work up',
    `${peak} queued at its peak`,
  );

  for (const request of scrub) {
    request.abort();
  }
  await Promise.all(scrub.map((request) => request.done));
  await wait(250);

  const afterScrub = JSON.parse(await jobs()).jobs;
  check(
    afterScrub.queued === 0,
    'letting go of the scrub bar empties the queue',
    JSON.stringify(afterScrub),
  );

  const landed = await get(segments[LANDING]);
  check(
    landed.status === 200,
    'the segment the scrub ends on is served',
    `${landed.status} in ${landed.ms}ms`,
  );
  check(
    landed.ms < 15000,
    'and does not queue behind the whole scrub',
    `${landed.ms}ms`,
  );
  await idle();
}

section('two viewers, far apart in the same file');

{
  const far = await get(segments[12]);
  check(far.status === 200, 'the far viewer is served', String(far.status));

  const near = await get(segments[0]);
  check(
    near.status === 200,
    'the near viewer is served too',
    String(near.status),
  );

  const farMissing = await rendered([13, 14, 15]);
  check(
    farMissing.length === 0,
    'a second viewer elsewhere in the file keeps its own prefetch',
    farMissing.length
      ? `never rendered: ${farMissing.join(', ')}`
      : '13, 14, 15',
  );

  const nearMissing = await rendered([1, 2, 3]);
  check(
    nearMissing.length === 0,
    'and the first viewer still gets its own',
    nearMissing.length
      ? `never rendered: ${nearMissing.join(', ')}`
      : '1, 2, 3',
  );
  await idle();
}

section('two viewers on the same segment');

{
  const video = path.join(cacheDir, 'hls', seeded.infoHash, '0', 'video');
  for (const n of [5, 7, 8]) {
    rmSync(path.join(video, `${n}.m4s`), { force: true });
  }

  const at = (request) => request.then((res) => ({ ...res, at: Date.now() }));
  const blocker = at(get(segments[5]));
  await wait(100);
  const leaver = abortable(segments[7]);
  const stayer = at(get(segments[7]));
  await wait(100);
  const later = at(get(segments[8]));
  await wait(100);

  leaver.abort();
  await leaver.done;
  const [held, shared, after] = await Promise.all([blocker, stayer, later]);

  check(
    held.status === 200 && shared.status === 200 && after.status === 200,
    'everyone still waiting is served',
    [held.status, shared.status, after.status].join(', '),
  );
  check(
    shared.at < after.at,
    'one viewer leaving does not cost the other its place in the queue',
    `segment 7 at +${shared.at - held.at}ms, segment 8 at +${after.at - held.at}ms`,
  );
  await idle();
}

// Restarting on a fresh port drops in-memory playheads and demand counts
// while keeping the cache, so the scheduler starts cold here.
section('one viewer reading ahead while another seeks');

{
  const oldBase = server.base;
  await server.stop();
  server = await startServer({
    name: 'concurrency-restarted',
    port: port + 1,
    cacheDir,
    env: serverEnv,
  });
  const url = (n) => segments[n].replace(oldBase, server.base);
  const video = path.join(cacheDir, 'hls', seeded.infoHash, '0', 'video');
  for (const n of [2, 3, 4, 11, 16]) {
    rmSync(path.join(video, `${n}.m4s`), { force: true });
  }

  const at = (request) => request.then((res) => ({ ...res, at: Date.now() }));
  const blocker = at(get(url(11)));
  await wait(100);
  const playing = await get(url(1));
  const [a2, a3, a4] = [2, 3, 4].map((n) => at(get(url(n))));
  await wait(150);
  const b = at(get(url(16)));

  const [held, next, further, furthest, seek] = await Promise.all([
    blocker,
    a2,
    a3,
    a4,
    b,
  ]);
  check(
    [playing, held, next, further, furthest, seek].every(
      (res) => res.status === 200,
    ),
    'both viewers are served',
  );
  check(
    seek.at < further.at && seek.at < furthest.at,
    "a seek is not kept waiting by another viewer's look-ahead",
    `after the blocker: A's 2 at +${next.at - held.at}ms, B's seek at ` +
      `+${seek.at - held.at}ms, A's 3 and 4 at +${further.at - held.at}ms and ` +
      `+${furthest.at - held.at}ms`,
  );
  await idle();
}

section('a player landing on a cold position');

{
  const audioLine = [...master.body.matchAll(/#EXT-X-MEDIA:(.*)/g)]
    .map(([, attributes]) => attributes)
    .find((a) => /TYPE=AUDIO/.test(a) && /DEFAULT=YES/.test(a));
  const audioUrl = new URL(
    /URI="([^"]*)"/.exec(audioLine)[1],
    `${server.base}/m3u8`,
  ).href;
  const audioSegments = (await get(audioUrl, false)).body
    .trim()
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, audioUrl).href);

  const audioDir = new URL(audioSegments[7]).pathname.split('/').slice(3, -1);
  const hls = path.join(cacheDir, 'hls', seeded.infoHash, '0');
  for (const n of [7, 8, 9]) {
    rmSync(path.join(hls, 'video', `${n}.m4s`), { force: true });
    rmSync(path.join(hls, ...audioDir, `${n}.m4s`), { force: true });
  }

  const at = (request) => request.then((res) => ({ ...res, at: Date.now() }));
  const url = (href) => href.replace(/^http:\/\/[^/]+/, server.base);
  const video = [7, 8, 9].map((n) => at(get(url(segments[n]))));
  const audio = [7, 8, 9].map((n) => at(get(url(audioSegments[n]))));
  const [v7, v8, v9, a7] = await Promise.all([...video, audio[0]]);
  await Promise.all(audio);

  check(
    [v7, v8, v9, a7].every((res) => res.status === 200),
    'every segment of the landing is served',
  );
  check(
    a7.at < v8.at && a7.at < v9.at,
    "the first frame's audio does not wait behind video look-ahead",
    `video 7/8/9 at +0/+${v8.at - v7.at}/+${v9.at - v7.at}ms, audio 7 at +${a7.at - v7.at}ms`,
  );
  await idle();
}

section('seeking again before anything arrives');

{
  const oldBase = server.base;
  await server.stop();
  server = await startServer({
    name: 'concurrency-seeking',
    port: port + 2,
    cacheDir,
    env: serverEnv,
  });
  const onServer = (href) =>
    href.replace(oldBase, server.base).replace(/^http:\/\/[^/]+/, server.base);

  const masterUrl = `${server.base}/m3u8`;
  const audioLine = [...master.body.matchAll(/#EXT-X-MEDIA:(.*)/g)]
    .map(([, attributes]) => attributes)
    .find((a) => /TYPE=AUDIO/.test(a) && /DEFAULT=YES/.test(a));
  const audioUrl = new URL(/URI="([^"]*)"/.exec(audioLine)[1], masterUrl).href;
  const audioSegments = (await get(audioUrl, false)).body
    .trim()
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, audioUrl).href);

  const hls = path.join(cacheDir, 'hls', seeded.infoHash, '0');
  const audioDir = new URL(audioSegments[0]).pathname.split('/').slice(3, -1);
  const files = (n) => [
    path.join(hls, 'video', `${n}.m4s`),
    path.join(hls, ...audioDir, `${n}.m4s`),
  ];
  for (let n = 0; n <= 12; n++) {
    for (const file of files(n)) {
      rmSync(file, { force: true });
    }
  }

  const land = (n) => [
    ...[n, n + 1, n + 2].map((k) => abortable(onServer(segments[k]))),
    ...[n, n + 1, n + 2].map((k) => abortable(onServer(audioSegments[k]))),
  ];
  const leave = async (requests) => {
    for (const request of requests) {
      request.abort();
    }
    await Promise.all(requests.map((request) => request.done));
  };
  const rendered = (positions) =>
    positions.flatMap((n) => files(n)).filter((file) => existsSync(file));

  const first = land(2);
  await wait(10);
  await leave(first);
  const second = land(6);
  await wait(10);
  await leave(second);
  const started = Date.now();
  const last = land(10);
  const [video, audio] = await Promise.all([last[0].done, last[3].done]);
  const firstFrame = Date.now() - started;
  await Promise.all(last.map((request) => request.done));

  check(
    video.status === 200 && audio.status === 200,
    'the position the player stops at is served',
    `${video.status}, ${audio.status}`,
  );
  const leftBehind = rendered([2, 3, 4, 6, 7, 8]);
  check(
    leftBehind.length === 0,
    'nothing is rendered for positions the player already left',
    leftBehind.map((file) => path.relative(hls, file)).join(', ') || 'none',
  );
  check(
    firstFrame < 4000,
    'and its first frame does not wait for them',
    `${firstFrame}ms`,
  );
  await idle();

  const cold = land(0);
  await wait(10);
  await leave(cold);
  const cached = land(10);
  await Promise.all(cached.map((request) => request.done));
  await wait(3000);

  const stats = JSON.parse(await jobs()).jobs;
  const orphans = rendered([0, 1]);
  check(
    orphans.length === 0 && stats.running === 0 && stats.queued === 0,
    'a job nobody waits for stops, even when no one needs its slot',
    `${orphans.map((file) => path.relative(hls, file)).join(', ') || 'nothing rendered'}; ${JSON.stringify(stats)}`,
  );
}

section('a manifest while someone else is watching');

{
  const pack = path.join(workDir, 'concurrency-pack');
  rmSync(pack, { recursive: true, force: true });
  await mkdir(pack, { recursive: true });
  await copyFile(
    path.join(fixturesDir, 'movie.mkv'),
    path.join(pack, 'one.mkv'),
  );
  await copyFile(
    path.join(fixturesDir, 'sparse.mkv'),
    path.join(pack, 'two.mkv'),
  );
  const packed = await seedFixture(pack, { uploadLimit: SEED_RATE });

  const masterUrl = (file) =>
    `${server.base}/m3u8?magnet=${encodeURIComponent(packed.magnet)}&file=${file}`;
  const watched = await get(masterUrl(0), false);
  check(
    watched.status === 200,
    "the watched file's master is served",
    String(watched.status),
  );
  const videoUrl = new URL(
    watched.body.trim().split('\n').at(-1),
    `${server.base}/m3u8`,
  ).href;
  const watchedSegments = (await get(videoUrl, false)).body
    .trim()
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, videoUrl).href);

  const indexFile = path.join(
    cacheDir,
    'hls',
    packed.torrent.infoHash,
    '1',
    'index.json',
  );
  // Removing the cached index forces the manifest request to read the
  // torrent, which is the work the abort has to cancel.
  rmSync(path.dirname(indexFile), { recursive: true, force: true });

  const at = (request) => request.then((res) => ({ ...res, at: Date.now() }));
  const busy = [3, 4, 5].map((n) => at(get(watchedSegments[n])));
  await wait(100);

  const leaver = abortable(masterUrl(1));
  await wait(10);
  const builtBeforeAbort = existsSync(indexFile);
  leaver.abort();
  await leaver.done;
  await wait(3000);
  check(
    !builtBeforeAbort && !existsSync(indexFile),
    'a manifest request that is dropped takes its index read with it',
    builtBeforeAbort
      ? 'the index was already built before the request was dropped'
      : existsSync(indexFile)
        ? 'the index was written anyway'
        : 'no index written',
  );

  const opened = await at(get(masterUrl(1), false));
  const served = await Promise.all(busy);
  check(
    opened.status === 200 && served.every((r) => r.status === 200),
    'both players are served',
    `${opened.status}, ${served.map((r) => r.status).join(', ')}`,
  );
  const slowest = Math.max(...served.map((r) => r.ms));
  check(
    opened.at < Math.max(...served.map((r) => r.at)) && opened.ms < slowest,
    "a new player's manifest does not wait for another player's segments",
    `manifest in ${opened.ms}ms while segments took up to ${slowest}ms`,
  );
  packed.client.destroy();
  await idle();
}

await server.stop();
seeder.destroy();
process.exit(failureCount() ? 1 : 0);
