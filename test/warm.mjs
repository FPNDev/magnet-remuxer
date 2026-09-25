// Warming a title before anyone plays it: what GET /warm answers while the
// work is queued, in flight and done, what that leaves on disk, whether the
// warmed title still plays with the seeder gone, and what WARM_SEGMENTS=0
// warms.
//
//   node test/warm.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  cacheRoot,
  dirFiles,
  ensureFixtures,
  exists,
  fileSize,
  fixtures,
  reporter,
  resolveBinaries,
  seed,
  suitePort,
  TestServer,
  waitFor,
} from './lib.mjs';

const CACHE_DIR = `${cacheRoot}/warm`;
const ZERO_CACHE_DIR = `${cacheRoot}/warm-zero`;
const PORT = suitePort(1);
const WARM_SEGMENTS = 2;

await resolveBinaries();
await ensureFixtures();

const report = reporter('warm');
const server = await TestServer.start({
  name: 'warm',
  port: PORT,
  cacheDir: CACHE_DIR,
});
const seeded = await seed(fixtures.tiny());
const query = `magnet=${encodeURIComponent(seeded.magnet)}&file=0`;

/** Log lines written after the byte offset, so a restart can be read alone. */
async function logSince(target, offset) {
  const text = await readFile(target.logPath, 'utf8').catch(() => '');
  return text.slice(offset);
}

/** The "Rendered segment" records in a log slice, one per ffmpeg run. */
function rendersIn(log) {
  const renders = [];
  for (const line of log.split('\n')) {
    if (!line.includes('Rendered segment')) {
      continue;
    }
    renders.push(JSON.parse(line.slice(line.indexOf('{'))));
  }
  return renders;
}

/** The readiness shape the route advertises. */
function isReadiness(body) {
  const keys = Object.keys(body).sort().join(',');
  return (
    keys === 'full,infoHash,pending,queued,ready,warming' &&
    typeof body.infoHash === 'string' &&
    typeof body.ready === 'boolean' &&
    typeof body.queued === 'boolean' &&
    typeof body.warming === 'boolean' &&
    typeof body.pending === 'number' &&
    typeof body.full === 'boolean'
  );
}

const readinessOf = async () => (await server.request(`/warm?${query}`)).json();

report.section('the readiness answer');

const firstCall = await readinessOf();

await report.check('GET /warm answers readiness for one title', async () => {
  return {
    passed: isReadiness(firstCall) && firstCall.infoHash === seeded.infoHash,
    detail: JSON.stringify(firstCall),
  };
});

await report.check('the first call queues a cold title', async () => {
  return {
    passed:
      firstCall.ready === false &&
      (firstCall.queued === true || firstCall.warming === true),
    detail: JSON.stringify(firstCall),
  };
});

const secondCall = await readinessOf();

await report.check(
  'a second call while warming is in flight answers warming',
  async () => {
    return {
      passed:
        isReadiness(secondCall) &&
        secondCall.infoHash === seeded.infoHash &&
        (secondCall.warming === true || secondCall.ready === true),
      detail: JSON.stringify(secondCall),
    };
  },
);

report.section('what warming leaves behind');

// `ready` only means the playlists are written; the opening segments are
// rendered after that, so wait until the queue is no longer holding the title.
const readiness = await waitFor(
  async () => {
    const body = await readinessOf();
    return body.ready && !body.warming ? body : false;
  },
  { timeoutMs: 120_000, intervalMs: 200 },
);

const masterResponse = await server.request(`/m3u8?${query}`);
const masterText = masterResponse.text;
const mediaDir = path.join(CACHE_DIR, 'hls', seeded.infoHash, '0');
const masterFile = path.join(mediaDir, 'master.m3u8');
const segmentFile = path.join(mediaDir, 'video', '0.m4s');

// Warming renders the opening tracks, which are the default audio and the
// video, so those two directories are the ones that fill up.
const defaultAudio = [...masterText.matchAll(/URI="([^"]+)"/g)]
  .map((match) => match[1])
  .find((uri) => uri.includes('/audio/') && uri.endsWith('/index.m3u8'));
if (!defaultAudio) {
  throw new Error('the master playlist lists no audio rendition');
}
const audioDir = defaultAudio
  .slice(`${seeded.infoHash}/0/`.length)
  .replace(/\/index\.m3u8$/, '');

const expected = [
  path.join(mediaDir, 'master.m3u8'),
  path.join(mediaDir, 'index.json'),
  path.join(mediaDir, 'video', 'index.m3u8'),
  path.join(mediaDir, 'video', 'init.mp4'),
  path.join(mediaDir, audioDir, 'index.m3u8'),
  path.join(mediaDir, audioDir, 'init.mp4'),
];
for (let n = 0; n < WARM_SEGMENTS; n++) {
  expected.push(path.join(mediaDir, 'video', `${n}.m4s`));
  expected.push(path.join(mediaDir, audioDir, `${n}.m4s`));
}
const onDisk = await dirFiles(mediaDir);
const absent = expected.filter((file) => !onDisk.includes(file));

