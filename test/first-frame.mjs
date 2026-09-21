import { rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { fixturesDir, get, seedFixture, startServer, workDir } from './lib.mjs';

// Benchmark, not a pass/fail suite. Arguments: seed rate in KiB/s, piece
// length in KiB, then variant specs of name=entry:segmentSeconds:prefetch.
const rate = Number(process.argv[2] ?? 512) * 1024;
const pieceLength = Number(process.argv[3] ?? 512) * 1024;
// With no variant given, the current build is measured against an earlier
// one left in dist-before/.
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
const SCRUB = [100, 110, 20];
const SEEKS = [45, 70, 95];
const SUSTAINED_SECONDS = 60;
const IN_FLIGHT = 4;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = path.join(fixturesDir, 'movie.mkv');
const { client, torrent, magnet } = await seedFixture(fixture, {
  uploadLimit: rate,
  pieceLength,
});
// The movie fixture runs 120.5 seconds, which turns the seed rate into a
// multiple of the film's own bitrate.
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
      for (const r of requests) {
        if (!r.status) {
          r.abort();
        }
      }
      await Promise.all(requests.map((r) => r.done));
    };
    // Requests 0 and 3 are the video and audio segment the player needs to show
    // a frame; the rest are the look-ahead it would ask for at the same time.
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

// Plays from the start with a fixed number of requests in flight per track,
// which shows whether rendering keeps up with realtime.
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
          while (inFlight.size < IN_FLIGHT && next < until) {
            send();
          }
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
console.log(
  `\nsustained: ${SUSTAINED_SECONDS}s of video and audio from the start, on an empty cache`,
);
console.log(
  `${'variant'.padEnd(width)} | segments | wall time | realtime | MiB downloaded`,
);
for (const r of results) {
  const s = r.sustained;
  console.log(
    `${r.name.padEnd(width)} | ${String(r.segments).padStart(8)} | ${(s.wallMs / 1000).toFixed(1).padStart(8)}s | ${s.realtime.toFixed(2).padStart(7)}x | ${s.mib.toFixed(1).padStart(8)}`,
  );
}

client.destroy();
process.exit(0);
