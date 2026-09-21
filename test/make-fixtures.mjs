import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ffmpeg, fixturesDir, section } from './lib.mjs';

// Fixtures are built once into test/.work/fixtures. Pass --force to rebuild
// them after changing anything here.
const force = process.argv.includes('--force');
const movie = path.join(fixturesDir, 'movie.mkv');
const tiny = path.join(fixturesDir, 'tiny.mkv');
const sparse = path.join(fixturesDir, 'sparse.mkv');
const codecs = path.join(fixturesDir, 'codecs.mkv');

if (
  !force &&
  existsSync(movie) &&
  existsSync(tiny) &&
  existsSync(sparse) &&
  existsSync(codecs)
) {
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

// movie.mkv: keyframes every 1.7s, so segment boundaries never land on a
// round second. AAC stereo is copied, the 5.1 AC3 track needs a transcode.
const channel = '0.4*sin(2*PI*330*t)';
await ffmpeg([
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=1280x720:rate=24000/1001',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-f',
  'lavfi',
  '-i',
  `aevalsrc=${Array(6).fill(channel).join('|')}:c=5.1:s=48000`,
  '-i',
  subtitles,
  '-i',
  subtitles,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-map',
  '3:s',
  '-map',
  '4:s',
  '-t',
  '120',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-pix_fmt',
  'yuv420p',
  '-x264-params',
  'keyint=72:min-keyint=24:scenecut=0:bframes=3:b-pyramid=normal',
  '-force_key_frames',
  'expr:gte(t,n_forced*1.7)',
  '-c:a:0',
  'aac',
  '-b:a:0',
  '128k',
  '-c:a:1',
  'ac3',
  '-b:a:1',
  '384k',
  '-c:s:0',
  'srt',
  '-c:s:1',
  'ass',
  '-metadata:s:a:0',
  'language=eng',
  '-metadata:s:a:0',
  'title=English Stereo',
  '-metadata:s:a:1',
  'language=ukr',
  '-metadata:s:a:1',
  'title=Ukrainian 5.1',
  '-metadata:s:s:0',
  'language=eng',
  '-metadata:s:s:0',
  'title=English SRT',
  '-metadata:s:s:1',
  'language=eng',
  '-metadata:s:s:1',
  'title=English ASS',
  '-disposition:a:0',
  'default',
  '-disposition:a:1',
  '0',
  '-disposition:s:0',
  '0',
  '-disposition:s:1',
  '0',
  movie,
]);
console.log(`built ${movie}`);

// sparse.mkv: two subtitle cues in the first six seconds and none after,
// so most subtitle segments come out empty.
const sparseSubtitles = path.join(fixturesDir, 'sparse.srt');
writeFileSync(
  sparseSubtitles,
  `1\n${srtTime(1)} --> ${srtTime(3)}\nOnly cue near the start\n\n2\n${srtTime(4)} --> ${srtTime(6)}\nSecond and last cue\n\n`,
);
await ffmpeg([
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=navy:s=160x120:r=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=220:sample_rate=48000',
  '-i',
  sparseSubtitles,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:s',
  '-t',
  '60',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-pix_fmt',
  'yuv420p',
  '-x264-params',
  'keyint=48:min-keyint=48:scenecut=0:bframes=2',
  '-c:a',
  'aac',
  '-b:a',
  '64k',
  '-c:s',
  'srt',
  '-metadata:s:s:0',
  'language=eng',
  sparse,
]);
console.log(`built ${sparse}`);

// codecs.mkv: DTS, TrueHD, FLAC and Vorbis over 5.1 and 7.1 layouts, for
// the copy-or-transcode decision and the AAC channel limit.
await ffmpeg([
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=teal:s=160x120:r=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:sample_rate=48000',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=220:sample_rate=48000',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=170:sample_rate=48000',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-map',
  '3:a',
  '-map',
  '4:a',
  '-t',
  '16',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-pix_fmt',
  'yuv420p',
  '-x264-params',
  'keyint=48:min-keyint=48:scenecut=0',
  '-filter:a:0',
  'aformat=channel_layouts=5.1',
  '-filter:a:3',
  'aformat=channel_layouts=7.1',
  '-c:a:0',
  'dca',
  '-strict',
  '-2',
  '-c:a:1',
  'truehd',
  '-ac:a:1',
  '2',
  '-c:a:2',
  'flac',
  '-ac:a:2',
  '2',
  '-c:a:3',
  'libvorbis',
  '-metadata:s:a:0',
  'language=eng',
  '-metadata:s:a:0',
  'title=DTS 5.1',
  '-metadata:s:a:1',
  'language=eng',
  '-metadata:s:a:1',
  'title=TrueHD Stereo',
  '-metadata:s:a:2',
  'language=eng',
  '-metadata:s:a:2',
  'title=FLAC Stereo',
  '-metadata:s:a:3',
  'language=eng',
  '-metadata:s:a:3',
  'title=Vorbis 7.1',
  codecs,
]);
console.log(`built ${codecs}`);

// tiny.mkv: 64x64 with a keyframe every half second, so suites that need
// many segments build and remux in seconds.
await ffmpeg([
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=gray:s=64x64:r=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=8000',
  '-t',
  '60',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-x264-params',
  'keyint=12:min-keyint=12:scenecut=0:bframes=2',
  '-c:a',
  'aac',
  '-b:a',
  '12k',
  '-ac',
  '1',
  tiny,
]);
console.log(`built ${tiny}`);
