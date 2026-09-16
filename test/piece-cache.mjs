// Exercises the sliding piece cache against a local peer, using a torrent with
// two files: one budget covers everything, it follows whoever is reading, and
// anything it drops is downloaded again on demand.
import { readdirSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readRange } from '../dist/io/byte-source.js';
import { PieceCache } from '../dist/torrent/piece-store.js';
import { TorrentFileSource } from '../dist/torrent/torrent-source.js';
import {
  check,
  directorySize,
  failureCount,
  fixturesDir,
  section,
  seedFixture,
  workDir,
} from './lib.mjs';

const BUDGET_MB = 8;
const HEAD_BYTES = 1_000_000;
const MiB = 1024 * 1024;

const pack = path.join(workDir, 'pack');
const dir = path.join(workDir, 'piece-cache');
rmSync(dir, { recursive: true, force: true });
rmSync(pack, { recursive: true, force: true });
await mkdir(pack, { recursive: true });

// Two sizeable files in one torrent, both far larger than the budget.
const source = path.join(fixturesDir, 'movie.mkv');
await copyFile(source, path.join(pack, 'a.mkv'));
await copyFile(source, path.join(pack, 'b.mkv'));

section(`piece cache - ${BUDGET_MB} MiB shared budget, two files`);

const { client: seeder, torrent: seeded, magnet } = await seedFixture(pack);
const { default: WebTorrent } = await import('webtorrent');

const cache = new PieceCache(dir, BUDGET_MB * MiB);
const client = new WebTorrent();
const torrent = client.add(magnet, {
  store: cache.createStore,
  path: dir,
  deselect: true,
  storeCacheSlots: 0,
  destroyStoreOnDestroy: true,
});
await new Promise((resolve) => torrent.once('ready', resolve));

const [fileA, fileB] = torrent.files;
const readerA = new TorrentFileSource(torrent, fileA, cache, {
  stallMs: 45_000,
});
const readerB = new TorrentFileSource(torrent, fileB, cache, {
  stallMs: 45_000,
});

/** Bytes currently cached for one file, from the pieces covering its range. */
const cachedBytes = (file) => {
  const first = Math.floor(file.offset / torrent.pieceLength);
  const last = Math.floor(
    (file.offset + file.length - 1) / torrent.pieceLength,
  );
  let pieces = 0;
  for (let i = first; i <= last; i++) {
    if (torrent.bitfield.get(i)) {
      pieces++;
    }
  }
  return pieces * torrent.pieceLength;
};

const stream = async (reader, file) => {
  const started = Date.now();
  for (let offset = 0; offset < file.length; offset += 2_000_000) {
    await readRange(reader, offset, Math.min(file.length, offset + 2_000_000));
  }
  return Date.now() - started;
};

const expectedHead = (await readFile(source)).subarray(0, HEAD_BYTES);
check(
  (await readRange(readerA, 0, HEAD_BYTES)).equals(expectedHead),
  'reads return the file bytes',
);

const slack = 2 * torrent.pieceLength;
const streamedA = await stream(readerA, fileA);
check(
  directorySize(dir) <= BUDGET_MB * MiB + slack,
  'the cache stays within its budget while streaming',
  `${(directorySize(dir) / MiB).toFixed(1)} MiB held after streaming ${(fileA.length / MiB).toFixed(0)} MiB in ${streamedA} ms`,
);

const streamedB = await stream(readerB, fileB);
check(
  directorySize(dir) <= BUDGET_MB * MiB + slack,
  'one budget covers both files of the torrent',
  `${(directorySize(dir) / MiB).toFixed(1)} MiB held after streaming both files`,
);
check(
  cachedBytes(fileB) > cachedBytes(fileA),
  'the cache follows whoever is reading',
  `file A ${(cachedBytes(fileA) / MiB).toFixed(1)} MiB, file B ${(cachedBytes(fileB) / MiB).toFixed(1)} MiB after ${streamedB} ms`,
);

const folders = readdirSync(dir);
check(
  folders.length === 1 && folders[0] === seeded.infoHash,
  'pieces are stored once per torrent, under its info hash',
  folders.join(', '),
);

const reread = await Promise.race([
  readRange(readerA, 0, HEAD_BYTES),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timed out')), 60_000),
  ),
]).catch((err) => err);
check(
  Buffer.isBuffer(reread) && reread.equals(expectedHead),
  'evicted pieces are downloaded again on demand',
  Buffer.isBuffer(reread) ? '' : reread.message,
);

client.destroy();
seeder.destroy();
process.exit(failureCount() ? 1 : 0);
