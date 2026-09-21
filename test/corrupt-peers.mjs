import { createHash } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CacheLayout } from '../dist/cache/cache-layout.js';
import { parseInfoHash } from '../dist/torrent/magnet.js';
import { PieceCache } from '../dist/torrent/piece-store.js';
import { TorrentManager } from '../dist/torrent/torrent-manager.js';
import { TorrentFileSource } from '../dist/torrent/torrent-source.js';
import { readJson } from '../dist/util/fs.js';
import {
  check,
  failureCount,
  fixturesDir,
  section,
  seedFixture,
  startFakePeer,
  workDir,
} from './lib.mjs';

const PIECE_LENGTH = 256 * 1024;
const READ_BYTES = 512 * 1024;
const ALONE_MS = 2500;
const BUDGET_MS = 60_000;

const fixture = path.join(fixturesDir, 'movie.mkv');
const cacheDir = path.join(workDir, 'corrupt-peers');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seeded = await seedFixture(fixture, { pieceLength: PIECE_LENGTH });
const seeder = `127.0.0.1:${seeded.client.address().port}`;
// The liar answers with bytes that cannot pass the piece hash.
const liar = await startFakePeer({
  file: fixture,
  torrent: seeded.torrent,
  corrupt: true,
});
const infoHash = parseInfoHash(seeded.magnet);

// Reference digest of the leading bytes, taken straight off the fixture.
const expected = await (async () => {
  const handle = await open(fixture, 'r');
  const buffer = Buffer.alloc(READ_BYTES);
  await handle.read(buffer, 0, READ_BYTES, 0);
  await handle.close();
  return createHash('sha1').update(buffer).digest('hex');
})();

async function run({ fresh, offerSeeder }) {
  if (fresh) {
    await rm(cacheDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
  const layout = new CacheLayout(cacheDir);
  await mkdir(layout.piecesDir, { recursive: true });
  await mkdir(layout.torrentDir(infoHash), { recursive: true });
  await writeFile(layout.torrentFile(infoHash), seeded.torrent.torrentFile);
  await writeFile(
    layout.magnetFile(infoHash),
    `magnet:?xt=urn:btih:${infoHash}&x.pe=${liar.address}` +
      (offerSeeder ? `&x.pe=${seeder}` : ''),
  );
  const before = liar.stats.connections;

  const pieces = new PieceCache(layout.piecesDir, 256 * 1024 * 1024);
  const manager = new TorrentManager({
    layout,
    pieces,
    metadataTimeoutMs: 30_000,
    idleMs: 600_000,
    maxPeers: 55,
    hedge: { enabled: false, deadlineMs: 1000 },
    churn: { enabled: false, graceMs: 30_000 },
    corrupt: { enabled: true, banMs: 7 * 24 * 60 * 60 * 1000 },
  });

  const digest = createHash('sha1');
  let read = 0;
  const started = Date.now();
  try {
    await manager.use(infoHash, async (torrent) => {
      const source = new TorrentFileSource(torrent, torrent.files[0], pieces, {
        stallMs: BUDGET_MS,
        signal: AbortSignal.timeout(BUDGET_MS),
      });
      if (!offerSeeder) {
        // Leave the liar alone in the swarm at first, so a failed piece
        // can only have come from it.
        setTimeout(() => torrent.addPeer(seeder), ALONE_MS);
      }
      for await (const chunk of source.stream(0, READ_BYTES)) {
        digest.update(chunk);
        read += chunk.length;
      }
    });
  } catch {}
  const ms = Date.now() - started;
  const status = manager.status()[0];
  // The ban is written after the read ends, so wait for it before closing.
  await wait(2500);
  await manager.close();
  const connections = liar.stats.connections - before;

  const done = read === READ_BYTES;
  console.log(
    `   ${offerSeeder ? 'both offered' : 'liar first'}: ` +
      `${done ? `${ms}ms` : `${Math.round((read / READ_BYTES) * 100)}% read in ${ms}ms`}` +
      `, ${status?.corrupt?.failures ?? 0} pieces failed, ${status?.corrupt?.banned ?? 0} peers banned` +
      `, liar connected ${connections}x and sent ${liar.stats.served} blocks`,
  );
  return {
    ms,
    done,
    connections,
    corrupt: status?.corrupt,
    layout,
    sha1: done ? digest.digest('hex') : null,
  };
}

section('a peer that answers with noise');
const banning = await run({ fresh: true, offerSeeder: false });

check(
  banning.corrupt?.failures > 0,
  'the noise it sends fails verification',
  `${banning.corrupt?.failures} pieces`,
);
check(
  banning.corrupt?.banned > 0,
  'and the peer that sent the bad piece is banned',
  `${banning.corrupt?.banned} banned`,
);
check(
  banning.done && banning.sha1 === expected,
  'the read still finishes, with the bytes the file really has',
  `${banning.ms}ms`,
);

const saved = (await readJson(banning.layout.bannedFile(infoHash))) ?? {};
check(
  Object.keys(saved).includes(liar.address),
  'the ban is written down rather than kept in memory',
  JSON.stringify(saved),
);

section('the same swarm, from the same cache');
const again = await run({ fresh: false, offerSeeder: true });
check(
  again.connections === 0,
  'the banned peer is not dialled again, even when offered',
  `${again.connections} connections`,
);
check(
  again.done && again.sha1 === expected,
  'and the read is served by the honest seeder alone',
  `${again.ms}ms`,
);

await liar.stop();
seeded.client.destroy();
process.exit(failureCount() ? 1 : 0);
