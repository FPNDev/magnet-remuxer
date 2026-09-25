// DiskGuard sweeps: a metadata budget that drops whole titles, a title being
// played that no budget may touch, old pieces and old segments judged against
// each other rather than store by store, and the temp files a dead render left
// behind.
//
//   node test/cache-budget.mjs

import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../dist/cache/cache-layout.js';
import { DiskGuard } from '../dist/cache/disk-guard.js';
import { MetadataCache } from '../dist/cache/metadata-cache.js';
import { PieceCache } from '../dist/torrent/piece-store.js';
import { SegmentCache } from '../dist/cache/segment-cache.js';
import { TEMP_SUFFIX } from '../dist/util/fs.js';
import { cacheRoot, exists, removeDir, reporter } from './lib.mjs';

const KiB = 1024;
const MINUTE = 60_000;
const UNIT = 64 * KiB;
const ROOMY = 8 * UNIT; // big enough that nothing has to go

const report = reporter('cache-budget');
const root = path.join(cacheRoot, 'cache-budget');
await removeDir(root);

/** Writes a file of the given size, back-dated by `ageMs`. */
async function writeAged(file, bytes, ageMs) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 0x5a));
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
  return file;
}

/** Only numbered segments are evictable, and they live under hls/<hash>/<idx>. */
const segmentPath = (layout, infoHash, fileIndex, index) =>
  path.join(layout.mediaDir(infoHash, fileIndex), `${index}.m4s`);

const piecePath = (layout, infoHash, index) =>
  path.join(layout.piecesDir, infoHash, `${index}.piece`);

async function freshRoot(name) {
  const dir = path.join(root, name);
  await removeDir(dir);
  const layout = new CacheLayout(dir);
  for (const sub of [layout.piecesDir, layout.torrentsDir, layout.hlsDir]) {
    await mkdir(sub, { recursive: true });
  }
  return layout;
}

async function guardOver(layout, { total, piecesBudget, segmentBudget, metadataBudget, inUse, load = true }) {
  const metadata = new MetadataCache(layout, metadataBudget);
  const pieces = new PieceCache(layout.piecesDir, piecesBudget);
  const segments = new SegmentCache(layout.hlsDir, segmentBudget);
  if (load) {
    await pieces.load();
    await segments.load();
  }
  const guard = new DiskGuard({
    layout,
    pieces,
    segments,
    metadata,
    totalBytes: total,
    intervalMs: 60_000,
    inUse: inUse ?? (() => new Set()),
  });
  return { guard, metadata, pieces, segments };
}

