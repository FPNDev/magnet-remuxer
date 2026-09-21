import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../dist/cache/cache-layout.js';
import { parseInfoHash } from '../dist/torrent/magnet.js';
import { PieceCache } from '../dist/torrent/piece-store.js';
import { TorrentManager } from '../dist/torrent/torrent-manager.js';
import { TorrentFileSource } from '../dist/torrent/torrent-source.js';
import {
  check,
  failureCount,
  fixturesDir,
  section,
  seedFixture,
  workDir,
} from './lib.mjs';

// A small piece length makes the 2 MiB read span enough pieces for one
// bad piece to be isolated from the rest.
const PIECE_LENGTH = 256 * 1024;
const READ_BYTES = 2 * 1024 * 1024;
const BUDGET_MS = 20_000;

const fixture = path.join(fixturesDir, 'movie.mkv');
const cacheDir = path.join(workDir, 'piece-reuse');
const layout = new CacheLayout(cacheDir);

await rm(cacheDir, { recursive: true, force: true, maxRetries: 20 });
await mkdir(layout.piecesDir, { recursive: true });

const seeded = await seedFixture(fixture, { pieceLength: PIECE_LENGTH });
const infoHash = parseInfoHash(seeded.magnet);
let seeding = true;

const pieceFiles = async () => {
  const dir = path.join(layout.piecesDir, infoHash);
  return (await readdir(dir).catch(() => [])).filter((name) =>
    name.endsWith('.piece'),
  );
};

async function withManager(work) {
  const pieces = new PieceCache(layout.piecesDir, 256 * 1024 * 1024);
  await pieces.load();
  // idleMs 0 makes sweep drop the torrent as soon as no reader holds it;
  // hedging and churn are off so peer timing cannot move the pieces.
  const manager = new TorrentManager({
    layout,
    pieces,
    metadataTimeoutMs: 20_000,
    idleMs: 0,
    maxPeers: 55,
    hedge: { enabled: false, deadlineMs: 1000 },
    churn: { enabled: false, graceMs: 30_000 },
    corrupt: { enabled: true, banMs: 60_000 },
  });
  try {
    return await work(manager, pieces);
  } finally {
    await manager.close();
  }
}

// A read that stalls or aborts is a result here, not a failure: the
// caller judges it by the byte count and the digest.
async function read(manager, pieces) {
  const digest = createHash('sha1');
  let bytes = 0;
  const started = Date.now();
  try {
    await manager.use(infoHash, async (torrent) => {
      const source = new TorrentFileSource(torrent, torrent.files[0], pieces, {
        stallMs: BUDGET_MS,
        signal: AbortSignal.timeout(BUDGET_MS),
      });
      for await (const chunk of source.stream(0, READ_BYTES)) {
        digest.update(chunk);
        bytes += chunk.length;
      }
    });
  } catch {}
  return {
    bytes,
    done: bytes === READ_BYTES,
    ms: Date.now() - started,
    sha1: bytes === READ_BYTES ? digest.digest('hex') : null,
  };
}

const expected = await (async () => {
  const file = await readFile(fixture);
  return createHash('sha1').update(file.subarray(0, READ_BYTES)).digest('hex');
})();

section('a torrent that goes idle');
const first = await withManager(async (manager, pieces) => {
  await manager.remember(infoHash, seeded.magnet);
  const result = await read(manager, pieces);
  manager.sweep();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { result, torrents: manager.status().length };
});

check(
  first.result.done && first.result.sha1 === expected,
  'reads the file while its swarm is there',
  `${first.result.ms}ms`,
);
check(
  first.torrents === 0,
  'and the torrent is removed once nothing is using it',
  `${first.torrents} torrents left`,
);
const kept = await pieceFiles();
check(kept.length > 0, 'its pieces stay on the disk', `${kept.length} pieces`);

section('the same title, with the swarm switched off');
seeded.client.destroy();
// With the seeder gone, a read can only be served from stored pieces.
seeding = false;
const cached = await withManager((manager, pieces) => read(manager, pieces));
check(
  cached.done && cached.sha1 === expected,
  'is served from the pieces the cache kept, with no peer to ask',
  `${cached.ms}ms`,
);

section('a piece an earlier run left in the wrong state');
const victim = (await pieceFiles()).sort(
  (a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]),
)[0];
const victimPath = path.join(layout.piecesDir, infoHash, victim);
const { size } = await stat(victimPath);
// Overwrites a stored piece with filler so it fails its SHA-1 check the
// next time the store loads it.
await writeFile(victimPath, Buffer.alloc(size, 0x7f));

const corrupted = await withManager((manager, pieces) => read(manager, pieces));
check(
  !corrupted.done || corrupted.sha1 === expected,
  'is never handed to a reader as though it were the file',
  corrupted.done ? 'read finished' : `stopped after ${corrupted.bytes} bytes`,
);
check(
  !(await pieceFiles()).includes(victim),
  'and is thrown away rather than kept and trusted',
  `piece ${victim.split('.')[0]}`,
);
check(
  (await pieceFiles()).length > 0,
  'while the pieces that did hash correctly are still there',
  `${(await pieceFiles()).length} pieces`,
);

if (seeding) {
  seeded.client.destroy();
}
process.exit(failureCount() ? 1 : 0);
