// Not part of `npm test`. Measures MAX_JOBS_PER_TORRENT in the regime that
// actually binds in production: the swarm, not the CPU, is the limit.
//
// Seeding over localhost gives a server more bandwidth than it can use, so it
// can only show the cost of a limit being too low. Here the seeder's upload is
// throttled and its pieces are made large, which is what a big release looks
// like from a starved swarm - and what makes reads divide bandwidth instead of
// adding to it.
//
//   node test/bandwidth.mjs [KiB/s] [pieceKiB] [limits...]
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  fixturesDir,
  get,
  section,
  seedFixture,
  startServer,
  summarize,
  workDir,
} from './lib.mjs';

const rate = Number(process.argv[2] ?? 1024) * 1024;
const pieceLength = Number(process.argv[3] ?? 1024) * 1024;
const limits = (process.argv[4] ?? '1,2,4,8,32').split(',').map(Number);

/** How many segments a player keeps in flight; Shaka's default prefetch is 3. */
const IN_FLIGHT = 3;
const SEGMENTS = 8;
const SEEK_TO = 12;
const PORT = Number(process.env.TEST_PORT ?? 3931);

const file = path.join(fixturesDir, 'movie.mkv');
const { client, torrent, magnet } = await seedFixture(file, {
  uploadLimit: rate,
  pieceLength,
});

section(
  `bandwidth: ${(rate / 1024).toFixed(0)} KiB/s seed, ${(pieceLength / 1024).toFixed(0)} KiB pieces, ` +
    `${torrent.pieces.length} pieces over ${(torrent.length / 2 ** 20).toFixed(1)} MiB`,
);
console.log(
  `a read of one segment is about ${(torrent.length / 18 / pieceLength).toFixed(1)} pieces, ` +
    `and one piece alone takes ${(pieceLength / rate).toFixed(1)}s of the whole pipe\n`,
);

const url = (base, n) => `${base}/${torrent.infoHash}/0/video/${n}.m4s`;

/** Plays `count` segments from `first`, keeping IN_FLIGHT requests open. */
async function play(base, first, count) {
  const times = [];
  const pending = new Map();
  let next = first;

  const send = () => {
    if (next < first + count) {
      const n = next++;
      pending.set(
        n,
        get(url(base, n)).then((res) => ({ n, res })),
      );
    }
  };
  for (let i = 0; i < IN_FLIGHT; i++) {
    send();
  }

  while (pending.size) {
    const { n, res } = await Promise.race(pending.values());
    pending.delete(n);
    if (res.status !== 200) {
      throw new Error(
        `segment ${n} → ${res.status} ${res.body.toString().slice(0, 120)}`,
      );
    }
    times.push(res.ms);
    send();
  }
  return times;
}

const results = [];
for (const limit of limits) {
  const cacheDir = path.join(workDir, `bandwidth-${limit}`);
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });

  const server = await startServer({
    name: `bandwidth-${limit}`,
    port: PORT + limit,
    cacheDir,
    env: { MAX_JOBS_PER_TORRENT: String(limit) },
  });

  try {
    const master = await get(
      `${server.base}/m3u8?magnet=${encodeURIComponent(magnet)}`,
      false,
    );
    if (master.status !== 200) {
      throw new Error(`master → ${master.status} ${master.body}`);
    }

    const playing = await play(server.base, 0, SEGMENTS);
    // A seek lands on a cold position with nothing prefetched for it, which is
    // where reads compete hardest.
    const seek = await play(server.base, SEEK_TO, IN_FLIGHT);
    results.push({ limit, playing, seek });
    console.log(
      `limit ${String(limit).padStart(2)}  play ${summarize(playing)}  |  ` +
        `seek first=${seek[0]}ms ${summarize(seek)}`,
    );
  } catch (err) {
    console.log(`limit ${String(limit).padStart(2)}  FAILED - ${err.message}`);
  } finally {
    await server.stop();
  }
}

console.log('');
console.log('limit | play median | play max | first segment after a seek');
for (const { limit, playing, seek } of results) {
  const sorted = [...playing].sort((a, b) => a - b);
  console.log(
    `${String(limit).padStart(5)} | ${String(sorted[sorted.length >> 1]).padStart(11)} | ` +
      `${String(sorted.at(-1)).padStart(8)} | ${String(seek[0]).padStart(26)}`,
  );
}

client.destroy();
process.exit(0);
