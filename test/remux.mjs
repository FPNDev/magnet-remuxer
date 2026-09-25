// Index, slice and remux one local file. A seeded MKV is served over HLS at a
// target segment duration given on the command line, and every claim about the
// output is made against real ffprobe numbers: the playlist covers the source,
// segments start at the time the playlist gives them, AAC frames join up across
// a boundary, packet timestamps come through the remux, transcodes land on a
// channel count AAC can carry, and no subtitle cue is dropped or repeated.
//
//   node test/remux.mjs test/.work/fixtures/tiny.mkv 2

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TIMELINE_OFFSET_SECONDS } from '../dist/hls/remux.js';
import {
  cacheRoot,
  ensureFixtures,
  ffprobeEntries,
  ffprobeJson,
  playlistOf,
  reporter,
  resolveBinaries,
  seed,
  suitePort,
  TestServer,
} from './lib.mjs';

const source = process.argv[2];
const target = Number(process.argv[3]);

if (!source || !Number.isFinite(target) || target <= 0) {
  console.log('usage: node test/remux.mjs <file.mkv> <targetSegmentSeconds>');
  process.exit(1);
}

await resolveBinaries();
await ensureFixtures();

const report = reporter(`remux ${path.basename(source)}@${target}s`);
const cacheDir = path.join(cacheRoot, 'remux');
// Outside the cache's own directories, which the disk guard sweeps.
const scratch = path.join(cacheDir, 'probe');

const server = await TestServer.start({
  name: 'remux',
  port: suitePort(12),
  cacheDir,
  options: { env: { SEGMENT_DURATION: String(target) } },
});
const seeded = await seed(source);
await mkdir(scratch, { recursive: true });

// ------------------------------------------------------------------ helpers

/**
 * The `EXT-X-MEDIA` lines of the master playlist. `playlistOf` collects only
 * `EXT-X-STREAM-INF`, so rendition URIs are taken straight from the text.
 * Would sit better in lib.mjs; kept here because that file is shared.
 */
function mediaEntries(text) {
  const entries = [];
  for (const match of text.matchAll(/#EXT-X-MEDIA:([^\r\n]*)/g)) {
    const line = match[1];
    const type = /TYPE=([A-Z]+)/.exec(line)?.[1];
    const uri = /URI="([^"]+)"/.exec(line)?.[1];
    const channels = /CHANNELS="(\d+)"/.exec(line)?.[1];
    if (!type || !uri) {
      continue;
    }
    entries.push({
      type,
      uri,
      channels: channels === undefined ? undefined : Number(channels),
    });
  }
  return entries;
}

/** `index.m3u8` -> the directory holding the rendition's segments. */
const dirOf = (uri) => uri.replace(/index\.m3u8$/, '');

async function playlistAt(uri) {
  const response = await server.request(`/${uri}`);
  if (response.status !== 200) {
    throw new Error(`playlist ${uri} answered ${response.status}`);
  }
  return playlistOf(response.text);
}

const initSections = new Map();

async function initFor(dir) {
  if (!initSections.has(dir)) {
    initSections.set(dir, await server.getBytes(`/${dir}init.mp4`));
  }
  return initSections.get(dir);
}

/**
 * One segment as ffprobe packets. A segment carries only fragments, so the
 * init section is prepended: ffprobe needs the `moov` to read them.
 */
async function segmentAt(dir, n, extension) {
  const bytes = await server.getBytes(`/${dir}${n}.${extension}`);
  const init = await initFor(dir);
  const file = path.join(
    scratch,
    `${dir.replaceAll('/', '-')}${n}.${extension}`,
  );
  await writeFile(file, Buffer.concat([init, bytes]));
  const packets = await ffprobeEntries(file, 'packets');
  return { bytes, file, packets };
}

/**
 * Start time in seconds of every cue in a WebVTT body. HLS keeps source
 * timestamps here and declares the offset in X-TIMESTAMP-MAP.
 */