await report.check(
  'the playlists and first segments are on disk afterwards',
  async () => {
    const storedMaster = await readFile(masterFile, 'utf8');
    const served =
      masterResponse.status === 200 && masterText === storedMaster;
    return {
      passed: readiness.ready === true && served && absent.length === 0,
      detail:
        `ready=${readiness.ready}, pending=${readiness.pending}, ` +
        (absent.length === 0
          ? `${expected.length} expected files present`
          : `missing ${absent.join(', ')}`),
    };
  },
);

const warmedBytes = await readFile(segmentFile);

report.section('with the swarm gone');

await server.stop();
await seeded.close();
await server.restart({});

const restartMark = await fileSize(server.logPath);
const startedAt = Date.now();
const segmentAfter = await server.request(
  `/${seeded.infoHash}/0/video/0.m4s`,
);
const elapsed = Date.now() - startedAt;
const restartRenders = rendersIn(await logSince(server, restartMark));
const unchanged = segmentAfter.bytes.equals(warmedBytes);

await report.check('a warmed title plays without waiting on the swarm', async () => {
  return {
    passed:
      segmentAfter.status === 200 &&
      segmentAfter.bytes.length > 0 &&
      unchanged &&
      restartRenders.length === 0,
    detail:
      `segment ${segmentAfter.status} ${segmentAfter.bytes.length}B in ` +
      `${elapsed}ms, identical to the warmed file=${unchanged}, ` +
      `renders=${restartRenders.length}`,
  };
});

const fileListAfter = await server.request(`/files?${query}`);

await report.check(
  'the file list still answers after a restart with no swarm',
  async () => {
    const body = fileListAfter.json();
    const ok =
      fileListAfter.status === 200 &&
      body.infoHash === seeded.infoHash &&
      Array.isArray(body.files) &&
      body.files.some((file) => file.playable) &&
      restartRenders.length === 0;
    return {
      passed: ok,
      detail:
        `${fileListAfter.status} ${body.name}, ` +
        `${body.files?.length ?? 0} file(s), ` +
        `cache-control=${fileListAfter.headers.get('cache-control')}`,
    };
  },
);

// The playlists are cached, so a title that has been warmed never needs the
// swarm to answer readiness or the file list.
report.note(
  `readiness before the restart: ${JSON.stringify(readiness)}; ` +
    `the second call while warming ran: ${JSON.stringify(secondCall)}`,
);

await server.stop();

// WARM_SEGMENTS is read once, at import, so the zero case needs its own
// server - and its own cache, since a warmed one would answer from disk.
let zero;
let zeroSeeded;

try {
  zero = await TestServer.start({
    name: 'warm-zero',
    port: PORT,
    cacheDir: ZERO_CACHE_DIR,
    options: { fresh: true, env: { WARM_SEGMENTS: '0' } },
  });
  zeroSeeded = await seed(fixtures.tiny());
  const zeroQuery = `magnet=${encodeURIComponent(zeroSeeded.magnet)}&file=0`;
  const zeroFirst = (await zero.request(`/warm?${zeroQuery}`)).json();

  await report.check('the first call still queues a cold title', async () => {
    return {
      passed:
        isReadiness(zeroFirst) &&
        zeroFirst.ready === false &&
        (zeroFirst.queued === true || zeroFirst.warming === true),
      detail: JSON.stringify(zeroFirst),
    };
  });

  const zeroReady = await waitFor(
    async () => {
      const body = (await zero.request(`/warm?${zeroQuery}`)).json();
      return body.ready && !body.warming ? body : false;
    },
    { timeoutMs: 120_000, intervalMs: 200 },
  );

  const zeroMediaDir = path.join(
    ZERO_CACHE_DIR,
    'hls',
    zeroSeeded.infoHash,
    '0',
  );
  const zeroFiles = await dirFiles(zeroMediaDir);
  const isSegment = (file) => /[\\/]\d+\.(m4s|vtt)$/.test(file);
  const zeroSegments = zeroFiles.filter(isSegment);
  const zeroInits = zeroFiles.filter((file) => file.endsWith('init.mp4'));

  await report.check(
    'WARM_SEGMENTS=0 warms the index and playlists only',
    async () => {
      const parts = ['master.m3u8', 'index.json', 'video/index.m3u8'];
      const stored = [];
      for (const part of parts) {
        stored.push(await exists(path.join(zeroMediaDir, ...part.split('/'))));
      }
      const ok =
        zeroReady.ready === true &&
        stored.every(Boolean) &&
        zeroInits.length > 0 &&
        zeroSegments.length === 0;
      return {
        passed: ok,
        detail:
          `${zeroFiles.length} files: ${zeroInits.length} init, ` +
          `${zeroSegments.length} segments`,
      };
    },
  );

  const zeroLog = await logSince(zero, 0);
  const warmed = zeroLog
    .split('\n')
    .filter((line) => line.includes('Warmed a title'))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));

  await report.check('the warm run reports the segments it rendered', async () => {
    const ok =
      warmed.length > 0 && warmed.every((entry) => entry.segments === 0);
    const lines = warmed.map(
      (entry) => `segments=${entry.segments} ms=${entry.ms}`,
    );
    return {
      passed: ok,
      detail: lines.join(', ') || 'no "Warmed a title" line',
    };
  });

  report.note(
    `readiness after warming with no segments: ${JSON.stringify(zeroReady)}`,
  );
} finally {
  await zero?.stop();
  await zeroSeeded?.close();
}

report.finish();
process.exit(process.exitCode ?? 0);
