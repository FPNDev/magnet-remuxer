import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ByteSource } from '../io/byte-source.js';
import {
  buildTrackHeader,
  EMPTY_CLUSTER,
  sliceMatroska,
  type SliceResult,
} from '../matroska/slicer.js';
import {
  aacChannels,
  aacSampleRate,
  type AudioRendition,
  type Rendition,
  type VideoRendition,
} from '../media/codecs.js';
import {
  keyframeSlice,
  secondsToTicks,
  segmentCount,
  segmentStart,
  timeSlice,
  type MediaIndex,
  type SliceTarget,
} from '../media/media-index.js';
import { tempPathFor, writeFileAtomic } from '../util/fs.js';
import { runFfmpeg } from './ffmpeg.js';
import { Fmp4Splitter, hasTopLevelBox } from './mp4.js';

/**
 * Added to every fMP4 timestamp so B-frame decode times never go negative.
 * WebVTT segments map their cue times onto the same offset.
 */
export const TIMELINE_OFFSET_SECONDS = 10;

const AAC_FRAME_SAMPLES = 1024;
/** AAC frames encoded past each segment edge, then dropped, so edges match. */
const AUDIO_PAD_FRAMES = 16;
/** A source audio frame may begin this long before the first sample needed. */
const AUDIO_READ_MARGIN_SECONDS = 0.5;

const INPUT_ARGS = ['-copyts', '-f', 'matroska', '-i', 'pipe:0', '-map', '0:0'];

const FMP4_OUTPUT_ARGS = [
  '-output_ts_offset',
  String(TIMELINE_OFFSET_SECONDS),
  // Without this ffmpeg shifts every segment to start at zero.
  '-avoid_negative_ts',
  'disabled',
  '-map_metadata',
  '-1',
  '-map_chapters',
  '-1',
  '-fflags',
  '+bitexact',
  '-f',
  'mp4',
  '-movflags',
  '+frag_custom+empty_moov+default_base_moof+frag_discont+skip_trailer',
  '-use_editlist',
  '0',
  'pipe:1',
];

const WEBVTT_OUTPUT_ARGS = ['-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'];

export interface RemuxTarget {
  index: MediaIndex;
  source: ByteSource;
  rendition: Rendition;
  signal?: AbortSignal | undefined;
}

export interface RemuxerOptions {
  ffmpegPath: string;
  timeoutMs: number;
}

interface Plan {
  /** Slices to try in order; later ones read more generously. */
  slices: SliceTarget[];
  args: string[];
}

/** Produces HLS init and media segments from Matroska byte ranges via ffmpeg. */
export class Remuxer {
  constructor(private readonly options: RemuxerOptions) {}

  /**
   * Writes the fMP4 initialization section of an audio or video rendition.
   */
  async writeInit(
    index: MediaIndex,
    rendition: Rendition,
    outPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (rendition.type === 'subtitle') {
      throw new Error('Subtitle renditions have no init segment');
    }

    const converted = rendition.type === 'audio' && rendition.transcode;
    const splitter = new Fmp4Splitter();
    splitter.resume();
    await runFfmpeg(this.options.ffmpegPath, {
      args: converted ? silenceArgs(rendition) : copyArgs(rendition),
      // An empty cluster follows the header because the demuxer reports no
      // stream parameters until it has reached one.
      input: converted
        ? undefined
        : [Buffer.concat([trackHeader(index, rendition), EMPTY_CLUSTER])],
      output: splitter,
      signal,
      timeoutMs: this.options.timeoutMs,
    });

    const init = splitter.init;
    if (!hasTopLevelBox(init, 'moov')) {
      throw new Error('ffmpeg produced no moov box');
    }
    await writeFileAtomic(outPath, init);
  }

