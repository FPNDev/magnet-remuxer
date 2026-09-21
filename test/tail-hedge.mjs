import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
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
  startFakePeer,
  workDir,
} from './lib.mjs';

const PIECE_LENGTH = 256 * 1024;
const SEED_RATE = 768 * 1024;
const READ_BYTES = Number(process.argv[2] ?? 1.5 * 1024 * 1024);
// BitTorrent blocks are 16 KiB, so the bad peer answers 640 KiB before it
// goes quiet.
const SERVE_BLOCKS = 40;
const BUDGET_MS = 45_000;
const HEDGE_MS = 600;

const fixture = path.join(fixturesDir, 'movie.mkv');

async function run(label, { hedge, bad }) {
  const cacheDir = path.join(workDir, 'tail-hedge', label);
  await rm(cacheDir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
  const layout = new CacheLayout(cacheDir);
  await mkdir(layout.piecesDir, { recursive: true });

  const seeded = await seedFixture(fixture, {
    pieceLength: PIECE_LENGTH,
    uploadLimit: SEED_RATE,
  });
  // The fake peer serves its quota, then keeps the blocks asked of it
  // reserved and never sends them.
  const peer = bad
    ? await startFakePeer({
        file: fixture,
        torrent: seeded.torrent,
        serveBlocks: SERVE_BLOCKS,
      })
    : null;

  const pieces = new PieceCache(layout.piecesDir, 256 * 1024 * 1024);
  const manager = new TorrentManager({
    layout,
    pieces,
    metadataTimeoutMs: 30_000,
    idleMs: 600_000,
    maxPeers: 55,
    hedge: { enabled: hedge, deadlineMs: HEDGE_MS },
    churn: { enabled: false, graceMs: 30_000 },
    corrupt: { enabled: false, banMs: 0 },
  });

  // x.pe names a peer address directly in the magnet, which is how the fake
  // peer joins a swarm that has no tracker.
  const magnet = peer ? `${seeded.magnet}&x.pe=${peer.address}` : seeded.magnet;
  const infoHash = parseInfoHash(magnet);
  await manager.remember(infoHash, magnet);

  const digest = createHash('sha1');
  let read = 0;
  const started = Date.now();
  // A read that never finishes is a result here: the run without hedging is
  // expected to give up part way.
  try {
    await manager.use(infoHash, async (torrent) => {
      const source = new TorrentFileSource(torrent, torrent.files[0], pieces, {
        stallMs: BUDGET_MS,
        signal: AbortSignal.timeout(BUDGET_MS),
      });
      for await (const chunk of source.stream(0, READ_BYTES)) {
        digest.update(chunk);
        read += chunk.length;
      }
    });
  } catch {}
  const ms = Date.now() - started;
  const hedges = manager.status()[0]?.hedges;
  await manager.close();
  const held = peer?.stats.held ?? 0;
  await peer?.stop();
  seeded.client.destroy();

  const done = read === READ_BYTES;
  console.log(
    `   ${label}: ${done ? `${ms}ms` : `gave up after ${ms}ms with ${Math.round((read / READ_BYTES) * 100)}% read`}` +
      (hedge
        ? `, ${hedges?.issued} hedged, ${hedges?.won} arrived first, ${hedges?.late} wasted`
        : '') +
      (peer ? `, bad peer held ${held} blocks` : ''),
  );
  return {
    ms,
    done,
    read,
    held,
    hedges,
    sha1: done ? digest.digest('hex') : null,
  };
}

section('a swarm with nothing wrong with it');
const clean = await run('clean', { hedge: false, bad: false });
check(clean.done, 'reads the file from a healthy seeder', `${clean.ms}ms`);

section(`one peer serving ${SERVE_BLOCKS} blocks and then going quiet`);
const hedged = await run('hedged', { hedge: true, bad: true });
const plain = await run('not-hedged', { hedge: false, bad: true });

check(
  hedged.held > 0 && plain.held > 0,
  'the bad peer really does sit on blocks asked of it',
  `${hedged.held} held with hedging, ${plain.held} without`,
);
check(
  hedged.hedges?.won > 0,
  'a duplicate request beats the peer the block was reserved from',
  `${hedged.hedges?.issued} sent, ${hedged.hedges?.won} won, ${hedged.hedges?.late} late`,
);
check(
  hedged.done,
  'the read finishes despite the peer holding what it needs',
  `${hedged.ms}ms`,
);
check(
  hedged.sha1 === clean.sha1,
  'and the bytes are the ones the healthy swarm gave',
  hedged.sha1 === clean.sha1 ? '' : `${hedged.sha1} vs ${clean.sha1}`,
);
check(
  !plain.done || plain.ms > hedged.ms * 2,
  'the same read without hedging waits on the held blocks',
  plain.done
    ? `${plain.ms}ms against ${hedged.ms}ms`
    : `${Math.round((plain.read / READ_BYTES) * 100)}% read in ${plain.ms}ms, against ${hedged.ms}ms hedged`,
);
check(
  (hedged.hedges?.wastedBytes ?? 0) < READ_BYTES / 10,
  'and duplicates that lost the race cost little',
  `${hedged.hedges?.wastedBytes ?? 0} bytes of ${READ_BYTES}`,
);

process.exit(failureCount() ? 1 : 0);
