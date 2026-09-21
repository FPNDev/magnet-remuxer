import { rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { get, startServer, summarize, workDir } from './lib.mjs';

// Benchmark against a real swarm, with no pass or fail. Arguments: a magnet,
// a repeat count, then variant specs of name=ENV=VALUE,ENV=VALUE.
const magnet = process.argv[2] || process.env.SWARM_MAGNET;
if (!magnet?.startsWith('magnet:')) {
  console.error(
    'usage: node test/swarm.mjs "<magnet>" [repeats] [name=ENV=VALUE,...]',
  );
  process.exit(2);
}
const repeats = Number(process.argv[3] ?? 2);
const variants = (
  process.argv.slice(4).length
    ? process.argv.slice(4)
    : ['tuned=TAIL_HEDGE=1,PEER_CHURN=1', 'plain=TAIL_HEDGE=0,PEER_CHURN=0']
).map((spec) => {
  const split = spec.indexOf('=');
  return {
    name: spec.slice(0, split),
    env: Object.fromEntries(
      spec
        .slice(split + 1)
        .split(',')
        .map((pair) => pair.split('=').map((part) => part.trim())),
    ),
  };
});

const SEEKS = [540, 1800];
const PORT = 3971;

const playlist = (text, base) => {
  const segments = [];
  let start = 0;
  let duration = 0;
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8));
    } else if (line && !line.startsWith('#')) {
      segments.push({ url: new URL(line, base).href, start, duration });
      start += duration;
    }
  }
  return segments;
};

const ok = (res, what) => {
  if (res.status !== 200) {
    throw new Error(`${what} -> ${res.status}`);
  }
  return res;
};

async function run(variant, index) {
  const name = `swarm-${variant.name}-${index}`;
  const cacheDir = path.join(workDir, name);
  rmSync(cacheDir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
  await mkdir(cacheDir, { recursive: true });
  const server = await startServer({
    name,
    port: PORT,
    cacheDir,
    env: variant.env,
  });
  const result = { name: variant.name };

  try {
    const masterUrl = `${server.base}/m3u8?magnet=${encodeURIComponent(magnet)}`;
    let started = Date.now();
    const master = ok(await get(masterUrl, false), 'master').body;
    result.master = Date.now() - started;

    const videoUri = new URL(master.trim().split('\n').at(-1), masterUrl).href;
    const audioUri = new URL(
      /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]*)"/.exec(master)[1],
      masterUrl,
    ).href;

    started = Date.now();
    const [videoText, audioText] = await Promise.all(
      [videoUri, audioUri].map(
        async (uri) => ok(await get(uri, false), uri).body,
      ),
    );
    await Promise.all(
      [
        [videoText, videoUri],
        [audioText, audioUri],
      ].map(async ([text, uri]) => {
        const init = new URL(/#EXT-X-MAP:URI="([^"]*)"/.exec(text)[1], uri)
          .href;
        ok(await get(init), 'init');
      }),
    );
    result.init = Date.now() - started;

    const video = playlist(videoText, videoUri);
    const audio = playlist(audioText, audioUri);
    const at = (track, seconds) =>
      Math.max(
        0,
        Math.min(
          track.findIndex((s) => s.start + s.duration > seconds),
          track.length - 1,
        ),
      );
    const frame = async (seconds) => {
      const begun = Date.now();
      await Promise.all([
        get(video[at(video, seconds)].url).then((r) => ok(r, 'video')),
        get(audio[at(audio, seconds)].url).then((r) => ok(r, 'audio')),
      ]);
      return Date.now() - begun;
    };

    result.load = await frame(0);
    for (const seconds of SEEKS) {
      result[`seek ${seconds}s`] = await frame(seconds);
    }

    const status = JSON.parse(
      ok(await get(`${server.base}/status`, false)).body,
    );
    const torrent = status.torrents[0] ?? {};
    result.peers = torrent.peers;
    result.hedges = torrent.hedges;
    result.churn = torrent.churn;
    result.downloadedMiB = Math.round((torrent.downloaded ?? 0) / 2 ** 20);
  } finally {
    await server.stop();
  }
  return result;
}

const runs = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  // Alternate the order, so a swarm that warms up does not always favour
  // whichever variant runs first.
  const order = repeat % 2 ? [...variants].reverse() : variants;
  for (const variant of order) {
    process.stdout.write(`run ${repeat + 1} ${variant.name}: `);
    try {
      const result = await run(variant, repeat);
      runs.push(result);
      console.log(
        `master ${result.master}ms, init ${result.init}ms, first frame ${result.load}ms, ` +
          SEEKS.map((s) => `seek ${s}s ${result[`seek ${s}s`]}ms`).join(', ') +
          `, ${result.peers} peers, ${result.downloadedMiB} MiB` +
          (result.hedges
            ? `, hedged ${result.hedges.issued}/won ${result.hedges.won}/late ${result.hedges.late}`
            : '') +
          (result.churn?.dropped
            ? `, dropped ${result.churn.dropped} ${JSON.stringify(result.churn.reasons)}`
            : ''),
      );
    } catch (err) {
      console.log(`failed: ${err.message}`);
      runs.push({ name: variant.name, failed: err.message });
    }
  }
}

console.log('');
for (const variant of variants) {
  const mine = runs.filter((r) => r.name === variant.name && !r.failed);
  if (!mine.length) {
    console.log(`${variant.name}: every run failed`);
    continue;
  }
  const times = (key) =>
    summarize(mine.map((r) => r[key]).filter(Number.isFinite));
  console.log(`${variant.name} (${mine.length} runs)`);
  for (const key of [
    'master',
    'init',
    'load',
    ...SEEKS.map((s) => `seek ${s}s`),
  ]) {
    console.log(`  ${key.padEnd(12)} ${times(key)}`);
  }
}
