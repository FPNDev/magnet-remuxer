import { rmSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  check,
  failureCount,
  fixturesDir,
  get,
  section,
  seedFixture,
  startServer,
  summarize,
  workDir,
} from './lib.mjs';

const basePort = Number(process.env.TEST_PORT ?? 3911);
const cacheDir = path.join(workDir, 'multi-cache');
rmSync(cacheDir, { recursive: true, force: true });

// Playlist URIs are relative to the playlist that carries them, so each
// one is resolved against its own base.
const parseMaster = (text, base) => ({
  audio: [...text.matchAll(/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI="([^"]*)"/g)].map(
    ([, uri]) => new URL(uri, base).href,
  ),
  subtitles: [
    ...text.matchAll(/#EXT-X-MEDIA:.*TYPE=SUBTITLES.*URI="([^"]*)"/g),
  ].map(([, uri]) => new URL(uri, base).href),
  video: new URL(text.trim().split('\n').at(-1), base).href,
});

const parseMedia = (text, base) => ({
  init:
    /#EXT-X-MAP:URI="([^"]*)"/.exec(text)?.[1] &&
    new URL(/#EXT-X-MAP:URI="([^"]*)"/.exec(text)[1], base).href,
  segments: text
    .trim()
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new URL(l, base).href),
});

async function openAsset(base, magnet, label, fileIndex) {
  const url = `${base}/m3u8?magnet=${encodeURIComponent(magnet)}${fileIndex === undefined ? '' : `&file=${fileIndex}`}`;
  const master = await get(url, false);
  if (master.status !== 200) {
    throw new Error(
      `${label}: master failed (${master.status}) ${master.body}`,
    );
  }

  const urls = parseMaster(master.body, `${base}/m3u8`);
  const video = parseMedia((await get(urls.video, false)).body, urls.video);
  const audio = urls.audio[0]
    ? parseMedia((await get(urls.audio[0], false)).body, urls.audio[0])
    : undefined;
  const subtitles = urls.subtitles[0]
    ? parseMedia((await get(urls.subtitles[0], false)).body, urls.subtitles[0])
    : undefined;
  return { label, video, audio, subtitles };
}

async function play(asset) {
  const failures = [];
  const times = [];
  for (const url of [asset.video.init, asset.audio?.init].filter(Boolean)) {
    const res = await get(url);
    if (res.status !== 200) {
      failures.push(`${url} → ${res.status} ${res.body}`);
    }
  }

  for (let n = 0; n < asset.video.segments.length; n++) {
    const urls = [
      asset.video.segments[n],
      asset.audio?.segments[n],
      asset.subtitles?.segments[n],
    ].filter(Boolean);
    const responses = await Promise.all(urls.map((url) => get(url)));
    for (const [i, res] of responses.entries()) {
      times.push(res.ms);
      if (res.status !== 200) {
        failures.push(`${urls[i]} → ${res.status} ${res.body}`);
      }
    }
  }
  return { failures, times };
}

const server = await startServer({
  name: 'multi',
  port: basePort,
  cacheDir,
  // A small piece budget makes both torrents compete for one cache.
  env: { PIECE_CACHE_MB: '24' },
});

section('two torrents playing at once');
const first = await seedFixture(path.join(fixturesDir, 'movie.mkv'));
const second = await seedFixture(path.join(fixturesDir, 'sparse.mkv'));

const assets = await Promise.all([
  openAsset(server.base, first.magnet, 'movie'),
  openAsset(server.base, second.magnet, 'sparse'),
]);
const results = await Promise.all(assets.map(play));
for (const [i, result] of results.entries()) {
  check(
    result.failures.length === 0,
    `${assets[i].label}: every request served while another asset played`,
    result.failures.length
      ? result.failures.slice(0, 3).join(' | ')
      : summarize(result.times),
  );
}

// Seeding a directory gives one multi-file torrent, which is what the
// file index in the /m3u8 query selects between.
section('two files of one torrent playing at once');
const pack = path.join(workDir, 'multi-pack');
rmSync(pack, { recursive: true, force: true });
await mkdir(pack, { recursive: true });
await copyFile(
  path.join(fixturesDir, 'movie.mkv'),
  path.join(pack, 'episode-1.mkv'),
);
await copyFile(
  path.join(fixturesDir, 'sparse.mkv'),
  path.join(pack, 'episode-2.mkv'),
);
const seededPack = await seedFixture(pack);

const packAssets = await Promise.all([
  openAsset(server.base, seededPack.magnet, 'episode-1', 0),
  openAsset(server.base, seededPack.magnet, 'episode-2', 1),
]);
const packResults = await Promise.all(packAssets.map(play));
for (const [i, result] of packResults.entries()) {
  check(
    result.failures.length === 0,
    `${packAssets[i].label}: every request served while its sibling played`,
    result.failures.length
      ? result.failures.slice(0, 3).join(' | ')
      : summarize(result.times),
  );
}

console.log(`status: ${(await get(`${server.base}/status`, false)).body}`);

await server.stop();
first.client.destroy();
second.client.destroy();
seededPack.client.destroy();
process.exit(failureCount() ? 1 : 0);
