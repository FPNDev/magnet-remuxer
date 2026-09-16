// Verifies the remux pipeline against a local file, with no torrent involved:
// every segment of every rendition is rendered, then compared with the source.
// Usage: node test/remux.mjs [file.mkv] [targetDuration]
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Remuxer, TIMELINE_OFFSET_SECONDS } from '../dist/hls/remux.js';
import { LocalFileSource } from '../dist/io/byte-source.js';
import { codecString, getRenditions } from '../dist/media/codecs.js';
import {
  buildMediaIndex,
  segmentCount,
  segmentEnd,
  segmentStart,
} from '../dist/media/media-index.js';
import {
  FFMPEG,
  check,
  failureCount,
  firstTfdt,
  fixturesDir,
  mediaDuration,
  packetCount,
  packets,
  section,
  trackTimescale,
  workDir,
} from './lib.mjs';

const file = path.resolve(process.argv[2] ?? path.join(fixturesDir, 'movie.mkv'));
const targetDuration = Number(process.argv[3] ?? 6);
const out = path.join(workDir, 'remux', path.basename(file, path.extname(file)));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const source = await LocalFileSource.open(file);
const index = await buildMediaIndex(source, path.basename(file), targetDuration);
const renditions = getRenditions(index);
const remuxer = new Remuxer({ ffmpegPath: FFMPEG, timeoutMs: 60_000 });
const count = segmentCount(index);

section(`remux ${path.basename(file)} - ${count} segments, ${index.keyframes.length} keyframes in ${new Set(index.keyframes.map((k) => k.cluster)).size} clusters`);

const sourceDuration = await mediaDuration(file);
const playlistDuration = segmentEnd(index, count - 1);
check(
  Math.abs(playlistDuration - sourceDuration) < 0.5,
  'playlist duration matches the file',
  `${playlistDuration.toFixed(3)}s vs ${sourceDuration.toFixed(3)}s`,
);

for (const rendition of [renditions.video, ...renditions.audio, ...renditions.subtitles]) {
  const name = rendition.type === 'video' ? 'video' : `${rendition.type}-${rendition.track.number}`;
  const label = `${name} (${rendition.track.codecId} → ${codecString(rendition)})`;
  const dir = path.join(out, name);
  await mkdir(dir, { recursive: true });

  const streamIndex = index.tracks.findIndex((track) => track.number === rendition.track.number);
  const isSubtitle = rendition.type === 'subtitle';
  const started = Date.now();

  if (!isSubtitle) {
    await remuxer.writeInit(index, rendition, path.join(dir, 'init.mp4'));
  }
  for (let n = 0; n < count; n++) {
    await remuxer.writeSegment(
      { index, source, rendition },
      n,
      path.join(dir, `${n}.${isSubtitle ? 'vtt' : 'm4s'}`),
    );
  }
  const ms = Date.now() - started;

  if (isSubtitle) {
    let cues = 0;
    for (let n = 0; n < count; n++) {
      const text = await readFile(path.join(dir, `${n}.vtt`), 'utf8');
      cues += (text.match(/-->/g) ?? []).length;
    }
    const expected = await packetCount(file, streamIndex);
    check(cues === expected, `${label}: every cue appears exactly once`, `${cues}/${expected} cues in ${ms} ms`);
    continue;
  }

  // Concatenating the init section and every segment must give a playable file.
  const init = await readFile(path.join(dir, 'init.mp4'));
  const timescale = trackTimescale(init);
  const parts = [init];
  let worstOffset = 0;
  for (let n = 0; n < count; n++) {
    const segment = await readFile(path.join(dir, `${n}.m4s`));
    parts.push(segment);
    const start = firstTfdt(segment) / timescale - TIMELINE_OFFSET_SECONDS;
    worstOffset = Math.max(worstOffset, Math.abs(start - segmentStart(index, n)));
  }
  const full = path.join(dir, 'full.mp4');
  await writeFile(full, Buffer.concat(parts));

  const produced = await packets(full);
  let regressions = 0;
  for (let i = 1; i < produced.length; i++) {
    if (produced[i][1] <= produced[i - 1][1]) {
      regressions++;
    }
  }

  check(
    worstOffset < 0.2,
    `${label}: segments start where the playlist says`,
    `worst offset ${Math.round(worstOffset * 1000)} ms`,
  );

  if (rendition.transcode) {
    let gaps = 0;
    for (let i = 1; i < produced.length; i++) {
      if (produced[i][0] - produced[i - 1][0] !== 1024) {
        gaps++;
      }
    }
    check(
      gaps === 0 && regressions === 0,
      `${label}: AAC frames are contiguous across segment boundaries`,
      `${produced.length} frames, ${gaps} gaps, ${regressions} dts regressions, ${ms} ms`,
    );
  } else {
    const expected = await packetCount(file, streamIndex);
    const sourcePts = (await packets(file, String(streamIndex))).map(([pts]) => pts).sort((a, b) => a - b);
    const outputPts = produced
      .map(([pts]) => Math.round((pts / timescale - TIMELINE_OFFSET_SECONDS) * 1000))
      .sort((a, b) => a - b);
    const mismatches = sourcePts.filter((pts, i) => Math.abs(pts - outputPts[i]) > 1).length;

    check(
      produced.length === expected && mismatches === 0 && regressions === 0,
      `${label}: every packet, unchanged timestamps`,
      `${produced.length}/${expected} packets, ${mismatches} pts mismatches, ${regressions} dts regressions, ${ms} ms`,
    );
  }
}

process.exit(failureCount() ? 1 : 0);
