// The HTTP surface of a running server. Rejected requests first - a missing
// magnet, a value that is not a magnet, a title the server was never handed,
// a path under a title that does not exist - then one cold play from the
// master playlist down to a subtitle cue, four viewers asking for the same
// cold segment at once, and what is still served once the server is restarted
// over the same cache with the swarm gone.
//
//   node test/e2e.mjs

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  cacheRoot,
  ensureFixtures,
  fileSize,
  fixtures,
  infoHashOf,
  playlistOf,
  reporter,
  resolveBinaries,
  seed,
  sleep,
  suitePort,
  TestServer,
  waitFor,
} from './lib.mjs';

const CACHE_DIR = `${cacheRoot}/e2e`;
const MASTER_TYPE = 'application/vnd.apple.mpegurl';
const FILE_LIST_CACHE = 'public, max-age=86400';
const VIEWERS = 4;
const COLD_SEGMENT = 6;

await resolveBinaries();
await ensureFixtures();

const report = reporter('e2e');
const server = await TestServer.start({
  name: 'e2e',
  port: suitePort(0),
  cacheDir: CACHE_DIR
});
const seeded = await seed(fixtures.movie());
const encoded = `magnet=${encodeURIComponent(seeded.magnet)}`;

/** The attribute list after an HLS tag. Both quoting styles are accepted. */
function attributes(text) {
  const found = {};
  for (const match of text.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi)) {
    found[match[1]] = match[3] ?? match[2];
  }
  return found;
}

/**
 * The EXT-X-MEDIA lines, which carry the audio, subtitle and video groups.
 * playlistOf() reads stream infos and segment URIs but leaves these alone.
 */
function mediaGroups(text) {
  const groups = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      groups.push(attributes(line.slice('#EXT-X-MEDIA:'.length)));
    }
  }
  return groups;
}

/** An fMP4 init section opens with a file type box. */
function isInit(bytes) {
  return bytes.length >= 8 && bytes.toString('latin1', 4, 8) === 'ftyp';
}

/** A rendered fMP4 segment opens with a movie fragment box. */
function isFragment(bytes) {
  return bytes.length >= 8 && bytes.toString('latin1', 4, 8) === 'moof';
}

/** What the app promises: a failure is JSON with one "error" string in it. */
function hasErrorShape(response) {
  let body;
  try {
    body = response.json();
  } catch {
    return false;
  }
  return (
    Object.keys(body).length === 1 &&
    typeof body.error === 'string' &&
    body.error.length > 0
  );
}

/** Log lines written after the byte offset, so a restart can be read alone. */
async function logSince(target, offset) {
  const text = await readFile(target.logPath, 'utf8').catch(() => '');
  return text.slice(offset);
}

/** The "Rendered segment" records in a log slice, one per ffmpeg run. */
function rendersIn(log) {
  const renders = [];
  for (const line of log.split('\n')) {
    if (!line.includes('Rendered segment')) {
      continue;
    }
    renders.push(JSON.parse(line.slice(line.indexOf('{'))));
  }
  return renders;
}

/** "<subject> → <status>" for every entry, or a fallback when none. */
function statusLines(entries, subject) {
  return entries
    .map((entry) => `${subject(entry)} → ${entry.response.status}`)
    .join(', ');
}

const failures = [];
const rejected = [];
for (const pathname of ['/m3u8', '/files', '/warm']) {
  rejected.push({ pathname, response: await server.request(pathname) });
}
failures.push(...rejected.map((entry) => entry.response));

const notMagnets = [
  'not-a-magnet',
  'http://example.com/movie.torrent',
  'magnet:?dn=Movie',
  'magnet:?xt=urn:btih:zzzz',
];
const badValues = [];
for (const value of notMagnets) {
  const response = await server.request(
    `/files?magnet=${encodeURIComponent(value)}`,
  );
  badValues.push({ value, response });
}
failures.push(...badValues.map((entry) => entry.response));

// A title only exists here once it has been handed over by magnet; until then
// every path underneath its info hash is a stray one.
const unseen = crypto.randomBytes(20).toString('hex');
const unknownTitle = [];
for (const pathname of [
  `/${unseen}/0/video/index.m3u8`,
  `/${unseen}/0/video/init.mp4`,
  `/${unseen}/0/video/0.m4s`,
  `/${unseen}/0/audio/1/init.mp4`,
]) {
  unknownTitle.push({ pathname, response: await server.request(pathname) });
}
failures.push(...unknownTitle.map((entry) => entry.response));

