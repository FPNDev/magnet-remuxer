// PieceCache with two files under one budget: reads come back as the file's own
// bytes, the store stays inside its budget, the pieces it keeps are the ones
// being read, and a piece evicted from under a torrent comes back when it is
// asked for again.
//
// The second half is a comparison: the same read pattern against a small and a
// large budget, to show retention really is the budget's doing.
//
//   node test/piece-cache.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../dist/cache/cache-layout.js';
import { PieceCache } from '../dist/torrent/piece-store.js';
import {
  cacheRoot,
  createSeeder,
  dirFiles,
  ensureFixtures,
  exists,
  fileSize,
  fixtures,
  removeDir,
  reporter,
  resolveBinaries,
  seed,
  waitFor,
} from './lib.mjs';

// Small pieces and a budget that will not hold a whole file, so eviction is a
// certainty rather than a race.
const PIECE_LENGTH = 16 * 1024;
const CHUNK = 64 * 1024;
const SMALL_BUDGET = 128 * 1024;
const BIG_BUDGET = 1024 * 1024;

await resolveBinaries();
await ensureFixtures();

const report = reporter('piece-cache');
const root = path.join(cacheRoot, 'piece-cache');
await removeDir(root);

const tiny = fixtures.tiny();
const sparse = fixtures.sparse();
const sources = [await readFile(tiny), await readFile(sparse)];

const seededTiny = await seed(tiny, { torrentOptions: { pieceLength: PIECE_LENGTH } });
const seededSparse = await seed(sparse, { torrentOptions: { pieceLength: PIECE_LENGTH } });

const leech = createSeeder();

/** Reads a byte range out of a torrent file and compares it to the source. */
function readRange(torrent, fileIndex, start, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = torrent.files[fileIndex].createReadStream({
      start,
      end: start + length - 1,
    });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** What of one torrent is actually on disk right now. */
async function onDisk(cache, infoHash) {
  const files = await dirFiles(path.join(cache.directory, infoHash));
  let bytes = 0;
  for (const file of files) {
    bytes += await fileSize(file).catch(() => 0);
  }
  return { kept: files.length, bytes };
}

async function walk(torrent, fileIndex, source, chunkSize, onChunk) {
  let peak = 0;
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, source.length);
    const slice = await readRange(torrent, fileIndex, offset, end - offset);
    if (!slice.equals(source.subarray(offset, end))) {
      return { ok: false, at: offset, peak };
    }
    if (onChunk) {
      peak = Math.max(peak, onChunk());
    }
  }
  return { ok: true, at: -1, peak };
}

