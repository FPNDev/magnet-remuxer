// What happens when players do not wait politely: scrubbing the timeline, and
// several viewers reading the same asset at very different timestamps. The
// server has no idea who anyone is, so everything here is inferred from the
// requests themselves.
import { existsSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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

/** One slot per torrent, so anything beyond the first read has to queue. */
const JOBS_PER_TORRENT = 1;
const PREFETCH = 3;
/**
 * Throttled like test/bandwidth.mjs, and for the same reason: over localhost a
 * segment renders in about 50ms, so a queue of them drains before anyone could
 * notice it was there. A queue only hurts when its jobs take real time.
 */
const SEED_RATE = 1536 * 1024;
/** Positions the scrub drags through, and where it comes to rest. */
const SCRUBBED = 12;
const LANDING = 15;

rmSync(cacheDir, { recursive: true, force: true });
await mkdir(cacheDir, { recursive: true });

const { client: seeder, torrent: seeded, magnet } = await seedFixture(fixture, {
  uploadLimit: SEED_RATE,
});
const serverEnv = {
  MAX_JOBS_PER_TORRENT: String(JOBS_PER_TORRENT),
  PREFETCH_SEGMENTS: String(PREFETCH),
  REQUEST_TIMEOUT_S: '30',
  // Long segments, so each render takes a couple of seconds at SEED_RATE: what
  // is tested here is the order work runs in and what gets dropped, and that
  // only shows when work takes long enough to queue behind.
  SEGMENT_DURATION: '6',
};
let server = await startServer({
  name: 'concurrency',
  port,
  cacheDir,
  env: serverEnv,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request a player can walk away from, the way a seek does. */
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
  // Nothing here waits on these, and an abort is not a failure.
  done.catch(() => {});
  return { abort: () => controller.abort(), done };
}

const jobs = async () => (await get(`${server.base}/status`, false)).body;

/** Waits for the queue to settle, so one section cannot bleed into the next. */
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

/** Waits for segments to appear in the cache, which is where prefetch lands. */
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

// ---------------------------------------------------------------------------

section(
  `scrubbing - ${segments.length} segments at ${SEED_RATE / 1024} KiB/s, ` +
    `${JOBS_PER_TORRENT} job per torrent`,
);

{
  // Drag the scrub bar across the first half of the file: every position is
  // requested, and abandoned before it can be rendered, because the next
  // position is already wanted.
  const scrub = [];
  for (let i = 0; i < SCRUBBED; i++) {
    scrub.push(abortable(segments[i]));
    await wait(15);
  }
  const peak = JSON.parse(await jobs()).jobs.queued;
  check(peak > 0, 'a scrub really does pile work up', `${peak} queued at its peak`);

  scrub.forEach((request) => request.abort());
  await Promise.all(scrub.map((request) => request.done));
  await wait(250);

  const afterScrub = JSON.parse(await jobs()).jobs;
  check(
    afterScrub.queued === 0,
    'letting go of the scrub bar empties the queue',
    JSON.stringify(afterScrub),
  );

  // Where the player actually stopped: a position the scrub never asked for,
  // so it is cold. This is the request that used to sit behind every abandoned
  // one and time out before reaching the front.
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

// ---------------------------------------------------------------------------

section('two viewers, far apart in the same file');

{
  // The far viewer arrives first and gets its prefetch queued behind the one
  // job this torrent is allowed...
  const far = await get(segments[12]);
  check(far.status === 200, 'the far viewer is served', String(far.status));

  // ...and the near viewer turns up before any of it has run. Cancelling
  // prefetch by rendition would throw the far viewer's window away here.
  const near = await get(segments[0]);
  check(near.status === 200, 'the near viewer is served too', String(near.status));

  const farMissing = await rendered([13, 14, 15]);
  check(
    farMissing.length === 0,
    'a second viewer elsewhere in the file keeps its own prefetch',
    farMissing.length ? `never rendered: ${farMissing.join(', ')}` : '13, 14, 15',
  );

  const nearMissing = await rendered([1, 2, 3]);
  check(
    nearMissing.length === 0,
    'and the first viewer still gets its own',
    nearMissing.length ? `never rendered: ${nearMissing.join(', ')}` : '1, 2, 3',
  );
  await idle();
}

// ---------------------------------------------------------------------------

section('two viewers on the same segment');

{
  // Two viewers are waiting on segment 7, queued behind a render that holds the
  // torrent's only slot, with segment 8 queued after them. One of the two leaves.
  // The job is still wanted, so it keeps its place: 7 renders before 8.
  //
  // Dropping the job on that first abort would still end in a 200 - the viewer
  // who stayed retries - but from the back of the queue, behind 8. Order is
  // what tells the two apart.
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

section('one viewer reading ahead while another seeks');

{
  // Viewer A is playing at segment 1 and asks for 2, 3 and 4 at once, the way a
  // player fills its buffer. Viewer B seeks to 16 a moment later. With one job
  // per torrent something has to wait: it should be A's look-ahead, not B's
  // only segment. In arrival order B would come last.
  //
  // Only a restart makes this honest. Every earlier section already downloaded
  // these pieces, and pieces render in milliseconds; the server wipes them on
  // start, which puts the swarm back between a request and its segment.
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
  // Holds the torrent's one slot while everything else arrives.
  const blocker = at(get(url(11)));
  await wait(100);
  // Segment 1 is still on disk, so this is served at once and puts A's
  // playhead there - which is what makes 2, 3 and 4 look-ahead.
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
    [playing, held, next, further, furthest, seek].every((res) => res.status === 200),
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
  // What Shaka sends on load and after every seek: for each track in turn, the
  // segment it lands on and the next two. The first frame needs video 7 and
  // audio 7; video 8 and 9 are look-ahead and must not come between them. In
  // arrival order they would, and on a release with 60 MiB segments that is a
  // minute the first frame waits for nothing.
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

  // e.g. /<infoHash>/0/audio/2/7.m4s -> audio, 2
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
  // A player dragged along the timeline: it lands, and 10ms later lands
  // somewhere else, cancelling what it asked for. Whatever the server started
  // for the positions it left has to stop - not wait for a player to need the
  // slot, because when the next position is already cached nobody ever will.
  const oldBase = server.base;
  await server.stop();
  server = await startServer({
    name: 'concurrency-seeking',
    port: port + 2,
    cacheDir,
    env: serverEnv,
  });
  const onServer = (href) => href.replace(oldBase, server.base).replace(/^http:\/\/[^/]+/, server.base);

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
    files(n).forEach((file) => rmSync(file, { force: true }));
  }

  /** What Shaka sends on landing at n: each track's n, n+1, n+2. */
  const land = (n) => [
    ...[n, n + 1, n + 2].map((k) => abortable(onServer(segments[k]))),
    ...[n, n + 1, n + 2].map((k) => abortable(onServer(audioSegments[k]))),
  ];
  const leave = async (requests) => {
    requests.forEach((request) => request.abort());
    await Promise.all(requests.map((request) => request.done));
  };
  const rendered = (positions) =>
    positions.flatMap((n) => files(n)).filter((file) => existsSync(file));

  // Cold, cold, cold: only the last landing should do any work.
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

  // Cold, then a position that is already cached: no player is left waiting
  // for a slot, so nothing would ever preempt a job that merely lost priority.
  const cold = land(0);
  await wait(10);
  await leave(cold);
  const cached = land(10);
  await Promise.all(cached.map((request) => request.done));
  await wait(3000); // longer than a render takes at this seed rate

  const stats = JSON.parse(await jobs()).jobs;
  const orphans = rendered([0, 1]);
  check(
    orphans.length === 0 && stats.running === 0 && stats.queued === 0,
    'a job nobody waits for stops, even when no one needs its slot',
    `${orphans.map((file) => path.relative(hls, file)).join(', ') || 'nothing rendered'}; ${JSON.stringify(stats)}`,
  );
}

await server.stop();
seeder.destroy();
process.exit(failureCount() ? 1 : 0);
