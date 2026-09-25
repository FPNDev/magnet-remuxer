// Builds the MKVs the suites read. They are skipped when already present
// unless the builder changed or `--force` was passed, so a run toying with one
// suite does not pay for ffmpeg every time.
//
//   node test/make-fixtures.mjs [--force]

import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { ffmpeg, fixtureDir, resolveBinaries, workDir } from './lib.mjs';

// Bumped whenever a fixture's shape changes. Fixtures built by anything other
// than this builder are rebuilt.
const BUILDER = 3;

// Keyframes land every 1.7 seconds, so no segment boundary falls on a round
// second and a playlist cannot be right by accident.
const KEYFRAME_SECONDS = 1.7;
const MOVIE_SECONDS = 120;
const SPARSE_SECONDS = 30;
const CODECS_SECONDS = 12;
const TINY_SECONDS = 30;

const VIDEO = {
  movie: { size: '1280x720', rate: 24 },
  sparse: { size: '480x270', rate: 24 },
  codecs: { size: '256x144', rate: 15 },
  tiny: { size: '64x64', rate: 10 },
};

const SRT = {
  'en.srt': { cues: 60, from: 0.2, every: 2, until: 120 },
  'sparse.srt': { cues: 3, from: 0.5, every: 2, until: 6 },
};

function subtitleTrack(name) {
  const spec = SRT[name];
  const lines = [];
  for (let cue = 0; cue < spec.cues; cue++) {
    const start = spec.from + cue * spec.every;
    const end = Math.min(start + 1.5, spec.until);
    lines.push(String(cue + 1), `${stamp(start)} --> ${stamp(end)}`, `Cue ${cue + 1}`, '');
  }
  return `${lines.join('\n')}\n`;
}

function stamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const whole = Math.floor(rest);
  const millis = Math.round((rest - whole) * 1000);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(whole)},${pad(millis, 3)}`;
}

/** Intermediates live in the disposable work directory, not beside fixtures. */
function tmpDir() {
  return path.join(workDir, 'tmp');
}

function keyframeArgs(seconds) {
  return ['-force_key_frames', `expr:gte(t,n_forced*${seconds})`];
}

async function buildMovie(target, seconds) {
  const { size, rate } = VIDEO.movie;
  return ffmpeg([
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`,
    '-i', path.join(fixtureDir, 'en.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    // A bitrate cap rather than a quality target: what these suites need is
    // exact keyframe placement, not picture detail, and the file stays small
    // enough to seed and hash quickly.
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '250k', '-maxrate', '300k', '-bufsize', '600k',
    ...keyframeArgs(KEYFRAME_SECONDS),
    // Stereo AAC a browser can decode, so this track is copied.
    '-c:a:0', 'aac', '-ac:a:0', '2', '-b:a:0', '96k',
    // 5.1 AC3 has to be transcoded downstream.
    '-c:a:1', 'ac3', '-ac:a:1', '6', '-b:a:1', '384k',
    '-c:s', 'srt',
    '-metadata:s:v:0', 'title=Video', '-metadata:s:a:0', 'title=Stereo AAC',
    '-metadata:s:a:1', 'title=Surround AC3', '-metadata:s:s:0', 'title=English',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=eng',
    '-metadata:s:s:0', 'language=eng',
    target,
  ]);
}