function vttStarts(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\d:.]+\.\d{3})\s*-->/.exec(line);
    if (!match) {
      continue;
    }
    let total = 0;
    for (const part of match[1].trim().split(':')) {
      total = total * 60 + Number(part);
    }
    found.push(total);
  }
  return found;
}

const ptsOf = (packet) => Number(packet.pts_time);
const firstPts = (packets) => ptsOf(packets[0]);
const lastPtsEnd = (packets) => {
  const last = packets.at(-1);
  return ptsOf(last) + Number(last.duration_time);
};

/** Shortest gap between the first few packets: the frame or AAC frame step. */
function packetStep(packets) {
  let step = Infinity;
  const limit = Math.min(packets.length, 8);
  for (let i = 1; i < limit; i++) {
    const gap = ptsOf(packets[i]) - ptsOf(packets[i - 1]);
    if (gap > 0) {
      step = Math.min(step, gap);
    }
  }
  return Number.isFinite(step) ? step : 1 / 24;
}

const fixed = (value, digits = 3) => value.toFixed(digits);
const milli = (value) => `${(value * 1000).toFixed(1)}ms`;

// -------------------------------------------------------------------- setup

const master = (
  await server.request(`/m3u8?magnet=${encodeURIComponent(seeded.magnet)}`)
).text;
const videoUri = playlistOf(master).playlists[0].uri;
const videoPlaylist = await playlistAt(videoUri);
const videoDir = dirOf(videoUri);

// Running sum of the durations the playlist printed: what a player believes
// the timeline is.
const starts = [];
let elapsed = 0;
for (const segment of videoPlaylist.segments) {
  starts.push(elapsed);
  elapsed += segment.duration;
}
const summed = elapsed;
const count = videoPlaylist.segments.length;

const sourceInfo = await ffprobeJson(source);
const sourceDuration = Number(sourceInfo.format.duration);
const audioStreams = sourceInfo.streams.filter(
  (stream) => stream.codec_type === 'audio',
);

const sourcePackets = (
  await ffprobeJson(source, ['-show_packets', '-select_streams', 'v:0'])
).packets;
if (!sourcePackets?.length) {
  throw new Error(`ffprobe found no video packets in ${source}`);
}
const sourceTimes = sourcePackets.map(ptsOf);
const sourceKeyframes = sourcePackets
  .filter((packet) => String(packet.flags ?? '').includes('K'))
  .map(ptsOf);

const sampled = [0, Math.floor(count / 2), Math.max(0, count - 1)].filter(
  (n, index, all) => all.indexOf(n) === index,
);

const audioEntries = mediaEntries(master).filter(
  (entry) => entry.type === 'AUDIO',
);
const subtitleEntries = mediaEntries(master).filter(
  (entry) => entry.type === 'SUBTITLES',
);