try {
  const budgetBytes = 384 * 1024;
  const layout = new CacheLayout(path.join(root, 'shared'));
  const cache = new PieceCache(layout.piecesDir, budgetBytes);
  await cache.load();

  const torrents = [];
  for (const seeded of [seededTiny, seededSparse]) {
    await cache.prepare(seeded.infoHash);
    const torrent = leech.add(seeded.magnet, {
      store: cache.createStore,
      path: cache.directory,
      deselect: true,
      storeCacheSlots: 0,
      destroyStoreOnDestroy: false,
      announce: [],
    });
    await new Promise((resolve, reject) => {
      torrent.once('ready', resolve);
      torrent.once('error', reject);
    });
    torrents.push({ torrent, seeded });
  }

  report.section('reads');

  await report.check('a read returns the file bytes, for both files', async () => {
    const results = [];
    for (const [index, { torrent }] of torrents.entries()) {
      const got = await readRange(torrent, 0, 0, CHUNK);
      const want = sources[index].subarray(0, CHUNK);
      results.push({ index, got: got.length, want: want.length, same: got.equals(want) });
    }
    return {
      passed: results.every((result) => result.same && result.got === CHUNK),
      detail: results.map((result) => `file ${result.index}: ${result.got} bytes, match=${result.same}`).join('; '),
    };
  });

  await report.check('the same range read twice is identical', async () => {
    const first = await readRange(torrents[0].torrent, 0, 0, CHUNK);
    const again = await readRange(torrents[0].torrent, 0, 0, CHUNK);
    return {
      passed: first.equals(again) && first.equals(sources[0].subarray(0, CHUNK)),
      detail: `identical=${first.equals(again)}, matches source=${first.equals(sources[0].subarray(0, CHUNK))}`,
    };
  });

  await report.check('the pieces served are on disk, named per torrent', async () => {
    const expected = Math.ceil(CHUNK / PIECE_LENGTH);
    const found = [];
    for (const { seeded } of torrents) {
      let count = 0;
      for (let index = 0; index < expected; index++) {
        if (await exists(cache.piecePath(seeded.infoHash, index))) {
          count++;
        }
      }
      found.push(count);
    }
    return {
      passed: found.every((count) => count === expected),
      detail: found.map((count) => `${count}/${expected} pieces`).join(' and '),
    };
  });

  report.section('one budget, two files');

  await report.check('walking one file never takes more than the budget', async () => {
    let peak = 0;
    const result = await walk(torrents[1].torrent, 0, sources[1], CHUNK, () => {
      peak = Math.max(peak, cache.usedBytes);
      return peak;
    });
    return {
      passed: result.ok && peak <= budgetBytes,
      detail: result.ok
        ? `peak ${Math.round(peak / 1024)} KiB of ${Math.round(budgetBytes / 1024)} KiB`
        : `mismatch at ${result.at}`,
    };
  });

  await report.check('what is kept is what was read last, not what came first', async () => {
    // Fill the cache from the first file, then move on to the second: the
    // pieces that survive the move must be the newer ones.
    await walk(torrents[0].torrent, 0, sources[0].subarray(0, 6 * CHUNK), CHUNK);
    const firstAt = cache.oldestUsedAt();
    await walk(torrents[1].torrent, 0, sources[1].subarray(0, 6 * CHUNK), CHUNK);
    const secondAt = cache.oldestUsedAt();
    return {
      passed: firstAt !== undefined && secondAt !== undefined && secondAt > firstAt,
      detail: `oldest entry moved from ${firstAt} to ${secondAt}`,
    };
  });

  await report.check('both files draw on one budget, not one each', async () => {
    // Each file read more than the budget, the second one last. A per-file
    // budget would still be holding pieces of the first file; a shared one
    // has handed the whole budget to whichever file is being read.
    const [a, b] = torrents;
    const { kept: keptA, bytes: bytesA } = await onDisk(cache, a.seeded.infoHash);
    const { kept: keptB, bytes: bytesB } = await onDisk(cache, b.seeded.infoHash);
    return {
      passed: bytesA + bytesB <= budgetBytes && keptB > 0 && bytesB > bytesA,
      detail: `held after walking both: ${keptA} pieces of file 0 (${Math.round(bytesA / 1024)} KiB), ${keptB} of file 1 (${Math.round(bytesB / 1024)} KiB), budget ${Math.round(budgetBytes / 1024)} KiB`,
    };
  });

  await report.check('an evicted piece comes back on demand', async () => {
    const { torrent, seeded } = torrents[0];
    const gone = [];
    for (let index = 0; index < 12; index++) {
      if (!(await exists(cache.piecePath(seeded.infoHash, index)))) {
        gone.push(index);
      }
    }
    if (gone.length === 0) {
      return { passed: false, detail: 'nothing was evicted, refetch is untested' };
    }
    const start = gone[0] * PIECE_LENGTH;
    const length = Math.min(PIECE_LENGTH, sources[0].length - start);
    const slice = await readRange(torrent, 0, start, length);
    const back = await exists(cache.piecePath(seeded.infoHash, gone[0]));
    return {
      passed: slice.equals(sources[0].subarray(start, start + length)) && back,
      detail: `piece ${gone[0]} refetched (${slice.length} bytes, on disk=${back})`,
    };
  });

  report.section('comparison: the budget decides how much is kept');

  const walked = sources[1].subarray(0, 8 * CHUNK);

  async function holdFor(budget) {
    const dir = path.join(root, `budget-${budget}`);
    await removeDir(dir);
    const cacheLayout = new CacheLayout(dir);
    const pieceCache = new PieceCache(cacheLayout.piecesDir, budget);
    await pieceCache.load();
    await pieceCache.prepare(seededSparse.infoHash);
    const client = createSeeder();
    const torrent = client.add(seededSparse.magnet, {
      store: pieceCache.createStore,
      path: pieceCache.directory,
      deselect: true,
      storeCacheSlots: 0,
      destroyStoreOnDestroy: false,
      announce: [],
    });
    await waitFor(() => torrent.ready === true, { timeoutMs: 20_000 });
    let peak = 0;
    await walk(torrent, 0, walked, CHUNK, () => {
      peak = Math.max(peak, pieceCache.usedBytes);
      return peak;
    });
    const held = await onDisk(pieceCache, seededSparse.infoHash);
    await new Promise((resolve) => client.destroy(() => resolve()));
    return { ...held, peak };
  }

  const results = await report.compare(
    'the same walk, two budgets (pieces kept / KiB / peak KiB)',
    [SMALL_BUDGET, BIG_BUDGET],
    holdFor,
  );
  const small = results.get(SMALL_BUDGET).value;
  const big = results.get(BIG_BUDGET).value;

  await report.check('the larger budget keeps more of the same read', () => ({
    passed: big.kept > small.kept && big.bytes > small.bytes,
    detail: `128 KiB budget kept ${small.kept} pieces, 1 MiB budget kept ${big.kept} pieces`,
  }));

  await report.check('each budget stayed inside itself', () => ({
    passed: small.peak <= SMALL_BUDGET && big.peak <= BIG_BUDGET,
    detail: `peaks: ${Math.round(small.peak / 1024)} KiB of ${Math.round(SMALL_BUDGET / 1024)} KiB, ${Math.round(big.peak / 1024)} KiB of ${Math.round(BIG_BUDGET / 1024)} KiB`,
  }));
} finally {
  await new Promise((resolve) => leech.destroy(() => resolve()));
  await seededTiny.close();
  await seededSparse.close();
}

report.finish();
process.exit(process.exitCode ?? 0);