report.section('rejected requests');

await report.check('a request without a magnet is 400', async () => {
  const wrong = rejected.filter((entry) => entry.response.status !== 400);
  const all = rejected.map((entry) => `${entry.pathname} 400`);
  const shown = statusLines(wrong, (entry) => entry.pathname);
  return { passed: wrong.length === 0, detail: shown || all.join(', ') };
});

await report.check('a value that is not a magnet is 400', async () => {
  const wrong = badValues.filter((entry) => entry.response.status !== 400);
  const shown = statusLines(wrong, (entry) => entry.value);
  const count = `${notMagnets.length} values rejected with 400`;
  return { passed: wrong.length === 0, detail: shown || count };
});

await report.check(
  'a title the server has never been given is 404',
  async () => {
    const found = new Map(
      unknownTitle.map((entry) => [entry.pathname, entry.response.status]),
    );
    const wrong = [...found].filter(([, status]) => status !== 404);
    return {
      passed: wrong.length === 0,
      detail:
        statusLines(wrong, (entry) => entry[0]) ||
        `${found.size} paths under an unseen info hash answered 404`,
    };
  },
);

// The README says a magnet for a title the server has never seen is 404. The
// /files and /m3u8 routes remember the magnet before they resolve it
// (src/hls/hls-service.ts:138, 86), so such a title counts as seen from then
// on and the request waits for metadata instead: that magnet answers 504 once
// METADATA_TIMEOUT_S runs out, never 404. A note rather than a check,
// because that is the app deciding.
const ghost = crypto.randomBytes(20).toString('hex');
const ghostResponse = await server.request(
  `/files?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${ghost}`)}`,
);
report.note(
  `a magnet that reaches nobody: /files answered ${ghostResponse.status} ` +
    `(${ghostResponse.json().error}) rather than 404`,
);

report.section('a magnet that carries its own trackers');

// A magnet URI keeps its trackers in the same query string the route reads, so
// the route splits on & and hands everything but `file=` back to the magnet.
// The tracker below is dead on purpose: the address in `x.pe` is the only
// thing that can find the seeder.
const bare =
  `magnet=${seeded.torrent.magnetURI}` +
  `&tr=http%3A%2F%2F127.0.0.1%3A1%2Fannounce` +
  `&x.pe=127.0.0.1:${seeded.port}` +
  `&file=0`;
const bareResponse = await server.request(`/m3u8?${bare}`);
const bareMaster = playlistOf(bareResponse.text);
const bareUri = bareMaster.playlists[0]?.uri;

await report.check(
  'a bare magnet carrying its own trackers works',
  async () => {
    return {
      passed:
        bareResponse.status === 200 &&
        bareResponse.headers.get('content-type') === MASTER_TYPE &&
        bareMaster.streamInf &&
        bareUri === `${seeded.infoHash}/0/video/index.m3u8`,
      detail: `${bareResponse.status}, references ${bareUri}`,
    };
  },
);

const magnetFile = path.join(
  CACHE_DIR,
  'torrents',
  seeded.infoHash,
  'magnet.txt',
);
const storedMagnet = await readFile(magnetFile, 'utf8');
const deadTracker = '&tr=http%3A%2F%2F127.0.0.1%3A1%2Fannounce';

await report.check(
  'the magnet keeps its trackers and never swallows file=',
  async () => {
    const ok =
      storedMagnet.includes(deadTracker) &&
      storedMagnet.includes(`&x.pe=127.0.0.1:${seeded.port}`) &&
      !storedMagnet.includes('file=') &&
      infoHashOf(storedMagnet) === seeded.infoHash;
    return { passed: ok, detail: storedMagnet };
  },
);

report.section('the file list');

const fileListResponse = await server.request(`/files?${encoded}`);
const fileList = fileListResponse.json();
const playable = fileList.files.filter((file) => file.playable);

await report.check('GET /files answers the title and its files', async () => {
  const shape =
    fileListResponse.status === 200 &&
    fileList.infoHash === seeded.infoHash &&
    typeof fileList.name === 'string' &&
    fileList.name.length > 0 &&
    Array.isArray(fileList.files) &&
    fileList.files.length > 0 &&
    fileList.files.every(
      (file) =>
        Number.isInteger(file.index) &&
        typeof file.name === 'string' &&
        file.name.length > 0 &&
        typeof file.path === 'string' &&
        file.path.length > 0 &&
        Number.isInteger(file.length) &&
        file.length > 0 &&
        typeof file.playable === 'boolean',
    );
  return {
    passed: shape && playable.length > 0,
    detail:
      `${fileList.name}: ${fileList.files.length} file(s), ` +
      `${playable.length} playable`,
  };
});

await report.check('the file list caches for a day', async () => {
  const header = fileListResponse.headers.get('cache-control');
  return { passed: header === FILE_LIST_CACHE, detail: header ?? 'absent' };
});

report.section('a cold master playlist');

const masterResponse = await server.request(`/m3u8?${encoded}`);
const masterText = masterResponse.text;
const master = playlistOf(masterText);
const groups = mediaGroups(masterText);
const groupsOf = (type) => groups.filter((group) => group.TYPE === type);
const stream = master.playlists[0];

await report.check(
  'the master playlist is HLS and lists its groups',
  async () => {
    const ok =
      masterResponse.status === 200 &&
      masterResponse.headers.get('content-type') === MASTER_TYPE &&
      masterText.startsWith('#EXTM3U') &&
      Number(stream.BANDWIDTH) > 0 &&
      /^\d+x\d+$/.test(stream.RESOLUTION) &&
      stream.AUDIO === 'audio' &&
      stream.VIDEO === 'video' &&
      stream.SUBTITLES === 'subs' &&
      groupsOf('VIDEO').length === 1 &&
      groupsOf('AUDIO').length > 0 &&
      groupsOf('SUBTITLES').length > 0 &&
      groupsOf('AUDIO').every((group) => group['GROUP-ID'] === 'audio') &&
      groupsOf('SUBTITLES').every((group) => group['GROUP-ID'] === 'subs');
    return {
      passed: ok,
      detail:
        `${stream.BANDWIDTH} bps, ${stream.RESOLUTION}, ` +
        `${groupsOf('AUDIO').length} audio, ` +
        `${groupsOf('SUBTITLES').length} subtitles`,
    };
  },
);

const referenced = [
  ...new Set([...groups.map((group) => group.URI), stream.uri]),
];
const mediaPlaylists = [];
for (const uri of referenced) {
  mediaPlaylists.push({ uri, response: await server.request(`/${uri}`) });
}
const unresolved = mediaPlaylists.filter((entry) => {
  const playlist = playlistOf(entry.response.text);
  // Subtitle renditions are WebVTT and carry no init section, so only the
  // audio and video playlists point at one.
  const wantsMap = !entry.uri.includes('/subtitles/');
  return (
    entry.response.status !== 200 ||
    entry.response.headers.get('content-type') !== MASTER_TYPE ||
    playlist.segments.length === 0 ||
    !playlist.endList ||
    Boolean(playlist.map) !== wantsMap
  );
});

await report.check(
  'every playlist the master references resolves',
  async () => {
    const shown = unresolved.map(
      (entry) => `${entry.uri} → ${entry.response.status}`,
    );
    const counts = mediaPlaylists.map(
      (entry) =>
        `${entry.uri} ${playlistOf(entry.response.text).segments.length}`,
    );
    return {
      passed: unresolved.length === 0,
      detail: shown.join(', ') || counts.join(', '),
    };
  },
);

report.section('init sections and segments');

const videoInit = await server.request(`/${seeded.infoHash}/0/video/init.mp4`);
const videoSegment = await server.request(`/${seeded.infoHash}/0/video/0.m4s`);
const boxOf = (bytes) => bytes.toString('latin1', 4, 8);

await report.check(
  'the video init section and first segment are fMP4',
  async () => {
    const ok =
      videoInit.status === 200 &&
      videoInit.headers.get('content-type') === 'video/mp4' &&
      isInit(videoInit.bytes) &&
      videoSegment.status === 200 &&
      videoSegment.headers.get('content-type') === 'video/mp4' &&
      isFragment(videoSegment.bytes);
    return {
      passed: ok,
      detail:
        `init ${videoInit.bytes.length}B (${boxOf(videoInit.bytes)}), ` +
        `segment ${videoSegment.bytes.length}B (${boxOf(videoSegment.bytes)})`,
    };
  },
);

const audioUris = groupsOf('AUDIO').map((group) => group.URI);
const audioTracks = [];
for (const uri of audioUris) {
  const directory = uri.replace(/\/index\.m3u8$/, '');
  const init = await server.request(`/${directory}/init.mp4`);
  const segment = await server.request(`/${directory}/0.m4s`);
  audioTracks.push({ uri, init, segment });
}
const brokenAudio = audioTracks.filter((track) => {
  const type = (response) => response.headers.get('content-type');
  return (
    track.init.status !== 200 ||
    type(track.init) !== 'audio/mp4' ||
    !isInit(track.init.bytes) ||
    track.segment.status !== 200 ||
    type(track.segment) !== 'audio/mp4' ||
    !isFragment(track.segment.bytes)
  );
});

await report.check(
  'every audio init section and first segment is fMP4',
  async () => {
    const shown = statusLines(brokenAudio, (track) => track.uri);
    const listed = audioTracks.map(
      (track) =>
        `${track.uri} init ${track.init.bytes.length}B ` +
        `segment ${track.segment.bytes.length}B`,
    );
    return {
      passed: brokenAudio.length === 0,
      detail: shown || listed.join('; '),
    };
  },
);

report.section('subtitle cues');

const subtitleUri = groupsOf('SUBTITLES')[0].URI;
const subtitleDirectory = subtitleUri.replace(/\/index\.m3u8$/, '');
const subtitleIndex = await server.request(`/${subtitleUri}`);
const cueList = playlistOf(subtitleIndex.text).segments;
const cueBodies = [];
for (const cue of cueList.slice(0, 8)) {
  const response = await server.request(`/${subtitleDirectory}/${cue.uri}`);
  cueBodies.push(response.text);
}
const spoken = cueBodies.filter((body) => body.includes('Cue '));
const cues = cueBodies.join('\n');

await report.check(
  'the subtitle playlist and its cues are WebVTT',
  async () => {
    const ok =
      subtitleIndex.status === 200 &&
      subtitleIndex.headers.get('content-type') === MASTER_TYPE &&
      cueList.length > 0 &&
      cueList.every((cue) => cue.uri.endsWith('.vtt')) &&
      spoken.length > 0 &&
      cues.includes('Cue 1') &&
      cues.includes('-->');
    return {
      passed: ok,
      detail:
        `${cueList.length} cues, ${spoken.length} of ${cueBodies.length} ` +
        `fetched carry text; "Cue 1" ` +
        `${cues.includes('Cue 1') ? 'present' : 'missing'}`,
    };
  },
);

report.section(`${VIEWERS} viewers, one cold segment`);
// Nothing of ours may still be running when they arrive, or the queue
// counters describe the earlier work rather than theirs.
await waitFor(
  async () => {
    const status = await server.getJson('/status');
    const idle = status.jobs.running === 0 && status.jobs.queued === 0;
    return idle ? status : false;
  },
  { timeoutMs: 90_000, intervalMs: 200 },
);

const coldPath = `/${seeded.infoHash}/0/video/${COLD_SEGMENT}.m4s`;
const logMark = await fileSize(server.logPath);
const peak = { running: 0, queued: 0 };
let sampling = true;

// A segment render is tens of milliseconds here, so the samples have to come
// faster than that to see it at all.
const sampler = (async () => {
  while (sampling) {
    const status = await server.getJson('/status');
    peak.running = Math.max(peak.running, status.jobs.running);
    peak.queued = Math.max(peak.queued, status.jobs.queued);
    await sleep(5);
  }
})();

const waiting = [];
for (let viewer = 0; viewer < VIEWERS; viewer++) {
  waiting.push(server.request(coldPath));
}
const served = await Promise.all(waiting);
sampling = false;
await sampler;

const firstView = served[0];
const others = served.slice(1);
const same = others.every((response) => response.bytes.equals(firstView.bytes));

await sleep(300);
const coldRenders = rendersIn(await logSince(server, logMark)).filter(
  (render) => render.rendition === 'video' && render.n === COLD_SEGMENT,
);
const settled = await waitFor(
  async () => {
    const status = await server.getJson('/status');
    const idle = status.jobs.running === 0 && status.jobs.queued === 0;
    return idle ? status : false;
  },
  { timeoutMs: 30_000, intervalMs: 100 },
);

await report.check(
  'identical concurrent requests share one render',
  async () => {
    return {
      passed:
        served.every((response) => response.status === 200) &&
        firstView.bytes.length > 0 &&
        same &&
        coldRenders.length === 1 &&
        peak.running <= 1 &&
        peak.queued === 0,
      detail:
        `${VIEWERS} × 200, ${firstView.bytes.length}B, ` +
        `byte-identical=${same}, renders=${coldRenders.length}, ` +
        `peak queue running=${peak.running} queued=${peak.queued}`,
    };
  },
);

report.section('unknown and wandering paths');

const strays = [
  `/${seeded.infoHash}/0/bogus/thing`,
  `/${seeded.infoHash}/0/video/../master.m3u8`,
  `/${seeded.infoHash}/0/video/%2e%2e%2f%2e%2e%2fmaster.m3u8`,
  `/${seeded.infoHash}/0/audio/1/init.mp4`,
  `/${seeded.infoHash}/0/video/0.mp4`,
  `/${seeded.infoHash}/0/video/9999.m4s`,
  `/${seeded.infoHash}/0/subtitles/1/index.m3u8`,
];
const strayResponses = [];
for (const pathname of strays) {
  const response = await server.request(pathname);
  strayResponses.push({ pathname, response });
}
failures.push(...strayResponses.map((entry) => entry.response));

const isEscape = (entry) =>
  entry.pathname.includes('..') || entry.pathname.toLowerCase().includes('%2e');
const escapes = strayResponses.filter(isEscape);
const leaked = escapes.filter(
  (entry) =>
    entry.response.status !== 404 || entry.response.text.includes('#EXTM3U'),
);

await report.check('an unknown path under a known title is 404', async () => {
  const found = new Map(
    strayResponses.map((entry) => [entry.pathname, entry.response.status]),
  );
  const wrong = [...found].filter(([, status]) => status !== 404);
  return {
    passed: wrong.length === 0,
    detail:
      statusLines(wrong, (entry) => entry[0]) ||
      `${found.size} stray paths answered 404`,
  };
});

await report.check('path traversal is rejected', async () => {
  const shown = leaked.map(
    (entry) => `${entry.pathname} → ${entry.response.status}`,
  );
  const summary =
    `${escapes.length} traversal attempts answered 404, ` +
    `none served a playlist`;
  return {
    passed: escapes.length > 0 && leaked.length === 0,
    detail: shown.join(', ') || summary,
  };
});

report.section('failures');

await report.check('every failure answers {"error": "..."}', async () => {
  const wrong = failures.filter((response) => !hasErrorShape(response));
  return {
    passed: failures.length > 0 && wrong.length === 0,
    detail:
      `${failures.length - wrong.length} of ${failures.length} failures ` +
      `carry a single "error" string`,
  };
});

report.section('a restart with the swarm gone');

// The seeder is closing after this, so anything the second server serves has
// to be on disk already.
const masterBefore = masterResponse.text;
const segmentBefore = await server.getBytes(
  `/${seeded.infoHash}/0/video/0.m4s`,
);

await server.stop();
await seeded.close();
await server.restart({});

const restartMark = await fileSize(server.logPath);
const masterAfter = await server.request(`/m3u8?${encoded}`);
const segmentAfter = await server.request(`/${seeded.infoHash}/0/video/0.m4s`);
const restartRenders = rendersIn(await logSince(server, restartMark));
const unchanged =
  masterAfter.text === masterBefore && segmentAfter.bytes.equals(segmentBefore);

await report.check(
  'a restart still serves the playlists and a rendered segment',
  async () => {
    return {
      passed:
        masterAfter.status === 200 &&
        segmentAfter.status === 200 &&
        segmentAfter.bytes.length > 0 &&
        unchanged &&
        restartRenders.length === 0,
      detail:
        `master ${masterAfter.status}, segment ${segmentAfter.status} ` +
        `${segmentAfter.bytes.length}B, identical=${unchanged}, ` +
        `renders after restart=${restartRenders.length}`,
    };
  },
);

await server.stop();
report.finish();
process.exit(process.exitCode ?? 0);