try {
  // --------------------------------------------------------------- playlist

  report.section('the playlist');

  await report.check(
    'the summed EXTINF covers the source duration',
    async () => {
      // A segment of slack: the planner folds a short tail into the segment
      // before it instead of ending on a sliver.
      const gap = Math.abs(summed - sourceDuration);
      return {
        passed: gap <= target,
        detail: `playlist ${fixed(summed)}s vs source ${fixed(sourceDuration)}s, off by ${fixed(gap)}s (slack ${target}s)`,
      };
    },
  );

  await report.check(
    'the segment count follows the duration and the target',
    async () => {
      // Boundaries snap to keyframes, so one segment can be as short as half the
      // target and as long as the target plus a keyframe interval. That band is
      // the entire difference between count and duration/target.
      const expected = sourceDuration / target;
      const low = Math.floor(expected / 2);
      const high = Math.ceil(expected * 2);
      return {
        passed: count >= low && count <= high,
        detail: `${count} segments for duration/target ${fixed(expected)} (band ${low}..${high})`,
      };
    },
  );

  // ------------------------------------------------------------- boundaries

  report.section('segment boundaries');

  const samples = [];
  for (const n of sampled) {
    samples.push({ n, ...(await segmentAt(videoDir, n, 'm4s')) });
  }

  await report.check(
    'a segment starts when the playlist says it does',
    async () => {
      let worst = { gap: 0 };
      for (const sample of samples) {
        const actual = firstPts(sample.packets) - TIMELINE_OFFSET_SECONDS;
        const expected = starts[sample.n];
        // EXTINF carries three decimals, so the running sum drifts by up to half
        // a millisecond for every segment it added up.
        const tolerance =
          1.5 * packetStep(sample.packets) + 0.0005 * (sample.n + 1);
        const gap = Math.abs(actual - expected);
        if (gap >= worst.gap) {
          worst = { gap, n: sample.n, actual, expected, tolerance };
        }
      }
      return {
        passed: worst.gap <= worst.tolerance,
        detail: `worst ${milli(worst.gap)} on segment ${worst.n}: packets at ${fixed(worst.actual, 6)}s, playlist ${fixed(worst.expected, 6)}s`,
      };
    },
  );

  await report.check('packet timestamps survive the remux', async () => {
    // Container timestamps are millisecond exact, so two milliseconds is room
    // enough for the round trip through fMP4.
    const tolerance = 0.002;
    let compared = 0;
    let worst = { gap: 0 };
    for (const sample of samples) {
      // The opening frames of each sampled segment have to exist, at the same
      // time, in the source.
      for (const packet of sample.packets.slice(0, 12)) {
        const wanted = ptsOf(packet) - TIMELINE_OFFSET_SECONDS;
        let best = Infinity;
        for (const time of sourceTimes) {
          const gap = Math.abs(time - wanted);
          if (gap < best) {
            best = gap;
          }
        }
        compared++;
        if (best > worst.gap) {
          worst = { gap: best, n: sample.n, wanted };
        }
      }
    }
    return {
      passed: worst.gap <= tolerance && compared > 0,
      detail: `${compared} packets across ${samples.length} segments, worst ${milli(worst.gap)} at ${fixed(worst.wanted, 6)}s`,
    };
  });

  await report.check('a segment starts on a source keyframe', async () => {
    const tolerance = 0.002;
    let worst = { gap: 0 };
    for (const sample of samples) {
      const actual = firstPts(sample.packets) - TIMELINE_OFFSET_SECONDS;
      let best = Infinity;
      let at = 0;
      for (const time of sourceKeyframes) {
        const gap = Math.abs(time - actual);
        if (gap < best) {
          best = gap;
          at = time;
        }
      }
      if (best >= worst.gap) {
        worst = { gap: best, n: sample.n, actual, keyframe: at };
      }
    }
    return {
      passed: worst.gap <= tolerance,
      detail: `${sourceKeyframes.length} keyframes, worst ${milli(worst.gap)} on segment ${worst.n} (start ${fixed(worst.actual, 6)}s vs keyframe ${fixed(worst.keyframe, 6)}s)`,
    };
  });

  // ------------------------------------------------------------------ audio

  report.section('audio');

  await report.check(
    'AAC frames are contiguous across a boundary',
    async () => {
      if (audioEntries.length === 0) {
        return {
          passed: true,
          detail: `skipped: ${path.basename(source)} has no audio rendition`,
        };
      }

      const results = [];
      for (const entry of audioEntries) {
        const dir = dirOf(entry.uri);
        for (const n of [0, Math.floor(count / 2)]) {
          if (n + 1 >= count) {
            continue;
          }
          const before = await segmentAt(dir, n, 'm4s');
          const after = await segmentAt(dir, n + 1, 'm4s');
          results.push({
            label: `${dir} ${n}->${n + 1}`,
            gap: Math.abs(firstPts(after.packets) - lastPtsEnd(before.packets)),
            step: packetStep(after.packets),
          });
        }
      }

      const worst = results.reduce((a, b) => (b.gap > a.gap ? b : a));
      return {
        passed:
          results.length > 0 &&
          results.every((result) => result.gap <= result.step),
        detail:
          `${results.length} boundaries over ${audioEntries.length} renditions, ` +
          `worst gap ${milli(worst.gap)} at ${worst.label} (one AAC frame is ${milli(worst.step)})`,
      };
    },
  );

  await report.check(
    'each rendition lands on a channel count AAC can carry',
    async () => {
      if (audioEntries.length === 0) {
        return {
          passed: true,
          detail: `skipped: ${path.basename(source)} has no audio rendition`,
        };
      }

      const labels = [];
      let bad = undefined;
      for (const [index, entry] of audioEntries.entries()) {
        const dir = dirOf(entry.uri);
        const { file } = await segmentAt(dir, 0, 'm4s');
        const served = (await ffprobeJson(file, ['-show_streams']))
          ?.streams?.[0];
        const source = audioStreams[index];
        const sourceChannels = Number(source?.channels ?? 2);
        const copied = served?.codec_name === source?.codec_name;
        // AAC tops out at six channels, so a wider source is folded down, while a
        // track that is copied through keeps exactly what it came in with.
        const expected = copied ? sourceChannels : Math.min(6, sourceChannels);
        const label =
          `${dir}: source ${sourceChannels}ch ${source?.codec_name} -> ` +
          `${served?.channels}ch ${served?.codec_name} (${copied ? 'copy' : 'transcode'})`;
        labels.push(label);
        if (Number(served?.channels) !== expected) {
          bad = `${label}, expected ${expected}ch`;
        } else if (
          entry.channels !== undefined &&
          entry.channels !== Number(served.channels)
        ) {
          bad = `${dir}: playlist says ${entry.channels}ch, segment carries ${served.channels}ch`;
        }
      }

      return {
        passed: bad === undefined,
        detail: bad ?? labels.join('; '),
      };
    },
  );

  // -------------------------------------------------------------- subtitles

  report.section('subtitles');

  await report.check('every cue appears in exactly one segment', async () => {
    if (subtitleEntries.length === 0) {
      return {
        passed: true,
        detail: `skipped: ${path.basename(source)} has no text subtitle track`,
      };
    }

    const cues = (
      await ffprobeJson(source, ['-show_packets', '-select_streams', 's:0'])
    ).packets.map(ptsOf);

    const seen = new Map();
    for (let n = 0; n < count; n++) {
      const response = await server.request(
        `/${dirOf(subtitleEntries[0].uri)}${n}.vtt`,
      );
      if (response.status !== 200) {
        return {
          passed: false,
          detail: `subtitle segment ${n} answered ${response.status}`,
        };
      }
      for (const start of vttStarts(response.text)) {
        seen.set(start, (seen.get(start) ?? 0) + 1);
      }
    }

    // A cue is cut at the keyframe boundary, and the WebVTT keeps the source
    // timestamps, so twenty milliseconds is generous and still below the gap
    // between two cues.
    const tolerance = 0.02;
    const counts = cues.map((cue) => {
      let total = 0;
      let gap = Infinity;
      for (const [start, count] of seen) {
        const distance = Math.abs(start - cue);
        if (distance <= tolerance) {
          total += count;
          gap = Math.min(gap, distance);
        }
      }
      return { cue, total, gap };
    });

    const wrong = counts.filter((entry) => entry.total !== 1);
    const servedCues = [...seen.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    return {
      passed: cues.length > 0 && wrong.length === 0,
      detail:
        `${cues.length} source cues, ${servedCues} served across ${count} segments, ` +
        (wrong.length === 0
          ? 'each in exactly one'
          : `${wrong.length} missing or repeated: ${wrong
              .slice(0, 4)
              .map((entry) => `${fixed(entry.cue)}s seen ${entry.total}x`)
              .join(', ')}`),
    };
  });
} finally {
  await rm(scratch, { recursive: true, force: true });
  await server.stop();
  await seeded.close();
}

report.finish();
process.exit(process.exitCode ?? 0);
