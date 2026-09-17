// Not part of `npm test`. How long a player waits for its first frame - on
// load, after a seek, after a scrub - and how fast playback can run, for
// several server variants against the same throttled seeder.
//
// Requests follow Shaka: for each track in turn, the segment it lands on and
// the next two. The first frame is the video and audio segments at the landing.
// Audio is the converted track, which is what real releases (TrueHD, DTS, AC3)
// mostly need.
//
//   node test/first-frame.mjs [KiB/s] [pieceKiB] [variants...]
//
// A variant is name=entry:segmentSeconds:prefetchSegments, e.g.
//   before=dist-before/index.js:6:3 after=dist/index.js:2:9
// Each variant gets a fresh server and an empty cache for its landings, and
// another for its sustained run, so neither sees the other's downloads.
import { rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { fixturesDir, get, seedFixture, startServer, workDir } from './lib.mjs';

const rate = Number(process.argv[2] ?? 512) * 1024;
const pieceLength = Number(process.argv[3] ?? 512) * 1024;
const variants = (
  process.argv.slice(4).length
    ? process.argv.slice(4)
    : ['before=dist-before/index.js:6:3', 'after=dist/index.js:2:9']
).map((spec) => {
  const [name, rest] = spec.split('=');
  const [entry, segment, prefetch] = rest.split(':');
  return { name, entry, segment, prefetch };
});

const MiB = 2 ** 20;
// Seconds into the film. Every landing is far enough from the others that none
// finds pieces an earlier one's look-ahead fetched (up to 18s with 6s segments).
const SCRUB = [100, 110, 20]; // a drag that settles on the last position
const SEEKS = [45, 70, 95];
const SUSTAINED_SECONDS = 60;
const IN_FLIGHT = 4; // Shaka: the segment being fetched plus three prefetched
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = path.join(fixturesDir, 'movie.mkv');
const { client, torrent, magnet } = await seedFixture(fixture, {
  uploadLimit: rate,
  pieceLength,
});
const bitrate = torrent.length / 120.5;
console.log(
  `seeding ${(torrent.length / MiB).toFixed(1)} MiB at ${(rate / 1024).toFixed(0)} KiB/s ` +
    `(${(rate / bitrate).toFixed(2)}x the film's bitrate), ${pieceLength / 1024} KiB pieces\n`,
);

function request(url) {
  const controller = new AbortController();
  const r = { url, status: null, at: null };
  r.done = fetch(url, { signal: controller.signal }).then(
    async (res) => {
      await res.arrayBuffer();
      r.status = res.status;
      r.at = Date.now();
      return r;
    },
    () => {
      r.status = 'aborted';
      r.at = Date.now();
      return r;
    },
  );
  r.abort = () => controller.abort();
  return r;
}

const playlist = (text, base) => {
  const segments = [];
  let start = 0;
  let duration = 0;
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8));
    } else if (line && !line.startsWith('#')) {
      segments.push({ url: new URL(line, base).href, start, duration });
      start += duration;
    }
  }
  return segments;
};

