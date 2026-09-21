import { mkdir, rm, writeFile } from 'node:fs/promises';
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
const MAX_PEERS = 4;
const READ_BYTES = 1024 * 1024;
// Short enough that a peer which connected and then answered nothing is
// recognised while the read is still running.
const GRACE_MS = 1000;
const BUDGET_MS = 25_000;

const fixture = path.join(fixturesDir, 'movie.mkv');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(label, { churn }) {
  const cacheDir = path.join(workDir, 'peer-churn', label);
  await rm(cacheDir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
  const layout = new CacheLayout(cacheDir);
  await mkdir(layout.piecesDir, { recursive: true });

  const seeded = await seedFixture(fixture, { pieceLength: PIECE_LENGTH });
  const seederPort = seeded.client.address().port;
  const useless = [];
  // Two peers have nothing to offer, two claim every piece and then send
  // nothing back.
  for (const has of ['none', 'none', 'all', 'all']) {
    useless.push(
      await startFakePeer({
        file: fixture,
        torrent: seeded.torrent,
        has,
        serveBlocks: 0,
      }),
    );
  }

  const infoHash = parseInfoHash(seeded.magnet);
  const magnet = `magnet:?xt=urn:btih:${infoHash}${useless
    .map((peer) => `&x.pe=${peer.address}`)
    .join('')}`;
  await mkdir(layout.torrentDir(infoHash), { recursive: true });
  // Planting the torrent file skips metadata exchange, so the read starts
  // with the peer slots already filled.
  await writeFile(layout.torrentFile(infoHash), seeded.torrent.torrentFile);
  await writeFile(layout.magnetFile(infoHash), magnet);

  const pieces = new PieceCache(layout.piecesDir, 256 * 1024 * 1024);
  const manager = new TorrentManager({
    layout,
    pieces,
    metadataTimeoutMs: 30_000,
    idleMs: 600_000,
    maxPeers: MAX_PEERS,
    hedge: { enabled: false, deadlineMs: 1000 },
    churn: { enabled: churn, graceMs: GRACE_MS },
    corrupt: { enabled: false, banMs: 0 },
  });

  let read = 0;
  let seederConnected = false;
  let queuedAtStart = 0;
  const started = Date.now();
  await manager.use(infoHash, async (torrent) => {
    await wait(1500);
    // Let the useless peers take every slot before the seeder is offered, so
    // it can only get in if one of them is dropped.
    queuedAtStart = torrent.wires.length;
    torrent.addPeer(`127.0.0.1:${seederPort}`);

    const source = new TorrentFileSource(torrent, torrent.files[0], pieces, {
      stallMs: BUDGET_MS,
      signal: AbortSignal.timeout(BUDGET_MS),
    });
    try {
      for await (const chunk of source.stream(0, READ_BYTES)) {
        read += chunk.length;
      }
    } catch {}
    seederConnected = torrent.wires.some(
      (wire) => wire.remotePort === seederPort,
    );
  });
  const ms = Date.now() - started;
  const stats = manager.status()[0]?.churn;

  const dropped = useless.find((peer) => peer.stats.connections > 0);
  const before = dropped?.stats.connections ?? 0;
  await manager.use(infoHash, async (torrent) => {
    torrent.addPeer(dropped.address);
    await wait(1500);
  });
  const redialled = (dropped?.stats.connections ?? 0) - before;

  await manager.close();
  await Promise.all(useless.map((peer) => peer.stop()));
  seeded.client.destroy();

  const done = read === READ_BYTES;
  console.log(
    `   ${label}: ${done ? `${ms}ms` : `${Math.round((read / READ_BYTES) * 100)}% read in ${ms}ms`}` +
      `, ${queuedAtStart} peers held the slots, ${stats?.dropped ?? 0} dropped` +
      `, seeder ${seederConnected ? 'got in' : 'never got in'}` +
      (stats?.dropped ? `, reasons: ${JSON.stringify(stats.reasons)}` : ''),
  );
  return { ms, done, read, stats, seederConnected, queuedAtStart, redialled };
}

section(`${MAX_PEERS} useless peers holding every slot`);
const churned = await run('churned', { churn: true });
const kept = await run('kept', { churn: false });

check(
  churned.queuedAtStart === MAX_PEERS && kept.queuedAtStart === MAX_PEERS,
  'the useless peers really do fill the swarm',
  `${churned.queuedAtStart} and ${kept.queuedAtStart} of ${MAX_PEERS}`,
);
check(
  churned.stats?.dropped >= 3,
  'churn drops the peers that are no use for what is being read',
  `${churned.stats?.dropped} dropped: ${JSON.stringify(churned.stats?.reasons)}`,
);
check(
  Object.keys(churned.stats?.reasons ?? {}).length >= 2,
  'both kinds are recognised: nothing we want, and connected but silent',
  JSON.stringify(churned.stats?.reasons),
);
check(
  churned.seederConnected && churned.done,
  'the seeder gets a slot and the read finishes',
  `${churned.ms}ms`,
);
check(
  !kept.done && !kept.seederConnected,
  'without churn the seeder waits in the queue and nothing arrives',
  `${Math.round((kept.read / READ_BYTES) * 100)}% read in ${kept.ms}ms`,
);
check(
  churned.redialled === 0,
  'and a dropped peer offered again is not dialled back',
  `${churned.redialled} reconnections`,
);

process.exit(failureCount() ? 1 : 0);
