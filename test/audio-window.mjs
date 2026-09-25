// The byte window a converted audio segment reads. One file, three servers:
// the first takes the tight read the planner prefers; the second is told up
// front that the file interleaves loosely and so takes the generous read
// straight away. Both have to produce the same bytes, and the tight one has to
// ask the swarm for less. The third serves a copy of the file whose cue index
// points one keyframe at a later cluster: the tight read there comes up
// short, the app has to notice, and the segment still has to come out intact.
//
//   node test/audio-window.mjs

import crypto from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LocalFileSource } from '../dist/io/byte-source.js';
import {
  childElements,
  readElementHeader,
  readUint,
} from '../dist/matroska/ebml.js';
import { Id } from '../dist/matroska/ids.js';
import { readMatroskaLayout } from '../dist/matroska/layout.js';
import {
  cacheRoot,
  ensureFixtures,
  exists,
  ffprobeJson,
  fixtures,
  playlistOf,
  removeDir,
  reporter,
  resolveBinaries,
  seed,
  sleep,
  suitePort,
  TestServer,
  waitFor,
  workDir,
  writeJson,
} from './lib.mjs';

// Boundaries snap to the keyframe grid, so a target that is not a multiple of
// the keyframe interval leaves keyframes sitting between two segments. Those
// are the ones the patched copy points at the wrong cluster.
const TARGET_SECONDS = 3;
const SAMPLE_OFFSETS = [0.15, 0.5, 0.85];
// InterleavingNotes.save is debounced by this much.
const NOTE_DEBOUNCE_MS = 2500;

await resolveBinaries();
await ensureFixtures();

const report = reporter('audio-window');
const root = path.join(cacheRoot, 'audio-window');
const buildDir = path.join(workDir, 'fixtures-audio-window');
const scratch = path.join(root, 'rendered');
await mkdir(buildDir, { recursive: true });
await mkdir(scratch, { recursive: true });

// ------------------------------------------------------------------ helpers

/**
 * The `EXT-X-MEDIA` lines of the master playlist, which `playlistOf` leaves
 * out. Would sit better in lib.mjs; kept here because that file is shared.
 */
function mediaEntries(text) {
  const entries = [];
  for (const match of text.matchAll(/#EXT-X-MEDIA:([^\r\n]*)/g)) {
    const line = match[1];
    const type = /TYPE=([A-Z]+)/.exec(line)?.[1];
    const uri = /URI="([^"]+)"/.exec(line)?.[1];
    const channels = /CHANNELS="(\d+)"/.exec(line)?.[1];
    const track = /\/audio\/(\d+)\//.exec(uri ?? '');
    if (!type || !uri) {
      continue;
    }
    entries.push({
      type,
      uri,
      track: track ? Number(track[1]) : undefined,
      channels: channels === undefined ? undefined : Number(channels),
    });
  }
  return entries;
}

const dirOf = (uri) => uri.replace(/index\.m3u8$/, '');

/** The Cues element of a Matroska file, reached through Segment. */
function cuesElement(bytes) {
  const ebml = readElementHeader(bytes, 0);
  const segmentAt = ebml.headerLength + ebml.size;
  const segment = readElementHeader(bytes, segmentAt);
  const from = segmentAt + segment.headerLength;
  const to = from + segment.size;
  for (const el of childElements(bytes, from, to)) {
    if (el.id === Id.Cues) {
      return el;
    }
  }
  return undefined;
}

/**
 * Where each video cue's cluster offset sits in the file, so a single pointer
 * can be rewritten in place. Cues store offsets relative to the Segment data
 * start and that is how they are read back, so the scale does not matter.
 */
function cuePointers(bytes, track) {
  const cues = cuesElement(bytes);
  if (!cues) {
    return [];
  }
  const points = [];
  for (const point of childElements(bytes, cues.dataStart, cues.dataEnd)) {
    if (point.id !== Id.CuePoint) {
      continue;
    }
    let time;
    let positions;
    for (const el of childElements(bytes, point.dataStart, point.dataEnd)) {
      if (el.id === Id.CueTime) {
        time = readUint(bytes, el);
      }
      if (el.id === Id.CueTrackPositions) {
        positions = el;
      }
    }
    if (!positions) {
      continue;
    }
    let cueTrack;
    for (const el of childElements(
      bytes,
      positions.dataStart,
      positions.dataEnd,
    )) {
      if (el.id === Id.CueTrack) {
        cueTrack = readUint(bytes, el);
      }
    }
    if (cueTrack !== track) {
      continue;
    }
    for (const el of childElements(
      bytes,
      positions.dataStart,
      positions.dataEnd,
    )) {
      if (el.id === Id.CueClusterPosition) {
        points.push({
          time,
          value: readUint(bytes, el),
          at: el.dataStart,
          width: el.dataEnd - el.dataStart,
        });
      }
    }
  }
  return points;
}