/** A server for `variant` on an empty cache; its pieces are wiped on start. */
async function freshServer(variant, port, phase) {
  const cacheDir = path.join(workDir, `first-frame-${variant.name}-${phase}`);
  rmSync(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  return startServer({
    name: `first-frame-${variant.name}-${phase}`,
    port,
    cacheDir,
    entry: variant.entry,
    env: {
      SEGMENT_DURATION: variant.segment,
      PREFETCH_SEGMENTS: variant.prefetch,
    },
  });
}

/** Master and media playlists plus init sections, as a player loads them. */
async function open(server) {
  const masterUrl = `${server.base}/m3u8?magnet=${encodeURIComponent(magnet)}`;
  const started = Date.now();
  const master = (await get(masterUrl, false)).body;
  const indexMs = Date.now() - started;

  const audioLine = [...master.matchAll(/#EXT-X-MEDIA:(.*)/g)]
    .map(([, attributes]) => attributes)
    .find((a) => /TYPE=AUDIO/.test(a) && /Ukrainian/.test(a));
  const audioUri = new URL(/URI="([^"]*)"/.exec(audioLine)[1], masterUrl).href;
  const videoUri = new URL(master.trim().split('\n').at(-1), masterUrl).href;
  const video = playlist((await get(videoUri, false)).body, videoUri);
  const audio = playlist((await get(audioUri, false)).body, audioUri);
  await Promise.all(
    [videoUri, audioUri].map(async (uri) => {
      const text = (await get(uri, false)).body;
      await get(new URL(/#EXT-X-MAP:URI="([^"]*)"/.exec(text)[1], uri).href);
    }),
  );
  return { indexMs, video, audio };
}

async function landings(variant, port) {
  const server = await freshServer(variant, port, 'landings');
  try {
    const { indexMs, video, audio } = await open(server);
    const at = (seconds) =>
      Math.min(
        video.findIndex((s) => s.start + s.duration > seconds),
        video.length - 3,
      );
    const land = (n) => [
      ...[n, n + 1, n + 2].map((k) => request(video[k].url)),
      ...[n, n + 1, n + 2].map((k) => request(audio[k].url)),
    ];
    const leave = async (requests) => {
      requests.forEach((r) => r.status || r.abort());
      await Promise.all(requests.map((r) => r.done));
    };
    const firstFrame = async (requests) => {
      const begun = Date.now();
      const [v, a] = await Promise.all([requests[0].done, requests[3].done]);
      if (v.status !== 200 || a.status !== 200) {
        throw new Error(`first frame failed: ${v.status}/${a.status}`);
      }
      return Date.now() - begun;
    };

    const result = { segments: video.length, indexMs, times: {} };
    let current = land(0);
    result.times.load = await firstFrame(current);

    await leave(current);
    const drag = SCRUB.map(at);
    for (const n of drag.slice(0, -1)) {
      const passing = land(n);
      await wait(10);
      await leave(passing);
    }
    current = land(drag.at(-1));
    result.times[`scrub to ${SCRUB.at(-1)}s`] = await firstFrame(current);

    for (const seconds of SEEKS) {
      await leave(current);
      current = land(at(seconds));
      result.times[`seek ${seconds}s`] = await firstFrame(current);
    }
    await leave(current);
    return result;
  } finally {
    await server.stop();
  }
}

/** A minute of both tracks from the start, as fast as the server allows. */
async function sustained(variant, port) {
  const server = await freshServer(variant, port, 'sustained');
  try {
    const { video, audio } = await open(server);
    const until = video.findIndex((s) => s.start >= SUSTAINED_SECONDS);
    const bytesBefore = torrent.uploaded;
    const started = Date.now();
    await Promise.all(
      [video, audio].map(async (track) => {
        let next = 0;
        const inFlight = new Set();
        const send = () => {
          const r = request(track[next++].url);
          const done = r.done.then((res) => {
            inFlight.delete(done);
            if (res.status !== 200) {
              throw new Error(`${res.url} -> ${res.status}`);
            }
          });
          inFlight.add(done);
        };
        while (next < until || inFlight.size) {
          while (inFlight.size < IN_FLIGHT && next < until) send();
          await Promise.race(inFlight);
        }
      }),
    );
    const wallMs = Date.now() - started;
    const content = video[until].start;
    return {
      content,
      wallMs,
      realtime: content / (wallMs / 1000),
      mib: (torrent.uploaded - bytesBefore) / MiB,
    };
  } finally {
    await server.stop();
  }
}

const results = [];
for (const [i, variant] of variants.entries()) {
  console.log(
    `running ${variant.name} (${variant.entry}, ${variant.segment}s segments, prefetch ${variant.prefetch})`,
  );
  const landed = await landings(variant, 3981 + i * 2);
  const steady = await sustained(variant, 3982 + i * 2);
  results.push({ name: variant.name, ...landed, sustained: steady });
  console.log(
    `  ${Object.entries(landed.times)
      .map(([what, ms]) => `${what} ${(ms / 1000).toFixed(1)}s`)
      .join(' | ')} | sustained ${steady.realtime.toFixed(2)}x realtime`,
  );
}

const labels = Object.keys(results[0].times);
const width = Math.max(...results.map((r) => r.name.length), 8);
console.log(
  `\nfirst frame, seconds (index build: ${results.map((r) => `${r.name} ${(r.indexMs / 1000).toFixed(1)}s`).join(', ')})`,
);
console.log(
  `${'variant'.padEnd(width)} | ${labels.map((l) => l.padStart(12)).join(' | ')} | ${'mean'.padStart(6)}`,
);
for (const r of results) {
  const values = labels.map((l) => r.times[l] / 1000);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `${r.name.padEnd(width)} | ${values.map((v) => v.toFixed(1).padStart(12)).join(' | ')} | ${mean.toFixed(1).padStart(6)}`,
  );
}
console.log(`\nsustained: ${SUSTAINED_SECONDS}s of video and audio from the start, on an empty cache`);
console.log(`${'variant'.padEnd(width)} | segments | wall time | realtime | MiB downloaded`);
for (const r of results) {
  const s = r.sustained;
  console.log(
    `${r.name.padEnd(width)} | ${String(r.segments).padStart(8)} | ${(s.wallMs / 1000).toFixed(1).padStart(8)}s | ${s.realtime.toFixed(2).padStart(7)}x | ${s.mib.toFixed(1).padStart(8)}`,
  );
}

client.destroy();
process.exit(0);
