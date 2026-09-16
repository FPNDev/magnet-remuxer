// Exercises the sliding piece cache against a local peer, using a torrent with
// two files: each file gets its own window, streaming one must not evict the
// other, and anything dropped must download again on demand.
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

const PER_FILE_MB = 8;
const TOTAL_MB = 64;
const HEAD_BYTES = 1_000_000;
const MiB = 1024 * 1024;

const pack = path.join(workDir, 'pack');
const dir = path.join(workDir, 'piece-cache');
rmSync(dir, { recursive: true, force: true });
rmSync(pack, { recursive: true, force: true });
await mkdir(pack, { recursive: true });

// Two sizeable files in one torrent, so the per-file windows are visible.
const source = path.join(fixturesDir, 'movie.mkv');
await copyFile(source, path.join(pack, 'a.mkv'));
await copyFile(source, path.join(pack, 'b.mkv'));

section(`piece cache - ${PER_FILE_MB} MiB per file, ${TOTAL_MB} MiB total, two files`);

const { client: seeder, torrent: seeded, magnet } = await seedFixture(pack);
const { default: WebTorrent } = await import('webtorrent');

const cache = new PieceCache(dir, PER_FILE_MB * MiB, TOTAL_MB * MiB);
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
const readerA = new TorrentFileSource(torrent, fileA, cache, { stallMs: 45_000 });
const readerB = new TorrentFileSource(torrent, fileB, cache, { stallMs: 45_000 });

/** Bytes currently cached for one file, from the pieces covering its range. */
const cachedBytes = (file) => {
  const first = Math.floor(file.offset / torrent.pieceLength);
  const last = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
  let pieces = 0;
  for (let i = first; i <= last; i++) if (torrent.bitfield.get(i)) pieces++;
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
check((await readRange(readerA, 0, HEAD_BYTES)).equals(expectedHead), 'reads return the file bytes');

const slack = 2 * torrent.pieceLength;
const streamedA = await stream(readerA, fileA);
const afterA = cachedBytes(fileA);
check(
  afterA <= PER_FILE_MB * MiB + slack,
  'a file keeps only its own window while streaming',
  `${(afterA / MiB).toFixed(1)} MiB cached after streaming ${(fileA.length / MiB).toFixed(0)} MiB in ${streamedA} ms`,
);

const streamedB = await stream(readerB, fileB);
const keptA = cachedBytes(fileA);
const keptB = cachedBytes(fileB);
check(
  keptA >= afterA - slack,
  'streaming a second file does not evict the first file’s window',
  `file A kept ${(keptA / MiB).toFixed(1)} MiB of ${(afterA / MiB).toFixed(1)} MiB`,
);
check(
  keptB <= PER_FILE_MB * MiB + slack,
  'the second file gets its own window',
  `${(keptB / MiB).toFixed(1)} MiB cached in ${streamedB} ms`,
);
check(
  directorySize(dir) <= TOTAL_MB * MiB,
  'the cache as a whole stays under the total budget',
  `${(directorySize(dir) / MiB).toFixed(1)} MiB on disk across ${cache.windowCount} file windows`,
);

const folders = readdirSync(dir);
check(
  folders.length === 1 && folders[0] === seeded.infoHash,
  'pieces are stored once per torrent, under its info hash',
  folders.join(', '),
);

const reread = await Promise.race([
  readRange(readerA, 0, HEAD_BYTES),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 60_000)),
]).catch((err) => err);
check(
  Buffer.isBuffer(reread) && reread.equals(expectedHead),
  'evicted pieces are downloaded again on demand',
  Buffer.isBuffer(reread) ? '' : reread.message,
);

client.destroy();
seeder.destroy();
process.exit(failureCount() ? 1 : 0);