async function buildSparse(target, seconds) {
  const { size, rate } = VIDEO.sparse;
  return ffmpeg([
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
    '-i', path.join(fixtureDir, 'sparse.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '120k', '-maxrate', '160k', '-bufsize', '320k',
    ...keyframeArgs(KEYFRAME_SECONDS),
    '-c:a', 'aac', '-ac', '2', '-b:a', '64k',
    '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng',
    target,
  ]);
}

async function buildCodecs(target, seconds) {
  const { size, rate } = VIDEO.codecs;
  const scratch = path.join(tmpDir(), 'codecs');
  await mkdir(scratch, { recursive: true });

  // Four exotic audio codecs refuse to open their encoders when they share one
  // filter graph, so each track is encoded on its own and muxed afterwards.
  const tracks = [
    { name: 'dts.mka', layout: 6, args: ['dca', '-strict', '-2'] },
    { name: 'truehd.mka', layout: 6, args: ['truehd', '-strict', '-2'] },
    { name: 'flac.mka', layout: 8, args: ['flac', '-strict', '-2'] },
    { name: 'vorbis.mka', layout: 8, args: ['libvorbis'] },
    // The dca and libvorbis encoders both reject a supplied bitrate, so those
    // two keep their defaults.
  ];

  const video = path.join(scratch, 'video.mkv');
  let result = await ffmpeg([
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '80k', '-maxrate', '100k', '-bufsize', '200k',
    '-g', String(rate * 2),
    video,
  ]);
  if (result.code !== 0) {
    return result;
  }

  for (const [index, track] of [...tracks].entries()) {
    const file = path.join(scratch, track.name);
    track.file = file;
    // DTS, TrueHD and Vorbis cannot be served as they are, so those three have
    // to be transcoded downstream. FLAC is copied. The 7.1 layouts decide what
    // channel count a transcode lands on.
    result = await ffmpeg([
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i',
      `anoisesrc=color=${['pink', 'white', 'brown', 'violet'][index]}:amplitude=0.05:sample_rate=48000:duration=${seconds}`,
      '-c:a', ...track.args, '-ac', String(track.layout),
      file,
    ]);
    if (result.code !== 0) {
      return result;
    }
  }

  const args = ['-y', '-loglevel', 'error', '-i', video];
  for (const track of tracks) {
    args.push('-i', track.file);
  }
  args.push('-map', '0:v');
  for (const [index] of [...tracks].entries()) {
    args.push('-map', `${index + 1}:a`);
  }
  args.push('-c', 'copy');
  for (const [index, track] of [...tracks].entries()) {
    args.push(`-metadata:s:a:${index}`, `title=${track.name.split('.')[0]} ${track.layout}ch`);
    args.push(`-metadata:s:a:${index}`, 'language=eng');
  }
  args.push(target);
  return ffmpeg(args);
}

async function buildTiny(target, seconds) {
  const { size, rate } = VIDEO.tiny;
  return ffmpeg([
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=48000:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a',
    // A keyframe every half second gives many segments for little work.
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '60k',
    ...keyframeArgs(0.5),
    '-c:a', 'aac', '-ac', '2', '-b:a', '48k',
    '-metadata:s:a:0', 'language=eng',
    target,
  ]);
}

const BUILDERS = [
  { file: 'movie.mkv', build: buildMovie, seconds: MOVIE_SECONDS },
  { file: 'sparse.mkv', build: buildSparse, seconds: SPARSE_SECONDS },
  { file: 'codecs.mkv', build: buildCodecs, seconds: CODECS_SECONDS },
  { file: 'tiny.mkv', build: buildTiny, seconds: TINY_SECONDS },
];

async function main() {
  await resolveBinaries();
  const force = process.argv.includes('--force') || process.env.FORCE === '1';
  await mkdir(fixtureDir, { recursive: true });

  const manifestPath = path.join(fixtureDir, 'manifest.json');
  let manifest = { builder: 0 };
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    // No manifest means these fixtures came from somewhere else.
  }

  const stale = force || manifest.builder !== BUILDER;

  // Subtitles are text: rebuilt every run so a change to their cues lands even
  // when the MKVs are reused.
  for (const [name, _spec] of Object.entries(SRT)) {
    await writeFile(path.join(fixtureDir, name), subtitleTrack(name), 'utf8');
  }

  for (const entry of BUILDERS) {
    const target = path.join(fixtureDir, entry.file);
    const missing = !(await stat(target).catch(() => undefined));
    if (!stale && !missing) {
      console.log(`fixture ${entry.file}: present, skipped`);
      continue;
    }
    process.stdout.write(`fixture ${entry.file}: building... `);
    const startedAt = Date.now();
    const result = await entry.build(target, entry.seconds);
    if (result.code !== 0) {
      console.log('failed');
      throw new Error(result.stderr.trim().split('\n').slice(-6).join('\n'));
    }
    console.log(`${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify({ builder: BUILDER, files: BUILDERS.map((entry) => entry.file) }, null, 2)}\n`,
  );
  await rm(tmpDir(), { recursive: true, force: true });
  console.log(`fixtures ready in ${fixtureDir}`);
}

await main().catch((err) => {
  console.error(`make-fixtures failed: ${err.message}`);
  process.exitCode = 1;
});