  /** Writes media segment `n` as fMP4 (moof + mdat) or WebVTT. */
  async writeSegment(
    target: RemuxTarget,
    n: number,
    outPath: string,
  ): Promise<void> {
    const { slices, args } = plan(target.index, target.rendition, n);

    for (const [attempt, slice] of slices.entries()) {
      const canRetry = attempt < slices.length - 1;

      if (target.rendition.type === 'subtitle') {
        const chunks: Buffer[] = [];
        const collector = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        });
        const result = await this.run(target, slice, args, collector);
        if (!isComplete(target.index, slice, result)) {
          if (canRetry) {
            continue;
          }
          throw boundaryError(n);
        }
        await writeFileAtomic(outPath, toHlsWebVtt(Buffer.concat(chunks)));
        return;
      }

      const temp = tempPathFor(outPath);
      const splitter = new Fmp4Splitter();
      const writing = pipeline(splitter, createWriteStream(temp));
      try {
        const result = await this.run(target, slice, args, splitter);
        await writing;
        if (!isComplete(target.index, slice, result)) {
          if (canRetry) {
            continue;
          }
          throw boundaryError(n);
        }
        await rename(temp, outPath);
        return;
      } catch (err) {
        splitter.destroy();
        await writing.catch(() => {});
        throw err;
      } finally {
        await rm(temp, { force: true });
      }
    }
  }

  private async run(
    target: RemuxTarget,
    slice: SliceTarget,
    args: string[],
    output: Writable,
  ): Promise<SliceResult> {
    const { index, source, rendition, signal } = target;
    const readable = source.stream(slice.readStart, slice.readEnd);
    const { stream, result } = sliceMatroska(readable, {
      header: trackHeader(index, rendition),
      track: rendition.track.number,
      videoTrack: index.videoTrack,
      range: slice.range,
    });

    try {
      await runFfmpeg(this.options.ffmpegPath, {
        args,
        input: stream,
        output,
        signal,
        timeoutMs: this.options.timeoutMs,
      });
      return result;
    } finally {
      readable.destroy();
    }
  }
}

function plan(index: MediaIndex, rendition: Rendition, n: number): Plan {
  const keyframeSlices = [
    keyframeSlice(index, n, true),
    keyframeSlice(index, n, false),
  ];

  switch (rendition.type) {
    case 'video':
      return { slices: keyframeSlices, args: copyArgs(rendition) };
    case 'audio':
      return rendition.transcode
        ? aacPlan(index, rendition, n)
        : { slices: keyframeSlices, args: copyArgs(rendition) };
    case 'subtitle':
      return {
        slices: keyframeSlices,
        args: [...INPUT_ARGS, ...WEBVTT_OUTPUT_ARGS],
      };
  }
}

function trackHeader(index: MediaIndex, rendition: Rendition): Buffer {
  return buildTrackHeader(
    Buffer.from(index.ebmlHeader, 'base64'),
    Buffer.from(index.info, 'base64'),
    Buffer.from(rendition.track.entry, 'base64'),
  );
}

function copyArgs(rendition: VideoRendition | AudioRendition): string[] {
  const tag =
    rendition.type === 'video' && rendition.codec === 'hevc'
      ? ['-tag:v', 'hvc1']
      : [];
  return [...INPUT_ARGS, '-c', 'copy', ...tag, ...FMP4_OUTPUT_ARGS];
}

/** The AAC output an audio rendition is converted to. */
function aacOutput(rendition: AudioRendition): {
  rate: number;
  channels: number;
  args: string[];
} {
  const rate = aacSampleRate(rendition.track);
  const channels = aacChannels(rendition.track);
  return {
    rate,
    channels,
    args: [
      '-c:a',
      'aac',
      '-ac',
      String(channels),
      '-b:a',
      aacBitrate(channels),
    ],
  };
}

/** Stereo and mono get a little more than the 64 kbps a surround channel needs. */
function aacBitrate(channels: number): string {
  switch (channels) {
    case 1:
      return '96k';
    case 2:
      return '192k';
    default:
      return `${64 * channels}k`;
  }
}

