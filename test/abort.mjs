import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Remuxer } from '../dist/hls/remux.js';
import { LocalFileSource } from '../dist/io/byte-source.js';
import { getRenditions } from '../dist/media/codecs.js';
import { buildMediaIndex, segmentCount } from '../dist/media/media-index.js';
import {
  FFMPEG,
  check,
  failureCount,
  fixturesDir,
  section,
  workDir,
} from './lib.mjs';

const ATTEMPTS = Number(process.argv[2] ?? 120);
// A render that has not settled this long after its abort counts as hung.
const SETTLE_MS = 5000;
const BATCH = Number(process.argv[3] ?? 12);
const out = path.join(workDir, 'abort');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const file = path.join(fixturesDir, 'movie.mkv');
const source = await LocalFileSource.open(file);
const index = await buildMediaIndex(source, path.basename(file), 2);
const { video, audio } = getRenditions(index);
const tracks = [video, ...audio];
const remuxer = new Remuxer({ ffmpegPath: FFMPEG, timeoutMs: 30_000 });
const count = segmentCount(index);

section(`stopping renders part way - ${ATTEMPTS} attempts`);

let hung = 0;
let finished = 0;
let stopped = 0;

async function attempt(i) {
  const rendition = tracks[i % tracks.length];
  const controller = new AbortController();
  const target = { index, source, rendition, signal: controller.signal };
  const render = remuxer
    .writeSegment(target, i % count, path.join(out, `${i}.m4s`))
    .then(
      () => 'finished',
      () => 'stopped',
    );
  // Abort delays sweep 1-30ms so renders stop at different stages:
  // before ffmpeg spawns, during the header write, and mid-stream.
  setTimeout(
    () => controller.abort(new Error('stopped by the queue')),
    1 + (i % 30),
  );
  return Promise.race([render, wait(SETTLE_MS).then(() => 'hung')]);
}

// Batched so the number of live ffmpeg processes stays bounded.
for (let i = 0; i < ATTEMPTS; i += BATCH) {
  const batch = await Promise.all(
    Array.from({ length: Math.min(BATCH, ATTEMPTS - i) }, (_, k) =>
      attempt(i + k),
    ),
  );
  for (const result of batch) {
    if (result === 'hung') {
      hung++;
    } else if (result === 'finished') {
      finished++;
    } else {
      stopped++;
    }
  }
}

check(
  hung === 0,
  'every render that is stopped part way settles',
  `${stopped} stopped, ${finished} finished first, ${hung} still running after ${SETTLE_MS}ms`,
);
check(
  stopped > 0,
  'and the attempts really do stop renders mid-flight',
  `${stopped} of ${ATTEMPTS}`,
);

process.exit(failureCount() ? 1 : 0);