const titlesOnDisk = async (layout) => {
  const entries = await readdir(layout.torrentsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
};

// ------------------------------------------------------------ metadata budget

report.section('the metadata budget');

// `aaaa` is an hour old, `eeee` is barely written, and each one is a whole
// 64 KiB title.
const TITLES = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'];

async function titlesKept(budget) {
  const layout = await freshRoot(`metadata-${budget}`);
  for (const [index, name] of TITLES.entries()) {
    await writeAged(layout.torrentFile(`${name}hash`), UNIT, (TITLES.length - index) * 10 * MINUTE);
  }
  const { guard, metadata } = await guardOver(layout, {
    total: ROOMY,
    piecesBudget: ROOMY,
    segmentBudget: ROOMY,
    metadataBudget: budget,
  });
  const usage = await guard.sweep();
  return {
    kept: await titlesOnDisk(layout),
    bytes: metadata.usedBytes,
    freed: usage.freed.metadata,
    total: usage.total,
  };
}

const TIGHT = 2 * UNIT;
const results = await report.compare('titles left after one sweep', [TIGHT, ROOMY], titlesKept);
const tight = results.get(TIGHT).value;
const roomy = results.get(ROOMY).value;

await report.check('a two-title budget keeps the two newest', () => ({
  passed: tight.kept.length === 2 && tight.kept.join(',') === 'ddddhash,eeeehash',
  detail: `kept ${tight.kept.join(', ')} of ${TITLES.join(', ')}`,
}));

await report.check('a budget with room for everyone keeps everyone', () => ({
  passed: roomy.kept.length === TITLES.length,
  detail: `kept ${roomy.kept.join(', ')}`,
}));

await report.check('dropped titles leave nothing of their own behind', () => ({
  passed: tight.freed === 3 * UNIT && tight.bytes <= TIGHT,
  detail: `freed ${Math.round(tight.freed / KiB)} KiB, ${Math.round(tight.bytes / KiB)} KiB left`,
}));

// ------------------------------------------------------------------ in-use pin

report.section('a title in use is never swept');

async function pinCase(protect) {
  const layout = await freshRoot(`pin-${protect}`);
  const hashes = ['1111', '2222', '3333'];
  for (const [index, name] of hashes.entries()) {
    await writeAged(layout.torrentFile(name), UNIT, (hashes.length - index) * 20 * MINUTE);
  }
  const oldest = hashes[0];
  const { guard } = await guardOver(layout, {
    total: ROOMY,
    piecesBudget: ROOMY,
    segmentBudget: ROOMY,
    metadataBudget: UNIT, // room for one; the oldest is the one to go
    inUse: () => (protect ? new Set([oldest]) : new Set()),
  });
  await guard.sweep();
  return { oldestKept: await exists(layout.torrentFile(oldest)) };
}

const pins = await report.compare('oldest title kept?', [false, true], pinCase);
const unprotected = pins.get(false).value;
const protectedOldest = pins.get(true).value;

await report.check('the oldest title goes when nobody is playing it', () => ({
  passed: unprotected.oldestKept === false,
  detail: `oldest on disk: ${unprotected.oldestKept}`,
}));

await report.check('the same oldest title survives while it is playing', () => ({
  passed: protectedOldest.oldestKept === true,
  detail: `oldest on disk: ${protectedOldest.oldestKept}`,
}));

// ------------------------------------------------------- oldest first, globally

report.section('oldest first, across both stores');

async function evictionShape(total) {
  const layout = await freshRoot(`oldest-${total}`);
  const hash = 'sharedhash';
  // Interleaved ages: the three oldest entries are all pieces and the two
  // youngest are all segments, so a scheme that took the same share from each
  // store would drop a segment instead.
  const specs = [
    ['p0', 60 * MINUTE],
    ['p1', 50 * MINUTE],
    ['p2', 40 * MINUTE],
    ['s0', 30 * MINUTE],
    ['s1', 20 * MINUTE],
  ];
  const files = new Map();
  for (const [name, age] of specs) {
    const file =
      name[0] === 'p'
        ? piecePath(layout, hash, Number(name.slice(1)))
        : segmentPath(layout, hash, 0, Number(name.slice(1)));
    files.set(name, file);
    await writeAged(file, UNIT, age);
  }

  const { guard } = await guardOver(layout, {
    total,
    piecesBudget: ROOMY,
    segmentBudget: ROOMY,
    metadataBudget: ROOMY,
  });
  const usage = await guard.sweep();
  const present = new Map();
  for (const [name, file] of files) {
    present.set(name, await exists(file));
  }
  return { present, usage };
}

const ROOM_FOR_FOUR = 4 * UNIT;
const shapes = await report.compare(
  'two sweeps, five entries on disk: what survives',
  [ROOM_FOR_FOUR, UNIT],
  evictionShape,
);
const roomy4 = shapes.get(ROOM_FOR_FOUR).value;
const tightest = shapes.get(UNIT).value;

await report.check('only as much is dropped as the limit demands', () => ({
  passed:
    roomy4.present.get('p0') === false &&
    roomy4.present.get('p1') === true &&
    roomy4.present.get('p2') === true &&
    roomy4.present.get('s0') === true &&
    roomy4.present.get('s1') === true,
  detail: [...roomy4.present].map(([name, there]) => `${name}=${there ? 'kept' : 'gone'}`).join(' '),
}));

await report.check('the oldest entry is the one that goes', () => ({
  // p0 is an hour old and p1 only fifty minutes: the sweep must pick p0.
  passed: roomy4.present.get('p0') === false && roomy4.present.get('p1') === true,
  detail: `pieces left: ${['p0', 'p1', 'p2'].filter((name) => roomy4.present.get(name)).join(', ')}`,
}));

await report.check('with more to free, the sweep moves on to the next store', () => ({
  passed:
    tightest.present.get('p0') === false &&
    tightest.present.get('p1') === false &&
    tightest.present.get('p2') === false &&
    tightest.present.get('s0') === false &&
    tightest.present.get('s1') === true,
  detail: [...tightest.present].map(([name, there]) => `${name}=${there ? 'kept' : 'gone'}`).join(' '),
}));

await report.check('freed bytes are reported per store', () => ({
  passed:
    tightest.usage.freed.pieces === 3 * UNIT &&
    tightest.usage.freed.segments === UNIT,
  detail: `${Math.round(tightest.usage.freed.pieces / KiB)} KiB of pieces and ${Math.round(tightest.usage.freed.segments / KiB)} KiB of segments freed`,
}));

await report.check('the cache ends the sweep inside its limit', () => ({
  passed: roomy4.usage.total <= roomy4.usage.limit && tightest.usage.total <= tightest.usage.limit,
  detail: `${Math.round(roomy4.usage.total / KiB)} of ${Math.round(roomy4.usage.limit / KiB)} KiB, ${Math.round(tightest.usage.total / KiB)} of ${Math.round(tightest.usage.limit / KiB)} KiB`,
}));

// ------------------------------------------------------------------ temp files

report.section('temp files a dead render left behind');

// SegmentCache.load() clears every temp file it finds, so this sweep runs
// without one: only the guard's own stale-file rule is under test.
const tempLayout = await freshRoot('temp-files');
const infoHash = 'tempyhash';
const finished = segmentPath(tempLayout, infoHash, 0, 0);
const freshTemp = `${segmentPath(tempLayout, infoHash, 0, 1)}${TEMP_SUFFIX}`;
const staleTemp = `${segmentPath(tempLayout, infoHash, 0, 2)}${TEMP_SUFFIX}`;
await writeAged(finished, 32 * KiB, 5 * MINUTE);
await writeAged(freshTemp, 32 * KiB, 2 * MINUTE);
await writeAged(staleTemp, 32 * KiB, 3 * 60 * MINUTE);

const { guard: tempGuard } = await guardOver(tempLayout, {
  total: ROOMY,
  piecesBudget: ROOMY,
  segmentBudget: ROOMY,
  metadataBudget: ROOMY,
  load: false,
});
const tempUsage = await tempGuard.sweep();

await report.check('a temp file nobody is finishing any more is swept', async () => ({
  passed: (await exists(staleTemp)) === false,
  detail: `stale temp on disk: ${await exists(staleTemp)}`,
}));

await report.check('a temp file from a write still in flight is left alone', async () => ({
  passed: (await exists(freshTemp)) === true,
  detail: `fresh temp on disk: ${await exists(freshTemp)}`,
}));

await report.check('finished segments are not swept for being old', async () => ({
  passed: (await exists(finished)) === true,
  detail: `segment on disk: ${await exists(finished)}`,
}));

await report.check('a sweep that has room to spare frees nothing', () => ({
  passed:
    tempUsage.freed.pieces === 0 &&
    tempUsage.freed.segments === 0 &&
    tempUsage.freed.metadata === 0,
  detail: `freed ${JSON.stringify(tempUsage.freed)}`,
}));

report.finish();
process.exit(process.exitCode ?? 0);
