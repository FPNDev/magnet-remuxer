import { existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  check,
  directorySize,
  failureCount,
  fixturesDir,
  get,
  packetCount,
  packets,
  section,
  seedFixture,
  startServer,
  summarize,
  workDir,
} from './lib.mjs';

const fixture = path.join(fixturesDir, 'movie.mkv');
const out = path.join(workDir, 'e2e');
const cacheA = path.join(workDir, 'e2e-cache-a');
const cacheB = path.join(workDir, 'e2e-cache-b');
const basePort = Number(process.env.TEST_PORT ?? 3901);

rmSync(out, { recursive: true, force: true });
rmSync(cacheA, { recursive: true, force: true });
rmSync(cacheB, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const { client: seeder, torrent: seeded, magnet } = await seedFixture(fixture);
const encoded = encodeURIComponent(magnet);

const parseMaster = (text, base) => ({
  media: [...text.matchAll(/#EXT-X-MEDIA:(.*)/g)].map(([, attributes]) => ({
    type: /TYPE=(\w+)/.exec(attributes)[1],
    name: /NAME="([^"]*)"/.exec(attributes)[1],
    uri: new URL(/URI="([^"]*)"/.exec(attributes)[1], base).href,
    isDefault: /DEFAULT=YES/.test(attributes),
  })),
  video: new URL(text.trim().split('\n').at(-1), base).href,
});

const parseMedia = (text, base) => {
  if (!text.startsWith('#EXTM3U')) {
    throw new Error(`not a playlist: ${text.slice(0, 200)}`);
  }
  const lines = text.trim().split('\n');
  const init = /#EXT-X-MAP:URI="([^"]*)"/.exec(text)?.[1];
  return {
    init: init && new URL(init, base).href,
    durations: lines
      .filter((l) => l.startsWith('#EXTINF:'))
      .map((l) => parseFloat(l.slice(8))),
    segments: lines
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => new URL(l, base).href),
    target: Number(/TARGETDURATION:(\d+)/.exec(text)?.[1] ?? 0),
  };
};

// The init section plus every segment must decode as one stream: DTS never
// goes backwards, and AAC frames stay exactly 1024 samples apart.
async function verifyConcat(
  label,
  parts,
  { expectedPackets, contiguousAac = false } = {},
) {
  const file = path.join(out, `${label.replace(/\W+/g, '_')}.mp4`);
  await writeFile(file, Buffer.concat(parts));
  const produced = await packets(file);

  let regressions = 0;
  let gaps = 0;
  for (let i = 1; i < produced.length; i++) {
    if (produced[i][1] <= produced[i - 1][1]) {
      regressions++;
    }
    if (contiguousAac && produced[i][0] - produced[i - 1][0] !== 1024) {
      gaps++;
    }
  }
  const countOk =
    expectedPackets === undefined || produced.length === expectedPackets;
  check(
    countOk && regressions === 0 && gaps === 0,
    `${label} decodes continuously`,
    `packets=${produced.length}${expectedPackets === undefined ? '' : `/${expectedPackets}`} dtsRegressions=${regressions}${contiguousAac ? ` aacGaps=${gaps}` : ''}`,
  );
}

// The piece budget is smaller than the fixture, so pieces are evicted while
// the run is still reading the file.
section('server A - sequential playback, 8 MiB piece budget');
let a = await startServer({
  name: 'a',
  port: basePort,
  cacheDir: cacheA,
  env: { PIECE_CACHE_MB: '8' },
});

check(
  (await get(`${a.base}/m3u8`, false)).status === 400,
  'missing magnet → 400',
);
check(
  (await get(`${a.base}/m3u8?magnet=nonsense`, false)).status === 400,
  'invalid magnet → 400',
);
check(
  (await get(`${a.base}/${'ab'.repeat(20)}/0/video/index.m3u8`, false))
    .status === 404,
  'unknown info hash → 404',
);

const files = await get(`${a.base}/files?magnet=${encoded}`, false);
check(
  files.status === 200,
  'lists the torrent files',
  `${files.ms}ms ${files.body}`,
);

const master = await get(`${a.base}/m3u8?magnet=${encoded}`, false);
check(
  master.status === 200 && master.type.includes('mpegurl'),
  'master playlist on a cold cache',
  `${master.ms}ms`,
);
console.log(master.body);

const { media, video } = parseMaster(master.body, `${a.base}/m3u8`);
const playlists = {};
for (const entry of [{ type: 'VIDEO', name: 'video', uri: video }, ...media]) {
  const res = await get(entry.uri, false);
  const parsed = parseMedia(res.body, entry.uri);
  playlists[entry.name] = { ...entry, ...parsed };
  const total = parsed.durations.reduce((sum, d) => sum + d, 0);
  check(
    res.status === 200,
    `media playlist: ${entry.name}`,
    `${res.ms}ms segments=${parsed.segments.length} total=${total.toFixed(3)}s target=${parsed.target}`,
  );
}

const videoPlaylist = playlists.video;
const defaultAudio = Object.values(playlists).find(
  (p) => p.type === 'AUDIO' && p.isDefault,
);
const otherAudio = Object.values(playlists).find(
  (p) => p.type === 'AUDIO' && !p.isDefault,
);
const subtitles = Object.values(playlists).filter(
  (p) => p.type === 'SUBTITLES',
);

const videoInit = await get(videoPlaylist.init);
const audioInit = await get(defaultAudio.init);
check(
  videoInit.status === 200 && audioInit.status === 200,
  'init sections',
  `video ${videoInit.ms}ms audio ${audioInit.ms}ms`,
);

