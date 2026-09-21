import { existsSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  check,
  failureCount,
  fixturesDir,
  get,
  seedFixture,
  section,
  startServer,
  workDir,
} from './lib.mjs';

const cacheDir = path.join(workDir, 'peers-cache');
const port = Number(process.env.TEST_PORT ?? 3951);
rmSync(cacheDir, { recursive: true, force: true });
await mkdir(cacheDir, { recursive: true });

const {
  client: seeder,
  torrent: seeded,
  magnet,
} = await seedFixture(path.join(fixturesDir, 'movie.mkv'));
const { infoHash } = seeded;
const torrentDir = path.join(cacheDir, 'torrents', infoHash);
const peersFile = path.join(torrentDir, 'peers.json');
const magnetFile = path.join(torrentDir, 'magnet.txt');
const savedPeers = path.join(workDir, 'peers-saved.json');
// Short timeouts, so the server that cannot find the swarm gives up fast.
const env = {
  REQUEST_TIMEOUT_S: '8',
  READ_STALL_S: '6',
  METADATA_TIMEOUT_S: '8',
};
const segment = (base, n) => `${base}/${infoHash}/0/video/${n}.m4s`;

section('remembered peers');

const first = await startServer({ name: 'peers-first', port, cacheDir, env });
const master = await get(
  `${first.base}/m3u8?magnet=${encodeURIComponent(magnet)}`,
  false,
);
const played = await get(segment(first.base, 0));
await first.stop();

check(
  master.status === 200 && played.status === 200,
  'the first player is served through the address in the magnet',
  `${master.status}, ${played.status}`,
);
check(
  existsSync(peersFile) &&
    JSON.parse(readFileSync(peersFile, 'utf8')).some((peer) =>
      peer.endsWith(`:${seeder.address().port}`),
    ),
  'the peer that served it is remembered',
  existsSync(peersFile) ? readFileSync(peersFile, 'utf8') : 'no peers file',
);

if (!existsSync(peersFile)) {
  seeder.destroy();
  process.exit(1);
}
await copyFile(peersFile, savedPeers);
// The fixture seeder announces to no tracker and no DHT. With the magnet
// and the remembered addresses gone, nothing can reach the swarm.
await rm(magnetFile, { force: true });
await rm(peersFile, { force: true });

const blind = await startServer({
  name: 'peers-blind',
  port: port + 1,
  cacheDir,
  env,
});
const unreachable = await get(segment(blind.base, 10));
await blind.stop();
check(
  unreachable.status !== 200,
  'without them the swarm cannot be found at all',
  `${unreachable.status} in ${unreachable.ms}ms`,
);

await copyFile(savedPeers, peersFile);
const remembered = await startServer({
  name: 'peers-remembered',
  port: port + 2,
  cacheDir,
  env,
});
const served = await get(segment(remembered.base, 11));
await remembered.stop();
check(
  served.status === 200,
  'with them the torrent is reached and the segment is served',
  `${served.status} in ${served.ms}ms`,
);

seeder.destroy();
process.exit(failureCount() ? 1 : 0);
