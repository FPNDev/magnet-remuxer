import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Remuxer } from '../dist/hls/remux.js';
import { LocalFileSource } from '../dist/io/byte-source.js';
import { getRenditions } from '../dist/media/codecs.js';
import {
  buildMediaIndex,
  secondsToTicks,
  segmentCount,
  segmentStart,
} from '../dist/media/media-index.js';
import {
  FFMPEG,
  check,
  failureCount,
  fixturesDir,
  section,
  workDir,
} from './lib.mjs';

const out = path.join(workDir, 'audio-window');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Byte source wrapper that records how much the remuxer asks for. Only
// length and stream are reached on this path.
function counting(source) {
  const counter = { bytes: 0 };
  return {
    counter,
    source: {
      length: source.length,
      stream(start, end) {
        counter.bytes += end - start;
        return source.stream(start, end);
      },
    },
  };
}

for (const [name, target] of [
  ['movie.mkv', 2],
  ['codecs.mkv', 2],
]) {
  const file = path.join(fixturesDir, name);
  const local = await LocalFileSource.open(file);
  const index = await buildMediaIndex(local, name, target);
  const converted = getRenditions(index).audio.filter((a) => a.transcode);
  const count = segmentCount(index);

  section(
    `audio window - ${name} at ${target}s, ${converted.length} converted tracks`,
  );

  for (const rendition of converted) {
    const label = rendition.track.codecId;
    const remuxer = new Remuxer({ ffmpegPath: FFMPEG, timeoutMs: 60_000 });
    const { source, counter } = counting(local);
    const rendered = [];
    for (let n = 0; n < count; n++) {
      const segment = path.join(
        out,
        `${name}-${rendition.track.number}-${n}.m4s`,
      );
      await remuxer.writeSegment({ index, source, rendition }, n, segment);
      rendered.push(segment);
    }
    check(
      remuxer.looselyInterleaved.size === 0,
      `${label}: every tight read is enough on a normally muxed file`,
      `${count} segments, ${(counter.bytes / 2 ** 20).toFixed(1)} MiB read`,
    );

    const wide = new Remuxer({ ffmpegPath: FFMPEG, timeoutMs: 60_000 });
    // The loose-interleave key is `fileName:fileLength`. Adding it up front
    // forces the generous read without waiting for a short one to fail.
    wide.looselyInterleaved.add(`${index.fileName}:${index.fileLength}`);
    const { source: wideSource, counter: wideCounter } = counting(local);
    let identical = true;
    for (let n = 0; n < count; n++) {
      const segment = path.join(
        out,
        `${name}-${rendition.track.number}-${n}-wide.m4s`,
      );
      await wide.writeSegment(
        { index, source: wideSource, rendition },
        n,
        segment,
      );
      identical &&= (await readFile(segment)).equals(
        await readFile(rendered[n]),
      );
    }
    check(
      identical,
      `${label}: tight and generous reads produce identical segments`,
    );
    check(
      counter.bytes < wideCounter.bytes,
      `${label}: and the tight read asks for fewer bytes`,
      `${(counter.bytes / 2 ** 20).toFixed(1)} vs ${(wideCounter.bytes / 2 ** 20).toFixed(1)} MiB`,
    );
  }

  const rendition = converted[0];
  const n = Math.floor(count / 2);
  const start = secondsToTicks(index, segmentStart(index, n));
  const startCluster = index.keyframes.find((k) => k.ts >= start).cluster;
  const window = secondsToTicks(index, 2.5);
  let moved = 0;
  // Move keyframes just before the segment start into its cluster, so the
  // tight read starts too late and the recovery path has to run.
  const misplaced = {
    ...index,
    keyframes: index.keyframes.map((k) => {
      if (k.ts > start - window && k.ts < start) {
        moved++;
        return { ...k, cluster: startCluster };
      }
      return k;
    }),
  };

  const reference = path.join(out, `${name}-reference.m4s`);
  await new Remuxer({ ffmpegPath: FFMPEG, timeoutMs: 60_000 }).writeSegment(
    { index, source: local, rendition },
    n,
    reference,
  );
  const remuxer = new Remuxer({ ffmpegPath: FFMPEG, timeoutMs: 60_000 });
  const recovered = path.join(out, `${name}-recovered.m4s`);
  await remuxer.writeSegment(
    { index: misplaced, source: local, rendition },
    n,
    recovered,
  );

  check(
    moved > 0,
    `${name}: the test really misplaces a keyframe cluster`,
    `${moved} moved`,
  );
  check(
    (await readFile(recovered)).equals(await readFile(reference)),
    `${name}: a tight read that starts too late is caught and read again generously`,
  );
  check(
    remuxer.looselyInterleaved.size === 1,
    `${name}: and the file is remembered, so later segments skip straight to it`,
  );
}

process.exit(failureCount() ? 1 : 0);