const videoParts = [videoInit.body];
const audioParts = [audioInit.body];
const timings = { video: [], audio: [], subtitles: [] };
let cues = 0;
for (let n = 0; n < videoPlaylist.segments.length; n++) {
  const [v, audio, text] = await Promise.all([
    get(videoPlaylist.segments[n]),
    get(defaultAudio.segments[n]),
    get(subtitles[0].segments[n], false),
  ]);
  if (v.status !== 200 || audio.status !== 200 || text.status !== 200) {
    check(
      false,
      `segment ${n}`,
      `video=${v.status} audio=${audio.status} subtitles=${text.status}`,
    );
    continue;
  }
  videoParts.push(v.body);
  audioParts.push(audio.body);
  cues += (text.body.match(/-->/g) ?? []).length;
  timings.video.push(v.ms);
  timings.audio.push(audio.ms);
  timings.subtitles.push(text.ms);
}
console.log(
  `video ${summarize(timings.video)}; audio ${summarize(timings.audio)}; subtitles ${summarize(timings.subtitles)}`,
);

// Stream indexes in the fixture: 0 video, 1 default audio, 3 subtitles.
await verifyConcat('A video', videoParts, {
  expectedPackets: await packetCount(fixture, 0),
});
await verifyConcat('A default audio', audioParts, {
  expectedPackets: await packetCount(fixture, 1),
});
check(
  cues === (await packetCount(fixture, 3)),
  'every subtitle cue is served exactly once',
  `${cues} cues`,
);

check(
  directorySize(path.join(cacheA, 'pieces')) <= 10 * 1024 * 1024,
  'piece cache stays near its budget',
  `${(directorySize(path.join(cacheA, 'pieces')) / 1048576).toFixed(1)} MiB on disk`,
);

const otherInit = await get(otherAudio.init);
const otherParts = [otherInit.body];
const otherTimings = [];
let otherFailures = 0;
for (const url of otherAudio.segments) {
  const res = await get(url);
  if (res.status !== 200) {
    otherFailures++;
  } else {
    otherParts.push(res.body);
  }
  otherTimings.push(res.ms);
}
check(
  otherFailures === 0,
  'converted audio track after its pieces were evicted',
  `${otherAudio.segments.length} segments, ${summarize(otherTimings)}`,
);
await verifyConcat('A converted audio', otherParts, { contiguousAac: true });

console.log(`status: ${(await get(`${a.base}/status`, false)).body}`);

section('server B - cold cache, seeking and concurrency');
const b = await startServer({
  name: 'b',
  port: basePort + 1,
  cacheDir: cacheB,
});
const onB = (url) => url.replace(a.base, b.base);

const rawMaster = await get(`${b.base}/m3u8?magnet=${magnet}`, false);
check(
  rawMaster.status === 200,
  'master playlist from an unencoded magnet link',
  `${rawMaster.ms}ms`,
);

const bInit = (await get(onB(videoPlaylist.init))).body;
const lastSegment = videoPlaylist.segments.length - 1;
for (const n of [10, 3, lastSegment, 0]) {
  const res = await get(onB(videoPlaylist.segments[n]));
  const file = path.join(out, `seek-${n}.mp4`);
  await writeFile(file, Buffer.concat([bInit, res.body]));
  const count = res.status === 200 ? (await packets(file)).length : 0;
  check(
    res.status === 200 && count > 0,
    `seek straight to video segment ${n}`,
    `${res.ms}ms packets=${count}`,
  );
}

const shared = onB(otherAudio.segments[7]);
const clients = await Promise.all(Array.from({ length: 6 }, () => get(shared)));
check(
  clients.every((c) => c.status === 200 && c.body.equals(clients[0].body)),
  'six clients requesting one segment get identical bytes',
  clients.map((c) => `${c.ms}ms`).join(' '),
);

const mixed = await Promise.all(
  [5, 6, 12, 13, 14].flatMap((n) => [
    get(onB(videoPlaylist.segments[n])),
    get(onB(defaultAudio.segments[n])),
  ]),
);
check(
  mixed.every((r) => r.status === 200),
  'parallel requests across segments and renditions',
  mixed.map((r) => `${r.ms}ms`).join(' '),
);
check(
  existsSync(path.join(cacheB, 'hls', seeded.infoHash, '0', 'master.m3u8')),
  'master playlist is cached on disk',
);
await b.stop();

section('server A - restarted');
await a.stop();
a = await startServer({ name: 'a', port: basePort, cacheDir: cacheA });

const warmMaster = await get(`${a.base}/m3u8?magnet=${encoded}`, false);
check(
  warmMaster.status === 200 && warmMaster.body === master.body,
  'master served from disk after a restart',
  `${warmMaster.ms}ms`,
);

const cachedSegment = await get(videoPlaylist.segments[4]);
check(
  cachedSegment.status === 200 && cachedSegment.body.equals(videoParts[5]),
  'rendered segment served from disk',
  `${cachedSegment.ms}ms`,
);

// Fixture cues sit at 1s and every 2s after. Pick a segment holding one
// clear of both edges, so the rendered VTT cannot come out empty.
const cueSegment = (() => {
  let start = 0;
  return subtitles[1].durations.findIndex((duration) => {
    const end = start + duration;
    const found = Array.from({ length: 60 }, (_, i) => 1 + i * 2).some(
      (cue) => cue > start + 0.2 && cue < end - 0.2,
    );
    start = end;
    return found && start > 4;
  });
})();
const freshSegment = await get(subtitles[1].segments[cueSegment], false);
check(
  freshSegment.status === 200 && freshSegment.body.includes('-->'),
  'segment rendered after a restart, from saved torrent metadata',
  `${freshSegment.ms}ms`,
);
await a.stop();

seeder.destroy();
process.exit(failureCount() ? 1 : 0);