/**
 * A copy of `source` in which every other video cue claims its keyframe sits
 * `ahead` clusters later than it really does. Widths are preserved, so no
 * element size moves: only what the index says.
 */
async function fileWithMovedCues(source, { ahead, outPath }) {
  const bytes = await readFile(source);
  const layout = await readMatroskaLayout(
    new LocalFileSource(source, bytes.length),
  );
  const video = layout.tracks.find((track) => track.kind === 'video');
  const points = cuePointers(bytes, video.number);
  const moved = [];
  for (let index = 1; index + ahead < points.length; index += 2) {
    const from = points[index];
    const to = points[index + ahead];
    if (from.value === to.value) {
      continue;
    }
    bytes.writeUIntBE(to.value, from.at, from.width);
    moved.push({ at: from.time, was: from.value, now: to.value });
  }
  if (moved.length === 0) {
    return undefined;
  }
  await writeFile(outPath, bytes);
  return { path: outPath, moved };
}

const kibi = (bytes) => `${Math.round(bytes / 1024)} KiB`;
const sha = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');

async function settle(server) {
  await waitFor(
    async () => {
      const status = await server.getJson('/status');
      return status.jobs.running === 0 && status.jobs.queued === 0
        ? true
        : false;
    },
    { timeoutMs: 60_000, intervalMs: 100 },
  );
}

async function swarmBytes(server) {
  const status = await server.getJson('/status');
  return status.torrents[0]?.downloaded ?? 0;
}

/** Segment indexes sampled: cold, so each is the only read in flight. */
function sampleIndexes(count) {
  const last = count - 1;
  return SAMPLE_OFFSETS.map((fraction) =>
    Math.min(last, Math.max(0, Math.round(last * fraction))),
  ).filter((value, index, all) => all.indexOf(value) === index);
}

/**
 * Serves one file over a cold cache and renders the sampled segments of every
 * audio rendition. `notes` pre-loads the app's own list of loosely interleaved
 * files, which is what turns a tight read into a generous one.
 */
async function render({ name, file, notes, samples }) {
  const cacheDir = path.join(root, name);
  await removeDir(cacheDir);
  if (notes) {
    await writeJson(path.join(cacheDir, 'interleaving.json'), notes);
  }
  const server = await TestServer.start({
    name: `audio-window-${name}`,
    port: suitePort(13),
    cacheDir,
    options: {
      fresh: false,
      env: { SEGMENT_DURATION: String(TARGET_SECONDS) },
    },
  });
  const seeded = await seed(file);
  try {
    const master = (
      await server.request(`/m3u8?magnet=${encodeURIComponent(seeded.magnet)}`)
    ).text;
    await settle(server);
    const playlist = playlistOf(
      (await server.request(`/${playlistOf(master).playlists[0].uri}`)).text,
    );
    const picks = samples ?? sampleIndexes(playlist.segments.length);

    const audio = mediaEntries(master).filter(
      (entry) => entry.type === 'AUDIO',
    );
    const renditions = [];
    for (const [index, entry] of audio.entries()) {
      const dir = dirOf(entry.uri);
      const init = await server.getBytes(`/${dir}init.mp4`);
      const segments = [];
      for (const n of picks) {
        const before = await swarmBytes(server);
        const response = await server.request(`/${dir}${n}.m4s`);
        await settle(server);
        const after = await swarmBytes(server);
        segments.push({
          n,
          status: response.status,
          swarm: after - before,
          bytes: response.bytes,
        });
      }
      const probe = path.join(scratch, `${name}-audio-${entry.track}.m4s`);
      await writeFile(probe, Buffer.concat([init, segments[0].bytes]));
      const stream = (await ffprobeJson(probe, ['-show_streams']))
        ?.streams?.[0];
      renditions.push({
        track: entry.track,
        dir,
        source: {
          codec: sourceAudio[index]?.codec_name,
          channels: Number(sourceAudio[index]?.channels ?? 2),
        },
        served: {
          codec: stream?.codec_name,
          channels: Number(stream?.channels ?? 0),
        },
        segments,
      });
    }

    // A note, if one was written, only lands after the debounce.
    await sleep(NOTE_DEBOUNCE_MS);
    const notesPath = path.join(cacheDir, 'interleaving.json');
    const saved = (await exists(notesPath))
      ? JSON.parse(await readFile(notesPath, 'utf8'))
      : undefined;

    return { renditions, notes: saved, count: playlist.segments.length };
  } finally {
    await server.stop();
    await seeded.close();
  }
}

