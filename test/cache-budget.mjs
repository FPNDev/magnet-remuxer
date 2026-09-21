import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../dist/cache/cache-layout.js';
import { DiskGuard } from '../dist/cache/disk-guard.js';
import { MetadataCache } from '../dist/cache/metadata-cache.js';
import { SegmentCache } from '../dist/cache/segment-cache.js';
import { PieceCache } from '../dist/torrent/piece-store.js';
import {
  check,
  directorySize,
  failureCount,
  section,
  workDir,
} from './lib.mjs';

const KiB = 1024;
const HOUR = 3_600_000;
const root = path.join(workDir, 'cache-budget');
// Stand-in info hashes. The cache layout only needs 40 hex characters.
const hash = (n) => String(n).repeat(40).slice(0, 40);
const TITLES = [hash(1), hash(2), hash(3), hash(4)];
const METADATA_PER_TITLE = 4 * 64 * KiB;
const SEGMENTS_PER_TITLE = 4 * 256 * KiB;
const PIECES_PER_TITLE = 4 * 256 * KiB;

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

const layout = new CacheLayout(root);
const segmentFile = (infoHash, n) =>
  path.join(layout.mediaDir(infoHash, 0), 'video', `${n}.m4s`);
const pieceFile = (infoHash, n) =>
  path.join(layout.piecesDir, infoHash, `${n}.piece`);

// Lays down four titles whose mtimes step back an hour each, so least
// recently used order is fixed before a sweep runs. ages shifts one class.
async function build({ ages = {} } = {}) {
  await rm(root, { recursive: true, force: true, maxRetries: 20 });
  for (const [age, infoHash] of TITLES.entries()) {
    const filler = (kib) => Buffer.alloc(kib * KiB, age + 1);
    const when = (hours) => new Date(Date.now() - hours * HOUR);
    const titleAge = TITLES.length - age;

    await mkdir(layout.torrentDir(infoHash), { recursive: true });
    await mkdir(path.join(layout.mediaDir(infoHash, 0), 'video'), {
      recursive: true,
    });
    await mkdir(path.join(layout.piecesDir, infoHash), { recursive: true });

    const written = [];
    for (const file of [
      layout.magnetFile(infoHash),
      layout.torrentFile(infoHash),
      layout.indexFile(infoHash, 0),
      layout.masterFile(infoHash, 0),
    ]) {
      await writeFile(file, filler(64));
      written.push([file, titleAge + (ages.metadata ?? 0)]);
    }
    for (const n of [0, 1, 2, 3]) {
      await writeFile(segmentFile(infoHash, n), filler(256));
      written.push([segmentFile(infoHash, n), titleAge + (ages.segments ?? 0)]);
      await writeFile(pieceFile(infoHash, n), filler(256));
      written.push([pieceFile(infoHash, n), titleAge + (ages.pieces ?? 0)]);
    }
    for (const [file, hours] of written) {
      await utimes(file, when(hours), when(hours));
    }
  }
}

async function caches({ metadataBytes = 1024 * 1024 * KiB } = {}) {
  const pieces = new PieceCache(layout.piecesDir, 1024 * 1024 * KiB);
  await pieces.load();
  const segments = new SegmentCache(layout.hlsDir, 1024 * 1024 * KiB);
  await segments.load();
  const metadata = new MetadataCache(layout, metadataBytes);
  return { pieces, segments, metadata };
}

// intervalMs outlasts the run, so the only sweep is the explicit one.
const guardFor = (held, { totalBytes, inUse = [] }) =>
  new DiskGuard({
    layout,
    ...held,
    totalBytes,
    intervalMs: HOUR,
    inUse: () => new Set(inUse),
  });

section('metadata, which has no budget of its own until now');
await build();
let held = await caches({ metadataBytes: METADATA_PER_TITLE * 2.5 });
let usage = await guardFor(held, { totalBytes: 1024 * 1024 * KiB }).sweep();

check(
  usage.titles === TITLES.length,
  'every title on disk is accounted for',
  `${usage.titles} titles, ${Math.round(usage.total / KiB)} KiB`,
);
check(
  !(await exists(layout.indexFile(TITLES[0], 0))) &&
    !(await exists(layout.magnetFile(TITLES[1], 0))),
  'the two nothing has wanted in longest lose their playlists and index',
  `${Math.round(usage.metadata / KiB)} KiB left`,
);
check(
  (await exists(layout.indexFile(TITLES[2], 0))) &&
    (await exists(layout.masterFile(TITLES[3], 0))),
  'and the two most recently wanted keep theirs',
  '',
);
check(
  await exists(segmentFile(TITLES[0], 0)),
  'segments of a dropped title stay: they are still exactly what the index cuts',
  '',
);

section('a title asked for again');
await build();
held = await caches({ metadataBytes: METADATA_PER_TITLE * 2.5 });
await guardFor(held, {
  totalBytes: 1024 * 1024 * KiB,
  inUse: TITLES,
}).sweep();
held.metadata.touch(TITLES[0]);
usage = await guardFor(held, { totalBytes: 1024 * 1024 * KiB }).sweep();

