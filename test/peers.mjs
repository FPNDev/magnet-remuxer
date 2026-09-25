// Peer memory. The address a magnet carries has to be enough on its own: the
// seeder here is a private torrent on loopback with DHT, LSD, trackers, PEX and
// NAT traversal switched off (createSeeder in lib.mjs), so the magnet's `x.pe`
// is the only thing that knows where it is. Once a title has been used, the
// peers that served it are written under the cache directory, and a server
// started later over that same directory finds the swarm again from what it
// remembered.
//
//   node test/peers.mjs

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  cacheRoot,
  ensureFixtures,
  exists,
  fileSize,
  fixtures,
  removeDir,
  reporter,
  resolveBinaries,
  seed,
  suitePort,
  TestServer,
  waitFor,
} from './lib.mjs';

const CACHE_DIR = `${cacheRoot}/peers`;
const COLD_CACHE_DIR = `${cacheRoot}/peers-cold`;
const PORT = suitePort(4);

await resolveBinaries();
await ensureFixtures();

const report = reporter('peers');
// A piece length of our own, so the info hash is ours alone: another client on
// this machine that happens to hold the same MKV cannot answer for it, which
// is what makes the magnet the only way to find the seeder.
const seeded = await seed(fixtures.tiny(), {
  torrentOptions: { pieceLength: 16 * 1024 },
});
const address = `127.0.0.1:${seeded.port}`;
const bareMagnet = seeded.torrent.magnetURI;

/** Log lines written after the byte offset, so a restart can be read alone. */
async function logSince(target, offset) {
  const text = await readFile(target.logPath, 'utf8').catch(() => '');
  return text.slice(offset);
}

/** The fields of every log line in a slice carrying a given message. */
function entries(log, message) {
  const found = [];
  for (const line of log.split('\n')) {
    if (line.includes(message)) {
      found.push(JSON.parse(line.slice(line.indexOf('{'))));
    }
  }
  return found;
}

/** The peers file for a title, parsed. */
async function rememberedPeers(cacheDir, infoHash) {
  const file = path.join(cacheDir, 'torrents', infoHash, 'peers.json');
  if (!(await exists(file))) {
    return { file, present: false, peers: [] };
  }
  const stored = JSON.parse(await readFile(file, 'utf8'));
  return { file, present: true, peers: stored };
}

report.section('the address in the magnet');

// Control: the very same title, seeded by the very same client, asked for
// without an address in the magnet. Trackers, DHT and LSD have the same chance
// here that they get below, and none of them reaches the seeder.
const cold = await TestServer.start({
  name: 'peers-cold',
  port: PORT,
  cacheDir: COLD_CACHE_DIR,
  options: { env: { METADATA_TIMEOUT_S: '10' } },
});
const coldResponse = await cold.request(
  `/files?magnet=${encodeURIComponent(bareMagnet)}`,
);
await cold.stop();

await report.check(
  'a magnet that carries no address finds nothing',
  async () => {
    const error = coldResponse.json().error;
    return {
      passed: coldResponse.status === 504 && /metadata/i.test(error),
      detail: `${coldResponse.status} ${error}; no trackers or DHT reach it`,
    };
  },
);

const coldPeers = await rememberedPeers(COLD_CACHE_DIR, seeded.infoHash);

await report.check(
  'a title that was never served is not remembered',
  async () => {
    const missing = coldPeers.present === false;
    return {
      passed: missing && coldPeers.peers.length === 0,
      detail:
        `${coldPeers.file} ` +
        `${coldPeers.present ? 'exists' : 'does not exist'}`,
    };
  },
);

// The only difference from the control is `x.pe` in the magnet, and the
// magnet is the only place that address was ever written down.
const magic = await TestServer.start({
  name: 'peers',
  port: PORT,
  cacheDir: CACHE_DIR,
});
const magicQuery = `magnet=${encodeURIComponent(seeded.magnet)}`;
const mark = await fileSize(magic.logPath);
const masterResponse = await magic.request(`/m3u8?${magicQuery}`);
const firstSegment = `/${seeded.infoHash}/0/video/0.m4s`;
const segmentResponse = await magic.request(firstSegment);
const status = await magic.getJson('/status');
const log = await logSince(magic, mark);

const torrent = status.torrents.find(
  (entry) => entry.infoHash === seeded.infoHash,
);
const added = entries(log, 'Adding torrent');
const ready = entries(log, 'Torrent ready');