// ---------------------------------------------------------------------- run

const source = fixtures.movie();
const sourceLength = (await stat(source)).size;
const sourceAudio = (await ffprobeJson(source)).streams.filter(
  (stream) => stream.codec_type === 'audio',
);

// A copy of the file whose cue index points the keyframe sitting between two
// segments at a cluster two places later than the one it was written in.
const shiftedFile = await fileWithMovedCues(source, {
  ahead: 2,
  outPath: path.join(buildDir, `shifted-${path.basename(source)}`),
});

try {
  const tight = await render({ name: 'tight', file: source, sourceAudio });
  const generous = await render({
    name: 'generous',
    file: source,
    sourceAudio,
    notes: [`${path.basename(source)}:${sourceLength}`],
  });
  const shifted = shiftedFile
    ? await render({
        name: 'shifted',
        file: shiftedFile.path,
        sourceAudio,
      })
    : undefined;

  // Only a track the app transcodes gets a window the note can change.
  const convertedIndex = tight.renditions.findIndex(
    (rendition) => rendition.served.codec !== rendition.source.codec,
  );
  const converted = tight.renditions[convertedIndex];
  const wide = generous.renditions[convertedIndex];

  if (converted === undefined) {
    report.section('the window');
    await report.check('a converted audio rendition is present', async () => ({
      passed: false,
      detail: `${path.basename(source)} has no transcoded audio track`,
    }));
  } else {
    report.section('the window');

    await report.check(
      'a tight read returns the same segment as a generous one',
      async () => {
        const sizes = [];
        let bad = undefined;
        for (const [index, segment] of converted.segments.entries()) {
          const other = wide.segments[index];
          sizes.push(`#${segment.n}:${segment.bytes.length}B`);
          if (segment.status !== 200 || other.status !== 200) {
            bad = `segment #${segment.n} answered ${segment.status}/${other.status}`;
            break;
          }
          if (!segment.bytes.equals(other.bytes)) {
            bad = `segment #${segment.n} differs: ${sha(segment.bytes)} vs ${sha(other.bytes)}`;
            break;
          }
        }
        return {
          passed: bad === undefined && converted.segments.length > 0,
          detail:
            `${converted.segments.length} segments identical (${sizes.join(' ')})` +
            (bad === undefined ? '' : `; ${bad}`),
        };
      },
    );

    await report.check(
      'the tight read pulls fewer bytes from the swarm',
      async () => {
        const pairs = [];
        let bad = undefined;
        for (const [index, segment] of converted.segments.entries()) {
          const other = wide.segments[index];
          pairs.push(
            `#${segment.n}: ${kibi(segment.swarm)} vs ${kibi(other.swarm)}`,
          );
          if (!(other.swarm > segment.swarm)) {
            bad = `segment #${segment.n}: tight ${kibi(segment.swarm)}, generous ${kibi(other.swarm)}`;
          }
        }
        return { passed: bad === undefined, detail: bad ?? pairs.join('; ') };
      },
    );
  }

  report.section('the cluster out of place');

  if (shiftedFile === undefined) {
    await report.check(
      'a keyframe cluster out of place is caught',
      async () => ({
        passed: false,
        detail: 'the shifted copy of the file could not be built',
      }),
    );
  } else {
    const key = `${path.basename(shiftedFile.path)}:${sourceLength}`;

    await report.check(
      'a keyframe cluster out of place is caught',
      async () => {
        const noted =
          Array.isArray(shifted.notes) && shifted.notes.includes(key);
        const quiet = tight.notes === undefined;
        return {
          passed: noted && quiet,
          detail:
            `shifted ${path.basename(shiftedFile.path)} at t=${shiftedFile.moved[0].at} ` +
            `(${shiftedFile.moved[0].was} -> ${shiftedFile.moved[0].now}); ` +
            `app wrote ${JSON.stringify(shifted.notes ?? null)}, control wrote ` +
            `${JSON.stringify(tight.notes ?? null)}`,
        };
      },
    );

    await report.check('the segment survives being read again', async () => {
      const control = converted.segments[0];
      const second = shifted.renditions[convertedIndex].segments[0];
      const intact =
        second.status === 200 &&
        second.bytes.length > 0 &&
        second.bytes.equals(control.bytes);
      return {
        passed: intact && second.swarm > control.swarm,
        detail:
          `segment #${control.n} identical at ${second.bytes.length}B; swarm ` +
          `${kibi(control.swarm)} tight vs ${kibi(second.swarm)} after the retry`,
      };
    });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

report.finish();
process.exit(process.exitCode ?? 0);