check(
  await exists(layout.indexFile(TITLES[0], 0)),
  'is the most recently used, however old its files are',
  '',
);
check(
  !(await exists(layout.indexFile(TITLES[1], 0))) &&
    !(await exists(layout.indexFile(TITLES[2], 0))),
  'so the next two in line go instead',
  '',
);

await build();
held = await caches({ metadataBytes: METADATA_PER_TITLE * 2.5 });
await guardFor(held, {
  totalBytes: 1024 * 1024 * KiB,
  inUse: TITLES,
}).sweep();
held.metadata.touch(TITLES[0]);
await new Promise((resolve) => setTimeout(resolve, 100));

held = await caches({ metadataBytes: METADATA_PER_TITLE * 2.5 });
await guardFor(held, { totalBytes: 1024 * 1024 * KiB }).sweep();
check(
  await exists(layout.indexFile(TITLES[0], 0)),
  'and a restart still knows it was the last one wanted',
  '',
);

section('a title being watched right now');
await build();
held = await caches({ metadataBytes: METADATA_PER_TITLE * 2.5 });
await guardFor(held, {
  totalBytes: 1024 * 1024 * KiB,
  inUse: [TITLES[0], TITLES[1]],
}).sweep();

check(
  (await exists(layout.indexFile(TITLES[0], 0))) &&
    (await exists(layout.indexFile(TITLES[1], 0))),
  'is never swept away, whatever the budget says',
  '',
);

section('the whole directory over its ceiling, with the pieces oldest');
await build({ ages: { pieces: 24 } });
held = await caches();
let before = directorySize(root);
usage = await guardFor(held, {
  totalBytes: before - PIECES_PER_TITLE * 2,
}).sweep();

check(
  usage.total <= usage.limit,
  'is brought back under it',
  `${Math.round(usage.total / KiB)} KiB of ${Math.round(usage.limit / KiB)} KiB`,
);
check(
  usage.freed.pieces > 0 && usage.freed.segments === 0,
  'by dropping pieces, which nothing has read in a day',
  `${Math.round(usage.freed.pieces / KiB)} KiB of pieces, ${Math.round(usage.freed.segments / KiB)} KiB of segments`,
);
check(
  !(await exists(pieceFile(TITLES[0], 0))) &&
    (await exists(pieceFile(TITLES[3], 0))),
  'oldest first, and not one piece more than the ceiling wanted',
  '',
);

section('the same, with the segments oldest instead');
await build({ ages: { segments: 24 } });
held = await caches();
before = directorySize(root);
usage = await guardFor(held, {
  totalBytes: before - SEGMENTS_PER_TITLE * 2,
}).sweep();

check(
  usage.freed.segments > 0 && usage.freed.pieces === 0,
  'segments go and pieces stay - the rule is age, not what is cheap to fetch',
  `${Math.round(usage.freed.segments / KiB)} KiB of segments, ${Math.round(usage.freed.pieces / KiB)} KiB of pieces`,
);
check(
  !(await exists(segmentFile(TITLES[0], 0))) &&
    (await exists(segmentFile(TITLES[3], 0))),
  'and again it is the least recently used that go',
  '',
);

section('a file written long ago and watched a moment ago');
await build({ ages: { segments: 2 } });
await rm(layout.piecesDir, { recursive: true, force: true, maxRetries: 20 });
held = await caches();
// Building the caches again after a touch stands in for a restart: use
// order has to come back off disk, not out of the previous instance.
held.segments.touch(segmentFile(TITLES[0], 0));
await new Promise((resolve) => setTimeout(resolve, 100));

before = directorySize(root);
held = await caches();
usage = await guardFor(held, {
  totalBytes: before - SEGMENTS_PER_TITLE,
}).sweep();

check(
  await exists(segmentFile(TITLES[0], 0)),
  'survives a restart, though everything around it was written later',
  `${Math.round(usage.freed.segments / KiB)} KiB of segments dropped`,
);
check(
  !(await exists(segmentFile(TITLES[0], 1))),
  'while its neighbours, which nobody asked for, do not',
  '',
);

section('what a render that died leaves behind');
await build();
held = await caches();
const media = path.join(layout.mediaDir(TITLES[3], 0), 'video');
const stale = path.join(media, '9.m4s.tmp');
const fresh = path.join(media, '8.m4s.tmp');
await writeFile(stale, Buffer.alloc(64 * KiB));
await writeFile(fresh, Buffer.alloc(64 * KiB));
await utimes(
  stale,
  new Date(Date.now() - 2 * HOUR),
  new Date(Date.now() - 2 * HOUR),
);
await guardFor(held, { totalBytes: 1024 * 1024 * KiB }).sweep();

check(!(await exists(stale)), 'a temp file left over for an hour is deleted');
check(await exists(fresh), 'one that could still be a live render is not');

await rm(root, { recursive: true, force: true, maxRetries: 20 });
process.exit(failureCount() ? 1 : 0);