await report.check('the address carried in the magnet serves the first request', async () => {
  const ok =
    masterResponse.status === 200 &&
    masterResponse.text.startsWith('#EXTM3U') &&
    segmentResponse.status === 200 &&
    segmentResponse.bytes.length > 0 &&
    torrent?.ready === true &&
    torrent?.peers >= 1 &&
    torrent?.downloaded > 0 &&
    added.some((entry) => entry.from === 'magnet') &&
    ready.some((entry) => entry.peers >= 1);
  return {
    passed: ok,
    detail:
      `master ${masterResponse.status}, segment ${segmentResponse.status} ` +
      `${segmentResponse.bytes.length}B; /status peers=${torrent?.peers} ` +
      `downloaded=${torrent?.downloaded}; log has ` +
      `${added.length} "Adding torrent" and ` +
      `${ready.length} "Torrent ready" line(s)`,
  };
});

report.section('peers on disk');

const saved = await waitFor(
  async () => {
    const found = await rememberedPeers(CACHE_DIR, seeded.infoHash);
    return found.present ? found : false;
  },
  { timeoutMs: 30_000, intervalMs: 200 },
);

await report.check('the learned peers are on disk', async () => {
  const ok =
    Array.isArray(saved.peers) &&
    saved.peers.includes(address) &&
    saved.peers.length > 0;
  return {
    passed: ok,
    detail: `${saved.file}: ${JSON.stringify(saved.peers)}`,
  };
});

// A restart is the point of the whole exercise, so the peers have to be flushed
// by the shutdown rather than by a lucky write in the middle of a read.
await magic.stop();
const flushed = await rememberedPeers(CACHE_DIR, seeded.infoHash);

await report.check('the shutdown flushes what it learned', async () => {
  return {
    passed: flushed.present && flushed.peers.includes(address),
    detail: `after SIGTERM: ${JSON.stringify(flushed.peers)}`,
  };
});

// Two things would let the next server answer without its peer memory: the
// stored magnet carries `x.pe` too, and the pieces already downloaded are
// cached beside it. Both go, so every byte the next request needs has to come
// from the address peers.json remembered.
await rm(path.join(CACHE_DIR, 'torrents', seeded.infoHash, 'magnet.txt'));
await removeDir(path.join(CACHE_DIR, 'pieces', seeded.infoHash));

const second = await TestServer.start({
  name: 'peers-again',
  port: PORT,
  cacheDir: CACHE_DIR,
  options: { fresh: false },
});
const secondMark = await fileSize(second.logPath);
const secondMaster = await second.request(`/m3u8?${magicQuery}`);
const secondSegment = await second.request(`/${seeded.infoHash}/0/video/3.m4s`);

const secondStatus = await waitFor(
  async () => {
    const current = await second.getJson('/status');
    const entry = current.torrents.find(
      (item) => item.infoHash === seeded.infoHash,
    );
    return entry && entry.peers >= 1 ? entry : false;
  },
  { timeoutMs: 30_000, intervalMs: 200 },
);

const secondLog = await logSince(second, secondMark);
const secondAdded = entries(secondLog, 'Adding torrent');
const secondReady = entries(secondLog, 'Torrent ready');

report.section('a server started later');

await report.check('the remembered peers are there to work from', async () => {
  const ok =
    secondMaster.status === 200 &&
    secondMaster.text.startsWith('#EXTM3U') &&
    secondSegment.status === 200 &&
    secondSegment.bytes.length > 0 &&
    secondStatus.peers >= 1 &&
    secondAdded.some((entry) => entry.from === 'saved metadata');
  return {
    passed: ok,
    detail:
      `master ${secondMaster.status}, cold segment ${secondSegment.status} ` +
      `${secondSegment.bytes.length}B (no address in the magnet); ` +
      `/status peers=${secondStatus.peers}; log: ` +
      `${secondAdded.map((entry) => entry.from).join(', ')}`,
  };
});

await report.check('the new server says so in its log', async () => {
  const ok =
    secondAdded.length > 0 &&
    secondAdded.every(
      (entry) =>
        entry.infoHash === seeded.infoHash && entry.from === 'saved metadata',
    ) &&
    secondReady.length > 0 &&
    // Nothing on disk to reuse, so the bytes behind the segment below were
    // asked for over the connection peers.json handed the new process.
    !secondLog.includes('Reused cached pieces');
  return {
    passed: ok,
    detail:
      `added from=${secondAdded.map((entry) => entry.from).join(', ')}, ` +
      `${secondReady.length} "Torrent ready" line(s), no cached pieces reused`,
  };
});

const afterRestart = await rememberedPeers(CACHE_DIR, seeded.infoHash);
await report.check('the memory survives being used', async () => {
  return {
    passed: afterRestart.present && afterRestart.peers.includes(address),
    detail: JSON.stringify(afterRestart.peers),
  };
});

await second.stop();
await seeded.close();

report.finish();
process.exit(process.exitCode ?? 0);
