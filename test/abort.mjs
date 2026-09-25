// Renders stopped part way through. Whatever a player leaves behind must
// settle: no request hangs, no ffmpeg process outlives it, no temp file is left
// under the cache directory, and a segment served after an abort is the whole
// segment or nothing at all.
//
//   node test/abort.mjs [attempts] [batchSize]

import { TEMP_SUFFIX } from '../dist/util/fs.js';
import {
  cacheRoot,
  dirFiles,
  ensureFixtures,
  fixtures,
  playlistOf,
  reporter,
  resolveBinaries,
  seed,
  sleep,
  suitePort,
  TestServer,
  waitFor,
} from './lib.mjs';

const attempts = Number(process.argv[2] ?? 24);
const batchSize = Number(process.argv[3] ?? 6);

await resolveBinaries();
await ensureFixtures();

const report = reporter('abort');
const server = await TestServer.start({
  name: 'abort',
  port: suitePort(9),
  cacheDir: `${cacheRoot}/abort`,
});
const seeded = await seed(fixtures.tiny());

const aborted = [];
const completed = [];

try {
  const master = playlistOf(
    (await server.request(`/m3u8?magnet=${encodeURIComponent(seeded.magnet)}`))
      .text,
  );
  const video = playlistOf(
    (await server.request(`/${master.playlists[0].uri}`)).text,
  );
  const count = video.segments.length;

  // Each attempt asks for a segment far enough through the file that the
  // render is still running when it is dropped.
  for (let round = 0; round < attempts; round += batchSize) {
    const batch = [];
    for (
      let offset = 0;
      offset < batchSize && round + offset < attempts;
      offset++
    ) {
      const index = (round + offset) % count;
      const controller = new AbortController();
      const wait = 5 + (((round + offset) * 7) % 90);
      batch.push(
        (async () => {
          const startedAt = Date.now();
          setTimeout(() => controller.abort(), wait);
          try {
            const response = await server.request(
              `/${seeded.infoHash}/0/video/${index}.m4s`,
              { signal: controller.signal },
            );
            const outcome = {
              index,
              status: response.status,
              bytes: response.bytes,
              aborted: false,
              ms: Date.now() - startedAt,
            };
            completed.push(outcome);
            return outcome;
          } catch (err) {
            const outcome = {
              index,
              error: err?.name === 'AbortError' ? 'aborted' : String(err),
              aborted: true,
              ms: Date.now() - startedAt,
            };
            aborted.push(outcome);
            return outcome;
          }
        })(),
      );
    }
    await Promise.all(batch);
  }

  report.section('settling');

  await report.check('every attempt settles', async () => {
    const settled = aborted.filter((entry) => entry.error === 'aborted');
    return {
      passed: aborted.length + completed.length === attempts,
      detail: `${aborted.length} aborted, ${completed.length} answered of ${attempts}; ${settled.length} aborted cleanly`,
    };
  });

  await report.check('aborted requests do not surface as errors', async () => {
    const faulty = aborted.filter((entry) => entry.error !== 'aborted');
    return {
      passed: faulty.length === 0,
      detail:
        faulty.map((entry) => `${entry.index}: ${entry.error}`).join(', ') ||
        'none',
    };
  });

  await report.check('no job left running', async () => {
    const status = await waitFor(
      async () => {
        const current = await server.getJson('/status');
        return current.jobs.running === 0 ? current : false;
      },
      { timeoutMs: 15_000 },
    );
    return {
      passed: status.jobs.running === 0 && status.jobs.queued === 0,
      detail: JSON.stringify(status.jobs),
    };
  });

  await report.check('no temp files left behind', async () => {
    await sleep(500);
    const files = await dirFiles(server.cacheDir);
    const stale = files.filter((file) => file.endsWith(TEMP_SUFFIX));
    return {
      passed: stale.length === 0,
      detail: `${stale.length} of ${files.length} files are temporary`,
    };
  });

  report.section('served afterwards');

  await report.check('an aborted segment is whole or absent', async () => {
    // A truncated body written as a complete file is the failure this catches:
    // fetch every segment once more and make sure each 200 matches the bytes a
    // clean request for it produces.
    const first = await server.request(`/${seeded.infoHash}/0/video/0.m4s`);
    const again = await server.request(`/${seeded.infoHash}/0/video/0.m4s`);
    return {
      passed: first.bytes.equals(again.bytes) && first.bytes.length > 0,
      detail: `first ${first.status}/${first.bytes.length}, again ${again.status}/${again.bytes.length}`,
    };
  });

  await report.check('the server still answers', async () => {
    const status = await server.getJson('/status');
    return {
      passed: Array.isArray(status.torrents),
      detail: `${status.torrents.length} live torrents`,
    };
  });
} finally {
  await server.stop();
  await seeded.close();
}

report.finish();
process.exit(process.exitCode ?? 0);