/**
 * Init section of a converted track, encoded from silence.
 *
 * Its moov describes our AAC output rather than the source, so silence yields
 * the same bytes the real audio would - and unlike the source it needs no
 * torrent data. Feeding the source's own header instead only works for codecs
 * that report their stream format before decoding anything: DTS and TrueHD
 * report nothing until they have decoded a frame, which a header alone never
 * gives them.
 */
function silenceArgs(rendition: AudioRendition): string[] {
  const { rate, channels, args } = aacOutput(rendition);
  return [
    '-f',
    'lavfi',
    // The layout here is immaterial: `-ac` in `args` maps it onto the same
    // output layout a real segment's audio goes through, so both produce the
    // same moov. Silence is silence either way.
    '-i',
    `anullsrc=r=${rate}:cl=${channels > 1 ? 'stereo' : 'mono'}`,
    '-t',
    '0.1',
    '-map',
    '0:0',
    ...args,
    ...FMP4_OUTPUT_ARGS,
  ];
}

/**
 * AAC conversion with segment edges snapped to the AAC frame grid. Each
 * segment is encoded with padding on both sides and the padding packets are
 * dropped afterwards, so neighbouring segments meet without gaps or clicks.
 */
function aacPlan(
  index: MediaIndex,
  rendition: AudioRendition,
  n: number,
): Plan {
  const { rate, args: outputArgs } = aacOutput(rendition);
  const toGrid = (seconds: number) =>
    Math.round((seconds * rate) / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;
  const padding = AUDIO_PAD_FRAMES * AAC_FRAME_SAMPLES;

  const isLast = n + 1 >= segmentCount(index);
  const start = toGrid(segmentStart(index, n));
  const end = isLast ? null : toGrid(segmentStart(index, n + 1));
  const encodeFrom = Math.max(0, start - padding);
  const encodeTo = end === null ? null : end + padding;

  const toTicks = (samples: number, marginSeconds: number) =>
    secondsToTicks(index, samples / rate + marginSeconds);
  const slice = timeSlice(
    index,
    toTicks(encodeFrom, -AUDIO_READ_MARGIN_SECONDS),
    encodeTo === null ? null : toTicks(encodeTo, AUDIO_READ_MARGIN_SECONDS),
  );

  const filters: string[] = [];
  if (rendition.track.sampleRate !== rate) {
    filters.push(`aresample=${rate}`);
  }
  filters.push(
    `atrim=start_pts=${encodeFrom}` +
      (encodeTo === null ? '' : `:end_pts=${encodeTo}`),
  );

  const drop =
    `lt(pts\\,${start})` + (end === null ? '' : `+gte(pts\\,${end})`);

  return {
    slices: [slice],
    args: [
      ...INPUT_ARGS,
      '-af',
      filters.join(','),
      ...outputArgs,
      '-bsf:a',
      `noise=drop=${drop}`,
      ...FMP4_OUTPUT_ARGS,
    ],
  };
}

function isComplete(
  index: MediaIndex,
  slice: SliceTarget,
  result: SliceResult,
): boolean {
  if (!result.started) {
    return false;
  }
  const { range } = slice;

  if (range.mode === 'keyframes') {
    return range.endKeyframe === null || result.reachedEnd;
  }
  // A time range feeds an encoder that stops reading once its window is full,
  // so a slice ending early only matters when the input itself ran out.
  if (range.to === null || result.reachedEnd || !result.sourceEnded)
    return true;
  return slice.readEnd >= index.mediaEnd;
}

function boundaryError(n: number): Error {
  return new Error(`Segment ${n} boundaries were not found in the file data`);
}

/** Adds the header that maps cue times onto the offset fMP4 timeline. */
function toHlsWebVtt(output: Buffer): string {
  const body = output
    .toString('utf8')
    .replace(/^﻿?WEBVTT[^\n]*\n?/, '')
    .replace(/^\n+/, '');
  const mpegTs = TIMELINE_OFFSET_SECONDS * 90000;
  return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegTs},LOCAL:00:00:00.000\n\n${body}`;
}
