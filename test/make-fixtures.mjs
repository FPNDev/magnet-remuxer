// Generates the MKV fixtures the other suites use. Pass --force to rebuild them.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ffmpeg, fixturesDir, section } from './lib.mjs';

const force = process.argv.includes('--force');
const movie = path.join(fixturesDir, 'movie.mkv');
const tiny = path.join(fixturesDir, 'tiny.mkv');
const sparse = path.join(fixturesDir, 'sparse.mkv');

if (!force && existsSync(movie) && existsSync(tiny) && existsSync(sparse)) {
  console.log(`fixtures already present in ${fixturesDir}`);
  process.exit(0);
}

section('building fixtures');

const pad = (n, width = 2) => String(n).padStart(width, '0');
const srtTime = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

let srt = '';
for (let i = 0; i < 60; i++) {
  const start = 1 + i * 2;
  srt += `${i + 1}\n${srtTime(start)} --> ${srtTime(start + 1.5)}\nCue ${i + 1} at ${start}s\n\n`;
}
const subtitles = path.join(fixturesDir, 'en.srt');
writeFileSync(subtitles, srt);

// H.264 with B-frames and irregular GOPs, AAC + AC3 5.1, SRT + ASS subtitles.
const channel = '0.4*sin(2*PI*330*t)';
await ffmpeg([
  '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24000/1001',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-f', 'lavfi', '-i', `aevalsrc=${Array(6).fill(channel).join('|')}:c=5.1:s=48000`,
  '-i', subtitles,
  '-i', subtitles,
  '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
  '-t', '120',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-x264-params', 'keyint=72:min-keyint=24:scenecut=0:bframes=3:b-pyramid=normal',
  '-force_key_frames', 'expr:gte(t,n_forced*1.7)',
  '-c:a:0', 'aac', '-b:a:0', '128k',
  '-c:a:1', 'ac3', '-b:a:1', '384k',
  '-c:s:0', 'srt', '-c:s:1', 'ass',
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English Stereo',
  '-metadata:s:a:1', 'language=ukr', '-metadata:s:a:1', 'title=Ukrainian 5.1',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English SRT',
  '-metadata:s:s:1', 'language=eng', '-metadata:s:s:1', 'title=English ASS',
  '-disposition:a:0', 'default', '-disposition:a:1', '0',
  '-disposition:s:0', '0', '-disposition:s:1', '0',
  movie,
]);
console.log(`built ${movie}`);

// Subtitles only near the start, so most segments contain no cues at all -
// exactly what a quiet stretch of a film looks like.
const sparseSubtitles = path.join(fixturesDir, 'sparse.srt');
writeFileSync(
  sparseSubtitles,
  `1\n${srtTime(1)} --> ${srtTime(3)}\nOnly cue near the start\n\n2\n${srtTime(4)} --> ${srtTime(6)}\nSecond and last cue\n\n`,
);
await ffmpeg([
  '-y',
  '-f', 'lavfi', '-i', 'color=c=navy:s=160x120:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
  '-i', sparseSubtitles,
  '-map', '0:v', '-map', '1:a', '-map', '2:s',
  '-t', '60',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-x264-params', 'keyint=48:min-keyint=48:scenecut=0:bframes=2',
  '-c:a', 'aac', '-b:a', '64k',
  '-c:s', 'srt',
  '-metadata:s:s:0', 'language=eng',
  sparse,
]);
console.log(`built ${sparse}`);

// Frames small enough that ffmpeg packs several GOPs per cluster, so keyframes
// land mid-cluster - the layout mkvmerge produces for real releases.
await ffmpeg([
  '-y',
  '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000',
  '-t', '60',
  '-c:v', 'libx264', '-preset', 'veryfast',
  '-x264-params', 'keyint=12:min-keyint=12:scenecut=0:bframes=2',
  '-c:a', 'aac', '-b:a', '12k', '-ac', '1',
  tiny,
]);
console.log(`built ${tiny}`);
